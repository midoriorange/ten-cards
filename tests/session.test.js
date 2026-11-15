import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSession, isValidInvite } from '../src/session.js';
import { createGame, getLegalActions, getActivePlayer } from '../src/game.js';

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

async function connectedPair(t, options = {}) {
  const fixtureValue = fixture(t, options);
  const host = fixtureValue.make(options.hostCallbacks);
  const invite = await host.host();
  const guest = fixtureValue.make(options.guestCallbacks);
  await guest.join(invite);
  return { ...fixtureValue, host, guest, invite };
}

async function submit(host, guest, role, action) {
  const before = host.state.revision;
  assert.equal((role === 'host' ? host : guest).act(action), true, `sent ${role} ${action.type}`);
  await flush();
  assert.equal(host.state.revision, before + 1, `accepted ${role} ${action.type}`);
  assert.deepEqual(guest.state, host.state);
}

async function reachPlay(host, guest, bidder = 'guest') {
  await submit(host, guest, 'host', { type: 'deal' });
  assert.equal(host.state.phase, 'auction');
  if (bidder === 'guest') {
    await submit(host, guest, 'guest', { type: 'bid', number: 3, mode: 'high' });
    await submit(host, guest, 'host', { type: 'pass' });
    assert.equal(host.state.phase, 'kitty');
  } else {
    await submit(host, guest, 'guest', { type: 'pass' });
    await submit(host, guest, 'host', { type: 'bid', number: 3, mode: 'high' });
    assert.equal(host.state.phase, 'trump_before');
    await submit(host, guest, 'host', { type: 'trump', suit: 'S' });
    assert.equal(host.state.phase, 'kitty');
  }
  const four = [...host.state.hands[bidder], ...host.state.kitty].slice(0, 4);
  await submit(host, guest, bidder, { type: 'discard', cards: four });
  if (bidder === 'guest') {
    assert.equal(host.state.phase, 'trump_after');
    await submit(host, guest, 'guest', { type: 'trump', suit: 'S' });
  }
  assert.equal(host.state.phase, 'play');
}

function chooseAction(state, preferTable = false) {
  const role = getActivePlayer(state);
  const legal = getLegalActions(state, role);
  if (legal.canDeal) return { role, action: { type: 'deal' } };
  if (legal.canBid && state.auction.entries.length === 0) {
    return { role, action: { type: 'bid', ...legal.bids[0] } };
  }
  if (legal.canPass) return { role, action: { type: 'pass' } };
  if (legal.canBid) return { role, action: { type: 'bid', ...legal.bids[0] } };
  if (legal.canCallTrump) return { role, action: { type: 'trump', suit: 'S' } };
  if (legal.canDiscard) return { role, action: {
    type: 'discard', cards: [...state.hands[role], ...state.kitty].slice(0, 4),
  } };
  if (preferTable && legal.tableStacks.length) return { role, action: { type: 'playTable', stackIndex: legal.tableStacks[0] } };
  if (legal.handCards.length) return { role, action: { type: 'playHand', cardId: legal.handCards[0] } };
  if (legal.tableStacks.length) return { role, action: { type: 'playTable', stackIndex: legal.tableStacks[0] } };
  if (legal.canContinue) return { role, action: { type: 'continue' } };
  if (legal.canNewMatch) return { role, action: { type: 'newMatch' } };
  assert.fail(`No legal action for ${role} in ${state.phase}`);
}

test('browser timers retain the global receiver through startup, heartbeat and cleanup', async () => {
  const names = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
  const originals = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  const calls = Object.fromEntries(names.map(name => [name, 0]));
  const { Peer } = fakeNetwork();
  const sessions = [];
  try {
    // Node timers accept arbitrary receivers; model the browser receiver check.
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
    await submit(host, guest, 'host', { type: 'deal' });
    await submit(host, guest, 'guest', { type: 'bid', number: 3, mode: 'high' });
    await new Promise(resolve => Reflect.apply(originals.setTimeout, globalThis, [resolve, 5]));
    host.close();
    guest.close();
    for (const name of names) assert(calls[name] > 0, `${name} was exercised`);
  } finally {
    Object.assign(globalThis, originals);
    for (const session of sessions) {
      try { session.close(); } catch { /* Preserve the original assertion. */ }
    }
  }
});

