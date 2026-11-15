/** Pure rules for a two-player, twelve-pack card game. No page or network code. */
const SUITS = Object.freeze({
  S: { symbol: '♠', color: 'black', name: 'spades' },
  H: { symbol: '♥', color: 'red', name: 'hearts' },
  D: { symbol: '♦', color: 'red', name: 'diamonds' },
  C: { symbol: '♣', color: 'black', name: 'clubs' },
});
const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
const RANK_NAMES = Object.freeze({
  A: 'Ace', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six',
  7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', J: 'Jack', Q: 'Queen', K: 'King',
});
const CARD_IDS = new Set(Object.keys(SUITS).flatMap(suit => RANKS.map(rank => rank + suit)));
const UINT32_RANGE = 0x100000000;
const GAME_PHASES = new Set(['lobby', 'auction', 'trump_before', 'kitty', 'trump_after',
  'play', 'pack_complete', 'game_over', 'match_over']);
const ALL_BIDS = Object.freeze(Array.from({ length: 6 }, (_, i) => [
  { number: i + 3, mode: 'high' }, { number: i + 3, mode: 'low' },
]).flat());

export function createDeck() { return [...CARD_IDS]; }

export function describeCard(id) {
  if (!CARD_IDS.has(id)) throw new RangeError('Unknown card ID.');
  const rank = id.slice(0, -1);
  const suit = id.slice(-1);
  const details = SUITS[suit];
  return { id, rank, suit, symbol: details.symbol, color: details.color,
    name: `${RANK_NAMES[rank]} of ${details.name}` };
}

export function otherPlayer(role) {
  return role === 'host' ? 'guest' : role === 'guest' ? 'host' : null;
}

export function bidLabel(bid) {
  return validBid(bid) ? `${bid.number} ${bid.mode === 'high' ? 'High' : 'Low'}` : '';
}

export function createGame() {
  return {
    schema: 3, revision: 0, phase: 'lobby', gameNumber: 0, dealer: 'host',
    scores: { host: 0, guest: 0 }, games: [],
    auction: { turn: null, entries: [] }, contract: null, trump: null,
    hands: { host: [], guest: [] }, table: { host: [[], [], []], guest: [[], [], []] },
    kitty: [], discards: [], currentPack: null, packs: { host: 0, guest: 0 },
    history: [], result: null, matchWinner: null,
  };
}

function isRole(value) { return value === 'host' || value === 'guest'; }
function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function isCount(value, maximum) { return Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function cardSuit(card) { return card.slice(-1); }
function validBid(bid) {
  return isObject(bid) && Number.isInteger(bid.number) && bid.number >= 3 && bid.number <= 8
    && (bid.mode === 'high' || bid.mode === 'low');
}
function bidOrder(bid) { return (bid.number - 3) * 2 + (bid.mode === 'low' ? 1 : 0); }
function defenderTarget(number) { return Math.max(1, 8 - number); }
function validCards(cards, maximum) {
  return Array.isArray(cards) && cards.length <= maximum && [...cards].every(card => CARD_IDS.has(card));
}
function secureRandom() {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / UINT32_RANGE;
}
function randomIndex(size, random) {
  if (random === secureRandom) {
    const limit = UINT32_RANGE - (UINT32_RANGE % size);
    const bytes = new Uint32Array(1);
    let value;
    do { value = globalThis.crypto.getRandomValues(bytes)[0]; } while (value >= limit);
    return value % size;
  }
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('Random source must return a number from 0 (inclusive) to 1 (exclusive).');
  }
  return Math.floor(value * size);
}
function shuffledDeck(random) {
  const deck = createDeck();
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1, random);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function activePlayer(state) {
  if (state.phase === 'lobby' || state.phase === 'match_over') return 'host';
  if (state.phase === 'game_over') return otherPlayer(state.dealer);
  if (state.phase === 'auction') return state.auction.turn;
  if (['trump_before', 'kitty', 'trump_after'].includes(state.phase)) return state.contract.bidder;
  if (state.phase === 'pack_complete') return state.history.at(-1).winner;
  if (state.phase === 'play') {
    return state.currentPack.plays.length % 2 === 0
      ? state.currentPack.leader : otherPlayer(state.currentPack.leader);
  }
  return null;
}
export function getActivePlayer(state) { return isValidState(state) ? activePlayer(state) : null; }

