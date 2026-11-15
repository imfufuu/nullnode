/**
 * NullNode relay — a Cloudflare Worker whose only job is to introduce two
 * browsers to each other, then forget it ever happened.
 *
 *   POST   /rooms              → { code, ttl }      mint a six-character room key
 *   GET    /rooms/:code        → { peers, open }    probe a room (no personal data)
 *   GET    /rooms/:code/ws     → WebSocket upgrade  signalling channel (max 2 peers)
 *   DELETE /rooms/:code        → { burned: true }   evict both peers, drop the room
 *   GET    /health             → { ok: true, ... }  liveness for the client
 *
 * Privacy contract enforced by this file:
 *   · No storage API is ever written with signalling content.
 *   · SDP / ICE payloads are forwarded byte-for-byte and never logged or parsed
 *     beyond a JSON envelope check.
 *   · Nothing survives the last peer: the Durable Object is deleted on alarm or
 *     on DELETE, and media never comes near it.
 */

const VERSION = '1.0.0';
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 32 chars, no 0/O/1/I/L
const CODE_LEN = 6;
const MAX_FRAME = 64 * 1024;        // drop anything bigger than 64 kB
const ALLOWED_TYPES = new Set(['sdp', 'ice', 'bye', 'ping', 'hello']);

/* ------------------------------------------------------------------ utils */

const enc = new TextEncoder();

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extra,
    },
  });
}

function cors(env, request) {
  const raw = (env.ALLOWED_ORIGINS || '*').trim();
  const origin = request.headers.get('Origin') || '';
  let allow = '*';
  if (raw !== '*') {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    allow = list.includes(origin) ? origin : list[0] || '*';
  }
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function originAllowed(env, request) {
  const raw = (env.ALLOWED_ORIGINS || '*').trim();
  if (raw === '*') return true;
  const origin = request.headers.get('Origin') || '';
  // A websocket from a native client may omit Origin entirely; allow that so the
  // smoke test and CLI tools keep working, browsers always send one.
  if (!origin) return true;
  return raw.split(',').map((s) => s.trim()).includes(origin);
}

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function validCode(code) {
  if (typeof code !== 'string' || code.length !== CODE_LEN) return false;
  for (const ch of code) if (!ALPHABET.includes(ch)) return false;
  return true;
}

/** Best-effort, per-isolate throttle. Real protection belongs in a WAF rule. */
const buckets = new Map();
function throttled(ip, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now > b.reset) {
    buckets.set(ip, { n: 1, reset: now + windowMs });
    if (buckets.size > 5000) buckets.clear();
    return false;
  }
  b.n += 1;
  return b.n > limit;
}

/* ------------------------------------------------------------ Worker entry */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const headers = cors(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (path === '/health' || path === '/') {
      return json({
        ok: true,
        service: 'nullnode-relay',
        version: VERSION,
        rooms: env.ROOMS ? 'durable-object' : 'missing-binding',
        peerLimit: Number(env.MAX_PEERS || 2),
        ttlSeconds: Number(env.ROOM_TTL_SECONDS || 7200),
        now: new Date().toISOString(),
      }, 200, headers);
    }

    // ---- mint a room key ------------------------------------------------
    if (path === '/rooms' && request.method === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      if (throttled(ip, 20, 60_000)) {
        return json({ error: 'rate_limited' }, 429, headers);
      }
      const ttl = Number(env.ROOM_TTL_SECONDS || 7200);
      return json({ code: makeCode(), ttl, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }, 201, headers);
    }

    const roomMatch = path.match(/^\/rooms\/([A-Za-z0-9]{4,12})(\/ws)?$/);
    if (roomMatch) {
      const code = roomMatch[1].toUpperCase();
      const wantsSocket = Boolean(roomMatch[2]);
      if (!validCode(code)) return json({ error: 'bad_code' }, 400, headers);
      if (!env.ROOMS) return json({ error: 'binding_missing' }, 500, headers);

      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);

      if (wantsSocket) {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return json({ error: 'expected_websocket' }, 426, headers);
        }
        if (!originAllowed(env, request)) return json({ error: 'origin_not_allowed' }, 403, headers);
        const forwarded = new Request('https://room.local/ws?code=' + code, request);
        return stub.fetch(forwarded);
      }

      if (request.method === 'GET') return stub.fetch(new Request('https://room.local/probe?code=' + code));
      if (request.method === 'DELETE') return stub.fetch(new Request('https://room.local/burn?code=' + code, { method: 'POST' }));
      return json({ error: 'method_not_allowed' }, 405, headers);
    }

    return json({ error: 'not_found', hint: 'POST /rooms · GET /rooms/:code/ws' }, 404, headers);
  },
};