test('host creates an unguessable invitation and authenticates one guest', async t => {
  const hostStatuses = [];
  const guestStatuses = [];
  const presence = [];
  const { host, guest, invite } = await connectedPair(t, {
    hostCallbacks: { onStatus: event => hostStatuses.push(event.phase), onGuest: value => presence.push(value) },
    guestCallbacks: { onStatus: event => guestStatuses.push(event.phase) },
  });
  assert.equal(isValidInvite(invite), true);
  assert.match(invite.hostId, /^ten-[a-f0-9]{32}$/);
  assert.match(invite.secret, /^[a-f0-9]{32}$/);
  assert.equal(host.role, 'host');
  assert.equal(guest.role, 'guest');
  assert.equal(hostStatuses.at(-1), 'connected');
  assert.equal(guestStatuses.at(-1), 'connected');
  assert.deepEqual(presence, [false, true]);
  assert.deepEqual(host.state, guest.state);
});

test('all game actions wait for a connected authenticated opponent', async t => {
  const { make } = fixture(t);
  const host = make();
  const invite = await host.host();
  assert.equal(host.act({ type: 'deal' }), false);
  assert.equal(host.state.revision, 0);
  const guest = make();
  await guest.join(invite);
  await submit(host, guest, 'host', { type: 'deal' });
  const before = host.state;
  guest.close();
  assert.equal(host.act({ type: 'pass' }), false);
  assert.equal(guest.act({ type: 'bid', number: 3, mode: 'high' }), false);
  assert.deepEqual(host.state, before);
});

test('auction, kitty, trump, action-hand and table plays remain synchronized', async t => {
  const { host, guest } = await connectedPair(t);
  await reachPlay(host, guest);
  const seen = new Set([host.state.phase]);
  let handPlays = 0;
  let tablePlays = 0;
  for (let i = 0; i < 200 && !['game_over', 'match_over'].includes(host.state.phase); i++) {
    const { role, action } = chooseAction(host.state, i % 2 === 0);
    if (action.type === 'playHand') handPlays++;
    if (action.type === 'playTable') tablePlays++;
    await submit(host, guest, role, action);
    seen.add(host.state.phase);
  }
  assert(handPlays > 0);
  assert(tablePlays > 0);
  assert(seen.has('pack_complete'));
  assert(['game_over', 'match_over'].includes(host.state.phase));
});

test('dealer winning the auction calls trump before the kitty exchange', async t => {
  const { host, guest } = await connectedPair(t);
  await reachPlay(host, guest, 'host');
  assert.deepEqual(host.state, guest.state);
});

test('every card play reaches both peers immediately and the pack winner leads without continue', async t => {
  const hostObserved = [];
  const guestObserved = [];
  const { host, guest } = await connectedPair(t, {
    hostCallbacks: { onState: state => hostObserved.push(state) },
    guestCallbacks: { onState: state => guestObserved.push(state) },
  });
  await reachPlay(host, guest);
  const played = [];
  for (let i = 0; i < 4; i++) {
    const before = host.state;
    const role = getActivePlayer(before);
    const legal = getLegalActions(before, role);
    const action = i < 2
      ? { type: 'playHand', cardId: legal.handCards[0] }
      : { type: 'playTable', stackIndex: legal.tableStacks[0] };
    played.push(i < 2 ? action.cardId : before.table[role][action.stackIndex][0]);
    await submit(host, guest, role, action);
    for (const snapshot of [host.state, guest.state, hostObserved.at(-1), guestObserved.at(-1)]) {
      const visible = snapshot.currentPack ?? snapshot.history.at(-1);
      assert.equal(visible.number, 1);
      assert.deepEqual(visible.plays.map(play => play.cardId), played,
        `both peers display all ${i + 1} played cards before another action`);
      if (i < 3) {
        assert.equal(snapshot.phase, 'play');
        assert.equal(snapshot.history.length, 0);
      } else {
        assert.equal(snapshot.phase, 'pack_complete');
        assert.equal(snapshot.history.length, 1);
        assert.equal(visible.plays.length, 4);
      }
    }
  }

  const complete = structuredClone(host.state.history[0]);
  const winner = complete.winner;
  const cardId = getLegalActions(host.state, winner).handCards[0];
  assert(host.state.hands[winner].includes(cardId));
  const revision = host.state.revision;
  await submit(host, guest, winner, { type: 'playHand', cardId });
  assert.equal(host.state.revision, revision + 1, 'leading starts the next pack in one action');
  for (const snapshot of [host.state, guest.state, hostObserved.at(-1), guestObserved.at(-1)]) {
    assert.equal(snapshot.phase, 'play');
    assert.equal(snapshot.currentPack.number, 2);
    assert.equal(snapshot.currentPack.leader, winner);
    assert.equal(snapshot.currentPack.plays.length, 1);
    assert.equal(snapshot.currentPack.plays[0].cardId, cardId);
    assert.deepEqual(snapshot.history, [complete], 'the previous four-card pack remains in history');
  }
});

