# Optional self-hosted library

The prototype loads a pinned PeerJS browser bundle from jsDelivr when a user
creates or joins a real table. To serve all JavaScript from your own website:

1. Download `peerjs.min.js` from the browser-bundle link in
   `THIRD_PARTY_NOTICES.md` on a device with access to that service.
2. Put it in this folder and retain its upstream license and dependency notices.
3. Set `peerLibraryUrl` in `src/config.js` to
   `new URL('../vendor/peerjs.min.js', import.meta.url).href`.
4. Add `'vendor'` to the copy list in `scripts/build.mjs` if using the optional
   GitHub Actions deployment.

Public signaling and STUN services are still used unless configured otherwise.
