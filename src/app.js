import { createGame, dealCards, describeCard, selectCard } from './game.js';
import { createSession } from './session.js';
import { makeInviteLink, parseInviteLink } from './invite.js';
import { peerOptions, peerLibraryUrl } from './config.js';

const $ = (id) => document.getElementById(id);
const localFile = location.protocol === 'file:';
let mode = 'idle';
let state = createGame();
let phase = 'idle';
let guestPresent = false;
let inviteLink = '';
let session = null;
let busy = false;
let pending = false;
let pendingTimer;
let toastTimer;
let libraryPromise;
let cardsRenderKey = '';
let operation = 0;

function showError(message) {
  $('error-message').textContent = message;
  $('error-panel').hidden = false;
}
function clearError() { $('error-panel').hidden = true; }
function announce(message) { $('connection-message').textContent = message; }
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}

// Load the only external library only when someone requests a networked table.
// Local practice works without that download or any signaling service.
function loadPeer() {
  if (globalThis.Peer) return Promise.resolve(globalThis.Peer);
  if (libraryPromise) return libraryPromise;
  libraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(failed, 18000);
    function failed() {
      clearTimeout(timer);
      script.remove();
      libraryPromise = null;
      reject(new Error('The connection library could not load. Check your internet connection or try another network. Local practice is still available.'));
    }
    script.src = peerLibraryUrl;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      clearTimeout(timer);
      if (globalThis.Peer) resolve(globalThis.Peer);
      else failed();
    };
    script.onerror = failed;
    document.head.append(script);
  });
  return libraryPromise;
}

function selectFromTable(cardId) {
  if (mode === 'practice') {
    state = selectCard(state, { round: state.round, cardId });
    render();
    return;
  }
  if (mode !== 'guest' || phase !== 'connected' || pending || state.selectedCard) return;
  pending = true;
  render();
  if (!session.select(cardId)) {
    pending = false;
    render();
    return;
  }
  announce('Sending your choice to the host…');
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pending = false;
    render();
    if (!state.selectedCard && phase === 'connected') announce('No confirmation yet. You can try your choice again.');
  }, 5000);
}

function renderCards() {
  const canSelect = (mode === 'practice' || (mode === 'guest' && phase === 'connected'))
    && !pending && !state.selectedCard;
  const key = JSON.stringify([state.cards, state.selectedCard, canSelect]);
  if (cardsRenderKey === key) return;
  cardsRenderKey = key;
  const grid = $('cards-grid');
  const oldFocus = document.activeElement?.dataset.card;
  grid.replaceChildren();
  if (!state.cards.length) {
    for (let i = 0; i < 10; i++) {
      const back = document.createElement('div');
      back.className = 'card-back';
      back.setAttribute('aria-hidden', 'true');
      grid.append(back);
    }
    return;
  }
  for (const id of state.cards) {
    const card = describeCard(id);
    const selected = state.selectedCard === id;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `playing-card ${card.color}${selected ? ' selected' : ''}`;
    button.disabled = !canSelect;
    button.dataset.card = id;
    button.setAttribute('aria-label', `${card.name}${selected ? ', selected' : ''}`);
    button.setAttribute('aria-pressed', String(selected));
    for (const corner of ['top', 'bottom']) {
      const label = document.createElement('span');
      label.className = `card-corner ${corner}`;
      label.setAttribute('aria-hidden', 'true');
      const rank = document.createElement('span'); rank.textContent = card.rank;
      const suit = document.createElement('span'); suit.className = 'suit'; suit.textContent = card.symbol;
      label.append(rank, suit);
      button.append(label);
    }
    const pip = document.createElement('span');
    pip.className = 'card-pip';
    pip.setAttribute('aria-hidden', 'true');
    pip.textContent = card.symbol;
    button.append(pip);
    if (selected) {
      const check = document.createElement('span');
      check.className = 'card-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
      button.append(check);
    }
    button.addEventListener('click', () => selectFromTable(id));
    grid.append(button);
  }
  if (oldFocus && canSelect) grid.querySelector(`[data-card="${oldFocus}"]`)?.focus({ preventScroll: true });
}