function legalPool(pool, ledSuit) {
  const suited = ledSuit ? pool.filter(card => cardSuit(card) === ledSuit) : [];
  return suited.length ? suited : pool;
}
function emptyActions() {
  return { canDeal: false, canBid: false, canPass: false, bids: [], canCallTrump: false,
    canDiscard: false, handCards: [], tableStacks: [], canContinue: false, canNewMatch: false };
}
export function getLegalActions(state, role) {
  const legal = emptyActions();
  if (!isRole(role) || !isValidState(state) || state.revision === Number.MAX_SAFE_INTEGER
    || role !== activePlayer(state)) return legal;
  if (state.phase === 'lobby' || state.phase === 'game_over') legal.canDeal = true;
  else if (state.phase === 'match_over') legal.canNewMatch = true;
  else if (state.phase === 'auction') {
    const previous = state.auction.entries.find(entry => entry.type === 'bid');
    legal.bids = ALL_BIDS.filter(bid => !previous || bidOrder(bid) > bidOrder(previous))
      .map(bid => ({ ...bid }));
    legal.canBid = legal.bids.length > 0;
    legal.canPass = state.auction.entries.length === 0 || Boolean(previous);
  } else if (state.phase === 'trump_before' || state.phase === 'trump_after') legal.canCallTrump = true;
  else if (state.phase === 'kitty') legal.canDiscard = true;
  else if (state.phase === 'pack_complete') legal.canContinue = true;
  else if (state.phase === 'play') {
    const pack = state.currentPack;
    if (pack.plays.length < 2) legal.handCards = [...legalPool(state.hands[role], pack.ledSuit)];
    else {
      const tops = state.table[role].map(stack => stack[0]).filter(Boolean);
      const permitted = new Set(legalPool(tops, pack.ledSuit));
      legal.tableStacks = state.table[role].flatMap((stack, index) => permitted.has(stack[0]) ? [index] : []);
    }
  }
  return legal;
}

