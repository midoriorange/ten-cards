import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeck, describeCard, createGame, applyAction, isValidState,
  otherPlayer, bidLabel, getActivePlayer, getLegalActions,
} from '../src/game.js';

const ROLES = ['host', 'guest'];
const SUITS = ['S', 'H', 'D', 'C'];
const ENDED = new Set(['game_over', 'match_over']);

function seeded(seed = 1) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}
function cardArrays(state) {
  return [state.hands.host, state.hands.guest, ...state.table.host, ...state.table.guest,
    state.kitty, state.discards];
}
function allCards(state) {
  return [...cardArrays(state).flat(),
    ...state.history.flatMap(pack => pack.plays.map(play => play.cardId)),
    ...(state.currentPack?.plays ?? []).map(play => play.cardId)];
}
function conserved(state) {
  const cards = allCards(state);
  assert.equal(cards.length, state.phase === 'lobby' ? 0 : 52, 'all cards must be accounted for');
  assert.equal(new Set(cards).size, cards.length, 'no card may occur in two places');
  assert.equal(cards.every(id => createDeck().includes(id)), true);
}
function act(state, role, action, random = seeded(1)) {
  const before = structuredClone(state);
  const next = applyAction(state, role, action, random);
  assert.notEqual(next, state, `Expected accepted ${role} ${JSON.stringify(action)} in ${state.phase}`);
  assert.deepEqual(state, before, 'an accepted action must not mutate its input');
  assert.equal(next.revision, state.revision + 1);
  assert.equal(isValidState(next), true, `Invalid state after ${JSON.stringify(action)}`);
  conserved(next);
  return next;
}
function reject(state, role, action) {
  const before = structuredClone(state);
  assert.equal(applyAction(state, role, action, seeded(2)), state,
    `Expected rejection of ${role} ${JSON.stringify(action)} in ${state.phase}`);
  assert.deepEqual(state, before);
}
function deal(state = createGame(), random = seeded(1)) {
  return act(state, getActivePlayer(state), { type: 'deal' }, random);
}
function auction(state, bidder = 'guest', number = 3, mode = 'high') {
  const opener = otherPlayer(state.dealer);
  if (bidder === opener) {
    state = act(state, opener, { type: 'bid', number, mode });
    state = act(state, state.dealer, { type: 'pass' });
  } else {
    state = act(state, opener, { type: 'pass' });
    state = act(state, state.dealer, { type: 'bid', number, mode });
  }
  return state;
}
function ready(state = createGame(), options = {}) {
  const { bidder = 'guest', number = 3, mode = 'high', trump = 'S', seed = 1 } = options;
  state = auction(deal(state, seeded(seed)), bidder, number, mode);
  if (state.phase === 'trump_before') state = act(state, bidder, { type: 'trump', suit: trump });
  state = act(state, bidder, { type: 'discard', cards: [...state.kitty] });
  if (state.phase === 'trump_after') state = act(state, bidder, { type: 'trump', suit: trump });
  assert.equal(state.phase, 'play');
  return state;
}
// A genuine shuffled deck can yield any of these arrangements. Swap locations
// before the first play so every fixture still contains exactly the same 52 cards.
function placeCards(state, placements) {
  state = structuredClone(state);
  for (const [path, index, id] of placements) {
    let target = state;
    for (const key of path) target = target[key];
    const source = cardArrays(state).find(cards => cards.includes(id));
    assert(source, `Missing fixture card ${id}`);
    const from = source.indexOf(id);
    [target[index], source[from]] = [source[from], target[index]];
  }
  assert.equal(isValidState(state), true, 'a pre-play card arrangement must remain valid');
  conserved(state);
  return state;
}
function suitCards(suit) { return createDeck().filter(card => card.endsWith(suit)); }
function withDistribution(state, { hostHand, guestHand, hostTable, guestTable }) {
  state = structuredClone(state);
  state.hands = { host: [...hostHand], guest: [...guestHand] };
  state.table = {
    host: [hostTable.slice(0, 4), hostTable.slice(4, 8), hostTable.slice(8, 12)],
    guest: [guestTable.slice(0, 4), guestTable.slice(4, 8), guestTable.slice(8, 12)],
  };
  const used = new Set([...hostHand, ...guestHand, ...hostTable, ...guestTable]);
  assert.equal(used.size, 48);
  state.discards = createDeck().filter(id => !used.has(id));
  assert.equal(isValidState(state), true);
  conserved(state);
  return state;
}
function scoringBoard(state, kind) {
  const S = suitCards('S'), H = suitCards('H'), D = suitCards('D'), C = suitCards('C');
  const bidder = state.contract.bidder;
  let bidderHand, defenderHand;
  if (kind === 'bolo') {
    bidderHand = S.slice(0, 12);
    defenderHand = D.slice(0, 12);
  } else if (kind === 'side') {
    bidderHand = S.filter(id => id !== 'AS');
    defenderHand = ['AS', ...D.slice(0, 11)];
  } else if (kind === 'reverse') {
    bidderHand = D.slice(0, 12);
    defenderHand = S.slice(0, 12);
  } else if (kind === 'ordinaryBidder') {
    bidderHand = [...S.filter(id => id !== 'AS' && id !== 'KS'), 'AD'];
    defenderHand = ['AS', 'KS', ...D.filter(id => id !== 'AD').slice(0, 10)];
  } else {
    bidderHand = ['AS', ...D.slice(0, 11)];
    defenderHand = S.filter(id => id !== 'AS');
  }
  return withDistribution(state, {
    hostHand: bidder === 'host' ? bidderHand : defenderHand,
    guestHand: bidder === 'guest' ? bidderHand : defenderHand,
    hostTable: bidder === 'host' ? H.slice(0, 12) : C.slice(0, 12),
    guestTable: bidder === 'guest' ? H.slice(0, 12) : C.slice(0, 12),
  });
}
function nextPlay(state, random = () => 0) {
  const role = getActivePlayer(state);
  const legal = getLegalActions(state, role);
  if (legal.canContinue) return act(state, role, { type: 'continue' }, random);
  if (legal.handCards.length) {
    return act(state, role, { type: 'playHand', cardId: legal.handCards[Math.floor(random() * legal.handCards.length)] }, random);
  }
  if (legal.tableStacks.length) {
    return act(state, role, { type: 'playTable', stackIndex: legal.tableStacks[Math.floor(random() * legal.tableStacks.length)] }, random);
  }
  assert.fail(`No legal play in phase ${state.phase}`);
}
function finishGame(state, random = () => 0) {
  let count = 0;
  while (!ENDED.has(state.phase)) {
    assert(++count < 100, 'game must finish after at most 12 four-card packs');
    state = nextPlay(state, random);
  }
  return state;
}
function playPack(state, cards) {
  for (let index = 0; index < 4; index++) {
    const role = getActivePlayer(state);
    state = act(state, role, index < 2
      ? { type: 'playHand', cardId: cards[index] }
      : { type: 'playTable', stackIndex: cards[index] });
  }
  return state;
}

