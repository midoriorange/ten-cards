import { createGame, applyAction, describeCard, otherPlayer, bidLabel, getActivePlayer } from './game.js';
import { getPlayerView } from './view.js';
import { createSession } from './session.js';
import { makeInviteLink, parseInviteLink } from './invite.js';
import { peerOptions, peerLibraryUrl } from './config.js';
import { APP_VERSION } from './version.js';

const $ = id => document.getElementById(id);
const localFile = location.protocol === 'file:';
const suitNames = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const suitSymbols = { S: '♠', H: '♥', D: '♦', C: '♣' };
let mode = 'idle';
let practiceRole = 'host';
let state = createGame();
let session = null;
let phase = 'idle';
let guestPresent = false;
let inviteLink = '';
let busy = false;
let pending = false;
let operation = 0;
let libraryPromise;
let pendingTimer;
let toastTimer;
let celebrationTimer;
let lastCelebration = '';
let selectedDiscards = new Set();
let lastBidOptions = '';

const playerName = role => role === 'host' ? 'Host' : 'Guest';
const viewerRole = () => mode === 'practice' ? practiceRole : mode === 'guest' ? 'guest' : 'host';
const gameReady = () => mode === 'practice' || phase === 'connected';
const endedGame = view => view.phase === 'game_over' || view.phase === 'match_over';

function announce(message) { $('connection-message').textContent = message; }
function showError(message) {
  $('error-message').textContent = message;
  $('error-panel').hidden = false;
  $('error-panel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function clearError() { $('error-panel').hidden = true; }
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}
function showCelebration(view) {
  if (!view.result?.badge) return;
  const key = `${view.gameNumber}:${view.result.badge}`;
  if (key === lastCelebration) return;
  lastCelebration = key;
  clearTimeout(celebrationTimer);
  $('celebration-text').textContent = view.result.badge;
  $('celebration').hidden = false;
  celebrationTimer = setTimeout(() => { $('celebration').hidden = true; }, 4500);
}

function loadPeer() {
  if (globalThis.Peer) return Promise.resolve(globalThis.Peer);
  if (libraryPromise) return libraryPromise;
  libraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(failed, 18000);
    function failed() {
      clearTimeout(timer); script.remove(); libraryPromise = null;
      reject(new Error('The connection library could not load. Check your connection or try local practice.'));
    }
    script.src = peerLibraryUrl;
    script.crossOrigin = 'anonymous';
    script.onload = () => { clearTimeout(timer); if (globalThis.Peer) resolve(globalThis.Peer); else failed(); };
    script.onerror = failed;
    document.head.append(script);
  });
  return libraryPromise;
}

function acceptState(next) {
  const changed = next.revision !== state.revision;
  state = next;
  pending = false;
  clearTimeout(pendingTimer);
  if (changed) selectedDiscards.clear();
  if (!next.result) { clearTimeout(celebrationTimer); $('celebration').hidden = true; }
  if (next.phase === 'lobby') lastCelebration = '';
  if (mode === 'practice') practiceRole = getActivePlayer(state) || practiceRole;
  render();
}

function act(action) {
  if (!gameReady() || pending) return false;
  clearError();
  if (mode === 'practice') {
    const next = applyAction(state, practiceRole, action);
    if (next === state) { showError('That action is not available on this turn.'); return false; }
    acceptState(next);
    return true;
  }
  const revision = state.revision;
  pending = true;
  render();
  const accepted = session?.act(action);
  if (!accepted) { pending = false; render(); return false; }
  if (!pending) return true;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pending = false; render();
    if (phase === 'connected' && state.revision === revision) announce('No confirmation yet. You can try that action again.');
  }, 5000);
  return true;
}

function chooseDiscard(cardId) {
  const view = getPlayerView(state, viewerRole());
  if (!gameReady() || pending || !view.legal.canDiscard) return;
  if (selectedDiscards.has(cardId)) selectedDiscards.delete(cardId);
  else if (selectedDiscards.size < 4) selectedDiscards.add(cardId);
  else { toast('Choose exactly four cards. Unselect one to change your choice.'); return; }
  render();
}

