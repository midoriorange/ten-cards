/**
 * Two-player WebRTC transport. PeerJS is supplied by the caller, not imported.
 * host() resolves to {hostId, secret}; join(invite) resolves after authentication.
 * All callbacks receive deep copies. The original host owns the official state
 * throughout the auction, kitty exchange, and play. act(action) submits a game
 * action; its return value reports local acceptance / request transmission.
 * Guest requests are acknowledged with a state callback even when rejected.
 * close() is final: make a new session object for another game.
 * The invitation is a bearer capability; it stays in memory for this tab.
 */
import { createGame, applyAction, isValidState } from './game.js';

const VERSION = 4;
const HOST_ID = /^ten-[a-f0-9]{32}$/;
const SECRET = /^[a-f0-9]{32}$/;
const noop = () => {};
const copy = state => structuredClone(state);
const packet = (type, fields = {}) => ({ v: VERSION, type, ...fields });
const packetShape = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && typeof value.type === 'string';
const validPacket = value => packetShape(value) && value.v === VERSION;
const UPDATE_MESSAGE = 'These pages are running different game versions. Refresh both browsers, then create a new invite.';

// Action payloads are small JSON records. Bound them before handing anything
// remote to the game engine; never accept arbitrary objects or giant payloads.
function normalizeAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    typeof value.type !== 'string' || value.type.length < 1 || value.type.length > 40) return null;
  try {
    const json = JSON.stringify(value);
    if (json.length > 4096) return null;
    const action = JSON.parse(json);
    return action && typeof action === 'object' && !Array.isArray(action) &&
      typeof action.type === 'string' ? action : null;
  } catch { return null; }
}

function randomHex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
    byte.toString(16).padStart(2, '0')).join('');
}

export function isValidInvite(invite) {
  return Boolean(invite && typeof invite === 'object' &&
    typeof invite.hostId === 'string' && typeof invite.secret === 'string' &&
    HOST_ID.test(invite.hostId) && SECRET.test(invite.secret));
}

