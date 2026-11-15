import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, describeCard, getLegalActions, getActivePlayer, otherPlayer } from '../src/game.js';
import { getPlayerView } from '../src/view.js';

function step(state, role, action) {
  const next = applyAction(state, role, action, () => 0.37);
  assert.notEqual(next, state, `Expected ${role} ${JSON.stringify(action)} to advance ${state.phase}`);
  return next;
}

function deal(state = createGame()) {
  return step(state, getActivePlayer(state), { type: 'deal' });
}

function winAuction(state, dealerWins = false) {
  const dealer = state.dealer;
  const nondealer = otherPlayer(dealer);
  if (dealerWins) {
    state = step(state, nondealer, { type: 'pass' });
    return step(state, dealer, { type: 'bid', number: 3, mode: 'high' });
  }
  state = step(state, nondealer, { type: 'bid', number: 3, mode: 'high' });
  return step(state, dealer, { type: 'pass' });
}

function discard(state) {
  const bidder = state.contract.bidder;
  return step(state, bidder, { type: 'discard', cards: state.hands[bidder].slice(0, 4) });
}

function startPlay(state = deal(), dealerWins = false) {
  state = winAuction(state, dealerWins);
  if (state.phase === 'trump_before') state = step(state, state.contract.bidder, { type: 'trump', suit: 'S' });
  state = discard(state);
  if (state.phase === 'trump_after') state = step(state, state.contract.bidder, { type: 'trump', suit: 'S' });
  assert.equal(state.phase, 'play');
  return state;
}

function playOne(state) {
  const role = getActivePlayer(state);
  const legal = getLegalActions(state, role);
  if (legal.tableStacks.length) return step(state, role, { type: 'playTable', stackIndex: legal.tableStacks[0] });
  assert(legal.handCards.length, 'An active player has a legal card');
  return step(state, role, { type: 'playHand', cardId: legal.handCards[0] });
}

function finishGame(state) {
  for (let count = 0; count < 200; count++) {
    if (state.phase === 'game_over' || state.phase === 'match_over') return state;
    state = state.phase === 'pack_complete'
      ? step(state, getActivePlayer(state), { type: 'continue' })
      : playOne(state);
  }
  assert.fail('Game did not finish within the available cards');
}

function stringValues(value, result = new Set()) {
  if (typeof value === 'string') result.add(value);
  else if (Array.isArray(value)) value.forEach(item => stringValues(item, result));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => stringValues(item, result));
  return result;
}

function assertHidden(view, cardIds) {
  const strings = stringValues(view);
  for (const id of cardIds) {
    assert(!strings.has(id), `Hidden ID ${id} was included in the view`);
    assert(!strings.has(describeCard(id).name), `Hidden name for ${id} was included in the view`);
  }
}

function assertBacks(cards, count) {
  assert.equal(cards.length, count);
  cards.forEach((card, index) => assert.deepEqual(card, { hidden: true, position: index + 1 }));
}

function assertCoveredTables(view) {
  for (const stack of [...view.ownTable, ...view.opponentTable]) {
    assert.equal(stack.card, null);
    assert.equal(stack.hidden, stack.count > 0);
    assert.equal(Object.hasOwn(stack, 'cards'), false);
  }
}

test('lobby projections contain no cards and reject invalid viewer/state values', () => {
  const state = createGame();
  for (const role of ['host', 'guest']) {
    const view = getPlayerView(state, role);
    assert.equal(view.role, role);
    assert.equal(view.opponent, otherPlayer(role));
    assert.deepEqual(view.hand, []);
    assert.deepEqual(view.opponentHand, []);
    assert.deepEqual(view.kitty, []);
    assert.equal(view.currentPack, null);
    assert.equal(view.lastPack, null);
  }
  for (const role of [undefined, null, '', 'dealer', 'spectator', 0]) {
    assert.throws(() => getPlayerView(state, role), TypeError);
  }
  for (const value of [null, [], {}, { ...state, schema: 2 }]) {
    assert.throws(() => getPlayerView(value, 'host'), TypeError);
  }
});

