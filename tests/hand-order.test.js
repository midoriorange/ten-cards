import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileHandOrder, moveHandCard, sortHandOrder } from '../src/hand-order.js';

test('reconciliation preserves relative local order and removes stale or duplicate entries', () => {
  const previous = Object.freeze(['9S', '3H', 'AS', 'AS', 'JOKER', null]);
  const current = Object.freeze(['AS', '2C', '3H', 'QD', '2C']);
  assert.deepEqual(reconcileHandOrder(previous, current), ['3H', 'AS', '2C', 'QD']);
  assert.deepEqual(previous, ['9S', '3H', 'AS', 'AS', 'JOKER', null]);
  assert.deepEqual(current, ['AS', '2C', '3H', 'QD', '2C']);
});

test('playing a card removes it without disturbing the remaining arranged hand', () => {
  const arranged = ['KH', '2C', 'AS', '3D'];
  assert.deepEqual(reconcileHandOrder(arranged, ['AS', 'KH', '3D']), ['KH', 'AS', '3D']);
  assert.deepEqual(reconcileHandOrder(arranged, []), []);
});

test('kitty cards kept in the hand append in current hand order', () => {
  const arranged = ['KH', 'AS', 'QD'];
  const afterKittyAndDiscards = ['AS', 'KH', '2C', '3H'];
  assert.deepEqual(reconcileHandOrder(arranged, afterKittyAndDiscards), ['KH', 'AS', '2C', '3H']);
});

test('resetting local order at a new game prevents old overlapping cards retaining priority', () => {
  const oldOrder = ['KS', 'AS', 'QD'];
  const newHand = ['2C', 'AS', 'KH'];
  assert.deepEqual(reconcileHandOrder(oldOrder, newHand), ['AS', '2C', 'KH']);
  assert.deepEqual(reconcileHandOrder([], newHand), newHand);
});

test('manual moves use final indices for left, right and across-row placement', () => {
  const hand = Object.freeze(['AS', 'KH', 'QD', 'JC', '10S', '9H', '8D', '7C', '6S', '5H', '4D', '3C']);
  assert.deepEqual(moveHandCard(hand, 'QD', 0), ['QD', 'AS', 'KH', 'JC', '10S', '9H', '8D', '7C', '6S', '5H', '4D', '3C']);
  assert.deepEqual(moveHandCard(hand, 'AS', 11), ['KH', 'QD', 'JC', '10S', '9H', '8D', '7C', '6S', '5H', '4D', '3C', 'AS']);
  const across = moveHandCard(hand, 'KH', 8);
  assert.equal(across[8], 'KH');
  assert.deepEqual(across, ['AS', 'QD', 'JC', '10S', '9H', '8D', '7C', '6S', 'KH', '5H', '4D', '3C']);
  assert.equal(hand[0], 'AS');
  assert.equal(hand[1], 'KH');
  assert.equal(hand[11], '3C');
});

test('manual targets clamp to the bounds and unknown valid cards return unchanged copies', () => {
  const hand = ['AS', 'KH', 'QD'];
  assert.deepEqual(moveHandCard(hand, 'KH', -100), ['KH', 'AS', 'QD']);
  assert.deepEqual(moveHandCard(hand, 'KH', 100), ['AS', 'QD', 'KH']);
  const unchanged = moveHandCard(hand, '2C', 1);
  assert.deepEqual(unchanged, hand);
  assert.notEqual(unchanged, hand);
  assert.deepEqual(moveHandCard([], 'AS', 0), []);
  assert.notEqual(moveHandCard(hand, 'AS', 0), hand);
});

test('High sorts ranks A K Q J 10 through 2 and Low sorts A 2 through K', () => {
  const hand = ['2S', 'KS', 'AS', 'QS', '10S', 'JS', '3S'];
  assert.deepEqual(sortHandOrder(hand, 'rank', 'high'), ['AS', 'KS', 'QS', 'JS', '10S', '3S', '2S']);
  assert.deepEqual(sortHandOrder(hand, 'rank', 'low'), ['AS', '2S', '3S', '10S', 'JS', 'QS', 'KS']);
  assert.deepEqual(sortHandOrder(hand, 'suit', 'high'), ['AS', 'KS', 'QS', 'JS', '10S', '3S', '2S']);
  assert.deepEqual(sortHandOrder(hand, 'suit', 'low'), ['AS', '2S', '3S', '10S', 'JS', 'QS', 'KS']);
});

test('suit sorting groups S H D C, and rank sorting uses that suit order to break ties', () => {
  const hand = ['2C', 'KH', 'AD', 'AS', '2H', 'KS', 'AC', 'AH', '2D', '2S'];
  assert.deepEqual(sortHandOrder(hand), ['AS', 'KS', '2S', 'AH', 'KH', '2H', 'AD', '2D', 'AC', '2C']);
  assert.deepEqual(sortHandOrder(hand, 'suit', 'low'), ['AS', '2S', 'KS', 'AH', '2H', 'KH', 'AD', '2D', 'AC', '2C']);
  assert.deepEqual(sortHandOrder(hand, 'rank', 'high'), ['AS', 'AH', 'AD', 'AC', 'KS', 'KH', '2S', '2H', '2D', '2C']);
  assert.deepEqual(sortHandOrder(hand, 'rank', 'low'), ['AS', 'AH', 'AD', 'AC', '2S', '2H', '2D', '2C', 'KS', 'KH']);
});

test('local arranging and sorting leave the original shared-hand array untouched', () => {
  const state = Object.freeze({ hands: Object.freeze({ host: Object.freeze(['2C', 'AS', 'KH']) }) });
  const before = structuredClone(state);
  const arranged = moveHandCard(state.hands.host, 'KH', 0);
  const sorted = sortHandOrder(state.hands.host);
  const reconciled = reconcileHandOrder(arranged, state.hands.host);
  assert.deepEqual(state, before);
  assert.notEqual(arranged, state.hands.host);
  assert.notEqual(sorted, state.hands.host);
  assert.notEqual(reconciled, arranged);
});

test('malformed inputs are rejected without accepting duplicate or invalid ordered cards', () => {
  for (const value of [null, undefined, 'AS', {}, ['JOKER'], ['AS', undefined]]) {
    assert.throws(() => reconcileHandOrder([], value), TypeError);
    assert.throws(() => moveHandCard(value, 'AS', 0), TypeError);
    assert.throws(() => sortHandOrder(value), TypeError);
  }
  assert.throws(() => reconcileHandOrder(null, ['AS']), TypeError);
  assert.throws(() => moveHandCard(['AS', 'AS'], 'AS', 0), TypeError);
  assert.throws(() => sortHandOrder(['AS', 'AS']), TypeError);
  for (const index of [undefined, null, '1', 1.5, NaN, Infinity]) {
    assert.throws(() => moveHandCard(['AS'], 'AS', index), TypeError);
  }
  assert.throws(() => moveHandCard(['AS'], 'JOKER', 0), TypeError);
  assert.throws(() => sortHandOrder(['AS'], 'color'), TypeError);
  assert.throws(() => sortHandOrder(['AS'], 'rank', 'middle'), TypeError);
});
