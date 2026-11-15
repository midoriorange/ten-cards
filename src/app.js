import { createGame, dealCards, describeCard, selectCard, getNextDealer, canDeal, canSelect } from './game.js';
import { createSession } from './session.js';
import { makeInviteLink, parseInviteLink } from './invite.js';
import { peerOptions, peerLibraryUrl } from './config.js';
import { getCardViews } from './view.js';

const $ = (id) => document.getElementById(id);
const localFile = location.protocol === 'file:';
let mode = 'idle';
let state = createGame();
let phase = 'idle';
let guestPresent = false;
let inviteLink = '';
let session = null;
let busy = false;
let pending = null;
let pendingTimer;
let toastTimer;
let libraryPromise;
let cardsRenderKey = '';
let operation = 0;

function showError(message) {
  $('error-message').textContent = message;
  $('error-panel').hidden = false;
  $('error-panel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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

function act(kind, cardId) {
  if (mode === 'practice') {
    state = kind === 'deal' ? dealCards(state) : selectCard(state, {
      round: state.round, cardId, role: state.dealer === 'host' ? 'guest' : 'host',
    });
    announce(state.selectedCard
      ? `Choice recorded. ${getNextDealer(state) === 'host' ? 'Host' : 'Guest'} deals next.`
      : `${state.dealer === 'host' ? 'Host' : 'Guest'} dealt. Practice choosing for the other player.`);
    render();
    return;
  }
  const connected = phase === 'connected';
  const hostWaiting = mode === 'host' && phase === 'waiting';
  if (pending || !session || (!connected && !(kind === 'deal' && hostWaiting))) return;
  if (kind === 'deal' ? !canDeal(state, mode) : !canSelect(state, mode)) return;
  const revision = state.revision;
  pending = kind;
  render();
  const accepted = kind === 'deal' ? session.deal() : session.select(cardId);
  if (!accepted) {
    pending = null;
    render();
    return;
  }
  // A host action is confirmed synchronously; a guest waits for shared state.
  if (!pending) return;
  announce(kind === 'deal' ? 'Dealing the next hand…' : 'Confirming your choice…');
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pending = null;
    render();
    if (state.revision === revision && phase === 'connected') announce('No confirmation yet. You can try that action again.');
  }, 5000);
}

function renderCards() {
  const selectable = (mode === 'practice' || (phase === 'connected' && canSelect(state, mode)))
    && !pending && !state.selectedCard;
  // Practice plays the chooser's side so one person can still try selection.
  const viewer = mode === 'practice' ? (state.dealer === 'host' ? 'guest' : 'host') : mode;
  const cards = state.cards.length ? getCardViews(state, viewer) : [];
  const key = JSON.stringify([cards, selectable]);
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
  for (const card of cards) {
    if (!card.faceUp) {
      const back = document.createElement('div');
      back.className = 'card-back dealt-back';
      back.setAttribute('role', 'img');
      back.setAttribute('aria-label', `Face-down card ${card.position}`);
      grid.append(back);
      continue;
    }
    const { id, selected } = card;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `playing-card ${card.color}${selected ? ' selected' : ''}`;
    button.disabled = !selectable;
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
    button.addEventListener('click', () => act('select', id));
    grid.append(button);
  }
  if (oldFocus && selectable) grid.querySelector(`[data-card="${oldFocus}"]`)?.focus({ preventScroll: true });
}

