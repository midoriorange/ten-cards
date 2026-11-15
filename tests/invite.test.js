import test from 'node:test';
import assert from 'node:assert/strict';
import { makeInviteLink, parseInviteLink, validInvite } from '../src/invite.js';
import { APP_VERSION } from '../src/version.js';

const invite = { hostId: 'ten-abcdef1234567890abcdef1234567890', secret: '0123456789abcdef0123456789abcdef' };
test('invite round-trips at a GitHub Pages project path; token is in fragment only', () => {
  const link = makeInviteLink(invite, 'https://someone.github.io/ten-cards/?old=1#old');
  assert.equal(new URL(link).pathname, '/ten-cards/');
  assert.equal(new URL(link).searchParams.get('v'), APP_VERSION);
  assert.equal(new URL(link).searchParams.has('old'), false);
  assert.deepEqual(parseInviteLink(link), invite);
});
test('invalid, oversized, executable and incomplete links are rejected', () => {
  for (const text of ['', 'hello', 'javascript:alert(1)', 'https://example.com/#host=other', 'x'.repeat(2049)]) {
    assert.throws(() => parseInviteLink(text));
  }
  assert.equal(validInvite({ hostId: 'wrong', secret: invite.secret }), false);
  assert.throws(() => makeInviteLink({ hostId: invite.hostId }, 'https://example.com'));
});