// Basic rules and state integrity.
test('standard deck has 52 unique, described cards and no jokers', () => {
  const deck = createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
  for (const suit of SUITS) assert.equal(deck.filter(id => id.endsWith(suit)).length, 13);
  assert.deepEqual(describeCard('AS'), { id: 'AS', rank: 'A', suit: 'S', symbol: '♠', color: 'black', name: 'Ace of spades' });
  assert.equal(describeCard('10H').rank, '10');
  assert.equal(describeCard('QD').color, 'red');
  assert.equal(otherPlayer('host'), 'guest');
  assert.equal(otherPlayer('guest'), 'host');
  assert.match(bidLabel({ number: 3, mode: 'high' }).toLowerCase(), /3.*high/);
  assert.match(bidLabel({ number: 8, mode: 'low' }).toLowerCase(), /8.*low/);
  deck.pop();
  assert.equal(createDeck().length, 52);
});

test('lobby is empty and only the original host may make the first deal', () => {
  const state = createGame();
  assert.equal(state.schema, 3);
  assert.equal(state.phase, 'lobby');
  assert.equal(state.gameNumber, 0);
  assert.equal(state.dealer, 'host');
  assert.deepEqual(state.scores, { host: 0, guest: 0 });
  assert.equal(isValidState(state), true);
  assert.equal(getActivePlayer(state), 'host');
  assert.equal(getLegalActions(state, 'host').canDeal, true);
  assert.equal(getLegalActions(state, 'guest').canDeal, false);
  conserved(state);
  reject(state, 'guest', { type: 'deal' });
  reject(state, 'observer', { type: 'deal' });
  reject(state, 'host', { type: 'newMatch' });
});

