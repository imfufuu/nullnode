/* ============================================================
   NullNode · rtc — media, signalling, data channel, telemetry
   ============================================================ */
(function () {
  'use strict';
  var RELAY_KEY = 'nn.relay', MODE_KEY = 'nn.mode.v2';
  var DEFAULT_RELAY = (document.querySelector('meta[name="nullnode-relay"]') || {}).content || '';
  var ICE = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: ['stun:stun.cloudflare.com:3478'] }
    ]
  };
  var CHANNEL = 'nn-data';

  var S = {
    mode: 'airgap', relay: '', code: '', role: null, state: 'idle',
    pc: null, ws: null, dc: null, channelOpen: false,
    local: null, remote: null, iceQueue: [], outQueue: [],
    timer: null, statsTimer: null, startedAt: 0, prevBytes: 0, prevTs: 0,
    airgapStage: null, health: 'unknown', path: '', relayBase: '', origin: ''
  };

  var listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, a, b) {
    (listeners[evt] || []).forEach(function (f) {
      try { f(a, b); } catch (e) { if (window.console) console.error('[nn]', evt, e); }
    });
  }

  /* ---------------- relay config ---------------- */
  function normalizeRelay(v) {
    if (!v) return '';
    v = String(v).trim().replace(/\/+$/, '');
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    if (!/^https?:\/\/[^\s]+$/i.test(v)) return '';
    return v;
  }
  function loadRelay() {
    var fromUrl = null;
    try { fromUrl = new URL(location.href).searchParams.get('relay'); } catch (e) {}
    if (fromUrl) {
      var n = normalizeRelay(fromUrl);
      if (n) { NN.store.set(RELAY_KEY, n); return n; }
    }
    return normalizeRelay(NN.store.get(RELAY_KEY, '')) || normalizeRelay(DEFAULT_RELAY);
  }

  function setMode(m, persist) {
    S.mode = m;
    if (persist) NN.store.set(MODE_KEY, m);
    emit('mode', m);
  }

  function paintRelay(status) {
    S.health = status;
    emit('relay', status);
  }

  function checkRelay() {
    if (!S.relay) { paintRelay('unknown'); return Promise.resolve(false); }
    if (typeof fetch !== 'function') { paintRelay('unknown'); return Promise.resolve(false); }
    paintRelay('checking');
    var ctrl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 5000);
    return fetch(S.relay + '/health', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('status ' + r.status)); })
      .then(function (j) { clearTimeout(to); var ok = !!(j && j.ok); paintRelay(ok ? 'live' : 'off'); return ok; })
      .catch(function () { clearTimeout(to); paintRelay('off'); return false; });
  }

  /* ---------------- media ---------------- */
  function mediaError(err) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'WebRTC needs https — this page cannot open a camera here';
    if (err && err.name === 'NotAllowedError') return 'Permission denied — allow camera and mic, then try again';
    if (err && err.name === 'NotFoundError') return 'No camera or microphone found';
    if (err && err.name === 'NotReadableError') return 'Device busy — close the other app using it';
    return 'Could not open camera or mic';
  }

  function ensureMedia() {
    if (S.local) return Promise.resolve(true);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      emit('toast', mediaError());
      emit('state', 'error', { title: 'Needs https', sub: 'getUserMedia is blocked on insecure origins' });
      return Promise.resolve(false);
    }
    emit('state', S.state === 'idle' ? 'handshake' : S.state, { title: 'Requesting access', sub: 'answer the browser prompt' });
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
    }).then(function (stream) {
      S.local = stream;
      emit('media', stream);
      return true;
    }).catch(function (err) {
      if (err && err.name === 'NotAllowedError') {
        emit('toast', mediaError(err));
        emit('state', 'idle', { title: 'Permission denied', sub: 'allow camera + mic to place a call' });
        return false;
      }
      return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        S.local = stream;
        emit('media', stream);
        emit('toast', 'Camera unavailable — audio only');
        return true;
      }).catch(function (err2) {
        emit('toast', mediaError(err2));
        emit('state', 'idle', { title: 'No devices', sub: 'camera and microphone unavailable' });
        return false;
      });
    });
  }

  function stopLocal() {
    if (S.local) { S.local.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); S.local = null; }
    emit('media', null);
  }

  /* ---------------- peer connection ---------------- */
  function send(obj) {
    if (S.ws && S.ws.readyState === 1) {
      try { S.ws.send(JSON.stringify(obj)); return true; } catch (e) {}
    }
    return false;
  }

  function bindChannel(dc) {
    S.dc = dc;
    dc.binaryType = 'arraybuffer';
    try { dc.bufferedAmountLowThreshold = 256 * 1024; } catch (e) {}
    dc.onopen = function () {
      S.channelOpen = true;
      while (S.outQueue.length && dc.readyState === 'open') {
        try { dc.send(S.outQueue.shift()); } catch (e) { break; }
      }
      emit('channel', 'open');
    };
    dc.onclose = function () { S.channelOpen = false; emit('channel', 'close'); };
    dc.onerror = function () {};
    dc.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        try { emit('message', JSON.parse(ev.data)); } catch (e) {}
      } else {
        emit('binary', ev.data);
      }
    };
  }

  function ensurePC(asOfferer) {
    if (S.pc) return S.pc;
    if (!window.RTCPeerConnection) { emit('toast', 'WebRTC is not available in this browser'); return null; }
    var pc = new RTCPeerConnection(ICE);
    S.pc = pc;

    if (S.local) S.local.getTracks().forEach(function (tr) { pc.addTrack(tr, S.local); });
    else {
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('audio', { direction: 'sendrecv' });
    }

    if (asOfferer) {
      try { bindChannel(pc.createDataChannel(CHANNEL, { ordered: true })); } catch (e) {}
    } else {
      pc.ondatachannel = function (e) { if (e.channel && e.channel.label === CHANNEL) bindChannel(e.channel); };
    }

    pc.onicecandidate = function (e) { if (e.candidate) send({ t: 'ice', candidate: e.candidate.toJSON() }); };
    pc.ontrack = function (e) {
      S.remote = (e.streams && e.streams[0]) ? e.streams[0] : S.remote || new MediaStream();
      if (!e.streams || !e.streams[0]) S.remote.addTrack(e.track);
      emit('remote', S.remote);
    };
    pc.onconnectionstatechange = function () {
      var st = pc.connectionState;
      if (st === 'connected') onConnected();
      else if (st === 'disconnected') emit('state', 'handshake', { title: 'Reconnecting', sub: 'network changed — holding the line' });
      else if (st === 'failed') emit('state', 'error', { title: 'No path', sub: 'no viable route — try another network or the airgap handshake' });
    };
    return pc;
  }

  function onConnected() {
    emit('state', 'live');
    startTimer();
    startStats();
    readFingerprints();
  }

  /* ---------------- offer / answer ---------------- */
  function offer() {
    var pc = ensurePC(true);
    if (!pc) return;
    emit('state', 'handshake', { title: 'Calling', sub: 'offering a direct channel' });
    pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true })
      .then(function (d) { return pc.setLocalDescription(d); })
      .then(function () { send({ t: 'sdp', sdp: { type: 'offer', sdp: pc.localDescription.sdp } }); })
      .catch(function () { emit('toast', 'Could not create an offer'); });
  }

  function answer(offerSdp) {
    var pc = ensurePC(false);
    if (!pc) return;
    emit('state', preferState('handshake'), { title: 'Answering', sub: 'completing the handshake' });
    pc.setRemoteDescription(new RTCSessionDescription(offerSdp))
      .then(function () { flushIce(); return pc.createAnswer(); })
      .then(function (d) { return pc.setLocalDescription(d); })
      .then(function () {
        send({ t: 'sdp', sdp: { type: 'answer', sdp: pc.localDescription.sdp } });
        readFingerprints();
      })
      .catch(function () { emit('toast', 'Handshake rejected'); });
  }

  function applyAnswer(ansSdp) {
    if (!S.pc) return;
    S.pc.setRemoteDescription(new RTCSessionDescription(ansSdp))
      .then(function () { flushIce(); readFingerprints(); })
      .catch(function () { emit('toast', 'Answer rejected'); });
  }

  function addIce(cand) {
    if (!cand || !S.pc) return;
    if (!S.pc.remoteDescription) { S.iceQueue.push(cand); return; }
    S.pc.addIceCandidate(cand).catch(function () {});
  }
  function flushIce() {
    if (!S.pc || !S.pc.remoteDescription) return;
    var q = S.iceQueue; S.iceQueue = [];
    q.forEach(function (c) { S.pc.addIceCandidate(c).catch(function () {}); });
  }
  function waitIce(pc, ms) {
    ms = ms || 2600;
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') return resolve();
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', check);
        clearTimeout(t); resolve();
      }
      function check() { if (pc.iceGatheringState === 'complete') finish(); }
      pc.addEventListener('icegatheringstatechange', check);
      var t = setTimeout(finish, ms);
    });
  }

  function preferState(fallback) {
    return ['invite', 'airgap', 'live', 'error', 'ended'].indexOf(S.state) >= 0 ? fallback : fallback;
  }

  /* ---------------- fingerprints + path ---------------- */
  function fpFrom(sdp) {
    if (!sdp) return '';
    var m = sdp.match(/a=fingerprint:sha-256\s+([0-9a-f:]+)/i);
    return m ? m[1].toUpperCase() : '';
  }
  function readFingerprints() {
    if (!S.pc) return;
    var l = fpFrom(S.pc.localDescription && S.pc.localDescription.sdp);
    var r = fpFrom(S.pc.remoteDescription && S.pc.remoteDescription.sdp);
    if (l && r) emit('fingerprints', { local: l, remote: r });
  }

  /* ---------------- timers + telemetry ---------------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function startTimer() {
    S.startedAt = Date.now();
    clearInterval(S.timer);
    S.timer = setInterval(function () {
      var s = Math.floor((Date.now() - S.startedAt) / 1000);
      emit('tick', pad(Math.floor(s / 60)) + ':' + pad(s % 60));
    }, 500);
  }
  function stopTimer() { clearInterval(S.timer); S.timer = null; S.startedAt = 0; }

  function startStats() {
    clearInterval(S.statsTimer);
    S.prevBytes = 0; S.prevTs = 0;
    var pathSent = false;
    S.statsTimer = setInterval(function () {
      if (!S.pc || !S.pc.getStats) return;
      S.pc.getStats(null).then(function (report) {
        var res = '—', fps = '—', rtt = '—', bytes = null, pair = null, cands = {};
        report.forEach(function (r) {
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            if (r.frameWidth) res = r.frameWidth + '×' + r.frameHeight;
            if (r.framesPerSecond != null) fps = Math.round(r.framesPerSecond);
            if (r.bytesReceived != null) bytes = r.bytesReceived;
          }
          if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r;
          if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded')) pair = r;
        });
        if (pair && cands[pair.localCandidateId] && cands[pair.remoteCandidateId]) {
          var l = cands[pair.localCandidateId].candidateType || '?';
          var rc = cands[pair.remoteCandidateId].candidateType || '?';
          var p = l + ' → ' + rc;
          if (p !== S.path) { S.path = p; emit('path', p); }
          if (pair.currentRoundTripTime != null) rtt = Math.round(pair.currentRoundTripTime * 1000) + 'ms';
          if (!pathSent) pathSent = true;
        }
        var rate = '—';
        if (bytes != null) {
          var now = performance.now();
          if (S.prevTs && now > S.prevTs && bytes >= S.prevBytes) {
            var kbps = ((bytes - S.prevBytes) * 8) / (now - S.prevTs);
            rate = kbps > 1000 ? (kbps / 1000).toFixed(1) + 'mb' : Math.round(kbps) + 'kb';
          }
          S.prevBytes = bytes; S.prevTs = now;
        }
        emit('stats', { res: res, fps: fps, rate: rate, rtt: rtt });
      }).catch(function () {});
    }, 2000);
  }
  function stopStats() { clearInterval(S.statsTimer); S.statsTimer = null; }

  /* ---------------- signalling ---------------- */
  function roomLink(code) {
    return location.origin + location.pathname.replace(/[^/]*$/, '') + 'app.html?r=' + code;
  }

  function openSocket(code) {
    if (!S.relay) { emit('toast', 'No relay configured'); return; }
    var url = null;
    try { url = new URL(S.relay); } catch (e) { emit('toast', 'Relay url is invalid'); return; }
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = (url.pathname.replace(/\/+$/, '')) + '/rooms/' + encodeURIComponent(code) + '/ws';
    try {
      S.ws = new WebSocket(url.toString());
    } catch (e) {
      emit('toast', 'Relay socket failed');
      emit('state', 'error', { title: 'Socket failed', sub: 'the relay refused the connection' });
      return;
    }
    S.ws.onopen = function () { emit('state', 'handshake', { title: 'Waiting', sub: 'relay connected · room ' + code }); };
    S.ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleSignal(m);
    };
    S.ws.onclose = function () {
      S.ws = null;
      if (S.state === 'live') emit('state', 'handshake', { title: 'Relay dropped', sub: 'media may keep flowing · signalling lost' });
    };
  }

  function handleSignal(m) {
    if (!m || !m.t) return;
    if (m.t === 'welcome') {
      S.role = m.role;
      emit('role', m.role);
      if (m.role === 'host') {
        if (m.peers >= 2) offer();
        else { S.code = m.code || S.code; emit('state', 'invite', { code: S.code }); }
      } else {
        S.code = m.code || S.code;
        emit('state', 'handshake', { title: 'Connected', sub: 'waiting for the host to offer' });
      }
      return;
    }
    if (m.t === 'peer-joined') { if (S.role === 'host') offer(); return; }
    if (m.t === 'peer-left') {
      if (S.state === 'live' || S.state === 'handshake') {
        emit('toast', 'Peer disconnected');
        closePeer();
        if (S.mode === 'relay' && S.code) emit('state', 'invite', { code: S.code });
        else emit('state', 'idle');
      }
      return;
    }
    if (m.t === 'sdp' && m.sdp) {
      if (m.sdp.type === 'offer') answer(m.sdp);
      else if (m.sdp.type === 'answer') applyAnswer(m.sdp);
      return;
    }
    if (m.t === 'ice' && m.candidate) { addIce(m.candidate); return; }
    if (m.t === 'error') {
      if (m.code === 'room_full') {
        emit('toast', 'That room already holds two peers');
        emit('state', 'error', { title: 'Room full', sub: 'two peers is the limit' });
      }
      return;
    }
    if (m.t === 'bye') { emit('toast', 'The other side hung up'); hangup(false); }
  }

  /* ---------------- actions ---------------- */
  function createRoom() {
    return ensureMedia().then(function (ok) {
      if (!ok) return false;
      if (S.mode === 'relay' && S.relay && typeof fetch === 'function') {
        emit('state', 'handshake', { title: 'Opening room', sub: 'asking the relay for a key' });
        return fetch(S.relay + '/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); })
          .then(function (j) {
            if (!j || !j.code) throw new Error('no code');
            S.code = j.code;
            emit('state', 'invite', { code: j.code });
            openSocket(j.code);
            paintRelay('live');
            return true;
          })
          .catch(function () {
            emit('toast', 'Relay unreachable — switching to airgap');
            paintRelay('off');
            setMode('airgap', false);
            airgapBegin('host');
            return false;
          });
      }
      airgapBegin('host');
      return true;
    });
  }

  function joinRoom(raw) {
    var code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (code.length !== 6) { emit('toast', 'A room key is six characters'); return Promise.resolve(false); }
    return ensureMedia().then(function (ok) {
      if (!ok) return false;
      S.code = code;
      if (S.mode === 'relay' && S.relay) {
        emit('state', 'handshake', { title: 'Joining ' + code, sub: 'contacting the relay' });
        openSocket(code);
      } else {
        airgapBegin('guest');
      }
      return true;
    });
  }

  function airgapBegin(role) {
    S.airgapStage = role;
    S.role = role;
    emit('state', 'airgap', { role: role });
    var pc = ensurePC(role === 'host');
    if (!pc) return;
    if (role === 'host') {
      pc.createOffer().then(function (d) { return pc.setLocalDescription(d); })
        .then(function () { return waitIce(pc); })
        .then(function () { emit('airgap-descriptor', { role: 'host', sdp: pc.localDescription.sdp }); readFingerprints(); })
        .catch(function () { emit('toast', 'Could not build the offer'); });
    } else {
      emit('airgap-descriptor', { role: 'guest', sdp: '' });
    }
  }

  function airgapAnswer(sdpText) {
    if (!S.pc) { emit('toast', 'Nothing to connect yet'); return; }
    var pc = S.pc;
    emit('state', 'handshake', { title: 'Answering', sub: 'building your descriptor' });
    pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: sdpText }))
      .then(function () { flushIce(); return pc.createAnswer(); })
      .then(function (d) { return pc.setLocalDescription(d); })
      .then(function () { return waitIce(pc); })
      .then(function () { emit('airgap-descriptor', { role: 'guest', sdp: pc.localDescription.sdp }); readFingerprints(); })
      .catch(function () { emit('toast', 'Could not read that offer'); });
  }

  function airgapApply(sdpText) {
    emit('state', 'handshake', { title: 'Connecting', sub: 'ice is finding a path' });
    applyAnswer({ type: 'answer', sdp: sdpText });
  }

  function closePeer() {
    if (S.pc) {
      try {
        S.pc.ontrack = null; S.pc.onicecandidate = null; S.pc.onconnectionstatechange = null;
        S.pc.ondatachannel = null; S.pc.close();
      } catch (e) {}
      S.pc = null;
    }
    if (S.dc) { try { S.dc.onmessage = null; S.dc.close(); } catch (e) {} S.dc = null; }
    S.channelOpen = false;
    S.outQueue = [];
    if (S.remote) { S.remote.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); S.remote = null; }
    emit('remote', null);
    emit('channel', 'close');
    S.iceQueue = [];
    stopStats();
  }

  function burnRoom() {
    if (S.mode !== 'relay' || !S.relay || !S.code) return;
    try { fetch(S.relay + '/rooms/' + encodeURIComponent(S.code), { method: 'DELETE', keepalive: true }); } catch (e) {}
  }

  function hangup(showEnded) {
    if (S.ws) { send({ t: 'bye' }); try { S.ws.close(); } catch (e) {} S.ws = null; }
    closePeer();
    stopLocal();
    stopTimer();
    burnRoom();
    S.code = ''; S.role = null; S.airgapStage = null; S.path = '';
    if (showEnded === false) emit('state', 'idle');
    else emit('state', 'ended');
  }

  /* ---------------- data channel api ---------------- */
  function sendControl(obj) {
    if (S.dc && S.dc.readyState === 'open') {
      try { S.dc.send(JSON.stringify(obj)); return true; } catch (e) {}
    }
    if (S.outQueue.length < 60 && obj && obj.t !== 'wb-live' && obj.t !== 'cursor') S.outQueue.push(JSON.stringify(obj));
    return false;
  }
  function sendRaw(buf) {
    if (!S.dc || S.dc.readyState !== 'open') return false;
    if (S.dc.bufferedAmount > 4 * 1024 * 1024) return false;
    try { S.dc.send(buf); return true; } catch (e) { return false; }
  }
  function drain() {
    return new Promise(function (resolve) {
      var dc = S.dc;
      if (!dc || dc.readyState !== 'open' || dc.bufferedAmount < 1024 * 1024) return resolve();
      var done = false;
      function fin() { if (done) return; done = true; dc.removeEventListener('bufferedamountlow', fin); clearTimeout(t); resolve(); }
      dc.addEventListener('bufferedamountlow', fin);
      var t = setTimeout(fin, 2500);
    });
  }

  /* ---------------- media toggles ---------------- */
  function toggleMic() {
    if (!S.local) return null;
    var a = S.local.getAudioTracks()[0];
    if (!a) return null;
    a.enabled = !a.enabled;
    return a.enabled;
  }
  function toggleCam() {
    if (!S.local) return null;
    var v = S.local.getVideoTracks()[0];
    if (!v) return null;
    v.enabled = !v.enabled;
    return v.enabled;
  }
  function shareScreen() {
    if (!S.pc) { emit('toast', 'Start a call first'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { emit('toast', 'Screen share unsupported here'); return; }
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false }).then(function (ss) {
      var sender = S.pc.getSenders().filter(function (s) { return s.track && s.track.kind === 'video'; })[0];
      if (!sender) { emit('toast', 'No video sender'); return; }
      var cam = sender.track;
      sender.replaceTrack(ss.getVideoTracks()[0]);
      emit('sharing', true);
      emit('toast', 'Sharing screen');
      ss.getVideoTracks()[0].onended = function () {
        if (cam) sender.replaceTrack(cam).catch(function () {});
        emit('sharing', false);
        emit('toast', 'Screen share ended');
      };
    }).catch(function () {});
  }

  /* ---------------- init ---------------- */
  S.relay = loadRelay();
  S.origin = location.origin;
  var savedMode = NN.store.get(MODE_KEY, '');
  NN.store.del('nn.mode');
  setMode(savedMode === 'airgap' ? 'airgap' : (S.relay ? 'relay' : 'airgap'), false);
  paintRelay('unknown');
  if (S.relay) checkRelay();
  emit('state', 'idle');

  NN.RTC = {
    on: on,
    emit: emit,
    get state() { return S; },
    get path() { return S.path; },
    get code() { return S.code; },
    get mode() { return S.mode; },
    get relay() { return S.relay; },
    get health() { return S.health; },
    get localStream() { return S.local; },
    get role() { return S.role; },
    get channelOpen() { return S.channelOpen; },
    setMode: setMode,
    setRelay: function (url) {
      var n = normalizeRelay(url);
      S.relay = n;
      if (n) NN.store.set(RELAY_KEY, n); else NN.store.del(RELAY_KEY);
      emit('relay', n ? 'unknown' : 'unknown');
      return n;
    },
    checkRelay: checkRelay,
    createRoom: createRoom,
    joinRoom: joinRoom,
    hangup: hangup,
    airgapBegin: airgapBegin,
    airgapAnswer: airgapAnswer,
    airgapApply: airgapApply,
    roomLink: roomLink,
    send: sendControl,
    sendRaw: sendRaw,
    drain: drain,
    toggleMic: toggleMic,
    toggleCam: toggleCam,
    shareScreen: shareScreen,
    fingerprints: function () {
      if (!S.pc) return { local: '', remote: '' };
      return {
        local: fpFrom(S.pc.localDescription && S.pc.localDescription.sdp),
        remote: fpFrom(S.pc.remoteDescription && S.pc.remoteDescription.sdp)
      };
    }
  };
})();