function cardNode(card, { enabled = false, selected = false, mini = false, onClick, label, stackIndex } = {}) {
  if (!card || card.hidden) {
    const node = document.createElement('div');
    node.className = card ? 'card-back' : 'empty-card';
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', label || (card ? `Face-down card ${card.position || ''}`.trim() : 'Empty card space'));
    if (!card) node.textContent = '—';
    return node;
  }
  const node = document.createElement('button');
  node.type = 'button';
  node.className = `playing-card ${card.color}${mini ? ' mini' : ''}${enabled ? ' legal' : ''}${selected ? ' selected' : ''}`;
  node.disabled = !enabled;
  node.dataset.card = card.id;
  if (stackIndex !== undefined) node.dataset.stack = String(stackIndex);
  node.setAttribute('aria-label', `${label ? label + ': ' : ''}${card.name}${selected ? ', selected for discard' : ''}`);
  node.setAttribute('aria-pressed', String(selected));
  for (const corner of ['top', 'bottom']) {
    const holder = document.createElement('span');
    holder.className = `corner ${corner}`;
    holder.setAttribute('aria-hidden', 'true');
    const rank = document.createElement('span'); rank.textContent = card.rank;
    const suit = document.createElement('span'); suit.className = 'suit'; suit.textContent = card.symbol;
    holder.append(rank, suit); node.append(holder);
  }
  const pip = document.createElement('span'); pip.className = 'pip'; pip.textContent = card.symbol; pip.setAttribute('aria-hidden', 'true'); node.append(pip);
  if (onClick && enabled) node.addEventListener('click', onClick);
  return node;
}

function drawTable(id, stacks, own, view) {
  const container = $(id);
  container.replaceChildren();
  for (const stack of stacks) {
    const outer = document.createElement('div'); outer.className = 'stack';
    const holder = document.createElement('div'); holder.className = 'stack-card';
    if (stack.cards?.length) {
      holder.classList.add('revealed-stack');
      for (const card of stack.cards) holder.append(cardNode(card, { mini: true }));
    } else {
      const enabled = own && gameReady() && !pending && view.legal.tableStacks.includes(stack.index);
      const content = stack.card || (stack.count ? { hidden: true } : null);
      holder.append(cardNode(content, {
        enabled, mini: true, stackIndex: enabled ? stack.index : undefined,
        label: `Stack ${stack.index + 1}${stack.hidden ? ', face down' : ''}`,
        onClick: () => act({ type: 'playTable', stackIndex: stack.index }),
      }));
    }
    const caption = document.createElement('span'); caption.className = 'stack-caption'; caption.textContent = `STACK ${stack.index + 1} · ${stack.count} LEFT`;
    outer.append(holder, caption); container.append(outer);
  }
}

function renderPack(view) {
  const pack = view.currentPack || (['pack_complete', 'game_over', 'match_over'].includes(view.phase) ? view.lastPack : null);
  const leader = pack?.leader || view.contract?.bidder || otherPlayer(view.dealer);
  const order = [leader, otherPlayer(leader), leader, otherPlayer(leader)];
  $('pack-label').textContent = pack ? `PACK ${String(pack.number).padStart(2, '0')} OF 12` : 'THE FIRST PACK AWAITS';
  $('pack-instruction').textContent = view.phase === 'pack_complete'
    ? `${playerName(view.lastPack.winner)} won this pack and leads next.`
    : endedGame(view) ? 'All remaining cards are now revealed.'
      : pack?.ledSuit ? `${suitSymbols[pack.ledSuit]} ${suitNames[pack.ledSuit]} led · ${view.contract.mode} wins · ${suitSymbols[view.trump]} trump`
        : view.phase === 'play' ? `${playerName(leader)} leads from their hand.` : 'The bid winner will lead.';
  const container = $('pack-cards'); container.replaceChildren();
  for (let i = 0; i < 4; i++) {
    const slot = document.createElement('div'); slot.className = 'pack-slot';
    const play = pack?.plays[i];
    slot.append(cardNode(play?.card || null, { mini: true, label: play ? `${playerName(play.role)} played` : `Play ${i + 1}` }));
    const label = document.createElement('small'); label.textContent = `${playerName(order[i])} · ${i < 2 ? 'hand' : 'table'}`;
    slot.append(label); container.append(slot);
  }
}