test('deal gives each person 12 hand cards, three stacks of four, and a four-card kitty', () => {
  const state = deal();
  assert.equal(state.phase, 'auction');
  assert.equal(state.gameNumber, 1);
  assert.equal(state.dealer, 'host');
  assert.equal(state.auction.turn, 'guest');
  for (const role of ROLES) {
    assert.equal(state.hands[role].length, 12);
    assert.deepEqual(state.table[role].map(stack => stack.length), [4, 4, 4]);
  }
  assert.equal(state.kitty.length, 4);
  assert.deepEqual(state.discards, []);
  conserved(state);
  reject(state, 'host', { type: 'deal' });
  reject(state, 'guest', { type: 'deal' });
  assert.deepEqual(deal(createGame(), seeded(99)), deal(createGame(), seeded(99)), 'seeded shuffles are reproducible');
});

test('dealing takes the table stacks first, then the kitty, then the two remaining hands', () => {
  // This random value leaves each Fisher–Yates position in place.
  const state = deal(createGame(), () => 0.999999);
  const deck = createDeck();
  assert.deepEqual(state.table.guest, [deck.slice(0, 4), deck.slice(8, 12), deck.slice(16, 20)]);
  assert.deepEqual(state.table.host, [deck.slice(4, 8), deck.slice(12, 16), deck.slice(20, 24)]);
  assert.deepEqual(state.kitty, deck.slice(24, 28));
  assert.deepEqual(state.hands.guest, deck.slice(28, 40));
  assert.deepEqual(state.hands.host, deck.slice(40, 52));
  conserved(state);
});

test('auction ranks high before low at each number and permits only one response', () => {
  let state = deal();
  assert.deepEqual(getLegalActions(state, 'guest').bids,
    Array.from({ length: 6 }, (_, i) => [{ number: i + 3, mode: 'high' }, { number: i + 3, mode: 'low' }]).flat());
  reject(state, 'host', { type: 'bid', number: 3, mode: 'high' });
  reject(state, 'guest', { type: 'bid', number: 2, mode: 'high' });
  reject(state, 'guest', { type: 'bid', number: 9, mode: 'low' });
  reject(state, 'guest', { type: 'bid', number: 3.5, mode: 'high' });
  reject(state, 'guest', { type: 'bid', number: 3, mode: 'sideways' });
  state = act(state, 'guest', { type: 'bid', number: 4, mode: 'high' });
  const replies = getLegalActions(state, 'host');
  assert.equal(replies.canPass, true);
  assert.deepEqual(replies.bids[0], { number: 4, mode: 'low' });
  reject(state, 'host', { type: 'bid', number: 4, mode: 'high' });
  reject(state, 'host', { type: 'bid', number: 3, mode: 'low' });
  state = act(state, 'host', { type: 'bid', number: 4, mode: 'low' });
  assert.equal(state.phase, 'trump_before');
  assert.equal(state.contract.bidder, 'host');
  assert.equal(state.contract.defender, 'guest');
  assert.equal(state.contract.number, 4);
  assert.equal(state.contract.mode, 'low');
  assert.equal(state.contract.target, 4);
  assert.equal(state.auction.entries.length, 2);
  reject(state, 'guest', { type: 'bid', number: 5, mode: 'high' });
});

test('an opening pass forces the dealer to bid, and 8-low is the highest bid', () => {
  let state = act(deal(), 'guest', { type: 'pass' });
  assert.equal(getLegalActions(state, 'host').canPass, false);
  reject(state, 'host', { type: 'pass' });
  state = act(state, 'host', { type: 'bid', number: 8, mode: 'low' });
  assert.equal(state.contract.target, 1);
  assert.equal(state.phase, 'trump_before');
  let top = act(deal(), 'guest', { type: 'bid', number: 8, mode: 'low' });
  assert.deepEqual(getLegalActions(top, 'host').bids, []);
  assert.equal(getLegalActions(top, 'host').canBid, false);
  top = act(top, 'host', { type: 'pass' });
  assert.equal(top.contract.bidder, 'guest');
  assert.equal(top.phase, 'kitty');
});

