import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSession, isValidInvite } from '../src/session.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeNetwork() {
  const peers = new Map();
  let nextId = 0;

  class Connection extends EventEmitter {
    constructor(owner, remote) {
      super();
      this.owner = owner;
      this.peer = remote;
      this.open = false;
      this.closed = false;
      this.other = null;
      this.muted = false;
    }
    send(value) {
      if (!this.open) throw new Error('Connection is closed');
      if (this.muted) return;
      const data = structuredClone(value);
      queueMicrotask(() => {
        if (!this.other.closed) this.other.emit('data', data);
      });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.open = false;
      this.emit('close');
      if (this.other && !this.other.closed) {
        this.other.closed = true;
        this.other.open = false;
        this.other.emit('close');
      }
    }
  }

  class Peer extends EventEmitter {
    constructor(id) {
      super();
      this.id = id ?? `guest-${++nextId}`;
      this.destroyed = false;
      this.disconnected = false;
      this.connections = [];
      peers.set(this.id, this);
      queueMicrotask(() => {
        if (!this.destroyed) this.emit('open', this.id);
      });
    }
    connect(id) {
      const outgoing = new Connection(this, id);
      this.connections.push(outgoing);
      queueMicrotask(() => {
        const destination = peers.get(id);
        if (!destination) {
          this.emit('error', { type: 'peer-unavailable' });
          return;
        }
        const incoming = new Connection(destination, this.id);
        outgoing.other = incoming;
        incoming.other = outgoing;
        destination.connections.push(incoming);
        destination.emit('connection', incoming);
        outgoing.open = incoming.open = true;
        incoming.emit('open');
        outgoing.emit('open');
      });
      return outgoing;
    }
    reconnect() {
      this.disconnected = false;
      queueMicrotask(() => this.emit('open', this.id));
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      peers.delete(this.id);
      for (const connection of this.connections) connection.close();
      this.emit('close');
    }
  }
  return { Peer, peers };
}

function manualClock() {
  let time = 0;
  let sequence = 0;
  const tasks = new Map();
  const schedule = (fn, ms, interval = 0) => {
    const id = ++sequence;
    tasks.set(id, { fn, due: time + ms, interval });
    return id;
  };
  return {
    now: () => time,
    setTimeout: (fn, ms) => schedule(fn, ms),
    clearTimeout: id => tasks.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, ms),
    clearInterval: id => tasks.delete(id),
    tick(ms) {
      const target = time + ms;
      while (true) {
        const next = [...tasks.entries()].filter(([, task]) => task.due <= target)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, task] = next;
        time = task.due;
        if (task.interval) task.due += task.interval;
        else tasks.delete(id);
        task.fn();
      }
      time = target;
    },
  };
}

function fixture(t, options = {}) {
  const network = fakeNetwork();
  const sessions = [];
  const make = callbacks => {
    const session = createSession({ Peer: network.Peer, timing: { lossGrace: 5, rejectGrace: 1, ...options.timing }, ...callbacks });
    sessions.push(session);
    return session;
  };
  t.after(() => { for (const session of sessions) session.close(); });
  return { ...network, make };
}

test('browser timers retain the global receiver through startup, heartbeat and cleanup', async () => {
  const names = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
  const originals = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  const calls = Object.fromEntries(names.map(name => [name, 0]));
  const { Peer } = fakeNetwork();
  const sessions = [];
  try {
    // Browser timer methods reject an unrelated object as `this`. Node's native
    // timers do not, so model that receiver check without needing a browser.
    for (const name of names) {
      globalThis[name] = function (...args) {
        assert.equal(this, globalThis, `${name} must be called on the global object`);
        calls[name] += 1;
        return Reflect.apply(originals[name], globalThis, args);
      };
    }
    const host = createSession({ Peer, timing: { heartbeat: 1 } });
    const guest = createSession({ Peer, timing: { heartbeat: 1 } });
    sessions.push(host, guest);
    const invite = await host.host();
    await guest.join(invite);
    host.deal();
    await flush();
    guest.select(guest.state.cards[0]);
    await flush();
    assert.equal(guest.state.selectedCard, host.state.selectedCard);
    // Allow an actual heartbeat tick to exercise the interval callback too.
    await new Promise(resolve => Reflect.apply(originals.setTimeout, globalThis, [resolve, 5]));
    host.close();
    guest.close();
    for (const name of names) assert(calls[name] > 0, `${name} was exercised`);
  } finally {
    // Restore globals even when the original bug prevents startup or cleanup.
    Object.assign(globalThis, originals);
    for (const session of sessions) {
      try { session.close(); } catch { /* Preserve the original assertion. */ }
    }
  }
});

