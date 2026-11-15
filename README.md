# Packs — a table for two

An open-source, two-player card game using the custom childhood rules agreed in
this conversation. One browser hosts the session; another joins by invite link.
The host keeps the authoritative state and validates every move. Both players
see their own private hands and the shared table.

**Release: v0.4.0.** This replaces the earlier ten-card selection demo. The GitHub
repository and Pages address can keep their existing `ten-cards` name.

## Try it without installing anything

Extract this download and open `START_HERE.html` or `index.html` in your browser.
Choose **Try both seats on this device**. This rehearsal controls both players
and automatically shows the active player's seat. **View as Host/Guest** lets
you inspect the other perspective. The rehearsal does not connect to anyone.

For a networked game, publish the homepage using GitHub Pages, or run the local
server. Browser-file invitations are disabled because another person cannot
open your computer's file path.

## Update your existing GitHub Pages website

1. On your repository's main **Code** page, choose **Add file → Upload files**.
2. Upload the **top-level `index.html`** from this download, replacing the old
   homepage. It contains the current application, stylesheet, and icon, so this
   is the only file needed to update the running website.
3. Commit to your publishing branch and wait for the Pages deployment to finish
   successfully under **Actions**.
4. Both players should open the updated website, refresh, and confirm **v0.4.0**
   in the footer. Start a new table and use its new invite link.

Existing sessions use a different message format and cannot be carried into
this version. Invite links include the release version so new guests request
the same page version. If you also keep the editable source on GitHub, upload
this project's source, tests, scripts, and documentation too, preserving their
folders. Leave `.github/` out if you use the simple branch publication route.

To publish for the first time, create a public GitHub repository and put this
project's contents at its root. Under **Settings → Pages**, select **Deploy from
a branch**, `main`, and `/(root)`. You do not need to install Node or run a build
because the downloaded homepage is already generated.

[GitHub Pages setup](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)

## Play with a friend

1. The original host opens the website and clicks **Create a table**.
2. Copy the invite link and send it to the guest. The guest opens it and clicks
   **Join table**. Wait for **Connected · 2 of 2**.
3. The host clicks **Deal the first game**. Bidding starts with the guest.
4. Follow the stage panel through the auction, trump call, and kitty exchange.
   The panel explains whose turn it is. Enabled cards are legal choices.
5. After a completed pack, its winner clicks **Lead the next pack**. This pause
   lets both players inspect the four played cards and newly revealed table tops.
6. At game end, inspect all remaining cards and the discards. The next dealer
   clicks **Deal game …**. Scores remain in the same session.
7. First to seven or more wins the match. The original host can start a new match.

Keep the original host's page open. Closing or refreshing it ends the session,
including when the guest is dealing. A guest connection loss pauses play; a
new guest using the invite can occupy that seat and receive the current game.
There is no automatic guest reconnection or persistent match storage.

## Exact game rules

### The deal and private cards

Use a standard 52-card deck without jokers. Deal three four-card table stacks to
each player, alternating the recipient of each stack with the non-dealer first.
Then deal the four-card kitty. Divide the remaining cards into two twelve-card
hands, the non-dealer's first. All 52 cards are accounted for.

Each player initially sees only their own twelve-card hand. Table stacks and
the kitty are face down. The original host deals the first game; the two players
alternate dealing after each completed game, independently of who won.

### One bid per player

The non-dealer bids or passes, then the dealer gets one response. Bid order is:

`3 High < 3 Low < 4 High < 4 Low < … < 8 High < 8 Low`

The dealer must either bid strictly higher or pass. **If the opening player
passes, the dealer must bid and has no pass option.** There is no further auction.

The bid winner is the bidder; the other player is the defender. The defender's
winning target is **8 minus the bid number, with a minimum of one pack**. This
rule intentionally uses eight even though there are twelve packs. For example,
a bid of 3 Low gives the defender a target of five packs; bids of seven or eight
give a target of one.

### Trump and the kitty

- If the dealer wins the bid, they must call one of the four trump suits before
  the kitty becomes visible to them.
- If the non-dealer wins, they see the kitty and complete their four-card
  discard before calling trump.
- The bidder selects exactly four cards to discard from the sixteen cards in
  their hand plus kitty. They keep twelve. Table stacks cannot be exchanged.
- The opponent sees no kitty or discard faces during play.

Once the exchange and trump call are complete, all six exposed table tops are
revealed to both players. Buried cards remain concealed.

### Four cards make one pack

The bid winner leads the first pack. A pack consists of these four plays:

1. Leader plays a card from their hand.
2. Follower plays a card from their hand.
3. Leader plays one of their exposed table cards.
4. Follower plays one of their exposed table cards.

All four plays follow the suit of the very first hand card whenever possible.
Availability is checked separately within the relevant pool: hand cards for a
hand play, or the player's exposed table tops for a table play. Buried cards and
cards in the other pool do not count. A player who has no led-suit card in that
pool may play any suit; playing trump is optional.

