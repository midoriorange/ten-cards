// Optional deployment settings. Never put permanent TURN credentials in public code.
// A production TURN service should issue short-lived credentials through a backend.
export const peerOptions = {
  secure: true,
  config: {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  },
};

// Pinned for reproducibility. Copy the browser bundle into vendor/ to self-host it.
export const peerLibraryUrl = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js';