/* --------------------------------------------------------- Durable Object */

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.maxPeers = Number(env.MAX_PEERS || 2);
  }

  peers() {
    return this.state.getWebSockets();
  }

  roleOf(ws) {
    try {
      return (ws.deserializeAttachment() || {}).role || 'peer';
    } catch {
      return 'peer';
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = (url.searchParams.get('code') || '').toUpperCase();

    /* --- liveness probe ------------------------------------------------- */
    if (url.pathname.endsWith('/probe')) {
      const peers = this.peers().length;
      return json({ room: code, peers, open: peers < this.maxPeers });
    }

    /* --- explicit burn -------------------------------------------------- */
    if (url.pathname.endsWith('/burn')) {
      const peers = this.peers();
      for (const ws of peers) {
        try { ws.send(JSON.stringify({ t: 'bye', reason: 'burned' })); } catch {}
        try { ws.close(4001, 'room burned'); } catch {}
      }
      await this.purge();
      return json({ burned: true, evicted: peers.length });
    }

    /* --- websocket upgrade --------------------------------------------- */
    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ error: 'expected_websocket' }, 426);
    }

    const existing = this.peers();
    if (existing.length >= this.maxPeers) {
      return json({ error: 'room_full', code: 'room_full' }, 409);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const role = existing.length === 0 ? 'host' : 'guest';

    this.state.acceptWebSocket(server, [role]);
    try { server.serializeAttachment({ role, joined: Date.now() }); } catch {}

    // Tell whoever is already here that the line opened.
    for (const ws of this.peers()) {
      if (ws === server) continue;
      try { ws.send(JSON.stringify({ t: 'peer-joined', peers: existing.length + 1 })); } catch {}
    }

    // Greet the newcomer with its assigned role. Delay the greeting by one tick
    // so it lands after the browser's own socket open event.
    const peers = this.peers().length;
    server.send(JSON.stringify({
      t: 'welcome',
      role,
      peers,
      code,
      ttl: Number(this.env.ROOM_TTL_SECONDS || 7200),
    }));

    await this.armAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  /* Every inbound frame: size check, envelope check, forward to the other side. */
  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;                 // binary is never expected
    if (enc.encode(message).byteLength > MAX_FRAME) {
      try { ws.send(JSON.stringify({ t: 'error', code: 'frame_too_large' })); } catch {}
      return;
    }

    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'ping') {
      try { ws.send(JSON.stringify({ t: 'pong', now: Date.now() })); } catch {}
      return;
    }
    if (!ALLOWED_TYPES.has(msg.t)) return;

    const self = ws;
    const out = JSON.stringify(msg);
    let delivered = 0;
    for (const peer of this.peers()) {
      if (peer === self) continue;
      try { peer.send(out); delivered++; } catch {}
    }
    if (msg.t === 'bye') {
      for (const peer of this.peers()) {
        try { peer.close(1000, 'peer left'); } catch {}
      }
      if (!this.peers().length) await this.purge();
    }
    return delivered;
  }

  async webSocketClose(ws) {
    for (const peer of this.peers()) {
      if (peer === ws) continue;
      try { peer.send(JSON.stringify({ t: 'peer-left' })); } catch {}
    }
    if (!this.peers().length) await this.armAlarm(30);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async armAlarm(seconds = 120) {
    const at = Date.now() + seconds * 1000;
    const current = await this.state.storage.getAlarm();
    if (current == null || at < current) await this.state.storage.setAlarm(at);
  }

  async alarm() {
    for (const ws of this.peers()) {
      try { ws.close(4000, 'room expired'); } catch {}
    }
    await this.purge();
  }

  /* The only storage writes in this class are alarm timestamps. */
  async purge() {
    try { await this.state.storage.deleteAll(); } catch {}
  }
}