function render() {
  const active = mode !== 'idle';
  const practice = mode === 'practice';
  const host = mode === 'host';
  const ended = phase === 'ended';
  $('setup-panel').hidden = active;
  $('active-panel').hidden = !active;
  $('create-button').disabled = busy || localFile;
  $('join-button').disabled = busy || localFile;
  $('practice-button').disabled = busy;
  $('join-input').disabled = busy || localFile;
  $('create-button').textContent = busy ? 'Connecting…' : '＋ Create a table';
  $('role-label').textContent = practice ? 'LOCAL PRACTICE' : host ? 'YOU ARE THE HOST' : 'YOU ARE THE GUEST';
  $('session-title').textContent = ended ? 'Until next time.' : practice ? 'Give it a little try.' : host ? 'A seat for a friend.' : 'You’re at the table.';
  $('host-seat-label').textContent = practice ? 'You deal' : host ? 'You' : ended ? 'Disconnected' : 'Your friend';
  $('guest-seat-label').textContent = practice ? 'You choose' : host ? (guestPresent ? 'Connected' : 'Waiting for a friend') : 'You';
  $('host-dot').className = `seat-dot${!ended && active ? ' online' : ''}`;
  $('guest-dot').className = `seat-dot${!ended && (practice || guestPresent || (mode === 'guest' && phase === 'connected')) ? ' online' : ''}`;
  $('host-dot').setAttribute('aria-label', ended ? 'Not connected' : 'Present');
  $('guest-dot').setAttribute('aria-label', $('guest-dot').classList.contains('online') ? 'Present' : 'Not connected');
  $('invite-section').hidden = !host || !inviteLink || ended;
  $('invite-output').value = inviteLink;
  $('deal-button').hidden = !(host || practice);
  $('deal-button').disabled = ended || !['waiting', 'connected'].includes(phase);
  $('deal-button').textContent = state.round ? 'Deal again ↻' : 'Deal ten cards ↻';
  $('leave-button').textContent = ended ? 'Back to start' : practice ? 'Exit practice' : host ? 'End game' : 'Leave table';
  $('session-guidance').textContent = ended ? 'This session has ended. Start a fresh table to play again.' : practice
    ? 'You can deal and choose here. Create a real table when you’re ready to invite someone.'
    : host ? 'Keep this page open. Closing or refreshing it ends the game.'
      : 'Your host deals. Pick one card each round. Both screens will show your choice.';
  $('round-label').textContent = state.round ? `DEAL ${String(state.round).padStart(2, '0')} · 10 CARDS` : 'YOUR SHARED TABLE';
  $('status-pill').dataset.phase = phase;
  const labels = { idle: 'Not connected', connecting: 'Connecting…', waiting: 'Waiting for guest', connected: practice ? 'Local practice' : 'Connected · 2 of 2', reconnecting: 'Connection interrupted', ended: 'Session ended' };
  $('status-label').textContent = labels[phase] || 'Not connected';
  $('felt').classList.toggle('empty', !state.cards.length);
  $('felt').classList.toggle('ended', ended);
  $('table-empty').hidden = Boolean(state.cards.length);
  $('empty-title').textContent = ended ? 'The table is closed.' : mode === 'guest' ? 'Take a little seat.' : active ? 'Your table is ready.' : 'Ready when you are.';
  $('empty-copy').textContent = ended ? 'Start a new game for a fresh deal.' : mode === 'guest' ? 'The cards will appear when your host deals.' : active ? 'Deal ten cards to get things going.' : 'Create a table to deal your first ten cards.';
  $('felt-label').textContent = practice ? 'PRACTICE · JUST ON THIS DEVICE' : 'TEN CARDS · ONE CHOICE';
  $('table-instruction').textContent = ended ? 'This game has ended.' : pending ? 'Waiting for the host to confirm…' : state.selectedCard ? 'A choice has been made. Ready for another deal?' : state.cards.length
    ? (host ? 'Your guest can choose one of these cards.' : 'Pick the card that catches your eye.')
    : 'A full deck. A fresh deal. A shared moment.';
  $('selection-copy').textContent = state.selectedCard
    ? `Selected: ${describeCard(state.selectedCard).name}.`
    : state.round ? (host ? 'Waiting for your guest’s choice.' : 'Which one will it be?') : 'Every good choice starts with a deal.';
  $('selection-tag').hidden = !state.selectedCard;
  renderCards();
}