test('authenticated guest cannot forge host actions or replace official state', async t => {
  const guestSnapshots = [];
  const { host, guest, peers, invite } = await connectedPair(t, {
    guestCallbacks: { onState: state => guestSnapshots.push(state) },
  });
  const conn = peers.get(invite.hostId).connections[0];
  const before = host.state;
  conn.emit('data', { v: 4, type: 'action', revision: 0, role: 'host', action: { type: 'deal', role: 'host' } });
  conn.emit('data', { v: 4, type: 'state', state: { ...before, revision: 100 } });
  await flush();
  assert.deepEqual(host.state, before);
  assert.deepEqual(guest.state, before);
  assert(guestSnapshots.length > 1, 'invalid action acknowledged with an unchanged snapshot');
  await submit(host, guest, 'host', { type: 'deal' });
  const auction = host.state;
  conn.emit('data', { v: 4, type: 'action', revision: auction.revision, role: 'host',
    action: { type: 'bid', number: 3, mode: 'high', role: 'host' } });
  await flush();
  assert.equal(host.state.revision, auction.revision + 1);
  assert.equal(host.state.auction.entries[0].role, 'guest');
  assert.deepEqual(host.state, guest.state);
});

test('stale and duplicate guest actions acknowledge current state without applying twice', async t => {
  const guestSnapshots = [];
  const { host, guest, peers, invite } = await connectedPair(t, {
    guestCallbacks: { onState: state => guestSnapshots.push(state) },
  });
  await submit(host, guest, 'host', { type: 'deal' });
  const conn = peers.get(invite.hostId).connections[0];
  const revision = host.state.revision;
  const bid = { v: 4, type: 'action', revision, action: { type: 'bid', number: 3, mode: 'high' } };
  conn.emit('data', bid);
  conn.emit('data', bid);
  conn.emit('data', { ...bid, revision: revision - 1 });
  await flush();
  assert.equal(host.state.revision, revision + 1);
  assert.equal(host.state.auction.entries.length, 1);
  assert.deepEqual(guest.state, host.state);
  const before = guestSnapshots.length;
  conn.emit('data', { ...bid, revision: host.state.revision, action: { type: 'not-a-move' } });
  await flush();
  assert.equal(guestSnapshots.length, before + 1, 'equal revision still calls onState to clear pending input');
  assert.equal(host.state.revision, revision + 1);
});

test('malformed and oversized action requests cannot alter official state', async t => {
  const { host, guest, peers, invite } = await connectedPair(t);
  const conn = peers.get(invite.hostId).connections[0];
  for (const value of [null, [], {}, { type: '' }, { type: 'x'.repeat(41) },
    { type: 'deal', extra: 'x'.repeat(5000) }, { type: 'deal', value: 1n }]) {
    assert.equal(guest.act(value), false);
  }
  const before = host.state;
  conn.emit('data', { v: 4, type: 'action', revision: before.revision, action: { type: 'deal', extra: 'x'.repeat(5000) } });
  conn.emit('data', { v: 4, type: 'action', revision: NaN, action: { type: 'deal' } });
  conn.emit('data', { v: 4, type: 'action', revision: '0', action: { type: 'deal' } });
  await flush();
  assert.deepEqual(host.state, before);
  assert.deepEqual(guest.state, before);
});