function renderHands(view) {
  const oldFocus = document.activeElement?.dataset.card;
  const own = $('own-hand'); own.replaceChildren();
  const discarding = view.legal.canDiscard && gameReady() && !pending;
  for (const card of view.hand) {
    const enabled = gameReady() && !pending && (discarding || view.legal.handCards.includes(card.id));
    own.append(cardNode(card, { enabled, selected: selectedDiscards.has(card.id),
      onClick: () => discarding ? chooseDiscard(card.id) : act({ type: 'playHand', cardId: card.id }) }));
  }
  $('hand-count').textContent = `${view.hand.length} CARDS`;
  $('hand-title').textContent = endedGame(view) ? 'Your remaining cards.' : view.legal.canDiscard ? 'Choose four to discard.' : 'Your private hand.';
  $('hand-eyebrow').textContent = endedGame(view) ? 'REVEALED AT GAME END' : mode === 'practice' ? `LOCAL PRACTICE · ${playerName(view.role).toUpperCase()}’S HAND` : 'VISIBLE ONLY TO YOU';
  $('hand-instruction').textContent = endedGame(view) ? 'Both players can now inspect the unplayed cards.' : view.legal.canDiscard
    ? 'Choose any four from your hand and the kitty below, then confirm.'
    : view.legal.handCards.length ? 'Highlighted cards are legal. Follow the led suit whenever you have it.' : 'Your hand stays private. Wait for your hand-play turn.';
  const opponent = $('opponent-hand'); opponent.replaceChildren();
  opponent.classList.toggle('revealed', endedGame(view));
  for (const card of view.opponentHand) opponent.append(cardNode(card, { mini: true, label: endedGame(view) ? undefined : 'Opponent’s private card' }));
  $('opponent-hand-count').textContent = `${view.opponentHand.length} ${endedGame(view) ? 'revealed' : 'private'} cards`;
  $('opponent-label').textContent = `${playerName(view.opponent).toUpperCase()}’S TABLE`;
  $('own-table-label').textContent = `${playerName(view.role).toUpperCase()}’S TABLE · YOU`;
  $('table-hint').textContent = endedGame(view) ? 'All remaining stack cards revealed' : ['play', 'pack_complete'].includes(view.phase) ? 'Only the exposed top cards can be played' : 'Face down until play begins';
  drawTable('own-table', view.ownTable, true, view);
  drawTable('opponent-table', view.opponentTable, false, view);
  $('kitty-panel').hidden = !view.kitty.length;
  const kitty = $('kitty-cards'); kitty.replaceChildren();
  const kittyVisible = view.kitty.some(card => !card.hidden);
  $('kitty-status').textContent = kittyVisible ? 'YOUR EXCHANGE' : 'FACE DOWN';
  $('kitty-instruction').textContent = kittyVisible ? 'You may keep any or all of these four. Discard exactly four cards in total.' : view.phase === 'trump_before' ? 'The dealer must call trump before looking.' : 'Only the bid winner can inspect the kitty.';
  for (const card of view.kitty) kitty.append(cardNode(card, { enabled: discarding && !card.hidden,
    selected: Boolean(card.id && selectedDiscards.has(card.id)), onClick: () => chooseDiscard(card.id), label: card.hidden ? 'Face-down kitty card' : undefined }));
  $('discard-panel').hidden = !endedGame(view) || !view.discards.length;
  const discards = $('discard-cards'); discards.replaceChildren();
  if (endedGame(view)) for (const card of view.discards) discards.append(cardNode(card, { mini: true }));
  if (oldFocus) own.querySelector(`[data-card="${oldFocus}"]`)?.focus({ preventScroll: true });
}