function nextPack(state, leader) {
  state.currentPack = { number: state.history.length + 1, leader, ledSuit: null, plays: [] };
  state.phase = 'play';
}
function finishAuction(state) {
  const winning = [...state.auction.entries].reverse().find(entry => entry.type === 'bid');
  state.auction.turn = null;
  state.contract = { bidder: winning.role, defender: otherPlayer(winning.role),
    number: winning.number, mode: winning.mode, target: defenderTarget(winning.number) };
  state.phase = winning.role === state.dealer ? 'trump_before' : 'kitty';
}
function rankStrength(card, mode) {
  const index = RANKS.indexOf(card.slice(0, -1));
  return index === 0 ? 14 : mode === 'low' ? 14 - index : index + 1;
}
function packWinner(pack, trump, mode) {
  let strongest = null;
  let bestSuit = -1;
  let bestRank = -1;
  for (const play of pack.plays) {
    const suit = cardSuit(play.cardId);
    const suitStrength = suit === trump ? 2 : suit === pack.ledSuit ? 1 : 0;
    const rank = rankStrength(play.cardId, mode);
    if (suitStrength > bestSuit || (suitStrength === bestSuit && rank > bestRank)) {
      strongest = play.role; bestSuit = suitStrength; bestRank = rank;
    }
  }
  return strongest;
}
function calculateResult(contract, packs, reason) {
  const winner = reason === 'target' ? contract.defender : contract.bidder;
  const loser = otherPlayer(winner);
  let points = 1;
  let badge = null;
  if (winner === contract.bidder && packs[contract.defender] === 0) { points = 2; badge = 'BOLO'; }
  else if (winner === contract.bidder && packs[contract.defender] === 1) badge = 'SIDE BOLO';
  else if (winner === contract.defender && packs[contract.bidder] === 0) { points = 2; badge = 'REVERSE BOLO'; }
  return { winner, loser, points, badge, reason };
}
function finishGame(state, reason) {
  state.result = calculateResult(state.contract, state.packs, reason);
  state.scores[state.result.winner] += state.result.points;
  state.games.push({ gameNumber: state.gameNumber, dealer: state.dealer, ...state.result,
    packs: { ...state.packs }, bid: { number: state.contract.number, mode: state.contract.mode },
    bidder: state.contract.bidder });
  if (state.scores[state.result.winner] >= 7) {
    state.phase = 'match_over'; state.matchWinner = state.result.winner;
  } else state.phase = 'game_over';
}
function playCard(state, role, source, cardId, stackIndex) {
  const pack = state.currentPack;
  if (source === 'hand') state.hands[role].splice(state.hands[role].indexOf(cardId), 1);
  else state.table[role][stackIndex].shift();
  if (pack.plays.length === 0) pack.ledSuit = cardSuit(cardId);
  pack.plays.push({ role, source, cardId, stackIndex });
  if (pack.plays.length !== 4) return;
  const winner = packWinner(pack, state.trump, state.contract.mode);
  state.history.push({ ...pack, winner });
  state.packs[winner] += 1;
  state.currentPack = null;
  if (state.packs[state.contract.defender] >= state.contract.target) finishGame(state, 'target');
  else if (state.history.length === 12) finishGame(state, 'exhausted');
  else state.phase = 'pack_complete';
}

export function applyAction(state, role, action, random = secureRandom) {
  if (!isObject(action) || typeof action.type !== 'string') return state;
  const legal = getLegalActions(state, role);
  let next;
  if (action.type === 'deal' && legal.canDeal) {
    if (typeof random !== 'function') return state;
    let deck;
    try { deck = shuffledDeck(random); } catch { return state; }
    next = createGame();
    next.gameNumber = state.gameNumber + 1;
    next.dealer = role;
    next.scores = { ...state.scores };
    next.games = structuredClone(state.games);
    next.auction.turn = otherPlayer(role);
    next.phase = 'auction';
    const recipients = [otherPlayer(role), role];
    for (let stack = 0; stack < 3; stack += 1) {
      for (const recipient of recipients) next.table[recipient][stack] = deck.splice(0, 4);
    }
    next.kitty = deck.splice(0, 4);
    for (const recipient of recipients) next.hands[recipient] = deck.splice(0, 12);
  } else if (action.type === 'newMatch' && legal.canNewMatch) next = createGame();
  else if (action.type === 'bid' && legal.bids.some(bid => bid.number === action.number && bid.mode === action.mode)) {
    next = structuredClone(state);
    next.auction.entries.push({ role, type: 'bid', number: action.number, mode: action.mode });
    if (next.auction.entries.length === 1) next.auction.turn = state.dealer;
    else finishAuction(next);
  } else if (action.type === 'pass' && legal.canPass) {
    next = structuredClone(state);
    next.auction.entries.push({ role, type: 'pass' });
    if (next.auction.entries.length === 1) next.auction.turn = state.dealer;
    else finishAuction(next);
  } else if (action.type === 'trump' && legal.canCallTrump
    && typeof action.suit === 'string' && Object.hasOwn(SUITS, action.suit)) {
    next = structuredClone(state);
    next.trump = action.suit;
    if (state.phase === 'trump_before') next.phase = 'kitty';
    else nextPack(next, next.contract.bidder);
  } else if (action.type === 'discard' && legal.canDiscard && validCards(action.cards, 4)
    && action.cards.length === 4 && new Set(action.cards).size === 4
    && action.cards.every(card => [...state.hands[role], ...state.kitty].includes(card))) {
    next = structuredClone(state);
    const discarded = new Set(action.cards);
    next.hands[role] = [...state.hands[role], ...state.kitty].filter(card => !discarded.has(card));
    next.discards = [...action.cards]; next.kitty = [];
    if (state.trump) nextPack(next, next.contract.bidder);
    else next.phase = 'trump_after';
  } else if (action.type === 'playHand' && legal.handCards.includes(action.cardId)) {
    next = structuredClone(state);
    playCard(next, role, 'hand', action.cardId, null);
  } else if (action.type === 'playTable' && legal.tableStacks.includes(action.stackIndex)) {
    next = structuredClone(state);
    playCard(next, role, 'table', state.table[role][action.stackIndex][0], action.stackIndex);
  } else if (action.type === 'continue' && legal.canContinue) {
    next = structuredClone(state);
    nextPack(next, state.history.at(-1).winner);
  } else return state;
  next.revision = state.revision + 1;
  return next;
}