test('host creates an unguessable invitation and accepts one authenticated guest', async t => {
  const { make } = fixture(t);
  const hostStatuses = [];
  const guestStatuses = [];
  const presence = [];
  const host = make({ onStatus: event => hostStatuses.push(event.phase), onGuest: value => presence.push(value) });
  const invite = await host.host();
  assert.equal(isValidInvite(invite), true);
  assert.match(invite.hostId, /^ten-[a-f0-9]{32}$/);
  assert.match(invite.secret, /^[a-f0-9]{32}$/);
  const guest = make({ onStatus: event => guestStatuses.push(event.phase) });
  await guest.join(invite);
  assert.equal(host.role, 'host');
  assert.equal(guest.role, 'guest');
  assert.equal(hostStatuses.at(-1), 'connected');
  assert.equal(guestStatuses.at(-1), 'connected');
  assert.deepEqual(presence, [false, true]);
  assert.deepEqual(host.state, guest.state);
});

test('host can deal before the guest joins; late join receives the current state', async t => {
  const { make } = fixture(t);
  const host = make();
  const invite = await host.host();
  assert.equal(host.deal(), true);
  assert.equal(host.state.cards.length, 10);
  const guest = make();
  await guest.join(invite);
  assert.deepEqual(guest.state, host.state);
  assert.equal(guest.deal(), false);
});

test('guest selection is host-validated, replicated, and reset by the guest’s next deal', async t => {
  const { make } = fixture(t);
  const host = make();
  const invite = await host.host();
  const guest = make();
  await guest.join(invite);
  host.deal();
  await flush();
  const chosen = guest.state.cards[3];
  assert.equal(guest.select(chosen), true);
  await flush();
  assert.equal(host.state.selectedCard, chosen);
  assert.equal(guest.state.selectedCard, chosen);
  assert.equal(guest.select(guest.state.cards[5]), false);
  assert.equal(host.select(chosen), false);
  assert.equal(host.deal(), false);
  assert.equal(guest.deal(), true);
  await flush();
  assert.equal(guest.state.selectedCard, null);
  assert.equal(guest.state.round, 2);
  assert.equal(guest.state.dealer, 'guest');
  assert.deepEqual(guest.state, host.state);
});

test('players alternate dealer and chooser over a full multi-round cycle', async t => {
  const { make } = fixture(t);
  const host = make();
  const invite = await host.host();
  const guest = make();
  await guest.join(invite);
  assert.equal(guest.deal(), false);
  assert.equal(host.deal(), true);
  await flush();
  assert.equal(host.state.dealer, 'host');
  assert.equal(host.select(host.state.cards[0]), false);
  assert.equal(guest.select(guest.state.cards[0]), true);
  await flush();
  assert.equal(host.deal(), false);
  assert.equal(guest.deal(), true);
  await flush();
  assert.equal(host.state.round, 2);
  assert.equal(host.state.dealer, 'guest');
  assert.equal(guest.select(guest.state.cards[0]), false);
  const hostChoice = host.state.cards[4];
  assert.equal(host.select(hostChoice), true);
  await flush();
  assert.equal(guest.state.selectedCard, hostChoice);
  assert.deepEqual(guest.state, host.state);
  assert.equal(guest.deal(), false);
  assert.equal(host.deal(), true);
  await flush();
  assert.equal(host.state.round, 3);
  assert.equal(host.state.dealer, 'host');
  assert.equal(guest.select(guest.state.cards[2]), true);
  await flush();
  assert.deepEqual(guest.state, host.state);
});