test('auction exposes own hand only; all opponent hand, kitty and table identities are omitted', () => {
  const state = deal();
  for (const role of ['host', 'guest']) {
    const view = getPlayerView(state, role);
    assert.deepEqual(view.hand, state.hands[role].map(describeCard));
    assert.equal(view.hand.length, 12);
    assertBacks(view.opponentHand, 12);
    assertBacks(view.kitty, 4);
    assertCoveredTables(view);
    assertHidden(view, [...state.hands[otherPlayer(role)], ...state.kitty,
      ...state.table.host.flat(), ...state.table.guest.flat()]);
  }
});

test('a nondealer bid winner sees the kitty only during the kitty phase', () => {
  const dealt = deal();
  const state = winAuction(dealt, false);
  assert.equal(state.phase, 'kitty');
  assert.notEqual(state.contract.bidder, state.dealer);
  const bidder = getPlayerView(state, state.contract.bidder);
  const defender = getPlayerView(state, state.contract.defender);
  assert.deepEqual(bidder.kitty, state.kitty.map(describeCard));
  assert.equal(bidder.hand.length, 12, 'Kitty cards are displayed separately from the original hand');
  assertBacks(defender.kitty, 4);
  assertHidden(defender, state.kitty);
  assertCoveredTables(bidder);
  assertCoveredTables(defender);
  const afterDiscard = discard(state);
  assert.equal(afterDiscard.phase, 'trump_after');
  for (const role of ['host', 'guest']) {
    const view = getPlayerView(afterDiscard, role);
    assertBacks(view.discards, 4);
    assertHidden(view, afterDiscard.discards);
    assertCoveredTables(view);
  }
});

test('a dealer bid winner must call trump before seeing the kitty', () => {
  let state = winAuction(deal(), true);
  assert.equal(state.phase, 'trump_before');
  assert.equal(state.contract.bidder, state.dealer);
  for (const role of ['host', 'guest']) {
    const view = getPlayerView(state, role);
    assertBacks(view.kitty, 4);
    assertHidden(view, state.kitty);
    assertCoveredTables(view);
  }
  state = step(state, state.contract.bidder, { type: 'trump', suit: 'H' });
  assert.equal(state.phase, 'kitty');
  assert.deepEqual(getPlayerView(state, state.contract.bidder).kitty, state.kitty.map(describeCard));
  assertBacks(getPlayerView(state, state.contract.defender).kitty, 4);
  state = discard(state);
  assert.equal(state.phase, 'play');
  for (const role of ['host', 'guest']) {
    const view = getPlayerView(state, role);
    assertBacks(view.discards, 4);
    assertHidden(view, state.discards);
  }
});

test('play exposes all six stack tops while omitting buried cards and opponent hands', () => {
  const state = startPlay();
  for (const role of ['host', 'guest']) {
    const view = getPlayerView(state, role);
    for (const [owner, projected] of [[role, view.ownTable], [otherPlayer(role), view.opponentTable]]) {
      projected.forEach((stack, index) => {
        assert.equal(stack.index, index);
        assert.equal(stack.count, state.table[owner][index].length);
        assert.equal(stack.hidden, false);
        assert.deepEqual(stack.card, describeCard(state.table[owner][index][0]));
        assert.equal(Object.hasOwn(stack, 'cards'), false);
      });
    }
    assertHidden(view, [...state.hands[otherPlayer(role)], ...state.discards,
      ...state.table.host.flatMap(stack => stack.slice(1)), ...state.table.guest.flatMap(stack => stack.slice(1))]);
  }
});

