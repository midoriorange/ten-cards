import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, describeCard, createGame, dealCards, selectCard, isValidState,
  getNextDealer, canDeal, canSelect } from '../src/game.js';

test('the full deck has exactly 52 unique, identifiable cards and no jokers', () => {
  const deck = createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
  for (const suit of ['S', 'H', 'D', 'C']) {
    assert.equal(deck.filter(id => id.endsWith(suit)).length, 13);
  }
  assert.deepEqual(describeCard('AS'), {
    id: 'AS', rank: 'A', suit: 'S', symbol: '♠', color: 'black', name: 'Ace of spades',
  });
  assert.equal(describeCard('10H').rank, '10');
  assert.equal(describeCard('10H').name, 'Ten of hearts');
  assert.equal(describeCard('QD').color, 'red');
  assert.throws(() => describeCard('JOKER'), RangeError);
  deck.pop();
  assert.equal(createDeck().length, 52, 'callers cannot modify the canonical deck');
});

test('a new game is empty, valid, and cannot accept a selection', () => {
  const state = createGame();
  assert.deepEqual(state, { round: 0, revision: 0, dealer: 'host', cards: [], selectedCard: null });
  assert.equal(isValidState(state), true);
  assert.equal(getNextDealer(state), 'host');
  assert.equal(canDeal(state, 'host'), true);
  assert.equal(canDeal(state, 'guest'), false);
  assert.equal(canSelect(state, 'guest'), false);
  assert.equal(canSelect(state, 'host'), false);
  assert.equal(selectCard(state, { round: 0, cardId: 'AS', role: 'guest' }), state);
});

test('every deal contains ten unique deck cards, and dealing does not mutate input', () => {
  let state = createGame();
  const allCards = new Set(createDeck());
  for (let round = 1; round <= 250; round += 1) {
    const previous = structuredClone(state);
    const next = dealCards(state);
    assert.deepEqual(state, previous);
    assert.equal(next.round, round);
    assert.equal(next.revision, round);
    assert.equal(next.dealer, 'host', 're-dealing without a choice keeps the same dealer');
    assert.equal(next.cards.length, 10);
    assert.equal(new Set(next.cards).size, 10);
    assert.equal(next.cards.every(card => allCards.has(card)), true);
    assert.equal(isValidState(next), true);
    state = next;
  }
});

test('a valid guest selection is accepted once and increments revision only', () => {
  const dealt = dealCards(createGame(), () => 0.5);
  const snapshot = structuredClone(dealt);
  const selected = selectCard(dealt, { round: dealt.round, cardId: dealt.cards[2], role: 'guest' });
  assert.equal(selected.selectedCard, dealt.cards[2]);
  assert.equal(selected.round, dealt.round);
  assert.equal(selected.revision, dealt.revision + 1);
  assert.deepEqual(dealt, snapshot);
  assert.equal(isValidState(selected), true);
  assert.equal(selectCard(selected, { round: selected.round, cardId: selected.cards[3], role: 'guest' }), selected);
  assert.equal(selectCard(selected, { round: selected.round, cardId: selected.cards[2], role: 'guest' }), selected);
});

test('malformed, unknown, and stale selections leave the original state unchanged', () => {
  const dealt = dealCards(createGame());
  const outsideDeal = createDeck().find(card => !dealt.cards.includes(card));
  for (const action of [
    null, undefined, [], 'AS', {},
    { round: dealt.round, cardId: outsideDeal, role: 'guest' },
    { round: dealt.round, cardId: 'joker', role: 'guest' },
    { round: dealt.round - 1, cardId: dealt.cards[0], role: 'guest' },
    { round: String(dealt.round), cardId: dealt.cards[0], role: 'guest' },
    { round: dealt.round, cardId: dealt.cards[0] },
    { round: dealt.round, cardId: dealt.cards[0], role: 'host' },
    { round: dealt.round, cardId: dealt.cards[0], role: 'spectator' },
  ]) assert.equal(selectCard(dealt, action), dealt);
});

test('re-dealing clears selection and invalidates requests from the previous round', () => {
  const first = dealCards(createGame());
  const selected = selectCard(first, { round: first.round, cardId: first.cards[0], role: 'guest' });
  const next = dealCards(selected);
  assert.equal(next.selectedCard, null);
  assert.equal(next.round, 2);
  assert.equal(next.revision, 3);
  assert.equal(selectCard(next, { round: first.round, cardId: next.cards[0], role: 'host' }), next);
});