function renderStage(view) {
  const activeName = playerName(view.activePlayer || 'host');
  const yours = view.activePlayer === view.role;
  const label = { lobby: 'READY FOR A FIRST DEAL', auction: 'ONE BID EACH', trump_before: 'CALL BEFORE YOU LOOK', kitty: 'THE KITTY EXCHANGE', trump_after: 'NOW CALL TRUMP', play: 'FOUR CARDS MAKE A PACK', pack_complete: 'PACK COMPLETE', game_over: 'GAME COMPLETE', match_over: 'MATCH COMPLETE' };
  $('stage-label').textContent = label[view.phase];
  $('game-label').textContent = `GAME ${String(Math.max(1, view.gameNumber)).padStart(2, '0')}`;
  let title = '', instruction = '';
  if (mode === 'idle') {
    title = 'Every game starts with a deal.'; instruction = 'Create a table and invite a friend, or explore both seats in local practice.';
  } else if (!gameReady()) {
    title = phase === 'ended' ? 'The table has closed.' : phase === 'waiting' ? 'A seat for your friend.' : 'Connecting your table…';
    instruction = phase === 'ended' ? 'Start a new session to play again.' : phase === 'waiting' ? 'Share your invite. The game starts once both players are connected.' : 'Play is paused until both participants are connected.';
  } else if (view.phase === 'lobby') {
    title = yours ? 'Your turn to deal.' : 'The first deal is coming.';
    instruction = 'Each player gets twelve hand cards and three stacks of four. Four cards form the kitty.';
  } else if (view.phase === 'auction') {
    title = yours ? 'Make your one bid.' : `${activeName} is considering a bid.`;
    instruction = view.auction.entries.length === 0 ? 'The non-dealer opens. Bids run from 3-high to 8-low; low beats high only at the same number.'
      : view.auction.entries[0].type === 'pass' ? 'The opening player passed. The dealer must lodge a bid.' : 'The dealer can bid strictly higher or pass. There is no further bidding.';
  } else if (view.phase === 'trump_before') {
    title = yours ? 'Call trump before the kitty.' : `${activeName} must call trump first.`;
    instruction = 'The dealer won the auction and must choose the trump suit before seeing the kitty.';
  } else if (view.phase === 'kitty') {
    title = yours ? 'Keep twelve. Discard four.' : `${activeName} is inspecting the kitty.`;
    instruction = yours ? 'Select exactly four cards from your hand and the kitty. Your table stacks are untouched.' : 'The bid winner’s exchange stays private until the game ends.';
  } else if (view.phase === 'trump_after') {
    title = yours ? 'Choose the trump suit.' : `${activeName} is calling trump.`;
    instruction = 'The non-dealer has finished the kitty exchange. Call trump to reveal the table tops and begin.';
  } else if (view.phase === 'play') {
    const source = view.currentPack.plays.length < 2 ? 'hand' : 'table';
    title = yours ? `Your ${source} play.` : `${activeName} plays from their ${source}.`;
    instruction = view.currentPack.ledSuit ? `Follow ${suitNames[view.currentPack.ledSuit]} if available among your ${source === 'hand' ? 'hand cards' : 'exposed table cards'}. If you have none there, any suit is legal.` : 'The leader may play any hand card. Its suit is the led suit for all four plays.';
  } else if (view.phase === 'pack_complete') {
    title = `${playerName(view.lastPack.winner)} takes the pack.`;
    instruction = 'Replacement table tops are now revealed. The pack winner leads the next pack.';
  } else {
    title = view.matchWinner ? `${playerName(view.matchWinner)} wins the match.` : `${playerName(view.result.winner)} wins this game.`;
    instruction = view.matchWinner ? 'Seven or more games won. All remaining cards are revealed for a final look.' : 'All remaining cards and the four discards are revealed. The other player deals the next game.';
  }
  $('stage-title').textContent = pending ? 'Confirming your move…' : title;
  $('stage-instruction').textContent = instruction;
  const history = $('auction-history'); history.replaceChildren();
  for (const entry of view.auction.entries) {
    const token = document.createElement('span'); token.className = 'bid-token'; token.textContent = `${playerName(entry.role)} · ${entry.type === 'bid' ? bidLabel(entry) : 'Pass'}`; history.append(token);
  }
  const auctionTurn = view.phase === 'auction' && yours;
  $('bid-controls').hidden = !auctionTurn;
  const optionsKey = JSON.stringify(view.legal.bids);
  if (lastBidOptions !== optionsKey) {
    lastBidOptions = optionsKey;
    const previous = $('bid-select').value;
    $('bid-select').replaceChildren();
    for (const bid of view.legal.bids) {
      const option = document.createElement('option'); option.value = `${bid.number}-${bid.mode}`; option.textContent = bidLabel(bid); $('bid-select').append(option);
    }
    $('bid-select').value = view.legal.bids.some(bid => `${bid.number}-${bid.mode}` === previous) ? previous
      : view.legal.bids.length ? `${view.legal.bids[0].number}-${view.legal.bids[0].mode}` : '';
  }
  $('bid-select').disabled = !gameReady() || pending || !view.legal.canBid;
  $('bid-button').disabled = !gameReady() || pending || !view.legal.canBid;
  $('pass-button').hidden = !view.legal.canPass;
  $('pass-button').disabled = !gameReady() || pending || !view.legal.canPass;
  $('trump-controls').hidden = !view.legal.canCallTrump;
  for (const suit of ['S', 'H', 'D', 'C']) $(`trump-${suit}`).disabled = !gameReady() || pending;
  $('discard-controls').hidden = !view.legal.canDiscard;
  $('discard-counter').textContent = `${selectedDiscards.size} of 4 selected`;
  $('discard-button').disabled = !gameReady() || pending || selectedDiscards.size !== 4;
  $('next-controls').hidden = !(view.legal.canDeal || view.legal.canContinue || view.legal.canNewMatch);
  $('next-button').disabled = !gameReady() || pending;
  $('next-button').textContent = view.legal.canContinue ? 'Lead the next pack →' : view.legal.canNewMatch ? 'Start a new match ↻'
    : view.gameNumber ? `Deal game ${view.gameNumber + 1} ↻` : 'Deal the first game ↻';
  $('result-panel').hidden = !view.result;
  if (view.result) {
    $('result-title').textContent = view.result.badge || `${playerName(view.result.winner)} wins`;
    $('result-description').textContent = `${playerName(view.result.winner)} earns ${view.result.points} ${view.result.points === 1 ? 'game' : 'games'}. Packs: Host ${view.packs.host}, Guest ${view.packs.guest}. ${view.result.reason === 'target' ? 'The defender reached the target.' : 'All twelve packs were played.'}`;
  }
}

