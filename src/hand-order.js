import { describeCard } from './game.js';

const HAND_ORDER_SUITS = ['S', 'H', 'D', 'C'];
const HAND_ORDER_HIGH_RANKS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
const HAND_ORDER_LOW_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function handOrderCard(id, label) {
  try { return describeCard(id); }
  catch { throw new TypeError(`${label} must contain valid card IDs.`); }
}

function checkedHandOrder(order) {
  if (!Array.isArray(order)) throw new TypeError('Hand order must be an array.');
  const seen = new Set();
  for (const id of order) {
    handOrderCard(id, 'Hand order');
    if (seen.has(id)) throw new TypeError('Hand order must not contain duplicate cards.');
    seen.add(id);
  }
  return [...order];
}

/**
 * Keep the local relative order of cards still held, then append new cards.
 * Previous stale/duplicate entries are ignored; current IDs are validated and
 * deduplicated. Both arguments must be arrays. Reset previousOrder to [] at the
 * start of a new game so any coincidentally repeated cards get a fresh order.
 */
export function reconcileHandOrder(previousOrder, currentCardIds) {
  if (!Array.isArray(previousOrder) || !Array.isArray(currentCardIds)) {
    throw new TypeError('Previous order and current cards must be arrays.');
  }
  const current = new Set();
  for (const id of currentCardIds) {
    handOrderCard(id, 'Current cards');
    current.add(id);
  }
  const result = [];
  const included = new Set();
  for (const id of [...previousOrder, ...currentCardIds]) {
    if (current.has(id) && !included.has(id)) {
      result.push(id);
      included.add(id);
    }
  }
  return result;
}

/**
 * Move a card to its final zero-based index, after removal from its old place.
 * Integer targets are clamped to the hand's bounds. A valid card not held is a
 * no-op returning a new array. Invalid IDs, duplicates, and noninteger targets
 * throw TypeError. Neither the input order nor shared game state is modified.
 */
export function moveHandCard(order, cardId, targetIndex) {
  const next = checkedHandOrder(order);
  handOrderCard(cardId, 'The moved card');
  if (!Number.isSafeInteger(targetIndex)) throw new TypeError('Target index must be an integer.');
  const oldIndex = next.indexOf(cardId);
  if (oldIndex === -1) return next;
  next.splice(oldIndex, 1);
  const finalIndex = Math.max(0, Math.min(targetIndex, next.length));
  next.splice(finalIndex, 0, cardId);
  return next;
}

/** Sort a new local order by suit/rank using the contract's High or Low order. */
export function sortHandOrder(order, sortBy = 'suit', bidMode = 'high') {
  const next = checkedHandOrder(order);
  if (sortBy !== 'suit' && sortBy !== 'rank') throw new TypeError('Sort by suit or rank.');
  if (bidMode !== 'high' && bidMode !== 'low') throw new TypeError('Bid mode must be high or low.');
  const ranks = bidMode === 'low' ? HAND_ORDER_LOW_RANKS : HAND_ORDER_HIGH_RANKS;
  const cards = next.map(id => ({ id, ...describeCard(id) }));
  cards.sort((a, b) => {
    const suitDifference = HAND_ORDER_SUITS.indexOf(a.suit) - HAND_ORDER_SUITS.indexOf(b.suit);
    const rankDifference = ranks.indexOf(a.rank) - ranks.indexOf(b.rank);
    return sortBy === 'suit' ? suitDifference || rankDifference : rankDifference || suitDifference;
  });
  return cards.map(card => card.id);
}