Any trump beats any non-trump. Otherwise only the led suit can win. The strongest
single qualifying card among the four decides the pack's winner:

- High: **A, K, Q, J, 10, 9, …, 2**.
- Low: **A, 2, 3, 4, 5, …, K**.

The winner leads the next pack. A replacement table top stays covered until all
four plays finish, then turns face up for both players. Empty stacks cannot be
played. **Completed packs** records every four-card pack and its winner.

### Winning games and the match

The defender wins as soon as they reach their target. Otherwise all twelve packs
are played, and the bidder wins if the defender stayed below target. The bidder's
win is not declared early, because the remaining packs determine BOLO results.

At game end all remaining hand cards, all remaining cards in every table stack,
and the four discards are revealed. The prior played cards remain available in
the completed-pack history, allowing both players to review the whole deck.

| Result | Condition | Games awarded |
| --- | --- | --- |
| BOLO | Bidder wins; defender won zero packs | 2 |
| SIDE BOLO | Bidder wins; defender won one pack | 1 |
| REVERSE BOLO | Defender wins; bidder won zero packs | 2 |
| Ordinary win | Other winning results | 1 |

Special result words flash on screen and remain in the result panel. Reduced
motion settings disable the flashing animation. First to **seven or more** wins
(the two-game bonus can take a score from six to eight). Match results are kept
for the life of the current session.

## Development

Install Node.js 20 or newer. There are no npm packages to install.

```sh
npm start
```

Open the local address printed in the terminal. To test both seats on one
computer, open a second browser window and use the invite. A `localhost` link
works only on that computer; publish the website before inviting another device.

```sh
npm run check
npm test
npm run build
```

The build regenerates the two self-contained HTML pages from the readable source
and copies the production homepage into `dist/`. `npm run standalone` regenerates
the pages without creating `dist/`. The optional `.github/workflows/pages.yml`
checks, tests, builds, and publishes when Pages is configured for GitHub Actions.
Use the branch publication route or the custom workflow, rather than both.

| File | Responsibility |
| --- | --- |
| `index.html` | Generated, self-contained homepage for GitHub Pages. |
| `src/page.html`, `styles.css` | Editable page template and stylesheet. |
| `src/game.js` | Rules, dealing, auction, kitty, legal moves, pack resolution, scoring, and validation. |
| `src/view.js` | Information displayed to one seat: private hand, hidden kitty, public tops, end reveal. |
| `src/session.js` | PeerJS connections, authenticated room admission, authoritative actions, synchronization, and disconnects. |
| `src/app.js` | Stage controls, cards, match scores, local rehearsal, and result animations. |
| `src/invite.js`, `src/version.js` | Versioned invite links and release identifier. |
| `src/config.js` | PeerJS location and ICE connection settings. |
| `tests/` | Rule, privacy, transport, and actual generated-interface regression tests. |

The message protocol is version 3; actions carry the shared revision to reject
stale or duplicated moves. The host validates actions under the sender's actual
seat, never an identity supplied in the action. State callbacks are deep copies.

## Network and privacy scope

The networked mode downloads the open-source [PeerJS](https://peerjs.com/client/getting-started)
browser library, pinned to 1.5.5, from jsDelivr when someone creates or joins a
real table. PeerJS Cloud performs signaling, and the configured Google STUN
service helps establish a direct WebRTC data channel. Local practice does not
load PeerJS or contact those services.

No TURN relay is configured. Restricted network combinations may need one. The
settings are in `src/config.js`; do not embed permanent private TURN credentials
in this public code. See the [PeerJS configuration](https://peerjs.com/client/api/peer)
and [WebRTC protocol documentation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols).

As agreed for this testing prototype, card privacy is **visual only**. The host
shuffles and holds the full deck state, and both browsers receive that state.
Hidden card elements omit identities, including accessible labels and DOM data
attributes, but a person inspecting browser data can still discover the cards.
This is not cryptographic blinding. There are no application accounts, analytics,
backend database, saved matches, or host migration.

## Verification

Automated checks cover both auction outcomes, mandatory bidding after a pass,
kitty/trump timing, separate-pool suit following, original-led-suit priority,
high/low trump resolution, all scoring branches, seven-point matches, deep state
isolation, stale guest actions, disconnects, and 52-card conservation. Interface
tests drive actual source and generated homepage code through both seats with a
simulated DOM and Peer transport.

The previous simple game was reported working on the live site. This new full
game has not yet been tested through actual browsers and external networks in
the development environment. After publishing, run a two-device acceptance test:
check both kitty sequences, a low-bid game, forced suit following in both pools,
a mid-pack stack replacement, an early defender win, dealer rotation, and a
complete match. Confirm v0.4.0 in both footers before creating the table.

## License

MIT; see `LICENSE`. PeerJS is a separate MIT-licensed component loaded from the
configured CDN; see `THIRD_PARTY_NOTICES.md`.