function validPacks(packs) {
  return isObject(packs) && isCount(packs.host, 12) && isCount(packs.guest, 12)
    && packs.host + packs.guest <= 12;
}
function validResult(result) {
  return isObject(result) && isRole(result.winner) && result.loser === otherPlayer(result.winner)
    && [1, 2].includes(result.points) && [null, 'BOLO', 'SIDE BOLO', 'REVERSE BOLO'].includes(result.badge)
    && ['target', 'exhausted'].includes(result.reason);
}
function sameResult(a, b) {
  return a.winner === b.winner && a.loser === b.loser && a.points === b.points
    && a.badge === b.badge && a.reason === b.reason;
}
function validPlay(play, leader, index) {
  return isObject(play) && play.role === (index % 2 === 0 ? leader : otherPlayer(leader))
    && play.source === (index < 2 ? 'hand' : 'table') && CARD_IDS.has(play.cardId)
    && (play.source === 'hand' ? play.stackIndex === null : isCount(play.stackIndex, 2));
}
function validPack(pack, number, leader, completed, trump, mode) {
  if (!isObject(pack) || pack.number !== number || pack.leader !== leader || !isRole(pack.leader)
    || !Array.isArray(pack.plays) || pack.plays.length > (completed ? 4 : 3)
    || (completed && pack.plays.length !== 4)
    || !pack.plays.every((play, index) => validPlay(play, leader, index))) return false;
  if (pack.ledSuit !== (pack.plays.length ? cardSuit(pack.plays[0].cardId) : null)) return false;
  return !completed || pack.winner === packWinner(pack, trump, mode);
}
function validAuction(state) {
  const { entries, turn } = state.auction;
  const opener = otherPlayer(state.dealer);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isObject(entry) || entry.role !== (index === 0 ? opener : state.dealer)) return false;
    if (entry.type === 'bid') {
      if (!validBid(entry)) return false;
      if (index === 1 && entries[0].type === 'bid' && bidOrder(entry) <= bidOrder(entries[0])) return false;
    } else if (entry.type !== 'pass' || (index === 1 && entries[0].type === 'pass')) return false;
  }
  if (state.phase === 'lobby') return entries.length === 0 && turn === null;
  if (state.phase === 'auction') return entries.length <= 1 && turn === (entries.length ? state.dealer : opener);
  if (entries.length !== 2 || turn !== null) return false;
  const winning = [...entries].reverse().find(entry => entry.type === 'bid');
  return winning && state.contract?.bidder === winning.role
    && state.contract.number === winning.number && state.contract.mode === winning.mode;
}
function checkGameRecord(record, index) {
  if (!isObject(record) || record.gameNumber !== index + 1
    || record.dealer !== (index % 2 === 0 ? 'host' : 'guest') || !validResult(record)
    || !validBid(record.bid) || !isRole(record.bidder) || !validPacks(record.packs)) return false;
  const contract = { bidder: record.bidder, defender: otherPlayer(record.bidder),
    number: record.bid.number, mode: record.bid.mode, target: defenderTarget(record.bid.number) };
  const total = record.packs.host + record.packs.guest;
  if (total < 1 || (record.reason === 'target'
    ? record.packs[contract.defender] !== contract.target
    : total !== 12 || record.packs[contract.defender] >= contract.target)) return false;
  return sameResult(record, calculateResult(contract, record.packs, record.reason));
}
function checkPlayedPools(state) {
  // Reconstruct each pool before each play. This validates following suit without
  // treating buried table cards, or the other pool, as available choices.
  const hands = { host: [...state.hands.host], guest: [...state.hands.guest] };
  const table = { host: state.table.host.map(stack => [...stack]),
    guest: state.table.guest.map(stack => [...stack]) };
  const packs = [...state.history, ...(state.currentPack ? [state.currentPack] : [])];
  for (let p = packs.length - 1; p >= 0; p -= 1) {
    const pack = packs[p];
    for (let i = pack.plays.length - 1; i >= 0; i -= 1) {
      const play = pack.plays[i];
      if (play.source === 'hand') hands[play.role].push(play.cardId);
      else table[play.role][play.stackIndex].unshift(play.cardId);
      const pool = play.source === 'hand' ? hands[play.role] : table[play.role].map(stack => stack[0]).filter(Boolean);
      if (cardSuit(play.cardId) !== pack.ledSuit && pool.some(card => cardSuit(card) === pack.ledSuit)) return false;
    }
  }
  return hands.host.length === 12 && hands.guest.length === 12
    && [...table.host, ...table.guest].every(stack => stack.length === 4);
}

