# NullNode

**A room that never existed.** Anonymous 1:1 video, text, files and a shared
whiteboard over a single encrypted peer-to-peer channel — no accounts, no
storage, no recording. The room is burned when you hang up.

- Site: **https://imfufuu.github.io/nullnode/** (GitHub Pages, static)
- Relay: **Cloudflare Worker + one Durable Object** (no database, no media server)
- Client: two pages — `index.html` (product) and `app.html` (the room) — plus
  `assets/css/*` and `assets/js/*`. No build step, no bundler, no dependencies
  beyond pinned CDN assets.

---

## Why it exists

Every video product is a data product first and a call second. NullNode is the
other shape: two browsers, one handshake, nothing in the middle to keep. The
only server involved is a relay that forwards a few kilobytes of signalling
text and then forgets the room key.

| | |
|---|---|
| **Accounts** | none — there is nothing to sign up for |
| **Media path** | peer → peer, DTLS-SRTP, mandatory in WebRTC |
| **Extra channels** | chat, files (64 MB max, 16 kB frames) and the board ride the same data channel |
| **Relay sees** | room key, IP addresses, SDP/ICE text (never parsed, never logged) |
| **Relay keeps** | nothing; the Durable Object is deleted after the last peer |
| **Recording** | impossible centrally; there is no central media to capture |
| **Fallback** | airgap mode — two people exchange one descriptor by hand, no server at all |

---

## Architecture

```
   browser A                                            browser B
┌───────────────┐        ┌──────────────────────┐      ┌───────────────┐
│   app.html    │  ws    │  Cloudflare Worker   │  ws  │   app.html    │
│  rtc + chat   │◄──────►│  POST /rooms         │◄────►│  rtc + chat   │
│  + board      │        │  GET  /rooms/:c/ws   │      │  + board      │
└───────┬───────┘        │  DELETE /rooms/:c    │      └───────┬───────┘
        │                │   └── Room (DO)      │              │
        │                │       · 2 sockets    │              │
        │                │       · no storage   │              │
        │                └──────────────────────┘              │
        │                                                      │
        └──────────── DTLS-SRTP media, direct ─────────────────┘
                   (never touches the relay)
```

Room lifecycle:

1. **Create** — `POST /rooms` mints a six-character key from a 32-character
   alphabet (no `0/O/1/I/L`). Nothing is written down; the key *is* the address.
2. **Handshake** — both peers open `/rooms/:key/ws`. The relay assigns
   `host` / `guest` by arrival order, forwards `sdp` and `ice` frames verbatim,
   and refuses a third socket. Host offers, guest answers.
3. **Live** — the relay is now idle. `getStats()` in your tab is the only place
   call telemetry exists.
4. **Burn** — `DELETE /rooms/:key` (or the last peer leaving) closes both
   sockets and deletes the Durable Object. A browser hangup also sends `bye`.

---

## Quickstart (local)

```bash
git clone https://github.com/imfufuu/nullnode
cd nullnode
./scripts/dev.sh          # site on :8080, relay on :8787
```

Open <http://localhost:8080/>, press **Open a room**, then **Create a room** in
one window and paste the six-character key into another window (or another
machine on your network). The preview server rewrites the relay meta tag on the
fly, so both pages point at `:8787` without touching anything on disk.

Verify without a browser:

```bash
node scripts/smoke-test.mjs http://127.0.0.1:8787   # 19 relay checks
node scripts/verify.mjs                             # static audit of the whole tree
```

---

## Deploy

### 1 · The site → GitHub Pages

The repository ships `.github/workflows/pages.yml`, which audits the tree with
`scripts/verify.mjs` and publishes `index.html`, `app.html` and `assets/` as a
Pages artefact on every push to `main`.

One-time, in the browser: **Settings → Pages → Source: GitHub Actions**.
Nothing else to configure — no build command, no output folder, no `gh-pages`
branch. (A token used *inside* Actions cannot create a Pages site, so this is the
one switch a human has to flip.)

Then either push, or let the script do the rest:

```bash
./scripts/deploy-pages.sh          # audit → push → enable Pages → run workflow
```

Site url: `https://<owner>.github.io/nullnode/`.

### 2 · The relay → Cloudflare Workers

Create an API token (**Workers Scripts: Edit** + **Account Settings: Read**) and
export it, then:

```bash
export CLOUDFLARE_API_TOKEN="v1.0-…"
export CLOUDFLARE_ACCOUNT_ID="0123456789abcdef0123456789abcdef"
./scripts/deploy-worker.sh --wire   # deploy, verify /health, write the url into both pages
git push                            # redeploy the page with the relay baked in
```

Full credential walkthrough, scopes and an error decoder:
**[docs/CREDENTIALS.md](docs/CREDENTIALS.md)**.

You can also deploy from CI with `.github/workflows/relay.yml` once
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are repository secrets.

If you never deploy a relay, the site still works: it falls back to **airgap
mode**, where the two people exchange one session descriptor over any channel
they already trust. No server, no room key, just a very long text blob.

---

## Using a room

1. Press **Create a room** → the browser asks for camera and microphone
   (never before you press it).
2. Share the six-character key or the invite link — one person only.
3. Compare certificate fingerprints out loud (**Verify** in the room footer) if
   you want proof there is nobody in between.
4. **End** stops every track, closes the peer connection and deletes the room key.

Modes:

