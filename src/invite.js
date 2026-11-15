import { APP_VERSION } from './version.js';

const HOST_PATTERN = /^ten-[a-f0-9]{32}$/;
const SECRET_PATTERN = /^[a-f0-9]{32}$/;

export function validInvite(value) {
  return Boolean(value && typeof value === 'object'
    && HOST_PATTERN.test(value.hostId) && SECRET_PATTERN.test(value.secret));
}

export function makeInviteLink(invite, pageUrl) {
  if (!validInvite(invite)) throw new Error('This invite is incomplete. Please create a new table.');
  const url = new URL(pageUrl);
  url.search = '';
  url.searchParams.set('v', APP_VERSION);
  url.hash = new URLSearchParams({ host: invite.hostId, key: invite.secret }).toString();
  return url.href;
}

export function parseInviteLink(text, baseUrl) {
  if (typeof text !== 'string' || text.trim().length > 2048) throw new Error('Please paste a complete Ten Cards invite link.');
  let url;
  try { url = new URL(text.trim(), baseUrl); } catch { throw new Error('That does not look like an invite link.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Please use an http or https invite link.');
  const params = new URLSearchParams(url.hash.slice(1));
  const invite = { hostId: params.get('host'), secret: params.get('key') };
  if (!validInvite(invite)) throw new Error('The invite link is incomplete or invalid. Ask the host for a fresh link.');
  return invite;
}