export function createSession({
  Peer,
  peerOptions = {},
  onStatus = noop,
  onState = noop,
  onInvite = noop,
  onGuest = noop,
  onError = noop,
  timing = {},
  timers = {},
} = {}) {
  const clock = {
    now: () => Date.now(),
    // Window timer methods require their global receiver. Storing a raw method
    // here would call it with `clock` as `this`, which browsers reject.
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    setInterval: (...args) => globalThis.setInterval(...args),
    clearInterval: (...args) => globalThis.clearInterval(...args),
    ...timers,
  };
  const limits = {
    startup: 20000, handshake: 8000, heartbeat: 3000,
    suspect: 9000, dead: 15000, lossGrace: 2500, rejectGrace: 120,
    ...timing,
  };
  let role = null;
  let phase = 'idle';
  let state = createGame();
  let peer = null;
  let connection = null;
  let invitation = null;
  let authenticated = false;
  let closed = false;
  let signalingReady = false;
  let startup = null;
  let startupTimer = null;
  let heartbeatTimer = null;
  let lossTimer = null;
  let lastReceived = 0;
  const pending = new Map();
  const deferredClosures = new Map();

  function status(next, message) {
    phase = next;
    onStatus({ phase: next, message });
  }

  function updateState(next) {
    state = copy(next);
    onState(copy(state));
  }

  function settle(error, value) {
    if (!startup) return;
    const promise = startup;
    startup = null;
    clock.clearTimeout(startupTimer);
    startupTimer = null;
    if (error) promise.reject(new Error(error));
    else promise.resolve(value);
  }

  function safeClose(conn) {
    try { conn.close(); } catch { /* Already closed. */ }
  }

  function cleanup() {
    clock.clearTimeout(startupTimer);
    clock.clearTimeout(lossTimer);
    clock.clearInterval(heartbeatTimer);
    startupTimer = lossTimer = heartbeatTimer = null;
    for (const [conn, timer] of pending) {
      clock.clearTimeout(timer);
      safeClose(conn);
    }
    pending.clear();
    for (const [conn, timer] of deferredClosures) {
      clock.clearTimeout(timer);
      safeClose(conn);
    }
    deferredClosures.clear();
    if (peer) {
      try { peer.destroy(); } catch { /* Best-effort transport cleanup. */ }
    }
  }

  function finish(message, error = false) {
    if (closed) return;
    closed = true;
    authenticated = false;
    settle(error ? message : 'The session ended before it connected.');
    cleanup();
    status('ended', message);
    if (error) onError(message);
  }

  function send(conn, data) {
    if (!conn?.open || closed) return false;
    try { conn.send(data); return true; }
    catch { return false; }
  }

  function clearPending(conn) {
    if (!pending.has(conn)) return;
    clock.clearTimeout(pending.get(conn));
    pending.delete(conn);
  }

  function reject(conn, reason, version = VERSION) {
    clearPending(conn);
    send(conn, { ...packet('reject', { reason }), v: version });
    const timer = clock.setTimeout(() => {
      deferredClosures.delete(conn);
      safeClose(conn);
    }, limits.rejectGrace);
    deferredClosures.set(conn, timer);
  }

  function connectedStatus() {
    status('connected', signalingReady ?
      (role === 'host' ? 'Guest connected. Your table is live.' : 'Connected to the host.') :
      'Game connected. The invitation service is reconnecting.');
  }

  function hostLostGuest(conn) {
    clearPending(conn);
    if (closed || conn !== connection) return;
    connection = null;
    authenticated = false;
    onGuest(false);
    status('waiting', signalingReady ?
      'Guest disconnected. Waiting for a guest.' :
      'Guest disconnected. The invitation service is reconnecting.');
  }

  function guestLostHost() {
    if (closed || lossTimer) return;
    authenticated = false;
    status('reconnecting', 'Host connection lost. This session is ending…');
    lossTimer = clock.setTimeout(() => finish('Session ended. The host is no longer connected.'),
      limits.lossGrace);
  }

  function touch() {
    lastReceived = clock.now();
    if (role === 'guest' && authenticated && phase === 'reconnecting' && !lossTimer) connectedStatus();
  }

  function startHeartbeat() {
    heartbeatTimer = clock.setInterval(() => {
      if (closed || !connection || !authenticated) return;
      const elapsed = clock.now() - lastReceived;
      if (elapsed >= limits.dead) {
        if (role === 'host') {
          const lost = connection;
          hostLostGuest(lost);
          safeClose(lost);
        } else finish('Session ended. The host stopped responding.');
        return;
      }
      if (role === 'guest' && elapsed >= limits.suspect && phase !== 'reconnecting') {
        status('reconnecting', 'Waiting for the host. The game is paused.');
      }
      if (!send(connection, packet('ping'))) {
        if (role === 'host') hostLostGuest(connection);
        else guestLostHost();
      }
    }, limits.heartbeat);
  }

  function handleHostConnection(conn) {
    if (closed || pending.size >= 4) {
      safeClose(conn);
      return;
    }
    pending.set(conn, clock.setTimeout(() => {
      clearPending(conn);
      safeClose(conn);
    }, limits.handshake));
    conn.on('data', data => {
      if (closed) return;
      if (conn !== connection && pending.has(conn) && packetShape(data) &&
        data.type === 'hello' && data.v !== VERSION) {
        // Reply using an older supported envelope so those clients receive
        // a reject they understand, rather than waiting for an unknown protocol.
        reject(conn, 'version-mismatch', [1, 2, 3].includes(data.v) ? data.v : VERSION);
        return;
      }
      if (!validPacket(data)) return;
      if (conn !== connection) {
        if (!pending.has(conn) || data.type !== 'hello') return;
        if (data.secret !== invitation.secret) { reject(conn, 'unauthorized'); return; }
        if (connection) { reject(conn, 'room-full'); return; }
        clearPending(conn);
        connection = conn;
        authenticated = true;
        touch();
        if (!send(conn, packet('welcome', { state: copy(state) }))) {
          hostLostGuest(conn);
          safeClose(conn);
          return;
        }
        onGuest(true);
        connectedStatus();
        return;
      }
      touch();
      if (data.type === 'ping') send(conn, packet('pong'));
      if (data.type === 'leave') { hostLostGuest(conn); safeClose(conn); }
      if (data.type === 'action') {
        const action = normalizeAction(data.action);
        if (authenticated && phase === 'connected' && conn.open &&
          Number.isSafeInteger(data.revision) && data.revision === state.revision && action) {
          // Permanent sender identity comes from this authenticated connection,
          // never an action.role or outer role supplied by the remote browser.
          let next = state;
          try { next = applyAction(state, 'guest', action); } catch { /* Reject invalid requests. */ }
          if (next !== state) updateState(next);
        }
        // An unchanged snapshot acknowledges invalid or stale requests too.
        // The guest can clear its pending indicator and use current legal moves.
        if (!send(conn, packet('state', { state: copy(state) }))) hostLostGuest(conn);
      }
    });
    conn.on('close', () => hostLostGuest(conn));
    conn.on('error', () => { hostLostGuest(conn); safeClose(conn); });
  }

  function handleGuestConnection(conn) {
    connection = conn;
    const greet = () => {
      if (!send(conn, packet('hello', { secret: invitation.secret }))) {
        finish('Could not contact the host. Ask for a new invite or try another network.', true);
      }
    };
    conn.on('open', greet);
    if (conn.open) queueMicrotask(greet);
    conn.on('data', data => {
      if (closed || conn !== connection) return;
      if (!authenticated && packetShape(data) && data.v !== VERSION) {
        finish(UPDATE_MESSAGE, true);
        return;
      }
      // Ignore malformed/unexpected traffic after authentication; it must not
      // disrupt a session whose version was successfully negotiated.
      if (!validPacket(data)) return;
      if (data.type === 'reject') {
        const message = data.reason === 'version-mismatch' ? UPDATE_MESSAGE :
          data.reason === 'room-full' ?
            'This table already has a guest. Ask the host to start another game.' :
            'This invitation is invalid. Ask the host for the complete invite link.';
        finish(message, true);
        return;
      }
      if (data.type === 'welcome' && !authenticated && !lossTimer) {
        if (!isValidState(data.state)) {
          finish('The host sent an incompatible game. Refresh both pages and try again.', true);
          return;
        }
        authenticated = true;
        touch();
        updateState(data.state);
        connectedStatus();
        settle(null, copy(state));
        return;
      }
      if (!authenticated) return;
      touch();
      if (data.type === 'state' && isValidState(data.state) && data.state.revision >= state.revision) {
        updateState(data.state);
      }
      if (data.type === 'ping') send(conn, packet('pong'));
      if (data.type === 'end') finish('Session ended. The host closed the table.');
    });
    conn.on('close', () => {
      if (!authenticated && startup && !closed) {
        finish('The host could not accept this connection. Ask for a new invite.', true);
      } else guestLostHost();
    });
    conn.on('error', () => {
      if (startup && !closed) finish('Could not connect to the host. Try another network or a new invite.', true);
      else guestLostHost();
    });
  }

  function start(nextRole, invite) {
    if (role || closed) return Promise.reject(new Error('Create a new session to start another game.'));
    if (typeof Peer !== 'function') {
      const message = 'The connection library could not load. Refresh the page and try again.';
      status('ended', message);
      onError(message);
      closed = true;
      return Promise.reject(new Error(message));
    }
    role = nextRole;
    invitation = invite;
    status('connecting', role === 'host' ? 'Creating your table…' : 'Connecting to the host…');
    const ready = new Promise((resolve, rejectPromise) => {
      startup = { resolve, reject: rejectPromise };
    });
    startupTimer = clock.setTimeout(() => finish(
      'Could not establish a connection. Refresh both browsers to update the game, then try a new invite or another network.', true),
    limits.startup);
    try {
      peer = new Peer(role === 'host' ? invitation.hostId : undefined, { debug: 0, ...peerOptions });
      peer.on('open', () => {
        if (closed) return;
        const firstOpen = !heartbeatTimer;
        signalingReady = true;
        if (firstOpen) startHeartbeat();
        if (role === 'host') {
          if (firstOpen) {
            onInvite({ ...invitation });
            onGuest(false);
            status('waiting', 'Table created. Invite your guest.');
            settle(null, { ...invitation });
          } else if (connection && authenticated) connectedStatus();
          else status('waiting', 'Waiting for your guest.');
        } else if (firstOpen) {
          handleGuestConnection(peer.connect(invitation.hostId, {
            reliable: true, serialization: 'json', metadata: { app: 'card-table', v: VERSION },
          }));
        } else if (authenticated) connectedStatus();
      });
      peer.on('connection', conn => {
        if (role === 'host') handleHostConnection(conn);
        else safeClose(conn);
      });
      peer.on('disconnected', () => {
        if (closed) return;
        signalingReady = false;
        if (authenticated) connectedStatus();
        else if (role === 'host') status('waiting', 'The invitation service is reconnecting.');
        try { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }
        catch { /* An existing data channel can continue without signaling. */ }
      });
      peer.on('error', error => {
        if (closed) return;
        if (authenticated && ['network', 'socket-error', 'socket-closed', 'server-error'].includes(error?.type)) {
          signalingReady = false;
          connectedStatus();
          return;
        }
        const message = error?.type === 'peer-unavailable' ?
          'This game is unavailable. The host may have closed or refreshed the page. Ask for a new invite.' :
          error?.type === 'browser-incompatible' ?
            'This browser does not support the connection. Try a current Chrome, Edge, Firefox, or Safari.' :
            'The connection could not be established. Check your connection or try another network.';
        finish(message, true);
      });
      peer.on('close', () => {
        if (!closed) finish('Session ended. The connection was closed.');
      });
    } catch {
      finish('The connection could not start. Check browser support and try again.', true);
    }
    return ready;
  }

  return {
    host() {
      return start('host', { hostId: `ten-${randomHex()}`, secret: randomHex() });
    },
    join(invite) {
      if (!isValidInvite(invite)) {
        const message = 'This invitation is incomplete or invalid. Ask the host for a new link.';
        onError(message);
        return Promise.reject(new Error(message));
      }
      return start('guest', { hostId: invite.hostId, secret: invite.secret });
    },
    act(value) {
      if (closed || !authenticated || phase !== 'connected' || !connection?.open) return false;
      const action = normalizeAction(value);
      if (!action) return false;
      if (role === 'guest') return send(connection, packet('action', { revision: state.revision, action }));
      if (role !== 'host') return false;
      let next = state;
      try { next = applyAction(state, 'host', action); } catch { return false; }
      if (next === state) return false;
      updateState(next);
      if (!send(connection, packet('state', { state: copy(state) }))) hostLostGuest(connection);
      return true;
    },
    close() {
      if (closed) return;
      if (connection) send(connection, packet(role === 'host' ? 'end' : 'leave'));
      finish(role === 'host' ? 'You ended this session.' : 'You left the game.');
    },
    get role() { return role; },
    get state() { return copy(state); },
  };
}