function renderHistory(view) {
  $('history-summary').textContent = `Completed packs · ${view.history.length}`;
  const history = $('pack-history'); history.replaceChildren();
  for (const pack of view.history) {
    const row = document.createElement('div'); row.className = 'history-pack';
    const cards = document.createElement('div'); cards.className = 'history-cards';
    for (const play of pack.plays) cards.append(cardNode(describeCard(play.cardId), { mini: true, label: playerName(play.role) }));
    const text = document.createElement('p'); text.textContent = `Pack ${pack.number} · ${playerName(pack.winner)} won · ${suitNames[pack.ledSuit]} led`;
    row.append(cards, text); history.append(row);
  }
  const games = $('game-history'); games.replaceChildren();
  for (const game of view.games) {
    const row = document.createElement('p'); row.className = 'game-result'; row.textContent = `Game ${game.gameNumber}: ${playerName(game.winner)} +${game.points}${game.badge ? ' · ' + game.badge : ''} · ${bidLabel(game.bid)} · packs ${game.packs.host}–${game.packs.guest}`; games.append(row);
  }
  if (!view.games.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'Completed games will appear here.'; games.append(empty); }
}

function render() {
  const role = viewerRole();
  const view = getPlayerView(state, role);
  const active = mode !== 'idle';
  $('build-label').textContent = `v${APP_VERSION}`;
  $('setup-panel').hidden = active;
  $('active-panel').hidden = !active;
  $('create-button').disabled = busy || localFile;
  $('join-button').disabled = busy || localFile;
  $('join-input').disabled = busy || localFile;
  $('practice-button').disabled = busy;
  $('create-button').textContent = busy ? 'Connecting…' : '＋ Create a table';
  $('role-label').textContent = mode === 'practice' ? `LOCAL PRACTICE · ${playerName(role).toUpperCase()} VIEW` : `YOU ARE THE ${playerName(role).toUpperCase()}`;
  $('session-title').textContent = mode === 'practice' ? 'Try both sides.' : phase === 'ended' ? 'Until next time.' : 'Your shared table.';
  $('practice-controls').hidden = mode !== 'practice';
  $('switch-seat').textContent = `View as ${playerName(otherPlayer(role))}`;
  $('invite-section').hidden = mode !== 'host' || !inviteLink || phase === 'ended';
  $('invite-output').value = inviteLink;
  $('session-guidance').textContent = mode === 'practice' ? 'This rehearsal stays on your device. Each move switches to the active seat.' : mode === 'host' ? 'Keep this page open. Closing or refreshing it ends the session.' : 'The original host keeps the game running. Your hand is private on screen.';
  $('leave-button').textContent = phase === 'ended' ? 'Back to start' : mode === 'practice' ? 'Exit practice' : mode === 'host' ? 'End session' : 'Leave table';
  $('host-name').textContent = `Host${role === 'host' && active ? ' · you' : ''}`;
  $('guest-name').textContent = `Guest${role === 'guest' && active ? ' · you' : ''}`;
  $('host-score').textContent = String(view.scores.host);
  $('guest-score').textContent = String(view.scores.guest);
  $('dealer-label').textContent = view.phase === 'game_over' ? `${playerName(otherPlayer(view.dealer))} deals next` : `${playerName(view.dealer)} ${view.gameNumber ? 'dealt this game' : 'deals first'}`;
  $('contract-label').textContent = view.contract ? `${playerName(view.contract.bidder)} · ${bidLabel(view.contract)}` : 'A fresh possibility.';
  $('trump-label').textContent = view.trump ? `${suitSymbols[view.trump]} ${suitNames[view.trump]} is trump · ${view.contract.mode} wins` : 'Trump is not called yet.';
  $('host-packs').textContent = String(view.packs.host); $('guest-packs').textContent = String(view.packs.guest);
  $('target-section').hidden = !view.contract;
  if (view.contract) {
    const count = view.packs[view.contract.defender];
    $('defender-label').textContent = `${playerName(view.contract.defender)} needs`;
    $('target-count').textContent = `${count} / ${view.contract.target} packs`;
    $('target-progress').max = view.contract.target; $('target-progress').value = count;
    $('target-description').textContent = `${playerName(view.contract.bidder)} must keep the defender below ${view.contract.target}.`;
  }
  $('status-dot').dataset.phase = phase;
  const labels = { idle: 'Not connected', connecting: 'Connecting…', waiting: 'Waiting for guest', connected: mode === 'practice' ? 'Local practice · one device' : 'Connected · 2 of 2', reconnecting: 'Connection interrupted', ended: 'Session ended' };
  $('status-label').textContent = labels[phase] || 'Not connected';
  renderStage(view); renderPack(view); renderHands(view); renderHistory(view); showCelebration(view);
}

