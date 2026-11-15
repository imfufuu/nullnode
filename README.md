# NullNode

**A room that never existed.** Anonymous 1:1 video over a single encrypted
peer-to-peer channel — no accounts, no storage, no recording. The room is burned
when you hang up.

- Site: **https://imfufuu.github.io/nullnode/** (GitHub Pages, one file)
- Relay: **Cloudflare Worker + one Durable Object** (no database, no media server)
- Client: `index.html` — 126 kB, zero build step, zero runtime dependencies
  beyond pinned CDN assets

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
| **Relay sees** | room key, IP addresses, SDP/ICE text (never parsed, never logged) |
| **Relay keeps** | nothing; the Durable Object is deleted after the last peer |
| **Recording** | impossible centrally; there is no central media to capture |
| **Fallback** | airgap mode — two people exchange one descriptor by hand, no server at all |

---

## Architecture

```
   browser A                                            browser B
┌───────────────┐        ┌──────────────────────┐      ┌───────────────┐
│  index.html   │  ws    │  Cloudflare Worker   │  ws  │  index.html   │
│  ── cards ──  │◄──────►│  POST /rooms         │◄────►│  ── cards ──  │
│  RTCPeerConn  │        │  GET  /rooms/:c/ws   │      │  RTCPeerConn  │
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

Open <http://localhost:8080/?relay=http://127.0.0.1:8787>, press **Create a
room** in one window, paste the key into another window (or another machine on
your LAN), and you are on a peer-to-peer call.

Verify the relay without a browser:

```bash
node scripts/smoke-test.mjs http://127.0.0.1:8787   # 19 checks
node scripts/verify.mjs                             # static audit of index.html
```

---

## Deploy

### 1 · The site → GitHub Pages

The repository ships `.github/workflows/pages.yml`, which audits `index.html`
and publishes it as a Pages artefact on every push to `main` or `arena/**`.

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
./scripts/deploy-worker.sh --wire   # deploy, verify /health, write url into index.html
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
index.html                 the entire site + call engine (single file)
worker/
  src/index.js             Worker entry + Room Durable Object
  wrangler.toml            bindings, migration, vars
  package.json             wrangler scripts
scripts/
  deploy-worker.sh         Cloudflare deploy, health check, optional --wire
  deploy-pages.sh          GitHub Pages: audit → push → enable → dispatch
  dev.sh                   local site + relay
  smoke-test.mjs           19-check end-to-end signalling test
  verify.mjs               static audit (syntax, ids, entities, emoji, meta)
docs/CREDENTIALS.md        every credential, scope, and error message
.github/workflows/         pages.yml · relay.yml
deploy.env.example         template for local secrets
```

---

## Design notes

- **Type**: Instrument Serif (display) against JetBrains Mono (interface) and
  Instrument Sans (body), all self-describing and free.
- **Palette**: ink `#08090a`, bone `#ede9df`, one acid green `#c8ff3d` and a
  rust `#ff4d22` reserved for the two states that matter — denied and burned.
- **Motion**: Lenis for the scroll, GSAP + ScrollTrigger for parallax and the
  step reveals, IntersectionObserver for everything else. Every reveal is
  additive: with JavaScript off or GSAP missing, the page renders fully, and
  `prefers-reduced-motion` collapses all of it.
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
- **Third-party requests on the page**: Google Fonts and jsDelivr (GSAP, Lenis,
  Lucide, Tailwind). They never see your media. Self-host them to remove them.
- **A public relay is rate limited per isolate**, not per account. Put a
  Cloudflare WAF rate-limit rule in front of `/rooms` for a hardened deploy.

---

## Licence

MIT. Fork it, restyle it, run your own.
