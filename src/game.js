/** Pure game rules. This module has no knowledge of the page or network. */
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

export function createDeck() {
  return [...CARD_IDS];
}

export function describeCard(id) {
  if (!CARD_IDS.has(id)) throw new RangeError('Unknown card ID.');
  const rank = id.slice(0, -1);
  const suit = id.slice(-1);
  const details = SUITS[suit];
  return { id, rank, suit, symbol: details.symbol, color: details.color,
    name: `${RANK_NAMES[rank]} of ${details.name}` };
}

export function createGame() {
  return { round: 0, revision: 0, cards: [], selectedCard: null };
}

function secureRandom() {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / UINT32_RANGE;
}

function randomIndex(size, random) {
  if (random === secureRandom) {
    // Rejection sampling keeps every index equally likely, without modulo bias.
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

export function dealCards(state, random = secureRandom) {
  if (!isValidState(state)) throw new TypeError('Cannot deal from an invalid game state.');
  if (typeof random !== 'function') throw new TypeError('Random source must be a function.');
  const deck = createDeck();
  // Fisher–Yates: shuffle a fresh full deck before each ten-card deal.
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1, random);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return {
    round: state.round + 1,
    revision: state.revision + 1,
    cards: deck.slice(0, 10),
    selectedCard: null,
  };
}

export function selectCard(state, action) {
  if (!isValidState(state) || !action || typeof action !== 'object' || Array.isArray(action)
    || action.round !== state.round || state.round === 0 || state.selectedCard !== null
    || !state.cards.includes(action.cardId)) return state;
  return { ...state, revision: state.revision + 1, selectedCard: action.cardId };
}

export function isValidState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isSafeInteger(value.round) || value.round < 0
    || !Number.isSafeInteger(value.revision) || value.revision < value.round
    || !Array.isArray(value.cards)
    || (value.selectedCard !== null && typeof value.selectedCard !== 'string')) return false;
  if (value.round === 0) {
    return value.revision === 0 && value.cards.length === 0 && value.selectedCard === null;
  }
  return value.cards.length === 10
    && new Set(value.cards).size === 10
    && value.cards.every(card => CARD_IDS.has(card))
    && (value.selectedCard === null || value.cards.includes(value.selectedCard));
}
