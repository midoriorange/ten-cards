# Ten Cards

A small, open-source card table for two people. One browser hosts the game, another joins through an invite link, and both display the same ten cards.

This project runs locally or on GitHub Pages. To update an existing site, replace the changed files in its repository and wait for Pages to deploy.

## The rules

- One host and one guest.
- The host deals the first ten distinct cards from a fresh standard 52-card deck, with no jokers.
- The chooser sees ten face-up cards; the dealer sees ten face-down cards.
- The guest selects one card. That card is revealed to the dealer in its original position; the other nine stay face down. Both screens show the accepted choice.
- The guest can then click **Deal next hand** to deal ten cards for the host to choose from.
- After each choice, the chooser gets the next deal. This repeats in the same room, using the same invite link.
- There is one choice per deal. A fresh deal clears the selection and turns all ten cards face down for the new dealer. Before a selection, the current dealer may re-deal without changing whose turn it is.
- The host can deal before the guest joins; the guest receives the current game when connecting.
- A disconnected guest can be replaced while the host keeps the game open.
- Closing, refreshing, or leaving the host's page ends that session. Connection loss takes a short time to detect.

## First look: no installation

Open **`START_HERE.html`** from the extracted folder in your browser, then choose
**Just exploring? Try it on this device**. This single-file edition lets you deal
and select cards immediately using the chooser's face-up view. When opened as a local file, network-game controls
are disabled; use the local web server or GitHub Pages for invite links.

`START_HERE.html` is generated from the same application source. Regenerate it
after code changes with `npm run standalone`.

## Run the full website on your computer