test('dealer auction winner must call trump before the kitty, then discard exactly four', () => {
  let state = auction(deal(), 'host');
  assert.equal(state.phase, 'trump_before');
  assert.equal(getLegalActions(state, 'host').canCallTrump, true);
  assert.equal(getLegalActions(state, 'host').canDiscard, false);
  reject(state, 'host', { type: 'discard', cards: [...state.kitty] });
  reject(state, 'guest', { type: 'trump', suit: 'S' });
  reject(state, 'host', { type: 'trump', suit: 'X' });
  reject(state, 'host', { type: 'trump', suit: { toString: 7 } });
  state = act(state, 'host', { type: 'trump', suit: 'D' });
  assert.equal(state.phase, 'kitty');
  assert.equal(state.trump, 'D');
  reject(state, 'host', { type: 'discard', cards: state.kitty.slice(0, 3) });
  reject(state, 'host', { type: 'discard', cards: Array(4).fill(state.kitty[0]) });
  const sparseDiscard = [...state.kitty];
  delete sparseDiscard[0];
  reject(state, 'host', { type: 'discard', cards: sparseDiscard });
  reject(state, 'host', { type: 'discard', cards: [state.table.host[0][0], ...state.kitty.slice(0, 3)] });
  const originalTable = structuredClone(state.table);
  const discard = [...state.hands.host.slice(0, 2), ...state.kitty.slice(0, 2)];
  state = act(state, 'host', { type: 'discard', cards: discard });
  assert.equal(state.phase, 'play');
  assert.deepEqual(state.discards, discard);
  assert.equal(state.hands.host.length, 12);
  assert.equal(state.kitty.length, 0);
  assert.deepEqual(state.table, originalTable);
  assert.equal(state.currentPack.leader, 'host');
});

test('nondealer winner takes and discards the kitty before calling trump', () => {
  let state = auction(deal(), 'guest');
  assert.equal(state.phase, 'kitty');
  assert.equal(state.trump, null);
  reject(state, 'guest', { type: 'trump', suit: 'H' });
  reject(state, 'host', { type: 'discard', cards: [...state.kitty] });
  state = act(state, 'guest', { type: 'discard', cards: [...state.kitty] });
  assert.equal(state.phase, 'trump_after');
  assert.equal(getActivePlayer(state), 'guest');
  assert.equal(getLegalActions(state, 'guest').canCallTrump, true);
  state = act(state, 'guest', { type: 'trump', suit: 'H' });
  assert.equal(state.phase, 'play');
  assert.equal(state.currentPack.leader, 'guest');
  assert.equal(state.currentPack.number, 1);
  assert.equal(state.currentPack.ledSuit, null);
});