test('state validation rejects malformed numbers, duplicate cards, and invalid selection', () => {
  const dealt = dealCards(createGame());
  const outsideDeal = createDeck().find(card => !dealt.cards.includes(card));
  for (const value of [
    null, [], 'state', {},
    { ...dealt, round: 1.5 }, { ...dealt, round: -1 }, { ...dealt, round: '1' },
    { ...dealt, revision: 1.5 }, { ...dealt, revision: NaN },
    { ...dealt, revision: Infinity }, { ...dealt, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...dealt, revision: 0 },
    { ...dealt, dealer: undefined }, { ...dealt, dealer: null },
    { ...dealt, dealer: 'spectator' }, { ...createGame(), dealer: 'guest' },
    { ...dealt, cards: 'not-cards' }, { ...dealt, cards: dealt.cards.slice(1) },
    { ...dealt, cards: Array(10).fill('AS') },
    { ...dealt, cards: [...dealt.cards.slice(0, 9), 'JOKER'] },
    { ...dealt, selectedCard: undefined }, { ...dealt, selectedCard: 1 },
    { ...dealt, selectedCard: outsideDeal },
    { ...createGame(), cards: dealt.cards }, { ...createGame(), revision: 1 },
  ]) assert.equal(isValidState(value), false, JSON.stringify(value));
});

test('shuffle supports deterministic tests and rejects invalid random sources', () => {
  const state = createGame();
  assert.deepEqual(dealCards(state, () => 0.2), dealCards(state, () => 0.2));
  for (const value of [-0.1, 1, NaN, Infinity, '0.2']) {
    assert.throws(() => dealCards(state, () => value), RangeError);
  }
  assert.throws(() => dealCards(state, 0.5), TypeError);
  assert.throws(() => dealCards({}), TypeError);
});

test('completed choices alternate host deal / guest choice / guest deal / host choice', () => {
  const first = dealCards(createGame());
  assert.equal(first.dealer, 'host');
  assert.equal(canDeal(first, 'host'), true);
  assert.equal(canDeal(first, 'guest'), false);
  assert.equal(canSelect(first, 'host'), false);
  assert.equal(canSelect(first, 'guest'), true);

  const guestChoice = selectCard(first, { round: first.round, cardId: first.cards[0], role: 'guest' });
  assert.equal(guestChoice.dealer, 'host', 'the dealer of the completed deal stays recorded');
  assert.equal(getNextDealer(guestChoice), 'guest');
  assert.equal(canDeal(guestChoice, 'host'), false);
  assert.equal(canDeal(guestChoice, 'guest'), true);
  assert.equal(canSelect(guestChoice, 'guest'), false);
  assert.equal(canSelect(guestChoice, 'host'), false);

  const second = dealCards(guestChoice);
  assert.equal(second.dealer, 'guest');
  assert.equal(second.selectedCard, null);
  assert.equal(canSelect(second, 'host'), true);
  assert.equal(canSelect(second, 'guest'), false);
  assert.equal(selectCard(second, { round: second.round, cardId: second.cards[0], role: 'guest' }), second);

  const hostChoice = selectCard(second, { round: second.round, cardId: second.cards[1], role: 'host' });
  assert.equal(hostChoice.selectedCard, second.cards[1]);
  assert.equal(hostChoice.dealer, 'guest');
  assert.equal(getNextDealer(hostChoice), 'host');
  assert.equal(canDeal(hostChoice, 'host'), true);
  assert.equal(canDeal(hostChoice, 'guest'), false);

  const third = dealCards(hostChoice);
  assert.equal(third.dealer, 'host');
  assert.equal(third.selectedCard, null);
  assert.equal(third.round, 3);
  assert.equal(third.revision, 5);
  assert.equal(canSelect(third, 'guest'), true);
});

test('re-dealing before selection preserves either current dealer', () => {
  const hostDeal = dealCards(createGame());
  const hostRedeal = dealCards(hostDeal);
  assert.equal(hostRedeal.dealer, 'host');
  assert.equal(getNextDealer(hostRedeal), 'host');

  const chosen = selectCard(hostRedeal, {
    round: hostRedeal.round, cardId: hostRedeal.cards[0], role: 'guest',
  });
  const guestDeal = dealCards(chosen);
  const guestRedeal = dealCards(guestDeal);
  assert.equal(guestRedeal.dealer, 'guest');
  assert.equal(getNextDealer(guestRedeal), 'guest');
  assert.equal(canDeal(guestRedeal, 'guest'), true);
  assert.equal(canSelect(guestRedeal, 'host'), true);
});

test('permission helpers reject invalid states and identities', () => {
  const dealt = dealCards(createGame());
  assert.equal(isValidState({ ...dealt, dealer: 'guest' }), true);
  for (const state of [null, {}, [], { ...dealt, dealer: 'observer' }]) {
    assert.equal(getNextDealer(state), null);
    for (const role of ['host', 'guest']) {
      assert.equal(canDeal(state, role), false);
      assert.equal(canSelect(state, role), false);
    }
  }
  for (const role of [undefined, null, '', 'dealer', 'spectator', 0]) {
    assert.equal(canDeal(dealt, role), false);
    assert.equal(canSelect(dealt, role), false);
  }
});