test('each current dealer may re-deal before the chooser selects', async t => {
  const { make } = fixture(t);
  const host = make();
  const invite = await host.host();
  const guest = make();
  await guest.join(invite);
  host.deal();
  await flush();
  assert.equal(host.deal(), true);
  await flush();
  assert.equal(host.state.dealer, 'host');
  guest.select(guest.state.cards[0]);
  await flush();
  guest.deal();
  await flush();
  assert.equal(guest.deal(), true);
  await flush();
  assert.equal(host.state.round, 4);
  assert.equal(host.state.dealer, 'guest');
  assert.deepEqual(host.state, guest.state);
});

test('guest deal requests reject the wrong turn and stale duplicate rounds', async t => {
  const { make, peers } = fixture(t);
  const host = make();
  const invite = await host.host();
  const guest = make();
  await guest.join(invite);
  const hostConnection = peers.get(invite.hostId).connections[0];
  hostConnection.emit('data', { v: 2, type: 'deal', round: 0, role: 'host' });
  assert.equal(host.state.round, 0);
  host.deal();
  await flush();
  const before = host.state;
  hostConnection.emit('data', { v: 2, type: 'deal', round: before.round });
  assert.deepEqual(host.state, before);
  guest.select(guest.state.cards[0]);
  await flush();
  const completedRound = host.state.round;
  hostConnection.emit('data', { v: 2, type: 'deal', round: completedRound - 1 });
  assert.equal(host.state.round, completedRound);
  hostConnection.emit('data', { v: 2, type: 'deal', round: completedRound });
  assert.equal(host.state.round, completedRound + 1);
  const guestDeal = host.state;
  hostConnection.emit('data', { v: 2, type: 'deal', round: completedRound });
  hostConnection.emit('data', { v: 2, type: 'select', round: guestDeal.round,
    cardId: guestDeal.cards[0], role: 'host' });
  assert.deepEqual(host.state, guestDeal);
  await flush();
  assert.deepEqual(host.state, guest.state);
});

test('out-of-deal and stale-round selections cannot alter host state', async t => {
  const { make, peers } = fixture(t);
  const host = make();
  const invite = await host.host();
  const guest = make();
  await guest.join(invite);
  host.deal();
  await flush();
  const hostPeer = peers.get(invite.hostId);
  const hostConnection = hostPeer.connections[0];
  const before = host.state;
  hostConnection.emit('data', { v: 2, type: 'select', round: 0, cardId: before.cards[0] });
  hostConnection.emit('data', { v: 2, type: 'select', round: 1, cardId: 'not-a-card' });
  hostConnection.emit('data', { v: 2, type: 'state', state: { ...before, selectedCard: before.cards[0] } });
  assert.deepEqual(host.state, before);
});

test('a second authenticated guest receives a clear full-table rejection', async t => {
  const { make } = fixture(t);
  const host = make();
  const invite = await host.host();
  const first = make();
  await first.join(invite);
  const errors = [];
  const second = make({ onError: message => errors.push(message) });
  await assert.rejects(second.join(invite), /already has a guest/);
  assert.match(errors[0], /already has a guest/);
  host.deal();
  await flush();
  assert.deepEqual(first.state, host.state);
});

test('wrong invite secret does not occupy the seat', async t => {
  const { make } = fixture(t);
  const host = make();
  const invite = await host.host();
  const intruder = make();
  const wrong = invite.secret === 'a'.repeat(32) ? 'b'.repeat(32) : 'a'.repeat(32);
  await assert.rejects(intruder.join({ ...invite, secret: wrong }), /invitation is invalid/);
  const guest = make();
  await guest.join(invite);
  assert.deepEqual(host.state, guest.state);
});