function newSession(Peer, currentOperation) {
  const current = () => operation === currentOperation;
  return createSession({
    Peer, peerOptions,
    onStatus(status) {
      if (!current()) return;
      phase = status.phase;
      if (phase !== 'connected') { pending = false; clearTimeout(pendingTimer); }
      announce(status.message);
      render();
    },
    onState(next) {
      if (!current()) return;
      state = next; pending = false; clearTimeout(pendingTimer);
      if (next.selectedCard) announce('Choice recorded.');
      render();
    },
    onInvite(invite) {
      if (!current()) return;
      inviteLink = makeInviteLink(invite, location.href);
      render();
    },
    onGuest(present) { if (current()) { guestPresent = present; render(); } },
    onError(message) { if (current()) showError(typeof message === 'string' ? message : message.message); },
  });
}

async function startNetwork(role, invite) {
  if (busy || mode !== 'idle') return;
  clearError();
  busy = true;
  phase = 'connecting';
  announce('Preparing your browser connection…');
  const currentOperation = ++operation;
  render();
  try {
    if (!globalThis.RTCPeerConnection) throw new Error('This browser does not support WebRTC. Please use a current browser, or try local practice.');
    const Peer = await loadPeer();
    if (operation !== currentOperation) return;
    mode = role;
    session = newSession(Peer, currentOperation);
    render();
    if (role === 'host') await session.host();
    else await session.join(invite);
  } catch (error) {
    if (operation !== currentOperation) return;
    // Invalidate callbacks before closing so a failed start returns to a usable form.
    operation++;
    session?.close();
    session = null;
    mode = 'idle'; phase = 'idle';
    inviteLink = ''; guestPresent = false; state = createGame();
    showError(error.message || 'The connection failed. Please try again.');
    announce('The table could not connect. You can retry or try local practice.');
  } finally {
    busy = false;
    render();
  }
}

function reset() {
  operation++;
  session?.close();
  session = null;
  mode = 'idle'; phase = 'idle'; state = createGame();
  inviteLink = ''; guestPresent = false; pending = false; busy = false;
  clearTimeout(pendingTimer);
  clearError();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  $('join-input').value = '';
  announce('Create a table, or use an invite link to join one.');
  render();
}

$('create-button').addEventListener('click', () => startNetwork('host'));
$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const invite = parseInviteLink($('join-input').value, location.href);
    startNetwork('guest', invite);
  } catch (error) { showError(error.message); }
});
$('practice-button').addEventListener('click', () => {
  clearError();
  mode = 'practice'; phase = 'connected';
  state = dealCards(createGame());
  announce('Local practice: you control both the deal and the choice. No one else is connected.');
  render();
});
$('deal-button').addEventListener('click', () => {
  if (mode === 'practice') { state = dealCards(state); render(); }
  else if (mode === 'host') session?.deal();
});
$('leave-button').addEventListener('click', () => {
  if (phase === 'ended' || mode === 'practice') reset();
  else session?.close();
});
$('copy-button').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(inviteLink);
    toast('Invite link copied. Send it to a friend.');
  } catch {
    $('invite-output').focus(); $('invite-output').select();
    toast('Select and copy the invite link above.');
  }
});
$('help-toggle').addEventListener('click', () => {
  const expanded = $('help-toggle').getAttribute('aria-expanded') === 'true';
  $('help-toggle').setAttribute('aria-expanded', String(!expanded));
  $('how-to-play').hidden = expanded;
});
$('dismiss-error').addEventListener('click', clearError);
window.addEventListener('pagehide', () => { session?.close(); });
window.addEventListener('pageshow', (event) => {
  if (event.persisted && session) {
    phase = 'ended';
    announce('This session ended when you left the page. Start a fresh table to play again.');
    render();
  }
});

if (location.hash) {
  try {
    parseInviteLink(location.href);
    $('join-input').value = location.href;
    $('join-hint').textContent = 'Your invitation is ready. Click Join table.';
    announce('You’ve been invited. Join the table when you’re ready.');
  } catch (error) { showError(error.message); }
}
if (localFile) {
  $('join-hint').textContent = 'Publish the website to enable invitations.';
  $('join-input').disabled = true;
  $('create-button').title = 'Run a local web server or publish with GitHub Pages to create a networked table.';
  $('join-button').title = 'Run a local web server or publish with GitHub Pages to join a networked table.';
  document.querySelector('.brand').href = location.href.split('#')[0];
  announce('Local file preview. Choose “Try it on this device” to explore the cards. Publish to invite a friend.');
}
render();