| Mode | Needs | Handshake travels through | Use it when |
|---|---|---|---|
| **Relay** | a deployed Worker url | the relay (memory only) | normal day-to-day calls |
| **Airgap** | nothing | whatever channel you trust (chat, email) | hostile networks, no infrastructure, maximum paranoia |

---

## Repository map

```
index.html                 product page — cover, capabilities, protocol, relay, faq, colophon
app.html                   the room — video, chat, files, board, modals
assets/
  css/base.css             tokens, reset, nav, buttons, modals, page curtain
  css/landing.css          cover, ticker, spreads, protocol strip, colophon
  css/app.css              room shell, stage, deck, sidebar, board
  js/core.js               namespace, icons + fallbacks, toast, modals, curtain
  js/landing.js            preloader, reveals, magnetic, horizontal strip, plate
  js/rtc.js                media, signalling, data channel, telemetry
  js/chat.js               chat thread + chunked file transfer
  js/board.js              vector whiteboard, undo/redo, PNG export
  js/app.js                room wiring, state machine, shortcuts
worker/
  src/index.js             Worker entry + Room Durable Object
  wrangler.toml            bindings, migration, vars
  package.json             wrangler scripts
scripts/
  deploy-worker.sh         Cloudflare deploy, health check, optional --wire
  deploy-pages.sh          GitHub Pages: audit → push → enable → dispatch
  dev.sh                   local site + relay
  smoke-test.mjs           19-check end-to-end signalling test
  verify.mjs               static audit (scripts, ids, icons, assets, meta, css)
docs/CREDENTIALS.md        every credential, scope, and error message
.github/workflows/         pages.yml · relay.yml
deploy.env.example         template for local secrets
```

---

## Design notes

- **Form**: the product page is set as a field manual — a numbered issue with
  running heads, folios, figure captions, footnotes and a colophon. Seven
  spreads in one grid, alternating between two stocks: `ink` (near-black paper)
  and `paper` (bone stock, inverted). The metaphor is the product: a printed
  manual for something that keeps nothing.
- **Type**: Fraunces (display, variable optical size and SOFT/WONK axes) against
  JetBrains Mono (interface, folios, footnotes) and Instrument Sans (body),
  all free. Display sizes are fluid from 56 px to 168 px with `.82` leading and
  `-0.042em` tracking.
- **Palette**: ink `#0a0a0b` and bone `#ece8de` as the two stocks, one acid
  `#c8ff3d` for live signal and `#637f0d` for acid on paper — the same hue
  darkened enough to clear 4.5:1 on bone. Rust marks denied and burned states.
  Every pair in the system is measured; nothing ships below 3:1.
- **Motion**: Lenis for the scroll, GSAP + ScrollTrigger for the protocol strip
  (vertical scroll drives a horizontal pan, pinned above 980 px), the ghost word
  parallax and the entry drift; IntersectionObserver for reveals. Every reveal
  is additive: with JavaScript off or GSAP missing, the page renders fully, and
  `prefers-reduced-motion` collapses all of it. The strip degrades to a plain
  vertical read below 980 px.
- **Icons**: Lucide from jsDelivr with an inline fallback set, so a CDN outage
  costs nothing.
- **No emoji, no lorem ipsum, no escaped markup, no placeholder states.**

---

## Honest limitations

- **No relay = no discovery.** Two peers need *some* channel to exchange a
  descriptor. Airgap is that channel, whatever it is.
- **IP addresses are visible.** To the relay and, if ICE picks a direct path, to
  each other. That is how the internet works; no design decision here can hide it.
- **Symmetric NAT / locked-down firewalls can block media.** NullNode ships STUN
  only. Adding TURN means adding a server that sees your media — which is exactly
  what this project refuses to do. Deploy your own TURN if you need it.

### Does it work across different networks?

Different LANs, different countries: usually yes, and it is the same mechanism
that makes a LAN call work.

- **Signalling is always possible.** The relay is an ordinary HTTPS/WebSocket
  service on Cloudflare's edge, so two browsers anywhere can exchange offers.
  The six-character key resolves across the internet exactly as it does at home.
- **Media needs ICE to find a path.** Both peers gather candidates from public
  STUN servers, which reveal each side's public NAT mapping. For most home
  routers (full-cone / restricted / port-restricted NAT) hole punching succeeds
  and media flows directly. `path` in the room badge tells you what won: a
  `host → host` pair is a same-LAN connection, `srflx → srflx` is a punched
  path across the internet.
- **Where it fails.** Symmetric NAT (common on mobile carriers and some
  corporate networks) assigns a different port per destination, so the mapping
  discovered through STUN is not the one the peer needs. Two symmetric NATs
  cannot be punched; the connection needs a TURN server relaying the media.
  NullNode does not ship TURN on purpose — a TURN server sees every packet.
  If you need it, put your own coturn next to the Worker and add it to the ICE
  list in `assets/js/rtc.js`.
- **Airgap is not a NAT fix.** It removes the relay from the handshake; it
  cannot invent a route that the network refuses to carry.
- **Third-party requests on the page**: Google Fonts and jsDelivr (GSAP, Lenis,
  Lucide). They never see your media. Self-host them to remove them.
- **A public relay is rate limited per isolate**, not per account. Put a
  Cloudflare WAF rate-limit rule in front of `/rooms` for a hardened deploy.

---

## Licence

MIT. Fork it, restyle it, run your own.