test('late replacement guest receives the complete current game', async t => {
  const { host, guest, invite, make } = await connectedPair(t);
  await reachPlay(host, guest);
  const first = chooseAction(host.state);
  await submit(host, guest, first.role, first.action);
  const snapshot = host.state;
  guest.close();
  await flush();
  const replacement = make();
  await replacement.join(invite);
  assert.deepEqual(replacement.state, snapshot);
  assert.deepEqual(host.state, snapshot);
});

test('deep snapshots and callback arguments cannot mutate either player’s official state', async t => {
  const { host, guest } = await connectedPair(t, {
    hostCallbacks: { onState: state => {
      if (state.hands?.host?.length) state.hands.host[0] = 'fake-host-callback';
    } },
    guestCallbacks: { onState: state => {
      if (state.table?.guest?.[0]?.length) state.table.guest[0][0] = 'fake-guest-callback';
    } },
  });
  await submit(host, guest, 'host', { type: 'deal' });
  const snapshot = host.state;
  snapshot.hands.host[0] = 'fake-getter';
  snapshot.table.guest[0][0] = 'fake-nested';
  snapshot.auction.entries.push({ type: 'pass', role: 'host' });
  assert.notEqual(host.state.hands.host[0], 'fake-getter');
  assert.notEqual(host.state.table.guest[0][0], 'fake-nested');
  assert.equal(host.state.auction.entries.length, 0);
  assert.deepEqual(host.state, guest.state);
});