1. Install [Node.js](https://nodejs.org/) version 20 or newer if it is not already installed.
2. Extract the project and open a terminal in the folder containing `package.json`.
3. Run:

   ```sh
   npm start
   ```

4. Open the address printed in the terminal.

There are no npm dependencies to install. Use the local web server rather than opening the development `index.html` directly: that version uses JavaScript modules.

For a first look, choose **Just exploring? Try it on this device**. This local practice mode lets you deal and select cards without another person or external service.

## Try the two-player game

1. The host clicks **Create a table**.
2. The host clicks **Copy invite link** and shares it with the guest.
3. The guest opens the link, or pastes it into **Invite link** and clicks **Join table**.
4. The host clicks **Deal ten cards**. The host sees card backs; the guest sees the card faces and picks one.
5. The chosen card turns face up for the host. The other nine remain face down. The guest now has a **Deal next hand** button.
6. The guest deals and sees card backs; the host sees the faces and selects a card. The selected card is revealed to the guest. The turns continue.

**Hosting and dealing are separate roles.** The original host keeps the session alive and validates shared state, even during the guest's dealing turn. Keep the host's tab open throughout.

When updating, upload the extracted project's contents, preserving the folders
and leaving out `.github/` for branch-based Pages publication. This update adds
`src/view.js` and changes the display, stylesheet, and instructions. Both players
should refresh the updated website and start a new game.

Face-down cards are hidden in the interface, including card text, accessible
labels, and DOM data attributes. The original host still shuffles and holds the
full game state, and both browsers receive it. This is visual hiding, not secure
blinding against someone inspecting browser developer tools.

To test on one computer, use a second browser window for the guest. For another device, first publish the project: a `localhost` link points to the device opening it, not to the host's computer.

An invite link grants access to the available guest seat. Share it only with the intended guest. It is an access capability, not a verified real-world identity. Its secret is kept in the URL fragment (the part after `#`); live game state exists only in browser memory.

## Publish with GitHub Pages

### Simple option: publish the repository's root folder

1. Create a new public GitHub repository.
2. Upload the **contents** of this project, preserving its folders. `index.html` must appear at the repository root, rather than inside another `card-table` folder.
3. Include `src/`, `scripts/`, the stylesheet, favicon, package file, README, license, and `.nojekyll`. The optional `.github/` workflow folder is not needed for this route.
4. Open the repository's **Settings → Pages**.
5. Under **Build and deployment**, select **Deploy from a branch**, then **main** and **/(root)**. Save.
6. Wait for GitHub to finish publishing, then open the site URL shown on that page.

The app uses relative file paths, so it can be hosted at a project address such as `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`.

### Optional: publish with GitHub Actions

The included `.github/workflows/pages.yml` checks, tests, builds, and deploys the `dist/` folder. To use it, ensure that file is committed and choose **GitHub Actions** as the Pages source instead of publishing from a branch. The workflow's Pages deployment is triggered by a push to `main` or by a manual run.

Use one publication option at a time. The root-folder option is sufficient to get started; it does not require uploading or configuring a workflow.

See [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site) and [publishing with a custom workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## How the pieces fit together

| File | Responsibility |
| --- | --- |
| `index.html` and `styles.css` | Page structure, controls, and card-table appearance. |
| `src/app.js` | Connects the controls to the game and displays updates. |
| `src/game.js` | Deck, shuffle, alternating dealer/chooser turns, and selection rules. |
| `src/view.js` | Shows card faces to the chooser and only the selected card to the dealer. |
| `src/session.js` | Host/guest connections, admission, messages, synchronization, and disconnect handling. |
| `src/invite.js` | Builds and validates invite links. |
| `src/config.js` | PeerJS library location and WebRTC connection settings. |
| `tests/` | Automated tests for rules, invitations, and simulated sessions. |
| `scripts/` | Local web server, project checks, and static build. |

The original host owns the official game state. The current chooser can select,
and the next dealer can start the next hand. Guest actions travel to the host,
which checks whose turn it is, shuffles or records the selection, and distributes
the accepted update. The browsers send card identifiers and small messages,
rather than streaming a screen.

## Networking and its current limits

Network games dynamically load the open-source [PeerJS](https://peerjs.com/client/getting-started) browser library, pinned to **1.5.5**, from jsDelivr. PeerJS's hosted signaling service helps the browsers find each other, and the configured Google STUN server helps them discover a connection route. After connection, game messages travel over a WebRTC data channel.

Local practice does not load PeerJS or contact these external services. Two-player games depend on the CDN, signaling service, STUN service, and the participants' network policies. Restricted networks may block them.

**No TURN relay is configured.** Some network combinations cannot establish a direct WebRTC connection and will need a TURN service. Connection settings are in `src/config.js`. Never put permanent private TURN credentials in a public repository; a deployment needing authenticated TURN should obtain short-lived credentials through an appropriate service. See the [PeerJS connection configuration](https://peerjs.com/client/api/peer) and [MDN's WebRTC protocol explanation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols).

There are no application accounts, database, or analytics. Third-party connection services may still receive connection metadata. Sessions are temporary; there is no saved history, host migration, or automatic recovery after the host refreshes.

## Checks and build

```sh
npm test
npm run check
npm run build
```

The build copies the public application files into `dist/`; no framework or package installation is required. Building is optional for root-folder GitHub Pages publication.

Automated verification covers card rules, invite handling, simulated host/guest
sessions, alternating turns, and which cards each player is shown. The browser timer regression is included.
The first version has been reported working on the user's live site; the new
display behavior still needs a live browser retest after deployment.
Test the full cycle on two devices: host deals, guest selects and deals, host
selects and deals again. Also test joining after a deal, a second guest being
refused, and closing the original host's page during the guest's dealing turn.

## Where this can go next

The card rules are separate from the connection and display code so that another shared activity can replace them later. This is a learning prototype, not a validated scientific-study or data-collection platform.

PWA installation is deferred. A future version can add a manifest, app icons, and optional interface caching without changing the basic host/guest model. Multiplayer will still require connectivity.

## License

MIT; see `LICENSE`. PeerJS is a separate MIT-licensed dependency loaded from the configured CDN.