function newSession(Peer, currentOperation) {
  const current = () => operation === currentOperation;
  return createSession({ Peer, peerOptions,
    onStatus(status) { if (!current()) return; phase = status.phase; if (phase !== 'connected') { pending = false; clearTimeout(pendingTimer); } announce(status.message); render(); },
    onState(next) { if (current()) acceptState(next); },
    onInvite(invite) { if (current()) { inviteLink = makeInviteLink(invite, location.href); render(); } },
    onGuest(present) { if (current()) { guestPresent = present; render(); } },
    onError(message) { if (current()) showError(typeof message === 'string' ? message : message.message); },
  });
}

async function startNetwork(role, invite) {
  if (busy || mode !== 'idle') return;
  clearError(); busy = true; phase = 'connecting'; announce('Preparing the browser connection…');
  const currentOperation = ++operation; render();
  try {
    if (!globalThis.RTCPeerConnection) throw new Error('This browser does not support WebRTC. Use a current browser or try local practice.');
    const Peer = await loadPeer();
    if (operation !== currentOperation) return;
    mode = role; session = newSession(Peer, currentOperation); render();
    if (role === 'host') await session.host(); else await session.join(invite);
  } catch (error) {
    if (operation !== currentOperation) return;
    operation++;
    try { session?.close(); } catch { /* Preserve the original startup error. */ }
    session = null; mode = 'idle'; phase = 'idle'; state = createGame(); inviteLink = ''; guestPresent = false;
    showError(error.message || 'The table could not connect.'); announce('You can retry or explore local practice.');
  } finally { busy = false; render(); }
}