function render() {
  const active = mode !== 'idle';
  const practice = mode === 'practice';
  const host = mode === 'host';
  const ended = phase === 'ended';
  const connecting = phase === 'connecting';
  const paused = phase === 'reconnecting';
  const nextDealer = getNextDealer(state);
  const chooser = state.dealer === 'host' ? 'guest' : 'host';
  const myDeal = practice || canDeal(state, mode);
  const myChoice = practice || canSelect(state, mode);
  const dealerName = state.dealer === 'host' ? 'Host' : 'Guest';
  const nextDealerName = nextDealer === 'host' ? 'Host' : 'Guest';
  const chooserName = chooser === 'host' ? 'Host' : 'Guest';
  const isDealer = mode === state.dealer;
  const waitingForGuest = host && phase === 'waiting' && !guestPresent;
  const roleHint = role => {
    const identity = mode === role ? 'You' : 'Your friend';
    const turn = state.selectedCard
      ? (nextDealer === role ? 'Deal next' : 'Choose next')
      : (state.dealer === role ? (state.round ? 'Dealt this hand' : 'First deal') : 'Choosing');
    return `${identity} · ${turn}`;
  };
  $('setup-panel').hidden = active;
  $('active-panel').hidden = !active;
  $('create-button').disabled = busy || localFile;
  $('join-button').disabled = busy || localFile;
  $('practice-button').disabled = busy;
  $('join-input').disabled = busy || localFile;
  $('create-button').textContent = busy ? 'Connecting…' : '＋ Create a table';
  $('role-label').textContent = practice ? 'LOCAL PRACTICE' : host ? 'YOU ARE THE HOST' : 'YOU ARE THE GUEST';
  $('session-title').textContent = ended ? 'Until next time.' : practice ? 'Practice both turns.' : connecting ? 'Opening your table…' : paused ? 'The game is paused.'
    : waitingForGuest ? 'Waiting for your friend.' : state.selectedCard ? (myDeal ? 'Your turn to deal.' : 'Your friend deals next.')
    : !state.round ? (myDeal ? 'Your turn to deal.' : 'Waiting for the first deal.')
    : myChoice ? 'Your turn to choose.' : 'Your friend is choosing.';
  $('host-seat-label').textContent = ended ? 'Disconnected' : practice ? 'You practice this side' : roleHint('host');
  $('guest-seat-label').textContent = ended ? 'Not connected' : practice ? 'And this side, too' : host && !guestPresent ? 'Waiting for a friend' : roleHint('guest');
  $('host-dot').className = `seat-dot${!ended && !connecting && active ? ' online' : ''}`;
  $('guest-dot').className = `seat-dot${!ended && (practice || guestPresent || (mode === 'guest' && phase === 'connected')) ? ' online' : ''}`;
  $('host-dot').setAttribute('aria-label', $('host-dot').classList.contains('online') ? 'Present' : 'Not connected');
  $('guest-dot').setAttribute('aria-label', $('guest-dot').classList.contains('online') ? 'Present' : 'Not connected');
  $('invite-section').hidden = !host || !inviteLink || ended;
  $('invite-output').value = inviteLink;
  $('deal-button').hidden = !myDeal;
  $('deal-button').disabled = ended || pending !== null || !(phase === 'connected' || (host && phase === 'waiting'));
  $('deal-button').textContent = pending === 'deal' ? 'Dealing…' : state.selectedCard ? 'Deal next hand ↻' : state.round ? 'Deal again ↻' : 'Deal ten cards ↻';
  $('leave-button').textContent = ended ? 'Back to start' : practice ? 'Exit practice' : host ? 'End game' : 'Leave table';
  let guidance;
  if (ended) guidance = 'This session has ended. Start a fresh table to play again.';
  else if (connecting) guidance = host ? 'Preparing your invite link. Keep this page open.' : 'Connecting to your host. Keep this page open.';
  else if (paused) guidance = 'The connection was interrupted. Wait for it to recover before dealing or choosing.';
  else if (practice) guidance = 'Practice shows the chooser’s view. In a two-player game, the dealer sees card backs until a choice reveals one.';
  else if (waitingForGuest) guidance = !state.round ? 'Invite your friend. You can deal the first hand while you wait.' : 'Waiting for your friend to join. Their place in the current hand is saved.';
  else if (state.selectedCard) guidance = myDeal ? 'Your choice is recorded. Deal the next hand for your friend.' : 'Your friend can now deal the next hand for you.';
  else if (myChoice) guidance = 'Choose one card. Then you can deal the next hand.';
  else if (state.round) guidance = 'Your friend sees the card faces. Your cards stay face down until their choice reveals one.';
  else guidance = myDeal ? 'Deal ten cards for your friend to choose from.' : 'Your friend will deal the first hand. The cards will appear here.';
  if (host && !ended && !connecting) guidance += ' Keep this page open to keep the game going.';
  $('session-guidance').textContent = guidance;
  $('round-label').textContent = state.round ? `DEAL ${String(state.round).padStart(2, '0')} · 10 CARDS` : 'YOUR SHARED TABLE';
  $('status-pill').dataset.phase = phase;
  const labels = { idle: 'Not connected', connecting: 'Connecting…', waiting: 'Waiting for guest', connected: practice ? 'Local practice' : 'Connected · 2 of 2', reconnecting: 'Connection interrupted', ended: 'Session ended' };
  $('status-label').textContent = labels[phase] || 'Not connected';
  $('felt').classList.toggle('empty', !state.cards.length);
  $('felt').classList.toggle('ended', ended);
  $('table-empty').hidden = Boolean(state.cards.length);
  $('cards-grid').setAttribute('aria-label', !state.cards.length ? 'Waiting for ten cards'
    : isDealer ? (state.selectedCard ? 'One selected card revealed; nine cards face down' : 'Ten face-down cards')
      : 'Ten face-up cards');
  $('empty-title').textContent = ended ? 'The table is closed.' : connecting ? 'Connecting your table…' : mode === 'guest' ? 'Take a little seat.' : active ? 'Your table is ready.' : 'Ready when you are.';
  $('empty-copy').textContent = ended ? 'Start a new game for a fresh deal.' : connecting
    ? (host ? 'Setting up your invite link. Please wait.' : 'Waiting for your host to accept the connection.')
    : mode === 'guest' ? 'The cards will appear when your host deals.' : active ? 'Deal ten cards to get things going.' : 'Create a table to deal your first ten cards.';
  $('felt-label').textContent = `${practice ? 'PRACTICE · ' : ''}${dealerName.toUpperCase()} DEALS · ${chooserName.toUpperCase()} CHOOSES`;
  $('table-instruction').textContent = ended ? 'This game has ended.' : paused ? 'Connection interrupted. The game is paused.' : pending ? (pending === 'deal' ? 'Dealing the next hand…' : 'Confirming your choice…')
    : waitingForGuest && state.round ? 'Waiting for your friend to join the table.'
    : state.selectedCard ? (practice ? `${nextDealerName} deals next. You can play that side, too.` : myDeal ? 'Your turn to deal the next hand.' : `${nextDealerName} can now deal the next hand for you.`) : state.cards.length
    ? (myChoice ? 'Pick the card that catches your eye.' : 'Your friend’s choice will reveal one card here.')
    : 'A full deck. A fresh deal. A shared moment.';
  $('selection-copy').textContent = state.selectedCard
    ? `Selected: ${describeCard(state.selectedCard).name}.`
    : state.round ? (waitingForGuest ? 'Waiting for your friend to join.' : myChoice ? 'Which one will it be?' : `Waiting for the ${chooser}'s choice.`) : 'Every good choice starts with a deal.';
  $('selection-tag').textContent = `${nextDealerName.toUpperCase()} DEALS NEXT`;
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
      if (phase !== 'connected') { pending = null; clearTimeout(pendingTimer); }
      announce(status.message);
      render();
    },
    onState(next) {
      if (!current()) return;
      const previousRound = state.round;
      state = next; pending = null; clearTimeout(pendingTimer);
      if (next.selectedCard) announce(getNextDealer(next) === mode
        ? 'Choice recorded. You can now deal the next hand.' : 'Choice recorded. Your friend can deal next.');
      else if (next.round > previousRound) announce(canSelect(next, mode)
        ? 'Ten new cards. It’s your turn to choose.' : 'Your hand is dealt. Your friend can choose a card.');
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
    try { session?.close(); } catch { /* A cleanup failure must not hide the original error. */ }
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
  inviteLink = ''; guestPresent = false; pending = null; busy = false;
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
$('deal-button').addEventListener('click', () => act('deal'));
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
