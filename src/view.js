import { isValidState, describeCard } from './game.js';

/**
 * Build the card information needed by one player's interface.
 * This controls presentation only; the shared game state still holds all cards.
 */
export function getCardViews(state, viewerRole) {
  if (!isValidState(state)) throw new TypeError('Cannot display an invalid game state.');
  if (viewerRole !== 'host' && viewerRole !== 'guest') {
    throw new TypeError('The viewer must be the host or guest.');
  }
  return state.cards.map((id, index) => {
    const selected = state.selectedCard === id;
    const position = index + 1;
    if (viewerRole === state.dealer && !selected) {
      return { position, faceUp: false, selected: false };
    }
    return { position, faceUp: true, selected, ...describeCard(id) };
  });
}