function reset() {
  operation++;
  try { session?.close(); } catch { /* Reset remains available after transport errors. */ }
  session = null; mode = 'idle'; phase = 'idle'; state = createGame(); inviteLink = ''; guestPresent = false; pending = false; busy = false; selectedDiscards.clear();
  clearTimeout(pendingTimer); clearTimeout(celebrationTimer); $('celebration').hidden = true; lastCelebration = '';
  clearError();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  $('join-input').value = ''; announce('Create a table, or try a local rehearsal.'); render();
}

$('create-button').addEventListener('click', () => startNetwork('host'));
$('join-form').addEventListener('submit', event => { event.preventDefault(); try { startNetwork('guest', parseInviteLink($('join-input').value, location.href)); } catch (error) { showError(error.message); } });
$('practice-button').addEventListener('click', () => {
  clearError(); mode = 'practice'; phase = 'connected'; practiceRole = 'host'; state = createGame(); lastCelebration = ''; selectedDiscards.clear();
  announce('Local rehearsal: you control both players. Each turn shows the active player’s view.');
  act({ type: 'deal' });
});
$('switch-seat').addEventListener('click', () => { practiceRole = otherPlayer(practiceRole); selectedDiscards.clear(); render(); });
$('bid-button').addEventListener('click', () => { const [number, bidMode] = $('bid-select').value.split('-'); act({ type: 'bid', number: Number(number), mode: bidMode }); });
$('pass-button').addEventListener('click', () => act({ type: 'pass' }));
for (const suit of ['S', 'H', 'D', 'C']) $(`trump-${suit}`).addEventListener('click', () => act({ type: 'trump', suit }));
$('discard-button').addEventListener('click', () => act({ type: 'discard', cards: [...selectedDiscards] }));
$('next-button').addEventListener('click', () => {
  const legal = getPlayerView(state, viewerRole()).legal;
  act({ type: legal.canContinue ? 'continue' : legal.canNewMatch ? 'newMatch' : 'deal' });
});
$('leave-button').addEventListener('click', () => { if (mode === 'practice' || phase === 'ended') reset(); else session?.close(); });
$('copy-button').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(inviteLink); toast('Invite copied. Send it to your friend.'); }
  catch { $('invite-output').focus(); $('invite-output').select(); toast('Select and copy the invite link above.'); }
});
$('help-toggle').addEventListener('click', () => { const expanded = $('help-toggle').getAttribute('aria-expanded') === 'true'; $('help-toggle').setAttribute('aria-expanded', String(!expanded)); $('how-to-play').hidden = expanded; });
$('dismiss-error').addEventListener('click', clearError);
window.addEventListener('pagehide', () => { session?.close(); });
window.addEventListener('pageshow', event => { if (event.persisted && session) { phase = 'ended'; announce('This session ended when you left. Start a new table.'); render(); } });
if (location.hash) {
  try { parseInviteLink(location.href); $('join-input').value = location.href; $('join-hint').textContent = 'Your invitation is ready. Click Join table.'; announce('You’ve been invited. Join when you’re ready.'); }
  catch (error) { showError(error.message); }
}
if (localFile) {
  $('join-hint').textContent = 'Publish the homepage to use invitations.';
  document.querySelector('.brand').href = location.href.split('#')[0];
  announce('Local file: choose “Try both seats on this device” to explore the complete game.');
} else {
  const home = new URL('./', location.href); home.searchParams.set('v', APP_VERSION); document.querySelector('.brand').href = home.href;
}
render();
