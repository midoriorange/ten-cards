# External component

The networked mode downloads **PeerJS 1.5.5** on demand from jsDelivr. The local
practice mode does not load it. PeerJS is open source under the MIT license:

- Project: https://github.com/peers/peerjs
- License: https://github.com/peers/peerjs/blob/v1.5.5/LICENSE
- Browser bundle: https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js

No third-party JavaScript is bundled in this source archive. PeerJS includes
its own dependencies; see the upstream package for their notices. If you
self-host a copy, retain the upstream license and dependency notices alongside it.

The default connection uses PeerJS Cloud for signaling and Google's public
STUN service. No TURN service or service availability guarantee is provided.