export function isValidState(state) {
  if (!isObject(state) || state.schema !== 3 || !isCount(state.revision, Number.MAX_SAFE_INTEGER)
    || !GAME_PHASES.has(state.phase) || !isCount(state.gameNumber, 13) || !isRole(state.dealer)
    || !isObject(state.scores) || !isCount(state.scores.host, 8) || !isCount(state.scores.guest, 8)
    || !Array.isArray(state.games) || state.games.length > 13
    || !isObject(state.auction) || !Array.isArray(state.auction.entries) || state.auction.entries.length > 2
    || !isObject(state.hands) || !validCards(state.hands.host, 12) || !validCards(state.hands.guest, 12)
    || !isObject(state.table) || !['host', 'guest'].every(role => Array.isArray(state.table[role])
      && state.table[role].length === 3 && [...state.table[role]].every(stack => validCards(stack, 4)))
    || !validCards(state.kitty, 4) || !validCards(state.discards, 4) || !validPacks(state.packs)
    || !Array.isArray(state.history) || state.history.length > 12
    || (state.trump !== null && (typeof state.trump !== 'string' || !Object.hasOwn(SUITS, state.trump)))
    || (state.matchWinner !== null && !isRole(state.matchWinner))) return false;
  const ended = state.phase === 'game_over' || state.phase === 'match_over';
  if (state.games.length !== state.gameNumber - (state.phase === 'lobby' || ended ? 0 : 1)) return false;
  const score = { host: 0, guest: 0 };
  for (let i = 0; i < state.games.length; i += 1) {
    const game = state.games[i];
    if (!checkGameRecord(game, i) || score.host >= 7 || score.guest >= 7) return false;
    score[game.winner] += game.points;
  }
  if (score.host !== state.scores.host || score.guest !== state.scores.guest) return false;
  if (!validAuction(state)) return false;
  const cards = [...state.hands.host, ...state.hands.guest, ...state.table.host.flat(),
    ...state.table.guest.flat(), ...state.kitty, ...state.discards];
  if (state.phase === 'lobby') {
    return state.gameNumber === 0 && state.dealer === 'host' && cards.length === 0
      && state.contract === null && state.trump === null && state.currentPack === null
      && state.history.length === 0 && state.packs.host === 0 && state.packs.guest === 0
      && state.result === null && state.matchWinner === null;
  }
  if (state.gameNumber < 1 || state.dealer !== (state.gameNumber % 2 === 1 ? 'host' : 'guest')) return false;
  if (state.phase === 'auction') {
    if (state.contract !== null) return false;
  } else if (!isObject(state.contract) || !validBid(state.contract) || !isRole(state.contract.bidder)
    || state.contract.defender !== otherPlayer(state.contract.bidder)
    || state.contract.target !== defenderTarget(state.contract.number)) return false;
  const beforePlay = ['auction', 'trump_before', 'kitty', 'trump_after'].includes(state.phase);
  if (beforePlay) {
    if (state.currentPack !== null || state.history.length !== 0 || state.packs.host !== 0 || state.packs.guest !== 0
      || state.hands.host.length !== 12 || state.hands.guest.length !== 12
      || ![...state.table.host, ...state.table.guest].every(stack => stack.length === 4)) return false;
    const afterKitty = state.phase === 'trump_after';
    if (state.kitty.length !== (afterKitty ? 0 : 4) || state.discards.length !== (afterKitty ? 4 : 0)) return false;
    if (state.phase === 'auction' && state.trump !== null) return false;
    if (state.phase === 'trump_before' && (state.contract.bidder !== state.dealer || state.trump !== null)) return false;
    if (state.phase === 'trump_after' && (state.contract.bidder === state.dealer || state.trump !== null)) return false;
    if (state.phase === 'kitty' && ((state.contract.bidder === state.dealer) !== (state.trump !== null))) return false;
  } else {
    if (state.trump === null || state.kitty.length !== 0 || state.discards.length !== 4) return false;
    let leader = state.contract.bidder;
    const counted = { host: 0, guest: 0 };
    for (let i = 0; i < state.history.length; i += 1) {
      const pack = state.history[i];
      if (!validPack(pack, i + 1, leader, true, state.trump, state.contract.mode)) return false;
      counted[pack.winner] += 1;
      if (i < state.history.length - 1 && counted[state.contract.defender] >= state.contract.target) return false;
      cards.push(...pack.plays.map(play => play.cardId));
      leader = pack.winner;
    }
    if (counted.host !== state.packs.host || counted.guest !== state.packs.guest) return false;
    if (state.phase === 'play') {
      if (state.history.length >= 12 || !validPack(state.currentPack, state.history.length + 1,
        leader, false, state.trump, state.contract.mode)) return false;
      cards.push(...state.currentPack.plays.map(play => play.cardId));
    } else if (state.currentPack !== null || state.history.length === 0) return false;
    if (!ended && (state.history.length >= 12 || state.packs[state.contract.defender] >= state.contract.target)) return false;
    if (!checkPlayedPools(state)) return false;
  }
  if (cards.length !== 52 || new Set(cards).size !== 52) return false;
  if (!ended) return state.result === null && state.matchWinner === null && score.host < 7 && score.guest < 7;
  if (!validResult(state.result)) return false;
  const reason = state.packs[state.contract.defender] >= state.contract.target ? 'target'
    : state.history.length === 12 ? 'exhausted' : null;
  if (!reason || !sameResult(state.result, calculateResult(state.contract, state.packs, reason))) return false;
  const record = state.games.at(-1);
  if (record.dealer !== state.dealer || record.bidder !== state.contract.bidder
    || record.bid.number !== state.contract.number || record.bid.mode !== state.contract.mode
    || record.packs.host !== state.packs.host || record.packs.guest !== state.packs.guest
    || !sameResult(record, state.result)) return false;
  return state.phase === 'match_over'
    ? state.matchWinner === state.result.winner && score[state.matchWinner] >= 7
    : state.matchWinner === null && score.host < 7 && score.guest < 7;
}