test('pack order is leader hand, follower hand, leader table, follower table; each pool follows original suit', () => {
  let state = placeCards(ready(), [
    [['hands', 'guest'], 0, '7H'], [['hands', 'host'], 0, 'AH'], [['hands', 'host'], 1, '2C'],
    [['table', 'guest', 0], 0, '2H'], [['table', 'guest', 1], 0, 'AS'], [['table', 'guest', 2], 0, 'KD'],
    [['table', 'host', 0], 0, '3H'], [['table', 'host', 1], 0, 'QS'], [['table', 'host', 2], 0, 'JC'],
  ]);
  reject(state, 'host', { type: 'playHand', cardId: state.hands.host[0] });
  reject(state, 'guest', { type: 'playTable', stackIndex: 0 });
  state = act(state, 'guest', { type: 'playHand', cardId: '7H' });
  assert.equal(state.currentPack.ledSuit, 'H');
  assert.equal(getActivePlayer(state), 'host');
  assert.equal(getLegalActions(state, 'host').handCards.every(id => id.endsWith('H')), true);
  reject(state, 'host', { type: 'playHand', cardId: '2C' });
  reject(state, 'host', { type: 'playTable', stackIndex: 0 });
  state = act(state, 'host', { type: 'playHand', cardId: 'AH' });
  assert.deepEqual(getLegalActions(state, 'guest').tableStacks, [0]);
  reject(state, 'guest', { type: 'playHand', cardId: state.hands.guest[0] });
  reject(state, 'guest', { type: 'playTable', stackIndex: 1 });
  state = act(state, 'guest', { type: 'playTable', stackIndex: 0 });
  assert.deepEqual(getLegalActions(state, 'host').tableStacks, [0]);
  state = act(state, 'host', { type: 'playTable', stackIndex: 0 });
  assert.equal(state.phase, 'pack_complete');
  assert.equal(state.currentPack, null);
  assert.equal(state.history[0].winner, 'host');
  assert.deepEqual(state.history[0].plays.map(play => [play.role, play.source]), [
    ['guest', 'hand'], ['host', 'hand'], ['guest', 'table'], ['host', 'table'],
  ]);
  assert.equal(state.table.guest[0].length, 3);
  assert.equal(state.table.host[0].length, 3);
  assert.equal(getLegalActions(state, 'guest').canContinue, false);
  reject(state, 'guest', { type: 'continue' });
  state = act(state, 'host', { type: 'continue' });
  assert.equal(state.currentPack.number, 2);
  assert.equal(state.currentPack.leader, 'host');
  assert.equal(state.currentPack.ledSuit, null);
});

test('a completed pack stays visible until its winner directly leads the next hand card', () => {
  let state = placeCards(ready(), [
    [['hands', 'guest'], 0, '7H'], [['hands', 'host'], 0, 'AH'], [['hands', 'host'], 1, '2C'],
    [['table', 'guest', 0], 0, '2H'], [['table', 'host', 0], 0, '3H'],
  ]);
  state = playPack(state, ['7H', 'AH', 0, 0]);
  assert.equal(state.phase, 'pack_complete');
  assert.equal(state.history[0].winner, 'host');
  assert.equal(state.history[0].ledSuit, 'H');
  assert.equal(state.currentPack, null);
  const completed = structuredClone(state);
  const winnerLegal = getLegalActions(state, 'host');
  assert.deepEqual(winnerLegal.handCards, state.hands.host, 'a fresh lead can use any own hand card');
  assert.deepEqual(getLegalActions(state, 'guest').handCards, []);
  winnerLegal.handCards.pop();
  assert.deepEqual(state, completed, 'reading or changing legal-action arrays does not alter the completed pack');
  reject(state, 'guest', { type: 'playHand', cardId: state.hands.guest[0] });
  reject(state, 'host', { type: 'playHand', cardId: state.hands.guest[0] });
  reject(state, 'host', { type: 'playTable', stackIndex: 0 });

  const next = act(state, 'host', { type: 'playHand', cardId: '2C' });
  assert.equal(next.revision, completed.revision + 1, 'starting and leading is one atomic action');
  assert.equal(next.phase, 'play');
  assert.equal(next.currentPack.number, 2);
  assert.equal(next.currentPack.leader, 'host');
  assert.equal(next.currentPack.ledSuit, 'C', 'the old pack suit does not constrain the fresh lead');
  assert.deepEqual(next.currentPack.plays, [{ role: 'host', source: 'hand', cardId: '2C', stackIndex: null }]);
  assert.deepEqual(next.history, completed.history, 'all four cards of the completed pack remain in history');
  assert.equal(next.hands.host.includes('2C'), false);
  assert.equal(next.hands.host.length, completed.hands.host.length - 1);
  assert.equal(getActivePlayer(next), 'guest');
  conserved(next);
});