test('a stack played into the current pack covers its replacement top until pack completion', () => {
  let state = startPlay();
  while (!state.currentPack?.plays.some(play => play.source === 'table')) state = playOne(state);
  const played = state.currentPack.plays.find(play => play.source === 'table');
  const replacement = state.table[played.role][played.stackIndex][0];
  assert(replacement);
  for (const role of ['host', 'guest']) {
    const view = getPlayerView(state, role);
    const stacks = played.role === role ? view.ownTable : view.opponentTable;
    assert.equal(stacks[played.stackIndex].hidden, true);
    assert.equal(stacks[played.stackIndex].card, null);
    assertHidden(view, [replacement]);
    const visiblePlay = view.currentPack.plays.find(play => play.role === played.role && play.stackIndex === played.stackIndex);
    assert.deepEqual(visiblePlay.card, describeCard(played.cardId));
  }
  while (state.phase === 'play') state = playOne(state);
  assert.equal(state.phase, 'pack_complete');
  assert.equal(state.currentPack, null);
  for (const role of ['host', 'guest']) {
    const view = getPlayerView(state, role);
    const stacks = played.role === role ? view.ownTable : view.opponentTable;
    assert.equal(stacks[played.stackIndex].hidden, false);
    assert.deepEqual(stacks[played.stackIndex].card, describeCard(replacement));
    assert.equal(view.lastPack.plays.length, 4);
    assert.equal(view.lastPack.winner, state.history.at(-1).winner);
  }
});

test('game end reveals remaining cards, complete remaining stacks and discards to both players', () => {
  const state = finishGame(startPlay());
  for (const role of ['host', 'guest']) {
    const view = getPlayerView(state, role);
    assert.deepEqual(view.opponentHand, state.hands[otherPlayer(role)].map(describeCard));
    assert.deepEqual(view.discards, state.discards.map(describeCard));
    assert.deepEqual(view.kitty, state.kitty.map(describeCard));
    for (const [owner, stacks] of [[role, view.ownTable], [otherPlayer(role), view.opponentTable]]) {
      stacks.forEach((stack, index) => {
        assert.equal(stack.hidden, false);
        assert.deepEqual(stack.cards, state.table[owner][index].map(describeCard));
      });
    }
  }
});

test('match completion also reveals every remaining opponent card and discard', () => {
  let state = finishGame(startPlay());
  for (let game = 0; state.phase !== 'match_over' && game < 14; game++) {
    state = finishGame(startPlay(deal(state)));
  }
  assert.equal(state.phase, 'match_over');
  assert(state.matchWinner);
  for (const role of ['host', 'guest']) {
    const view = getPlayerView(state, role);
    assert.equal(view.matchWinner, state.matchWinner);
    assert.deepEqual(view.opponentHand, state.hands[otherPlayer(role)].map(describeCard));
    assert.deepEqual(view.discards, state.discards.map(describeCard));
    [...view.ownTable, ...view.opponentTable].forEach(stack => {
      assert.equal(stack.hidden, false);
      assert(Array.isArray(stack.cards));
    });
  }
});

test('the next game keeps privacy rules when the guest becomes dealer', () => {
  const first = finishGame(startPlay());
  assert.equal(first.phase, 'game_over');
  const state = deal(first);
  assert.equal(state.dealer, 'guest');
  for (const role of ['host', 'guest']) {
    const view = getPlayerView(state, role);
    assertBacks(view.opponentHand, 12);
    assertBacks(view.kitty, 4);
    assertCoveredTables(view);
    assertHidden(view, [...state.hands[otherPlayer(role)], ...state.kitty,
      ...state.table.host.flat(), ...state.table.guest.flat()]);
  }
  const callBeforeKitty = winAuction(state, true);
  assert.equal(callBeforeKitty.phase, 'trump_before');
  assert.equal(callBeforeKitty.contract.bidder, 'guest');
  assertBacks(getPlayerView(callBeforeKitty, 'guest').kitty, 4);
});

test('projection copies cannot mutate shared state or one another', () => {
  const state = startPlay();
  const before = structuredClone(state);
  const view = getPlayerView(state, 'host');
  view.scores.host = 999;
  view.auction.entries.length = 0;
  view.hand[0].id = 'JOKER';
  view.opponentHand[0].position = 99;
  view.ownTable[0].card.id = 'JOKER';
  view.legal.handCards.length = 0;
  assert.deepEqual(state, before);
  assert.notDeepEqual(getPlayerView(state, 'host'), view);
});
