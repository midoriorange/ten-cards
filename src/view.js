import { isValidState, describeCard, getLegalActions, getActivePlayer, otherPlayer } from './game.js';

/**
 * The information drawn for one participant. Hidden card objects contain no
 * identities. This is UI presentation, not a network privacy boundary: the
 * original host still holds the authoritative full game state.
 */
export function getPlayerView(state, role) {
  if (!isValidState(state)) throw new TypeError('Cannot display an invalid game state.');
  if (role !== 'host' && role !== 'guest') throw new TypeError('The viewer must be the host or guest.');

  const opponent = otherPlayer(role);
  const revealAll = state.phase === 'game_over' || state.phase === 'match_over';
  const publicTables = ['play', 'pack_complete', 'game_over', 'match_over'].includes(state.phase);
  const clone = value => structuredClone(value);
  const faces = cards => cards.map(id => describeCard(id));
  const backs = cards => cards.map((_, index) => ({ hidden: true, position: index + 1 }));

  function projectPack(pack) {
    if (!pack) return null;
    const result = {
      number: pack.number,
      leader: pack.leader,
      ledSuit: pack.ledSuit,
      plays: pack.plays.map(play => ({
        role: play.role,
        source: play.source,
        card: describeCard(play.cardId),
        stackIndex: play.stackIndex,
      })),
    };
    if (Object.hasOwn(pack, 'winner')) result.winner = pack.winner;
    return result;
  }

  function projectTable(owner) {
    return state.table[owner].map((stack, index) => {
      // A played stack's replacement top stays covered until all four cards in
      // the pack have been played, even though the old top is already public.
      const playedThisPack = state.currentPack?.plays.some(play =>
        play.role === owner && play.source === 'table' && play.stackIndex === index);
      const showTop = revealAll || (publicTables && !playedThisPack);
      const card = showTop && stack.length ? describeCard(stack[0]) : null;
      const projected = { index, count: stack.length, card, hidden: stack.length > 0 && !showTop };
      if (revealAll) projected.cards = faces(stack);
      return projected;
    });
  }

  const canSeeKitty = revealAll || (state.phase === 'kitty' && state.contract?.bidder === role);
  return {
    role,
    opponent,
    phase: state.phase,
    gameNumber: state.gameNumber,
    dealer: state.dealer,
    scores: clone(state.scores),
    auction: clone(state.auction),
    contract: clone(state.contract),
    trump: state.trump,
    packs: clone(state.packs),
    history: clone(state.history),
    result: clone(state.result),
    matchWinner: state.matchWinner,
    games: clone(state.games),
    activePlayer: getActivePlayer(state),
    legal: clone(getLegalActions(state, role)),
    hand: faces(state.hands[role]),
    opponentHand: revealAll ? faces(state.hands[opponent]) : backs(state.hands[opponent]),
    ownTable: projectTable(role),
    opponentTable: projectTable(opponent),
    kitty: canSeeKitty ? faces(state.kitty) : backs(state.kitty),
    discards: revealAll ? faces(state.discards) : backs(state.discards),
    currentPack: projectPack(state.currentPack),
    lastPack: projectPack(state.history.at(-1)),
  };
}