test('all twelve packs can be completed by direct hand leads without continue actions', () => {
  let state = scoringBoard(ready(), 'bolo');
  let leadsFromCompletedPack = 0;
  while (!ENDED.has(state.phase)) {
    const role = getActivePlayer(state);
    const legal = getLegalActions(state, role);
    if (state.phase === 'pack_complete') leadsFromCompletedPack += 1;
    const action = legal.handCards.length
      ? { type: 'playHand', cardId: legal.handCards[0] }
      : { type: 'playTable', stackIndex: legal.tableStacks[0] };
    state = act(state, role, action);
  }
  assert.equal(leadsFromCompletedPack, 11);
  assert.equal(state.history.length, 12);
  assert.equal(state.result.badge, 'BOLO');
  assert.equal(state.currentPack, null, 'an ended game does not automatically start another pack');
  for (const role of ROLES) assert.deepEqual(getLegalActions(state, role).handCards, []);
  reject(state, 'guest', { type: 'playHand', cardId: 'AS' });
  conserved(state);
});

test('hand following ignores table cards, and exposed-table following ignores buried cards', () => {
  let state = ready();
  const placements = suitCards('C').slice(0, 12).map((id, index) => [['hands', 'host'], index, id]);
  placements.push([['hands', 'guest'], 0, '7H'],
    [['table', 'guest', 0], 0, 'AS'], [['table', 'guest', 1], 0, 'KD'], [['table', 'guest', 2], 0, 'JD'],
    [['table', 'guest', 0], 1, '2H'], [['table', 'host', 0], 0, 'AH']);
  state = placeCards(state, placements);
  state = act(state, 'guest', { type: 'playHand', cardId: '7H' });
  assert.equal(getLegalActions(state, 'host').handCards.length, 12, 'hearts on the table cannot force a heart from the hand');
  state = act(state, 'host', { type: 'playHand', cardId: state.hands.host[0] });
  assert.deepEqual(getLegalActions(state, 'guest').tableStacks, [0, 1, 2], 'a buried heart is unavailable');
  state = act(state, 'guest', { type: 'playTable', stackIndex: 1 });
  assert.equal(state.currentPack.plays[2].cardId, 'KD', 'void player may discard a nontrump even with trump available');
});

test('high and low rank order differ, with ace strongest in both modes', () => {
  for (const [mode, winner] of [['high', 'guest'], ['low', 'host']]) {
    let state = placeCards(ready(createGame(), { mode }), [
      [['hands', 'guest'], 0, 'KH'], [['hands', 'host'], 0, '2H'],
      [['table', 'guest', 0], 0, '3H'], [['table', 'host', 0], 0, 'QH'],
    ]);
    state = playPack(state, ['KH', '2H', 0, 0]);
    assert.equal(state.history[0].winner, winner, mode);
  }
  for (const mode of ['high', 'low']) {
    let state = placeCards(ready(createGame(), { mode }), [
      [['hands', 'guest'], 0, 'AH'], [['hands', 'host'], 0, '2H'],
      [['table', 'guest', 0], 0, '3H'], [['table', 'host', 0], 0, 'KH'],
    ]);
    state = playPack(state, ['AH', '2H', 0, 0]);
    assert.equal(state.history[0].winner, 'guest', `ace in ${mode}`);
  }
});

test('one table trump beats every nontrump, including an ace from the hand', () => {
  let state = placeCards(ready(), [
    [['hands', 'guest'], 0, 'AH'], [['hands', 'host'], 0, 'KH'],
    [['table', 'guest', 0], 0, '2H'],
    [['table', 'host', 0], 0, '3S'], [['table', 'host', 1], 0, '4D'], [['table', 'host', 2], 0, '5C'],
  ]);
  state = playPack(state, ['AH', 'KH', 0, 0]);
  assert.equal(state.history[0].winner, 'host');
  assert.equal(state.packs.host, 1);
});

test('BOLO awards two points after all twelve packs and preserves the full deal history', () => {
  let state = scoringBoard(ready(), 'bolo');
  state = finishGame(state);
  assert.deepEqual(state.packs, { host: 0, guest: 12 });
  assert.equal(state.result.winner, 'guest');
  assert.equal(state.result.points, 2);
  assert.equal(state.result.badge, 'BOLO');
  assert.equal(state.result.reason, 'exhausted');
  assert.equal(state.history.length, 12);
  assert.equal(state.scores.guest, 2);
  assert.equal(state.games.length, 1);
  assert.deepEqual(state.games[0].packs, state.packs);
  assert.equal(state.games[0].bidder, 'guest');
  assert.deepEqual(state.games[0].bid, { number: 3, mode: 'high' });
  assert.equal(state.currentPack, null);
});