test('host close disables the guest and ends the session', async t => {
  const { make } = fixture(t);
  const statuses = [];
  const host = make();
  const invite = await host.host();
  const guest = make({ onStatus: event => statuses.push(event.phase) });
  await guest.join(invite);
  host.deal();
  await flush();
  host.close();
  assert.equal(guest.select(guest.state.cards[0]), false);
  await delay(15);
  assert.equal(statuses.at(-1), 'ended');
  assert.equal(host.deal(), false);
});

test('guest departure frees the host seat for a new guest', async t => {
  const { make } = fixture(t);
  const host = make();
  const invite = await host.host();
  const guest = make();
  await guest.join(invite);
  guest.close();
  await flush();
  const replacement = make();
  await replacement.join(invite);
  host.deal();
  await flush();
  assert.deepEqual(replacement.state, host.state);
});

test('guest departure pauses a guest-dealt hand until a new guest connects', async t => {
  const { make } = fixture(t);
  const host = make();
  const invite = await host.host();
  const guest = make();
  await guest.join(invite);
  host.deal();
  await flush();
  guest.select(guest.state.cards[0]);
  await flush();
  guest.deal();
  await flush();
  const hand = host.state;
  guest.close();
  await flush();
  assert.equal(host.select(hand.cards[0]), false);
  assert.equal(host.deal(), false);
  assert.deepEqual(host.state, hand);
  const replacement = make();
  await replacement.join(invite);
  assert.deepEqual(replacement.state, hand);
  assert.equal(host.select(hand.cards[0]), true);
  await flush();
  assert.equal(replacement.state.selectedCard, hand.cards[0]);
});

test('original host closing still ends the game during a guest-dealt round', async t => {
  const { make } = fixture(t);
  const statuses = [];
  const host = make();
  const invite = await host.host();
  const guest = make({ onStatus: event => statuses.push(event.phase) });
  await guest.join(invite);
  host.deal();
  await flush();
  guest.select(guest.state.cards[0]);
  await flush();
  guest.deal();
  await flush();
  assert.equal(guest.state.dealer, 'guest');
  host.close();
  assert.equal(guest.deal(), false);
  assert.equal(guest.select(guest.state.cards[0]), false);
  await delay(15);
  assert.equal(statuses.at(-1), 'ended');
});

test('signaling disconnect preserves the working data connection', async t => {
  const { make, peers } = fixture(t);
  const host = make();
  const invite = await host.host();
  const guest = make();
  await guest.join(invite);
  const hostPeer = peers.get(invite.hostId);
  hostPeer.disconnected = true;
  hostPeer.emit('disconnected');
  assert.equal(host.deal(), true);
  await flush();
  assert.deepEqual(guest.state, host.state);
});

test('invalid invites fail before constructing a peer', async t => {
  const { make, peers } = fixture(t);
  const guest = make();
  for (const invite of [null, {}, { hostId: '../../host', secret: 'a'.repeat(32) }, { hostId: 'ten-' + 'a'.repeat(32), secret: 'short' }]) {
    await assert.rejects(guest.join(invite), /incomplete or invalid/);
  }
  assert.equal(peers.size, 0);
});

test('state snapshots cannot mutate the host state', async t => {
  const { make } = fixture(t);
  const host = make();
  await host.host();
  host.deal();
  const snapshot = host.state;
  snapshot.cards[0] = 'fake';
  snapshot.round = 100;
  assert.notEqual(host.state.cards[0], 'fake');
  assert.equal(host.state.round, 1);
});

