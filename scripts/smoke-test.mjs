#!/usr/bin/env node
/**
 * End-to-end signalling test for the NullNode relay.
 *
 *   node scripts/smoke-test.mjs http://127.0.0.1:8787
 *   node scripts/smoke-test.mjs https://nullnode-relay.you.workers.dev
 *
 * No browser, no media: it proves the room lifecycle, role assignment, frame
 * forwarding and burn-on-delete behaviour of the Worker + Durable Object.
 */
const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const wsBase = base.replace(/^http/i, 'ws');

let passed = 0;
const check = (label, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { console.error(`  ✗ ${label} ${extra}`); process.exitCode = 1; }
};

class Line {
  constructor(url) {
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.queue.push(msg);
    });
    this.ws.addEventListener('close', () => { this.closed = true; });
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('socket error ' + url)));
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  wait(match, ms = 4000) {
    const hit = this.queue.findIndex(match);
    if (hit >= 0) return Promise.resolve(this.queue.splice(hit, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error('timeout waiting for frame')); }
      }, ms);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const t = (m) => m && m.t === 'hello';

(async () => {
  console.log(`\nnullnode relay smoke test → ${base}\n`);

  /* 1. health ------------------------------------------------------------- */
  const health = await fetch(`${base}/health`).then((r) => r.json());
  check('GET /health is ok', health.ok === true, JSON.stringify(health));
  check('durable object binding present', health.rooms === 'durable-object');

  /* 2. mint a room -------------------------------------------------------- */
  const created = await fetch(`${base}/rooms`, { method: 'POST' }).then((r) => r.json());
  check('POST /rooms returns a six-character key', /^[2-9A-HJ-NP-Z]{6}$/.test(created.code || ''), created.code);

  /* 3. both peers connect ------------------------------------------------- */
  const host = new Line(`${wsBase}/rooms/${created.code}/ws`);
  await host.ready;
  const welcomeA = await host.wait((m) => m.t === 'welcome');
  check('first peer is greeted as host', welcomeA.role === 'host', JSON.stringify(welcomeA));
  check('host sees one peer', welcomeA.peers === 1);

  const guest = new Line(`${wsBase}/rooms/${created.code}/ws`);
  await guest.ready;
  const [welcomeB, joined] = await Promise.all([
    guest.wait((m) => m.t === 'welcome'),
    host.wait((m) => m.t === 'peer-joined')
  ]);
  check('second peer is greeted as guest', welcomeB.role === 'guest', JSON.stringify(welcomeB));
  check('host is told the peer joined', joined.peers === 2);

  /* 4. handshake traffic is forwarded verbatim ---------------------------- */
  const offer = { t: 'sdp', sdp: { type: 'offer', sdp: 'v=0\r\nfake-offer' } };
  host.send(offer);
  const gotOffer = await guest.wait((m) => m.t === 'sdp');
  check('offer reaches the guest unchanged', gotOffer.sdp.sdp === offer.sdp.sdp);

  const answer = { t: 'sdp', sdp: { type: 'answer', sdp: 'v=0\r\nfake-answer' } };
  guest.send(answer);
  const gotAnswer = await host.wait((m) => m.t === 'sdp');
  check('answer reaches the host unchanged', gotAnswer.sdp.sdp === answer.sdp.sdp);

  const cand = { t: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0' } };
  host.send(cand);
  const gotIce = await guest.wait((m) => m.t === 'ice');
  check('ice candidate reaches the guest', gotIce.candidate.sdpMid === '0');

  /* 5. ping/pong ---------------------------------------------------------- */
  host.send({ t: 'ping' });
  const pong = await host.wait((m) => m.t === 'pong');
  check('ping is answered with pong', typeof pong.now === 'number');

  /* 6. unknown frame types are dropped ----------------------------------- */
  host.send({ t: 'evil', payload: 'x' });
  let leaked = true;
  try { await guest.wait((m) => m.t === 'evil', 600); } catch { leaked = false; }
  check('unknown frame types are not forwarded', leaked === false);

  /* 7. probe -------------------------------------------------------------- */
  const probe = await fetch(`${base}/rooms/${created.code}`).then((r) => r.json());
  check('probe reports two peers', probe.peers === 2 && probe.open === false, JSON.stringify(probe));

  /* 8. a third peer is refused ------------------------------------------- */
  let refused = false;
  try {
    const third = new Line(`${wsBase}/rooms/${created.code}/ws`);
    await third.ready;
    refused = false;
    third.close();
  } catch { refused = true; }
  check('third peer is rejected', refused === true);

  /* 9. burn --------------------------------------------------------------- */
  const burned = await fetch(`${base}/rooms/${created.code}`, { method: 'DELETE' }).then((r) => r.json());
  check('DELETE /rooms/:code burns the room', burned.burned === true, JSON.stringify(burned));
  await new Promise((r) => setTimeout(r, 350));
  check('both sockets are closed after the burn', host.closed && guest.closed);

  const after = await fetch(`${base}/rooms/${created.code}`).then((r) => r.json());
  check('room is empty after the burn', after.peers === 0, JSON.stringify(after));

  /* 10. validation -------------------------------------------------------- */
  const bad = await fetch(`${base}/rooms`, { method: 'POST' });
  check('rooms can be minted repeatedly', bad.status === 201);
  const missing = await fetch(`${base}/rooms/ZZZZZZ`);
  const missingJson = await missing.json();
  check('unknown room probes as empty', missingJson.peers === 0);

  host.close(); guest.close();
  console.log(`\n${passed} checks passed${process.exitCode ? ' — with failures' : ''}\n`);
})().catch((err) => {
  console.error('\nsmoke test crashed:', err.message);
  process.exit(1);
});