test('SIDE BOLO awards one point when the defender takes exactly one pack', () => {
  const state = finishGame(scoringBoard(ready(), 'side'));
  assert.deepEqual(state.packs, { host: 1, guest: 11 });
  assert.equal(state.result.winner, 'guest');
  assert.equal(state.result.badge, 'SIDE BOLO');
  assert.equal(state.result.points, 1);
});

test('defender reaching target stops play immediately and reverse BOLO awards two points', () => {
  for (const [number, target] of [[3, 5], [7, 1], [8, 1]]) {
    const state = finishGame(scoringBoard(ready(createGame(), { number }), 'reverse'));
    assert.equal(state.contract.target, target);
    assert.deepEqual(state.packs, { host: target, guest: 0 });
    assert.equal(state.history.length, target);
    assert.equal(state.result.reason, 'target');
    assert.equal(state.result.winner, 'host');
    assert.equal(state.result.badge, 'REVERSE BOLO');
    assert.equal(state.result.points, 2);
    reject(state, 'host', { type: 'continue' });
    reject(state, 'guest', { type: 'playHand', cardId: state.hands.guest[0] });
  }
});

test('ordinary defender victory awards one point when the bidder has taken a pack', () => {
  const state = finishGame(scoringBoard(ready(), 'ordinary'));
  assert.deepEqual(state.packs, { host: 5, guest: 1 });
  assert.equal(state.result.winner, 'host');
  assert.equal(state.result.points, 1);
  assert.equal(state.result.badge, null);
  assert.equal(state.result.reason, 'target');
});

test('ordinary bidder victory awards one point with more than one defender pack', () => {
  const state = finishGame(scoringBoard(ready(), 'ordinaryBidder'));
  assert.deepEqual(state.packs, { host: 2, guest: 10 });
  assert.equal(state.result.winner, 'guest');
  assert.equal(state.result.points, 1);
  assert.equal(state.result.badge, null);
  assert.equal(state.result.reason, 'exhausted');
});

test('dealer alternates only between completed games and match ends at seven points', () => {
  let state = createGame();
  for (let game = 1; game <= 4; game++) {
    const expectedDealer = game % 2 ? 'host' : 'guest';
    state = ready(state, { bidder: 'guest', seed: game });
    assert.equal(state.dealer, expectedDealer);
    assert.equal(state.gameNumber, game);
    state = finishGame(scoringBoard(state, game === 1 ? 'side' : 'bolo'));
    assert.equal(state.dealer, expectedDealer, 'completion does not rewrite the recorded dealer');
    assert.equal(state.games.length, game);
    assert.equal(state.scores.guest, game === 1 ? 1 : (game - 1) * 2 + 1);
    if (game < 4) {
      assert.equal(state.phase, 'game_over');
      assert.equal(getLegalActions(state, otherPlayer(expectedDealer)).canDeal, true);
      assert.equal(getLegalActions(state, expectedDealer).canDeal, false);
      reject(state, expectedDealer, { type: 'deal' });
      reject(state, 'host', { type: 'newMatch' });
    }
  }
  assert.equal(state.phase, 'match_over');
  assert.equal(state.matchWinner, 'guest');
  assert.equal(state.scores.guest, 7);
  assert.equal(getLegalActions(state, 'host').canNewMatch, true);
  assert.equal(getLegalActions(state, 'guest').canNewMatch, false);
  reject(state, 'guest', { type: 'newMatch' });
  reject(state, 'host', { type: 'deal' });
  const revision = state.revision;
  state = act(state, 'host', { type: 'newMatch' });
  assert.deepEqual(state, { ...createGame(), revision: revision + 1 });
});

test('invalid action shapes, stale moves, and wrong-phase actions preserve the original reference', () => {
  let state = ready();
  for (const action of [null, undefined, [], 'deal', {}, { type: 'unknown' },
    { type: 'deal' }, { type: 'bid', number: 8, mode: 'low' }, { type: 'trump', suit: 'C' },
    { type: 'discard', cards: [] }, { type: 'continue' }, { type: 'newMatch' },
    { type: 'playHand', cardId: 'JOKER' }, { type: 'playTable', stackIndex: -1 },
    { type: 'playTable', stackIndex: 3 }, { type: 'playTable', stackIndex: 0.5 },
  ]) reject(state, 'guest', action);
  const oldAction = { type: 'playHand', cardId: state.hands.guest[0] };
  state = act(state, 'guest', oldAction);
  reject(state, 'guest', oldAction);
});