test('silent host pauses selection before timeout ends the session', async t => {
  const clock = manualClock();
  const { make, peers } = fixture(t, { timing: { heartbeat: 10, suspect: 30, dead: 50 } });
  const statuses = [];
  const host = make();
  const invite = await host.host();
  const guest = make({ timers: clock, onStatus: event => statuses.push(event.phase) });
  await guest.join(invite);
  host.deal();
  await flush();
  peers.get(invite.hostId).connections[0].muted = true;
  clock.tick(30);
  assert.equal(statuses.at(-1), 'reconnecting');
  assert.equal(guest.select(guest.state.cards[0]), false);
  clock.tick(20);
  assert.equal(statuses.at(-1), 'ended');
});

test('heartbeat recovers a temporarily unresponsive host before ending', async t => {
  const clock = manualClock();
  const { make, peers } = fixture(t, { timing: { heartbeat: 10, suspect: 30, dead: 50 } });
  const statuses = [];
  const host = make();
  const invite = await host.host();
  const guest = make({ timers: clock, onStatus: event => statuses.push(event.phase) });
  await guest.join(invite);
  const connection = peers.get(invite.hostId).connections[0];
  connection.muted = true;
  clock.tick(30);
  assert.equal(statuses.at(-1), 'reconnecting');
  connection.muted = false;
  await flush();
  assert.equal(statuses.at(-1), 'connected');
});

test('guest ignores malformed or stale host snapshots', async t => {
  const { make, peers } = fixture(t);
  const host = make();
  const invite = await host.host();
  const guest = make();
  await guest.join(invite);
  host.deal();
  await flush();
  const current = guest.state;
  const incoming = peers.get(invite.hostId).connections[0].other;
  incoming.emit('data', { v: 2, type: 'state', state: { ...current, revision: -1 } });
  incoming.emit('data', { v: 2, type: 'state', state: { ...current, cards: Array(10).fill('AS'), revision: 10 } });
  incoming.emit('data', { v: 2, type: 'state', state: { round: 0, revision: 0, cards: [], selectedCard: null } });
  assert.deepEqual(guest.state, current);
});

test('v1 guest receives a compatible version-mismatch rejection without occupying the seat', async t => {
  const { make, Peer } = fixture(t);
  const host = make();
  const invite = await host.host();
  const oldGuest = new Peer();
  t.after(() => oldGuest.destroy());
  const rejected = new Promise(resolve => {
    oldGuest.on('open', () => {
      const conn = oldGuest.connect(invite.hostId);
      conn.on('open', () => conn.send({ v: 1, type: 'hello', secret: invite.secret }));
      conn.on('data', resolve);
    });
  });
  assert.deepEqual(await rejected, { v: 1, type: 'reject', reason: 'version-mismatch' });
  const guest = make();
  await guest.join(invite);
  assert.deepEqual(guest.state, host.state);
});

test('new guest explains incompatible host versions during the handshake', async t => {
  const { make, Peer } = fixture(t);
  const invite = { hostId: 'ten-' + 'a'.repeat(32), secret: 'b'.repeat(32) };
  const oldHost = new Peer(invite.hostId);
  t.after(() => oldHost.destroy());
  oldHost.on('connection', conn => {
    conn.on('data', data => {
      if (data.type === 'hello') conn.send({ v: 1, type: 'welcome' });
    });
  });
  const errors = [];
  const guest = make({ onError: message => errors.push(message) });
  await assert.rejects(guest.join(invite), /different game versions.*Refresh both browsers/);
  assert.match(errors[0], /Refresh both browsers/);
});

test('silent old host startup timeout tells both players to update', async t => {
  const clock = manualClock();
  const { make, Peer } = fixture(t);
  const invite = { hostId: 'ten-' + 'a'.repeat(32), secret: 'b'.repeat(32) };
  const oldHost = new Peer(invite.hostId);
  t.after(() => oldHost.destroy());
  // A v1 host ignores v2 hello packets, so the new guest must time out clearly.
  oldHost.on('connection', conn => conn.on('data', () => {}));
  const guest = make({ timers: clock });
  const rejected = assert.rejects(guest.join(invite), /Refresh both browsers to update/);
  await flush();
  clock.tick(20000);
  await rejected;
});
