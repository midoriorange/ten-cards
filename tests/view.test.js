import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, dealCards, selectCard, describeCard } from '../src/game.js';
import { getCardViews } from '../src/view.js';

function choose(state, position = 3) {
  return selectCard(state, {
    round: state.round,
    cardId: state.cards[position],
    role: state.dealer === 'host' ? 'guest' : 'host',
  });
}

function dealsForBothRoles() {
  const hostDeal = dealCards(createGame(), () => 0.37);
  return [hostDeal, dealCards(choose(hostDeal), () => 0.61)];
}

test('an empty game has no card views for either player', () => {
  assert.deepEqual(getCardViews(createGame(), 'host'), []);
  assert.deepEqual(getCardViews(createGame(), 'guest'), []);
});

test('either current dealer sees ten anonymous card backs before selection', () => {
  for (const state of dealsForBothRoles()) {
    const views = getCardViews(state, state.dealer);
    assert.equal(views.length, 10);
    for (let index = 0; index < views.length; index += 1) {
      assert.deepEqual(views[index], { position: index + 1, faceUp: false, selected: false });
      for (const field of ['id', 'rank', 'suit', 'name', 'color', 'symbol']) {
        assert.equal(Object.hasOwn(views[index], field), false, `Hidden cards omit ${field}`);
      }
    }
  }
});

test('the chooser sees every face in dealt order before and after choosing', () => {
  for (const dealt of dealsForBothRoles()) {
    const chooser = dealt.dealer === 'host' ? 'guest' : 'host';
    for (const state of [dealt, choose(dealt)]) {
      const views = getCardViews(state, chooser);
      assert.equal(views.length, 10);
      views.forEach((view, index) => assert.deepEqual(view, {
        position: index + 1, faceUp: true,
        selected: state.cards[index] === state.selectedCard,
        ...describeCard(state.cards[index]),
      }));
    }
  }
});

test('only the selected card is revealed to either dealer at its original position', () => {
  for (const dealt of dealsForBothRoles()) {
    for (const selectedIndex of [0, 4, 9]) {
      const selected = choose(dealt, selectedIndex);
      const views = getCardViews(selected, dealt.dealer);
      assert.equal(views.filter(view => view.faceUp).length, 1);
      assert.deepEqual(views[selectedIndex], {
        position: selectedIndex + 1, faceUp: true, selected: true,
        ...describeCard(dealt.cards[selectedIndex]),
      });
      views.forEach((view, index) => {
        if (index !== selectedIndex) assert.deepEqual(view, {
          position: index + 1, faceUp: false, selected: false,
        });
      });
    }
  }
});

test('a new deal resets the reveal and follows the new dealer rather than the original host', () => {
  let state = dealCards(createGame(), () => 0.37);
  for (let turn = 0; turn < 4; turn += 1) {
    const selected = choose(state);
    assert.equal(getCardViews(selected, selected.dealer).filter(view => view.faceUp).length, 1);
    state = dealCards(selected, () => 0.61);
    assert.equal(state.dealer, selected.dealer === 'host' ? 'guest' : 'host');
    assert.equal(getCardViews(state, state.dealer).every(view => !view.faceUp), true);
    const chooser = state.dealer === 'host' ? 'guest' : 'host';
    assert.equal(getCardViews(state, chooser).every(view => view.faceUp), true);
  }
});

test('card views neither mutate shared state nor expose mutable state references', () => {
  const state = choose(dealCards(createGame(), () => 0.37));
  const before = structuredClone(state);
  Object.freeze(state.cards);
  Object.freeze(state);
  for (const role of ['host', 'guest']) {
    const views = getCardViews(state, role);
    views[0].position = 100;
    const visible = views.find(view => view.faceUp);
    visible.id = 'JOKER';
    views.pop();
  }
  assert.deepEqual(state, before);
});

test('invalid states and viewer identities are rejected', () => {
  const state = dealCards(createGame());
  for (const invalid of [null, [], {}, { ...state, dealer: 'spectator' }, { ...state, cards: Array(10).fill('AS') }]) {
    assert.throws(() => getCardViews(invalid, 'host'), TypeError);
  }
  for (const role of [undefined, null, '', 'dealer', 'chooser', 'practice', 0, {}]) {
    assert.throws(() => getCardViews(state, role), TypeError);
  }
});