test('state validation rejects malformed structure, impossible counts, duplicate cards, and false winners', () => {
  const state = ready();
  const bad = [];
  const variant = change => { const value = structuredClone(state); change(value); bad.push(value); };
  bad.push(null, [], 'state', {});
  variant(s => { s.schema = 2; });
  variant(s => { s.phase = 'impossible'; });
  variant(s => { s.revision = 0.5; });
  variant(s => { s.revision = Infinity; });
  variant(s => { s.revision = Number.MAX_SAFE_INTEGER + 1; });
  variant(s => { s.dealer = 'observer'; });
  variant(s => { s.hands.host[0] = s.hands.guest[0]; });
  variant(s => { s.hands.host.push('JOKER'); });
  variant(s => { delete s.hands.host[0]; });
  variant(s => { s.table.host.push([]); });
  variant(s => { delete s.table.host[0]; });
  variant(s => { s.table.host[0].push(s.table.host[1].pop()); });
  variant(s => { s.contract.target += 1; });
  variant(s => { s.contract.defender = s.contract.bidder; });
  variant(s => { s.packs.host = 1; });
  variant(s => { s.currentPack.leader = 'observer'; });
  variant(s => { s.currentPack.plays = Array(100).fill({}); });
  variant(s => { s.scores.host = -1; });
  variant(s => { s.games = Array(100).fill({}); });
  for (const value of bad) {
    assert.equal(isValidState(value), false, JSON.stringify(value));
    assert.equal(applyAction(value, 'host', { type: 'deal' }), value);
  }
  let complete = scoringBoard(state, 'bolo');
  for (let i = 0; i < 4; i++) complete = nextPlay(complete);
  assert.equal(complete.phase, 'pack_complete');
  complete = structuredClone(complete);
  complete.history[0].winner = 'host';
  complete.packs = { host: 1, guest: 0 };
  assert.equal(isValidState(complete), false, 'changing counts cannot legitimize a false pack winner');
});

test('seeded full legal matches conserve all cards and finish with a seven-point winner', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const random = seeded(seed * 913);
    let state = createGame();
    let steps = 0;
    while (state.phase !== 'match_over') {
      assert(++steps < 1200, `match seed ${seed} should finish`);
      const role = getActivePlayer(state);
      const legal = getLegalActions(state, role);
      let action;
      if (legal.canDeal) action = { type: 'deal' };
      else if (legal.canPass && (!legal.bids.length || random() < 0.25)) action = { type: 'pass' };
      else if (legal.canBid) action = { type: 'bid', ...legal.bids[Math.floor(random() * legal.bids.length)] };
      else if (legal.canCallTrump) action = { type: 'trump', suit: SUITS[Math.floor(random() * 4)] };
      else if (legal.canDiscard) {
        const pool = [...state.hands[role], ...state.kitty];
        const cards = [];
        for (let i = 0; i < 4; i++) cards.push(...pool.splice(Math.floor(random() * pool.length), 1));
        action = { type: 'discard', cards };
      } else if (legal.handCards.length) action = { type: 'playHand', cardId: legal.handCards[Math.floor(random() * legal.handCards.length)] };
      else if (legal.tableStacks.length) action = { type: 'playTable', stackIndex: legal.tableStacks[Math.floor(random() * legal.tableStacks.length)] };
      else if (legal.canContinue) action = { type: 'continue' };
      else assert.fail(`No action in ${state.phase} for ${role}`);
      state = act(state, role, action, random);
    }
    assert.equal(state.scores[state.matchWinner] >= 7, true);
    assert.equal(state.scores[otherPlayer(state.matchWinner)] < 7, true);
    assert.equal(state.games.length, state.gameNumber);
    for (const game of state.games) assert.equal(game.dealer, game.gameNumber % 2 ? 'host' : 'guest');
  }
});
