import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { APP_VERSION } from '../src/version.js';
import { describeCard } from '../src/game.js';
import { moveHandCard, sortHandOrder } from '../src/hand-order.js';

const root = new URL('../', import.meta.url);
const flush = () => new Promise(resolve => setImmediate(resolve));

// This is a DOM simulation of the actual application code, not a browser or a
// visual-layout test. It checks the nodes that real UI actions ask to render.
function createDocument(html) {
  const elements = new Map();
  const document = { activeElement: null };
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = new Map();
      this.dataset = {};
      this.events = new Map();
      this.className = '';
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.text = '';
      this.style = {};
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: (...names) => {
          this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' ');
        },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
        toggle: (name, force) => {
          const classes = new Set(this.className.split(/\s+/).filter(Boolean));
          const present = force === undefined ? !classes.has(name) : force;
          if (present) classes.add(name); else classes.delete(name);
          this.className = [...classes].join(' ');
          return present;
        },
      };
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'class') this.className = String(value);
      if (name.startsWith('data-')) this.dataset[name.slice(5)] = String(value);
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    append(...children) {
      for (const child of children) { child.parentElement = this; this.children.push(child); }
    }
    replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
    addEventListener(name, listener) {
      if (!this.events.has(name)) this.events.set(name, []);
      this.events.get(name).push(listener);
    }
    async fire(name, properties = {}) {
      if (name === 'click') {
        assert.equal(this.disabled, false, 'the tested control must be enabled');
        assert.equal(this.hidden, false, 'the tested control must be visible');
        this.focus();
      }
      const event = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...properties };
      await Promise.all((this.events.get(name) || []).map(listener => listener(event)));
      await flush();
    }
    focus() { document.activeElement = this; }
    select() {}
    scrollIntoView() {}
    remove() {}
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }
    querySelectorAll(selector) {
      const data = selector.match(/^\[data-(card|stack)(?:="([^"]+)")?\]$/);
      const matches = element => data
        ? Object.hasOwn(element.dataset, data[1]) && (data[2] === undefined || element.dataset[data[1]] === data[2])
        : selector.startsWith('.') ? element.classList.contains(selector.slice(1))
          : element.tagName === selector.toUpperCase();
      const found = [];
      function visit(element) {
        for (const child of element.children) { if (matches(child)) found.push(child); visit(child); }
      }
      visit(this);
      return found;
    }
  }
  for (const tag of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const id = tag[2].match(/\bid="([^"]+)"/)?.[1];
    if (!id) continue;
    const element = new Element(tag[1]);
    element.hidden = /(?:^|\s)hidden(?:\s|$)/.test(tag[2]);
    elements.set(id, element);
  }
  const brand = new Element('a');
  document.getElementById = id => {
    assert(elements.has(id), `the page must contain #${id}`);
    return elements.get(id);
  };
  document.querySelector = selector => selector === '.brand' ? brand : null;
  document.createElement = tag => new Element(tag);
  document.head = new Element('head');
  return document;
}