test('second authenticated guest receives a full-table rejection', async t => {
  const { host, guest, invite, make } = await connectedPair(t);
  const errors = [];
  const second = make({ onError: message => errors.push(message) });
  await assert.rejects(second.join(invite), /already has a guest/);
  assert.match(errors[0], /already has a guest/);
  await submit(host, guest, 'host', { type: 'deal' });
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

test('signaling disconnect preserves the working game connection', async t => {
  const { host, guest, peers, invite } = await connectedPair(t);
  const hostPeer = peers.get(invite.hostId);
  hostPeer.disconnected = true;
  hostPeer.emit('disconnected');
  await submit(host, guest, 'host', { type: 'deal' });
});

test('invalid invites fail before constructing a peer', async t => {
  const { make, peers } = fixture(t);
  const guest = make();
  for (const invite of [null, {}, { hostId: '../../host', secret: 'a'.repeat(32) },
    { hostId: 'ten-' + 'a'.repeat(32), secret: 'short' }]) {
    await assert.rejects(guest.join(invite), /incomplete or invalid/);
  }
  assert.equal(peers.size, 0);
});

test('silent host pauses actions before the timeout ends the session', async t => {
  const clock = manualClock();
  const statuses = [];
  const { host, guest, peers, invite } = await connectedPair(t, {
    timing: { heartbeat: 10, suspect: 30, dead: 50 },
    guestCallbacks: { timers: clock, onStatus: event => statuses.push(event.phase) },
  });
  await submit(host, guest, 'host', { type: 'deal' });
  peers.get(invite.hostId).connections[0].muted = true;
  clock.tick(30);
  assert.equal(statuses.at(-1), 'reconnecting');
  assert.equal(guest.act({ type: 'bid', number: 3, mode: 'high' }), false);
  clock.tick(20);
  assert.equal(statuses.at(-1), 'ended');
});

test('heartbeats recover a briefly unresponsive host before ending', async t => {
  const clock = manualClock();
  const statuses = [];
  const { peers, invite } = await connectedPair(t, {
    timing: { heartbeat: 10, suspect: 30, dead: 50 },
    guestCallbacks: { timers: clock, onStatus: event => statuses.push(event.phase) },
  });
  const connection = peers.get(invite.hostId).connections[0];
  connection.muted = true;
  clock.tick(30);
  assert.equal(statuses.at(-1), 'reconnecting');
  connection.muted = false;
  await flush();
  assert.equal(statuses.at(-1), 'connected');
});

test('guest ignores malformed or stale host state snapshots', async t => {
  const { host, guest, peers, invite } = await connectedPair(t);
  await submit(host, guest, 'host', { type: 'deal' });
  const before = guest.state;
  const incoming = peers.get(invite.hostId).connections[0].other;
  incoming.emit('data', { v: 4, type: 'state', state: { ...before, revision: -1 } });
  const malformed = structuredClone(before);
  malformed.hands.host[0] = 'fake-card';
  malformed.revision = 999;
  incoming.emit('data', { v: 4, type: 'state', state: malformed });
  incoming.emit('data', { v: 4, type: 'state', state: createGame() });
  assert.deepEqual(guest.state, before);
});

test('v1, v2 and v3 guests get compatible version rejection without occupying the seat', async t => {
  const { make, Peer } = fixture(t);
  const host = make();
  const invite = await host.host();
  for (const version of [1, 2, 3]) {
    const oldGuest = new Peer();
    t.after(() => oldGuest.destroy());
    const rejected = new Promise(resolve => {
      oldGuest.on('open', () => {
        const conn = oldGuest.connect(invite.hostId);
        conn.on('open', () => conn.send({ v: version, type: 'hello', secret: invite.secret }));
        conn.on('data', resolve);
      });
    });
    assert.deepEqual(await rejected, { v: version, type: 'reject', reason: 'version-mismatch' });
  }
  const guest = make();
  await guest.join(invite);
  assert.deepEqual(guest.state, host.state);
});

test('new guest explains incompatible host versions during the handshake', async t => {
  const { make, Peer } = fixture(t);
  const invite = { hostId: 'ten-' + 'a'.repeat(32), secret: 'b'.repeat(32) };
  const oldHost = new Peer(invite.hostId);
  t.after(() => oldHost.destroy());
  oldHost.on('connection', conn => conn.on('data', data => {
    if (data.type === 'hello') conn.send({ v: 2, type: 'welcome' });
  }));
  const guest = make();
  await assert.rejects(guest.join(invite), /different game versions.*Refresh both browsers/);
});

test('silent old host startup timeout tells both players to update', async t => {
  const clock = manualClock();
  const { make, Peer } = fixture(t);
  const invite = { hostId: 'ten-' + 'a'.repeat(32), secret: 'b'.repeat(32) };
  const oldHost = new Peer(invite.hostId);
  t.after(() => oldHost.destroy());
  oldHost.on('connection', conn => conn.on('data', () => {}));
  const guest = make({ timers: clock });
  const rejected = assert.rejects(guest.join(invite), /Refresh both browsers to update/);
  await flush();
  clock.tick(20000);
  await rejected;
});

test('a complete match synchronizes all phases and newMatch keeps revisions monotonic', async t => {
  const { host, guest } = await connectedPair(t);
  const phases = new Set([host.state.phase]);
  for (let i = 0; i < 2000 && host.state.phase !== 'match_over'; i++) {
    const { role, action } = chooseAction(host.state, i % 2 === 0);
    await submit(host, guest, role, action);
    phases.add(host.state.phase);
  }
  assert.equal(host.state.phase, 'match_over');
  for (const phase of ['auction', 'kitty', 'trump_after', 'play', 'pack_complete']) assert(phases.has(phase));
  const before = host.state.revision;
  await submit(host, guest, 'host', { type: 'newMatch' });
  assert.equal(host.state.revision, before + 1);
  const { revision, ...reset } = host.state;
  const { revision: initialRevision, ...initial } = createGame();
  assert.deepEqual(reset, initial);
});

test('original host closure ends sessions in every game phase', async t => {
  for (const target of ['lobby', 'auction', 'trump_before', 'kitty', 'trump_after',
    'play', 'pack_complete', 'game_over', 'match_over']) {
    await t.test(target, async subtest => {
      const statuses = [];
      const { host, guest } = await connectedPair(subtest, {
        guestCallbacks: { onStatus: event => statuses.push(event.phase) },
      });
      if (target === 'trump_before') {
        await submit(host, guest, 'host', { type: 'deal' });
        await submit(host, guest, 'guest', { type: 'pass' });
        await submit(host, guest, 'host', { type: 'bid', number: 3, mode: 'high' });
      } else {
        for (let i = 0; i < 2000 && host.state.phase !== target; i++) {
          const { role, action } = chooseAction(host.state, i % 2 === 0);
          await submit(host, guest, role, action);
        }
      }
      assert.equal(host.state.phase, target);
      host.close();
      assert.equal(guest.act({ type: 'deal' }), false);
      assert.equal(host.act({ type: 'deal' }), false);
      await delay(15);
      assert.equal(statuses.at(-1), 'ended');
    });
  }
});