function fakeNetwork() {
  const peers = new Map();
  let sequence = 0;
  let latestState = null;
  let actionCount = 0;
  class Connection extends EventEmitter {
    constructor() { super(); this.open = false; this.other = null; }
    send(value) {
      if (!this.open) throw new Error('Closed data channel');
      const copied = structuredClone(value);
      if (copied.type === 'action') actionCount += 1;
      if (copied.state) latestState = structuredClone(copied.state);
      queueMicrotask(() => { if (this.other.open) this.other.emit('data', copied); });
    }
    close() {
      if (!this.open) return;
      this.open = false;
      this.emit('close');
      if (this.other.open) {
        this.other.open = false;
        this.other.emit('close');
      }
    }
  }
  class Peer extends EventEmitter {
    constructor(id) {
      super();
      this.id = id ?? `guest-${++sequence}`;
      this.connections = [];
      this.destroyed = false;
      this.disconnected = false;
      peers.set(this.id, this);
      queueMicrotask(() => { if (!this.destroyed) this.emit('open', this.id); });
    }
    connect(id) {
      const outgoing = new Connection();
      this.connections.push(outgoing);
      queueMicrotask(() => {
        const destination = peers.get(id);
        if (!destination) { this.emit('error', { type: 'peer-unavailable' }); return; }
        const incoming = new Connection();
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
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      peers.delete(this.id);
      for (const connection of this.connections) connection.close();
      this.emit('close');
    }
  }
  return { Peer, get state() { return latestState; }, get actionCount() { return actionCount; } };
}

async function loadAppSource() {
  const sources = [];
  for (const name of ['version', 'game', 'view', 'hand-order', 'session', 'invite', 'config', 'app']) {
    let source = await readFile(new URL(`src/${name}.js`, root), 'utf8');
    const exports = [...source.matchAll(/^export (?:const|function) (\w+)/gm)].map(match => match[1]);
    source = source.replace(/^import \{([^}]+)\} from ['"]\.\/([\w-]+)\.js['"];\r?\n/gm,
      (_, names, dependency) => `const {${names}} = testModules[${JSON.stringify(dependency)}];\n`);
    source = source.replace(/^export (?=(?:const|function)\b)/gm, '');
    sources.push(`testModules[${JSON.stringify(name)}] = (() => {\n${source}\nreturn {${exports.join(',')}};\n})();`);
  }
  return `(() => { 'use strict'; const testModules = {};\n${sources.join('\n\n')}\n})();`;
}

function createApp(html, source, Peer) {
  const document = createDocument(html);
  const events = new Map();
  const errors = [];
  const context = vm.createContext({
    document, Peer, URL, URLSearchParams, crypto: globalThis.crypto, structuredClone,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    RTCPeerConnection: function () {},
    location: { protocol: 'https:', href: 'https://example.test/ten-cards/', hash: '', pathname: '/ten-cards/', search: '' },
    history: { replaceState() {} }, navigator: { clipboard: { async writeText() {} } },
    console: { ...console, error: (...args) => errors.push(args) },
  });
  context.window = {
    addEventListener(name, callback) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(callback);
    },
  };
  new vm.Script(source, { filename: 'Ten Cards actual app modules' }).runInContext(context);
  return {
    get: id => document.getElementById(id),
    errors,
    close() { for (const listener of events.get('pagehide') || []) listener({}); },
  };
}

function nodes(element) {
  return [element, ...element.children.flatMap(child => nodes(child))];
}
function faceNodes(element) {
  return nodes(element).filter(node => Object.hasOwn(node.dataset, 'card'));
}
function legalCards(element) {
  return faceNodes(element).filter(node => node.tagName === 'BUTTON' && !node.disabled && !node.hidden);
}
function assertNoHiddenIdentities(element, cards) {
  for (const node of nodes(element)) {
    for (const card of cards) {
      assert(!Object.values(node.dataset).includes(card), `Hidden ${card} must not appear in DOM data`);
      assert(!node.textContent.includes(describeCard(card).name), 'Hidden card names must not be rendered');
      assert(![...node.attributes.values()].some(value => value.includes(describeCard(card).name)),
        'Hidden names must not appear in accessible labels or attributes');
    }
  }
}
function assertPrivateCards(apps, state) {
  const reveal = state.phase === 'game_over' || state.phase === 'match_over';
  for (const [role, app] of Object.entries(apps)) {
    const other = role === 'host' ? 'guest' : 'host';
    if (!reveal) {
      assert.equal(faceNodes(app.get('opponent-hand')).length, 0);
      assertNoHiddenIdentities(app.get('opponent-hand'), state.hands[other]);
      for (const [region, owner] of [['own-table', role], ['opponent-table', other]]) {
        const played = index => state.currentPack?.plays.some(play =>
          play.role === owner && play.source === 'table' && play.stackIndex === index);
        const buried = state.table[owner].flatMap((stack, index) => played(index) ? stack : stack.slice(1));
        assertNoHiddenIdentities(app.get(region), buried);
        if (!['play', 'pack_complete'].includes(state.phase)) {
          assertNoHiddenIdentities(app.get(region), state.table[owner].flat());
        } else {
          const expectedTops = state.table[owner].flatMap((stack, index) =>
            stack.length && !played(index) ? [stack[0]] : []);
          assert.deepEqual(faceNodes(app.get(region)).map(node => node.dataset.card).sort(), expectedTops.sort(),
            'Only unplayed exposed tops are visible; replacements wait until the whole pack is complete');
        }
      }
    } else {
      assert.equal(faceNodes(app.get('opponent-hand')).length, state.hands[other].length,
        'The opponent’s remaining hand is revealed after the game');
      assert.equal(faceNodes(app.get('discard-cards')).length, 4,
        'The four discarded cards are revealed after the game');
    }
  }
}
function handOrder(app) { return faceNodes(app.get('own-hand')).map(node => node.dataset.card); }
function handNode(app, id) {
  const node = faceNodes(app.get('own-hand')).find(card => card.dataset.card === id);
  assert(node, `The hand must still contain ${id}`);
  return node;
}
async function assertLocalArrangement(app, opponent, network, bidMode = 'high') {
  const original = handOrder(app);
  const otherOrder = handOrder(opponent);
  const revision = network.state.revision;
  const remoteActions = network.actionCount;
  async function resetSelection() {
    await app.get('arrange-toggle').fire('click');
    await app.get('arrange-toggle').fire('click');
  }
  function assertLocal(expected) {
    assert.deepEqual(handOrder(app), expected);
    assert.deepEqual(handOrder(opponent), otherOrder, 'Reordering must not rearrange the other participant’s hand');
    assert.equal(network.state.revision, revision, 'Arrangement never submits a game move');
    assert.equal(network.actionCount, remoteActions, 'Arrangement never sends a remote action');
    assert.equal(app.get('error-panel').hidden, true);
  }

  await app.get('arrange-toggle').fire('click');
  assert.equal(app.get('arrange-controls').hidden, false);
  assert.match(app.get('arrange-toggle').textContent, /Done arranging/i);
  await handNode(app, original[0]).fire('click');
  await handNode(app, original[3]).fire('click');
  let expected = moveHandCard(original, original[0], 3);
  assertLocal(expected);

  await resetSelection();
  await handNode(app, original[0]).fire('click');
  await app.get('move-left').fire('click');
  expected = moveHandCard(expected, original[0], 2);
  assertLocal(expected);
  await app.get('move-right').fire('click');
  expected = moveHandCard(expected, original[0], 3);
  assertLocal(expected);
  await handNode(app, original[0]).fire('keydown', { key: 'ArrowLeft' });
  expected = moveHandCard(expected, original[0], 2);
  assertLocal(expected);
  await handNode(app, original[0]).fire('keydown', { key: 'ArrowRight' });
  expected = moveHandCard(expected, original[0], 3);
  assertLocal(expected);

  await resetSelection();
  const draggedId = expected[0];
  const targetId = expected.at(-1);
  const data = new Map();
  const dataTransfer = {
    setData(type, value) { data.set(type, value); },
    getData(type) { return data.get(type) || ''; },
  };
  const draggedNode = handNode(app, draggedId);
  await draggedNode.fire('dragstart', { dataTransfer });
  await handNode(app, targetId).fire('dragover', { dataTransfer });
  await handNode(app, targetId).fire('drop', { dataTransfer });
  await draggedNode.fire('dragend', { dataTransfer });
  expected = moveHandCard(expected, draggedId, expected.length - 1);
  assertLocal(expected);
  // A synthetic click sometimes follows a drop. It must not move/play again.
  await handNode(app, targetId).fire('click');
  assertLocal(expected);

  await app.get('sort-suit').fire('click');
  expected = sortHandOrder(expected, 'suit', bidMode);
  assertLocal(expected);
  await app.get('sort-rank').fire('click');
  expected = sortHandOrder(expected, 'rank', bidMode);
  assertLocal(expected);
  await app.get('arrange-toggle').fire('click');
  assert.equal(app.get('arrange-controls').hidden, true);
  assertLocal(expected);
  return expected;
}
async function assertTablePlayPausedByArrangement(app, network) {
  const tableCard = legalCards(app.get('own-table'))[0];
  assert(tableCard, 'This regression starts during a legal table-card turn');
  const originalOrder = handOrder(app);
  const revision = network.state.revision;
  const remoteActions = network.actionCount;
  await app.get('arrange-toggle').fire('click');
  assert.equal(legalCards(app.get('own-table')).length, 0,
    'Arrange mode disables every table-card play control');
  // Also exercise the action guard behind a previously rendered event handler.
  await tableCard.fire('click');
  assert.equal(network.state.revision, revision);
  assert.equal(network.actionCount, remoteActions);
  await handNode(app, originalOrder[0]).fire('click');
  await handNode(app, originalOrder[1]).fire('click');
  assert.deepEqual(handOrder(app), moveHandCard(originalOrder, originalOrder[0], 1));
  assert.equal(network.state.revision, revision, 'Reordering during a table turn does not play anything');
  assert.equal(network.actionCount, remoteActions);
  await app.get('arrange-toggle').fire('click');
  assert(legalCards(app.get('own-table')).some(card => card.dataset.card === tableCard.dataset.card),
    'Done arranging restores the legal table play immediately');
}
function assertPackDisplays(apps, state) {
  const pack = state.currentPack || (['pack_complete', 'game_over', 'match_over'].includes(state.phase)
    ? state.history.at(-1) : null);
  const expected = pack?.plays.map(play => play.cardId) || [];
  for (const app of Object.values(apps)) {
    const main = faceNodes(app.get('pack-cards'));
    const compact = faceNodes(app.get('live-pack-cards'));
    assert.deepEqual(main.map(card => card.dataset.card), expected,
      'Every individual play must immediately appear on the main table');
    assert.deepEqual(compact.map(card => card.dataset.card), expected,
      'Every individual play must immediately appear in the sticky live pack');
    for (const card of main) {
      assert.equal(card.style.width, '100%');
      assert.equal(card.style.height, 'clamp(99px, 13vw, 132px)');
    }
    for (const card of compact) {
      assert.equal(card.style.width, '42px');
      assert.equal(card.style.height, '58px');
    }
  }
}
async function discardKitty(app) {
  assert.equal(app.get('discard-controls').hidden, false);
  assert.equal(app.get('discard-button').disabled, true);
  for (let index = 0; index < 4; index += 1) {
    const card = legalCards(app.get('kitty-cards')).find(node => node.getAttribute('aria-pressed') !== 'true');
    assert(card, 'The bid winner must be able to choose a kitty card for discard');
    await card.fire('click');
  }
  assert.match(app.get('discard-counter').textContent, /4/);
  await app.get('discard-button').fire('click');
}
async function finishGame(apps, network, coverage) {
  let steps = 0;
  while (!['game_over', 'match_over'].includes(network.state.phase)) {
    assert(steps++ < 100, 'A game should finish within twelve four-card packs');
    const before = network.state;
    assertPrivateCards(apps, before);
    assertPackDisplays(apps, before);
    if (!coverage.tableArrangement && before.phase === 'play') {
      const app = Object.values(apps).find(candidate => legalCards(candidate.get('own-table')).length);
      if (app) {
        await assertTablePlayPausedByArrangement(app, network);
        coverage.tableArrangement = true;
      }
    }
    const oldOrders = Object.fromEntries(Object.entries(apps).map(([role, app]) => [role, handOrder(app)]));
    let actor;
    let chosenId;
    let playedFromHand = false;
    if (before.phase === 'pack_complete') {
      for (const app of Object.values(apps)) {
        assert.equal(app.get('next-controls').hidden, true, 'No separate continue click is required');
        assert.equal(faceNodes(app.get('pack-cards')).length, 4,
          'The completed pack stays visible until the next lead is actually played');
      }
      actor = before.history.at(-1).winner;
      const card = legalCards(apps[actor].get('own-hand'))[0];
      assert(card, 'The pack winner can lead directly from a legal hand card');
      chosenId = card.dataset.card;
      playedFromHand = true;
      await card.fire('click');
      assert.equal(network.state.phase, 'play');
      assert.equal(network.state.currentPack.plays.length, 1);
      assert.equal(network.state.currentPack.plays[0].cardId, chosenId);
    } else {
      assert.equal(before.phase, 'play');
      let acted = false;
      for (const [role, app] of Object.entries(apps)) {
        const handCard = legalCards(app.get('own-hand'))[0];
        const card = handCard || legalCards(app.get('own-table'))[0];
        if (card) {
          actor = role; chosenId = card.dataset.card; playedFromHand = Boolean(handCard);
          await card.fire('click'); acted = true; break;
        }
      }
      assert(acted, 'The active player must have a legal hand or table card');
    }
    assert(network.state.revision > before.revision, 'Every UI action must reach the shared state');
    assertPackDisplays(apps, network.state);
    for (const [role, app] of Object.entries(apps)) {
      const expected = playedFromHand && role === actor ? oldOrders[role].filter(id => id !== chosenId) : oldOrders[role];
      assert.deepEqual(handOrder(app), expected,
        'Remote updates preserve local hand order; a hand play removes only the played card');
    }
  }
  assertPrivateCards(apps, network.state);
  for (const app of Object.values(apps)) assert.equal(app.get('result-panel').hidden, false);
}

async function assertFullGameUi(t, html, source) {
  const network = fakeNetwork();
  const host = createApp(html, source, network.Peer);
  const guest = createApp(html, source, network.Peer);
  const apps = { host, guest };
  const coverage = { tableArrangement: false };
  t.after(() => { host.close(); guest.close(); });
  assert.equal(host.get('build-label').textContent, `v${APP_VERSION}`);
  assert.equal(guest.get('build-label').textContent, `v${APP_VERSION}`);
  await host.get('create-button').fire('click');
  assert.equal(host.get('invite-section').hidden, false);
  assert.equal(new URL(host.get('invite-output').value).searchParams.get('v'), APP_VERSION);
  guest.get('join-input').value = host.get('invite-output').value;
  await guest.get('join-form').fire('submit');
  assert.match(host.get('status-label').textContent, /Connected/);
  assert.match(guest.get('status-label').textContent, /Connected/);

  await host.get('next-button').fire('click');
  assert.equal(network.state.phase, 'auction');
  assert.equal(network.state.dealer, 'host');
  assert.equal(network.state.auction.turn, 'guest');
  assert.equal(faceNodes(host.get('own-hand')).length, 12);
  assert.equal(faceNodes(guest.get('own-hand')).length, 12);
  assertPrivateCards(apps, network.state);
  const arrangedHostHand = await assertLocalArrangement(host, guest, network);
  guest.get('bid-select').value = '3-high';
  await guest.get('bid-button').fire('click');
  assert.deepEqual(handOrder(host), arrangedHostHand, 'An opponent’s bid preserves the locally arranged hand');
  assert.match(host.get('auction-history').textContent, /Guest.*3 High/);
  await host.get('pass-button').fire('click');
  assert.equal(network.state.phase, 'kitty');
  assert.equal(network.state.contract.bidder, 'guest');
  assert.equal(faceNodes(guest.get('kitty-cards')).length, 4);
  assert.equal(faceNodes(host.get('kitty-cards')).length, 0);
  assertNoHiddenIdentities(host.get('kitty-cards'), network.state.kitty);
  assert.equal(guest.get('trump-controls').hidden, true,
    'A non-dealer winner must discard before calling trump');
  await discardKitty(guest);
  assert.equal(network.state.phase, 'trump_after');
  await guest.get('trump-H').fire('click');
  assert.equal(network.state.phase, 'play');
  assert.equal(network.state.trump, 'H');
  assert.deepEqual(handOrder(host), arrangedHostHand, 'Kitty and trump updates preserve the other hand’s local order');
  await assertLocalArrangement(guest, host, network);
  await finishGame(apps, network, coverage);
  assert.equal(network.state.games.length, 1);
  const firstScore = network.state.scores.host + network.state.scores.guest;
  assert(firstScore === 1 || firstScore === 2);

  await guest.get('next-button').fire('click');
  assert.equal(network.state.gameNumber, 2);
  assert.equal(network.state.dealer, 'guest');
  assert.equal(network.state.auction.turn, 'host');
  await host.get('pass-button').fire('click');
  assert.equal(guest.get('pass-button').disabled || guest.get('pass-button').hidden, true,
    'The dealer must bid when the opener passes');
  guest.get('bid-select').value = '3-low';
  await guest.get('bid-button').fire('click');
  assert.equal(network.state.phase, 'trump_before');
  assert.equal(faceNodes(guest.get('kitty-cards')).length, 0,
    'A dealer winner must call trump before seeing the kitty');
  assertNoHiddenIdentities(guest.get('kitty-cards'), network.state.kitty);
  await guest.get('trump-H').fire('click');
  assert.equal(network.state.phase, 'kitty');
  assert.equal(faceNodes(guest.get('kitty-cards')).length, 4);
  await discardKitty(guest);
  assert.equal(network.state.phase, 'play');
  await assertLocalArrangement(guest, host, network, 'low');
  await finishGame(apps, network, coverage);
  assert.equal(network.state.games.length, 2);
  assert(network.state.scores.host + network.state.scores.guest > firstScore);
  assert.equal(coverage.tableArrangement, true, 'The table-turn arrangement regression was exercised');
  for (const app of Object.values(apps)) {
    assert.equal(Number(app.get('host-score').textContent), network.state.scores.host);
    assert.equal(Number(app.get('guest-score').textContent), network.state.scores.guest);
    assert.deepEqual(app.errors, []);
  }
}

test('source UI completes both bidding/kitty orders and two games with private hands, legal plays, reveals and scoring', async t => {
  const html = await readFile(new URL('src/page.html', root), 'utf8');
  await assertFullGameUi(t, html, await loadAppSource());
});

test('generated single-file homepage plays complete games, rotates the dealer and preserves private card views', async t => {
  await import('../scripts/standalone.mjs');
  const html = await readFile(new URL('index.html', root), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, 'the deployed homepage includes one complete inline application');
  assert(!/\bsrc\s*=|\btype\s*=\s*["']module["']/i.test(scripts[0][1]),
    'the homepage must not fetch a stale external application module');
  await assertFullGameUi(t, html, scripts[0][2]);
});
