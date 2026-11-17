/* ============================================================
   NullNode · room wiring
   ============================================================ */
(function () {
  'use strict';
  var $ = NN.$, $$ = NN.$$;
  var room, E = {}, mode = 'airgap', verified = false, airgapRole = null, prevState = 'idle';

  var DECK = {
    idle: ['Idle', 'no session · permissions not requested'],
    handshake: ['Connecting', 'negotiating a direct path'],
    invite: ['Room open', 'six-character key · expiring'],
    airgap: ['Airgap', 'handshake happens by hand'],
    live: ['Live', 'peer-to-peer · encrypted'],
    ended: ['Ended', 'room key burned'],
    error: ['Error', 'the line did not come up']
  };

  /* ---------------- state ---------------- */
  function setState(name, info) {
    info = info || {};
    if (!room) return;
    if (name === 'handshake' && (prevState === 'idle' || prevState === 'ended')) resetRoom();
    prevState = name;
    room.dataset.state = name;
    if (E.stateText) E.stateText.textContent = name === 'idle' ? 'idle' : name;
    var d = DECK[name] || DECK.idle;
    if (E.deckTitle) E.deckTitle.textContent = info.title || d[0];
    if (E.deckSub) E.deckSub.textContent = info.sub || d[1];
    if (E.waitingText) {
      E.waitingText.textContent = name === 'invite'
        ? 'waiting for the other side · ' + (NN.RTC.code || '------')
        : (info.sub || 'negotiating');
    }
    if (name === 'live') {
      var how = NN.RTC.mode === 'relay' ? 'signalled by your relay' : 'airgap handshake';
      if (E.deckTitle && !info.title) E.deckTitle.textContent = 'Live';
      if (E.deckSub) E.deckSub.textContent = 'peer-to-peer · ' + how;
    }
    if (name === 'idle') { verified = false; setFpState(false); }
    syncAddr();
  }

  function resetRoom() {
    var thread = $('#thread');
    if (thread) {
      NN.$$('.msg', thread).forEach(function (n) { n.remove(); });
      var empty = $('#threadEmpty');
      if (empty) empty.hidden = false;
    }
    var transfers = $('#transfers');
    if (transfers) while (transfers.firstChild) transfers.removeChild(transfers.firstChild);
    if (E.fpLocal) E.fpLocal.textContent = '—';
    if (E.fpRemote) E.fpRemote.textContent = '—';
    if (E.pathBadge) E.pathBadge.hidden = true;
    if (E.timer) E.timer.textContent = '00:00';
    verified = false;
    setFpState(false);
  }

  function syncAddr() {
    if (E.addrCode) E.addrCode.textContent = NN.RTC.code ? NN.RTC.code : '------';
  }

  /* ---------------- invite ---------------- */
  function showInvite(code) {
    syncAddr();
    if (E.bigCode) E.bigCode.textContent = code;
    if (E.inviteLink) E.inviteLink.value = NN.RTC.roomLink(code);
    document.title = 'NullNode · room ' + code;
  }

  /* ---------------- fingerprints ---------------- */
  function shortFp(fp) {
    if (!fp) return '—';
    var hex = fp.replace(/:/g, '');
    return (hex.slice(0, 4) + ' ' + hex.slice(4, 8)).toUpperCase();
  }
  function setFpState(ok) {
    if (!E.fpMatch) return;
    E.fpMatch.dataset.ok = ok ? '1' : '0';
    E.fpMatch.textContent = ok ? 'verified' : 'unverified';
  }
  function paintFp(pair) {
    pair = pair || NN.RTC.fingerprints();
    if (E.fpLocal) E.fpLocal.textContent = shortFp(pair.local);
    if (E.fpRemote) E.fpRemote.textContent = shortFp(pair.remote);
    if (E.fpLocalFull) E.fpLocalFull.textContent = pair.local || '—';
    if (E.fpRemoteFull) E.fpRemoteFull.textContent = pair.remote || '—';
    if (E.pathFull) E.pathFull.textContent = NN.RTC.path || 'not connected';
  }

  /* ---------------- relay chip ---------------- */
  function paintRelay(status) {
    if (!E.relayChip) return;
    var host = (NN.RTC.relay || '').replace(/^https?:\/\//, '');
    var label = { live: 'relay live', off: host ? 'relay off' : 'relay unset', checking: 'relay …', unknown: host ? 'relay set' : 'relay unset' }[status] || status;
    E.relayChip.dataset.state = status;
    if (E.relayChipText) E.relayChipText.textContent = label;
    E.relayChip.title = host ? host : 'No relay configured — airgap only';
  }

  function paintMode(m) {
    mode = m;
    if (E.modeRelay) E.modeRelay.setAttribute('aria-pressed', String(m === 'relay'));
    if (E.modeAirgap) E.modeAirgap.setAttribute('aria-pressed', String(m === 'airgap'));
    if (E.modeHint) {
      E.modeHint.textContent = m === 'relay'
        ? 'relay ' + (NN.RTC.relay || '—').replace(/^https?:\/\//, '')
        : 'airgap · descriptors move by hand';
    }
  }

  /* ---------------- sidebar ---------------- */
  function setTab(name) {
    $$('.side-tab').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === name)); });
    $$('.side-pane').forEach(function (p) { p.hidden = p.dataset.pane !== name; });
    var un = name === 'chat' ? E.chatUnread : E.fileUnread;
    if (un) un.hidden = true;
    if (name === 'chat' && NN.Chat) NN.Chat.clearUnread();
    var dot = toggledOff(E.sideBtn);
    if (E.sideBtn && dot) E.sideBtn.classList.remove('has-new');
    if (name === 'chat' && E.chatInput) setTimeout(function () { E.chatInput.focus({ preventScroll: true }); }, 60);
  }
  function toggledOff(btn) { return btn ? btn.classList.contains('has-new') : false; }

  function isChatVisible() {
    var mobile = window.matchMedia('(max-width:880px)').matches;
    var open = !mobile || document.body.classList.contains('side-open');
    var on = E.side && !E.side.classList.contains('hidden');
    var tab = document.querySelector('.side-tab[aria-selected="true"]');
    return open && on && tab && tab.dataset.tab === 'chat';
  }

  function ping(kind) {
    if (E.sideBtn) E.sideBtn.classList.add('has-new');
    if (kind === 'files' && E.fileUnread) E.fileUnread.hidden = false;
  }

  /* ---------------- wiring ---------------- */
  function bind() {
    /* create / join */
    if (E.createBtn) E.createBtn.addEventListener('click', function () {
      if (mode === 'relay' && !NN.RTC.relay) { NN.toast('Set a relay first — opening settings'); openSettings(); return; }
      NN.RTC.createRoom();
    });
    if (E.joinForm) E.joinForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var code = NN.RTC.normaliseCode(E.codeInput.value);
      if (code.length !== NN.RTC.CODE_LEN) { NN.toast('Six characters, no spaces'); E.codeInput.focus(); return; }
      if (!NN.RTC.isCode(code)) {
        NN.toast('Room keys never contain 0, O, 1, I or L — read it again');
        E.codeInput.focus();
        return;
      }
      if (mode === 'airgap') NN.RTC.setMode('airgap', true);
      NN.RTC.joinRoom(code);
    });
    if (E.codeInput) {
      E.codeInput.addEventListener('input', function () {
        /* Strip the characters the relay can never mint, so a typo surfaces
           while typing rather than as an opaque rejection later. */
        var v = NN.RTC.normaliseCode(E.codeInput.value).replace(/[01OIL]/g, '');
        if (v !== E.codeInput.value) E.codeInput.value = v;
      });
    }

    /* invite */
    if (E.copyLinkBtn) E.copyLinkBtn.addEventListener('click', function () {
      NN.copy(E.inviteLink.value, 'Invite link copied');
    });
    if (E.inviteLink) E.inviteLink.addEventListener('focus', function () { E.inviteLink.select(); });
    if (E.cancelRoom) E.cancelRoom.addEventListener('click', function () { NN.RTC.hangup(false); });

    /* airgap */
    if (E.copyBlob) E.copyBlob.addEventListener('click', function () {
      if (!E.airgapOut.value) { NN.toast('Nothing to copy yet'); return; }
      NN.copy(E.airgapOut.value, 'Descriptor copied');
    });
    if (E.pasteBlob) E.pasteBlob.addEventListener('click', function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) { NN.toast('Paste it yourself with ' + (navigator.platform.indexOf('Mac') >= 0 ? '⌘V' : 'Ctrl+V')); E.airgapIn.focus(); return; }
      navigator.clipboard.readText().then(function (t) { E.airgapIn.value = t; NN.toast('Pasted'); }).catch(function () { E.airgapIn.focus(); });
    });
    if (E.airgapConnect) E.airgapConnect.addEventListener('click', function () {
      var txt = (E.airgapIn.value || '').trim();
      if (!txt) { NN.toast('Paste their descriptor first'); E.airgapIn.focus(); return; }
      if (!/^v=0/.test(txt)) { NN.toast('That does not look like a descriptor'); return; }
      if (airgapRole === 'host') NN.RTC.airgapApply(txt);
      else NN.RTC.airgapAnswer(txt);
    });
    if (E.airgapReset) E.airgapReset.addEventListener('click', function () {
      E.airgapIn.value = ''; E.airgapOut.value = '';
      NN.RTC.hangup(false);
      setTimeout(function () { NN.RTC.airgapBegin(airgapRole || 'host'); }, 120);
    });
    if (E.airgapClose) E.airgapClose.addEventListener('click', function () { NN.RTC.hangup(false); });
    if (E.airgapUseRelay) E.airgapUseRelay.addEventListener('click', function () {
      NN.RTC.setMode('relay', true);
      NN.RTC.hangup(false);
      NN.toast('Relay mode armed for the next room');
    });

    /* ended */
    if (E.againBtn) E.againBtn.addEventListener('click', function () {
      setState('idle');
      NN.RTC.createRoom();
    });
    if (E.dismissEnded) E.dismissEnded.addEventListener('click', function () { setState('idle'); });

    /* deck */
    if (E.micBtn) E.micBtn.addEventListener('click', function () {
      var on = NN.RTC.toggleMic();
      if (on === null) { NN.toast('No microphone in this session'); return; }
      E.micBtn.setAttribute('aria-pressed', String(on));
      E.micBtn.querySelector('.tip').textContent = on ? 'Mute' : 'Unmute';
    });
    if (E.camBtn) E.camBtn.addEventListener('click', function () {
      var on = NN.RTC.toggleCam();
      if (on === null) { NN.toast('No camera in this session'); return; }
      E.camBtn.setAttribute('aria-pressed', String(on));
      E.camBtn.querySelector('.tip').textContent = on ? 'Camera off' : 'Camera on';
    });
    if (E.shareBtn) E.shareBtn.addEventListener('click', function () { NN.RTC.shareScreen(); });
    if (E.hangupBtn) E.hangupBtn.addEventListener('click', function () { NN.RTC.hangup(); });

    /* board + side */
    if (E.boardBtn) E.boardBtn.addEventListener('click', function () {
      NN.Board.toggle();
      E.boardBtn.setAttribute('aria-pressed', String(NN.Board.isOpen()));
    });
    document.addEventListener('click', function () {
      if (E.boardBtn) E.boardBtn.setAttribute('aria-pressed', String(NN.Board.isOpen()));
    });

    if (E.sideBtn) E.sideBtn.addEventListener('click', function () {
      var mobile = window.matchMedia('(max-width:880px)').matches;
      if (mobile) {
        document.body.classList.toggle('side-open');
      } else {
        var body = $('.body');
        var hidden = body.classList.toggle('side-hidden');
        E.side.classList.toggle('hidden', hidden);
        E.sideBtn.setAttribute('aria-pressed', String(!hidden));
        if (!hidden) setTab('chat');
      }
      E.sideBtn.classList.remove('has-new');
      if (NN.Chat) NN.Chat.clearUnread();
      if (!mobile && E.side.classList.contains('hidden') === false) {
        setTimeout(function () { if (E.chatInput) E.chatInput.focus({ preventScroll: true }); }, 80);
      }
    });
    if (E.sideClose) E.sideClose.addEventListener('click', function () {
      document.body.classList.remove('side-open');
      if (E.sideBtn) E.sideBtn.setAttribute('aria-pressed', 'false');
    });
    $$('.side-tab').forEach(function (b) {
      b.addEventListener('click', function () { setTab(b.dataset.tab); });
    });

    /* modes */
    if (E.modeRelay) E.modeRelay.addEventListener('click', function () {
      if (!NN.RTC.relay) { NN.toast('No relay configured — add one first'); openSettings(); return; }
      NN.RTC.setMode('relay', true);
      if (NN.RTC.state.state === 'live') NN.toast('Relay applies to the next room');
    });
    if (E.modeAirgap) E.modeAirgap.addEventListener('click', function () {
      NN.RTC.setMode('airgap', true);
      if (NN.RTC.state.state === 'live') NN.toast('Airgap applies to the next room');
    });

    /* modals */
    if (E.verifyBtn) E.verifyBtn.addEventListener('click', function () { paintFp(); NN.modal('verifyModal', true); });
    if (E.settingsBtn) E.settingsBtn.addEventListener('click', openSettings);
    if (E.relayChip) E.relayChip.addEventListener('click', openSettings);
    if (E.saveRelay) E.saveRelay.addEventListener('click', function () {
      var v = NN.RTC.setRelay(E.relayInput.value);
      NN.modal('settingsModal', false);
      NN.toast(v ? 'Relay saved' : 'Relay cleared');
      paintMode(NN.RTC.mode);
      NN.RTC.checkRelay();
    });
    if (E.clearRelay) E.clearRelay.addEventListener('click', function () {
      E.relayInput.value = '';
      NN.RTC.setRelay('');
      NN.RTC.setMode('airgap', true);
      NN.toast('Relay cleared — airgap only');
      NN.modal('settingsModal', false);
    });
    if (E.testRelay) E.testRelay.addEventListener('click', function () {
      var v = NN.RTC.setRelay(E.relayInput.value);
      if (!v) { E.relayTestOut.textContent = 'No url to test.'; return; }
      E.relayTestOut.textContent = 'Testing ' + v + ' …';
      NN.RTC.checkRelay().then(function (ok) {
        E.relayTestOut.textContent = ok ? 'Reachable · POST /rooms will mint keys here.' : 'No answer · rooms would fall back to airgap.';
      });
    });
    if (E.markVerified) E.markVerified.addEventListener('click', function () {
      verified = true;
      setFpState(true);
      NN.modal('verifyModal', false);
      NN.toast('Marked as verified on this device');
    });

    /* keys */
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (NN.Board.isOpen()) return;
      var k = e.key.toLowerCase();
      if (k === 'm') { e.preventDefault(); if (E.micBtn) E.micBtn.click(); }
      else if (k === 'v') { e.preventDefault(); if (E.camBtn) E.camBtn.click(); }
      else if (k === 'b') { e.preventDefault(); if (E.boardBtn) E.boardBtn.click(); }
      else if (k === 'c') { e.preventDefault(); if (E.sideBtn) E.sideBtn.click(); }
      else if (k === 'escape') {
        document.body.classList.remove('side-open');
        NN.modal('settingsModal', false); NN.modal('verifyModal', false);
      }
    });
  }

  function openSettings() {
    if (!E.relayInput) return;
    E.relayInput.value = NN.RTC.relay || '';
    if (E.relayTestOut) E.relayTestOut.textContent = NN.RTC.relay ? 'Saved relay · test it again after editing.' : 'Not tested. The relay only sees room keys and handshake text.';
    NN.modal('settingsModal', true);
  }

  /* ---------------- engine events ---------------- */
  function listen() {
    var R = NN.RTC;

    R.on('state', function (name, info) {
      setState(name, info);
      if (name === 'invite' && info && info.code) showInvite(info.code);
      if (name === 'airgap' && info) airgapRole = info.role;
      if (name === 'ended') {
        if (E.pip) E.pip.classList.remove('show');
        if (E.fpLocal) E.fpLocal.textContent = '—';
        if (E.fpRemote) E.fpRemote.textContent = '—';
        if (E.pathBadge) E.pathBadge.hidden = true;
      }
      if (name === 'live') {
        paintFp();
        if (E.encBadge) E.encBadge.textContent = 'encrypted · dtls-srtp';
      }
    });

    R.on('media', function (stream) {
      if (!stream) { if (E.pip) E.pip.classList.remove('show'); return; }
      if (E.localVideo) { E.localVideo.srcObject = stream; E.localVideo.play().catch(function () {}); }
      if (E.pip) E.pip.classList.add('show');
    });

    R.on('remote', function (stream) {
      if (!E.remoteVideo) return;
      E.remoteVideo.srcObject = stream || null;
      if (stream) E.remoteVideo.play().catch(function () {});
    });

    R.on('channel', function (st) {
      if (st === 'open') NN.toast('Channel open · chat, files and the board are live');
    });

    R.on('role', function (role) { airgapRole = role; });

    R.on('airgap-descriptor', function (d) {
      if (!E.airgapOut) return;
      E.airgapOut.value = d.sdp || '';
      if (d.role === 'host') {
        E.airgapOutLabel.textContent = '01 — your offer';
        E.airgapInLabel.textContent = '02 — their answer';
        E.airgapLead.textContent = 'No relay involved. Copy the offer, send it over any channel you trust, then paste their answer here.';
      } else {
        E.airgapOutLabel.textContent = '02 — your answer';
        E.airgapInLabel.textContent = '01 — their offer';
        E.airgapLead.textContent = 'Paste the offer you received, press Connect, then send the answer below back the same way.';
      }
      E.airgapConnect.disabled = !E.airgapIn.value.trim();
    });

    R.on('relay', paintRelay);
    R.on('mode', paintMode);

    R.on('tick', function (t) { if (E.timer) E.timer.textContent = t; });

    R.on('stats', function (s) {
      if (E.stRes) E.stRes.textContent = s.res;
      if (E.stFps) E.stFps.textContent = s.fps;
      if (E.stRate) E.stRate.textContent = s.rate;
      if (E.stRtt) E.stRtt.textContent = s.rtt;
    });

    R.on('path', function (p) {
      if (E.pathBadge) { E.pathBadge.hidden = false; E.pathBadge.textContent = 'path ' + p; }
      if (E.pathFull) E.pathFull.textContent = p;
    });

    R.on('fingerprints', function (pair) { paintFp(pair); });

    R.on('sharing', function (on) {
      if (E.shareBtn) E.shareBtn.setAttribute('aria-pressed', String(!!on));
    });

    R.on('toast', function (msg) { NN.toast(msg); });
  }

  /* ---------------- boot ---------------- */
  function init() {
    room = $('#room');
    E = {
      addrCode: $('#addrCode'), relayChip: $('#relayChip'), relayChipText: $('#relayChipText'),
      stateText: $('#stateText'), timer: $('#timer'), verifyBtn: $('#verifyBtn'), settingsBtn: $('#settingsBtn'),
      remoteVideo: $('#remoteVideo'), localVideo: $('#localVideo'), pip: $('#pip'), encBadge: $('#encBadge'),
      pathBadge: $('#pathBadge'), waitingText: $('#waitingText'),
      createBtn: $('#createBtn'), joinForm: $('#joinForm'), codeInput: $('#codeInput'),
      bigCode: $('#bigCode'), inviteLink: $('#inviteLink'), copyLinkBtn: $('#copyLinkBtn'), cancelRoom: $('#cancelRoom'),
      airgapOut: $('#airgapOut'), airgapIn: $('#airgapIn'), airgapOutLabel: $('#airgapOutLabel'),
      airgapInLabel: $('#airgapInLabel'), airgapLead: $('#airgapLead'), copyBlob: $('#copyBlob'),
      pasteBlob: $('#pasteBlob'), airgapConnect: $('#airgapConnect'), airgapReset: $('#airgapReset'),
      airgapClose: $('#airgapClose'), airgapUseRelay: $('#airgapUseRelay'),
      againBtn: $('#againBtn'), dismissEnded: $('#dismissEnded'),
      micBtn: $('#micBtn'), camBtn: $('#camBtn'), shareBtn: $('#shareBtn'), hangupBtn: $('#hangupBtn'),
      boardBtn: $('#boardBtn'), sideBtn: $('#sideBtn'), side: $('#side'), sideClose: $('#sideClose'),
      modeRelay: $('#modeRelay'), modeAirgap: $('#modeAirgap'), modeHint: $('#modeHint'),
      deckTitle: $('#deckTitle'), deckSub: $('#deckSub'),
      stRes: $('#stRes'), stFps: $('#stFps'), stRate: $('#stRate'), stRtt: $('#stRtt'),
      thread: $('#thread'), chatInput: $('#chatInput'), chatUnread: $('#chatUnread'), fileUnread: $('#fileUnread'),
      fpLocal: $('#fpLocal'), fpRemote: $('#fpRemote'), fpMatch: $('#fpMatch'),
      fpLocalFull: $('#fpLocalFull'), fpRemoteFull: $('#fpRemoteFull'), pathFull: $('#pathFull'),
      markVerified: $('#markVerified'),
      relayInput: $('#relayInput'), relayTestOut: $('#relayTestOut'), saveRelay: $('#saveRelay'),
      clearRelay: $('#clearRelay'), testRelay: $('#testRelay')
    };

    NN.App = {
      isChatVisible: isChatVisible,
      ping: ping,
      setState: setState,
      setTab: setTab
    };

    NN.Chat.init();
    NN.Board.init();
    listen();
    bind();

    paintMode(NN.RTC.mode);
    paintRelay(NN.RTC.health);
    paintFp();
    setState('idle');
    if (E.relayInput) E.relayInput.placeholder = 'https://nullnode-relay.you.workers.dev';

    if (E.airgapConnect) E.airgapConnect.disabled = true;
    if (E.airgapIn) E.airgapIn.addEventListener('input', function () {
      if (E.airgapConnect) E.airgapConnect.disabled = !E.airgapIn.value.trim();
    });

    /* deep link ?r=CODE */
    var code = '';
    try { code = NN.RTC.normaliseCode(new URL(location.href).searchParams.get('r')); } catch (e) {}
    if (code.length === NN.RTC.CODE_LEN && NN.RTC.isCode(code)) {
      if (E.codeInput) E.codeInput.value = code;
      NN.toast('Invite found · joining ' + code);
      setTimeout(function () { NN.RTC.joinRoom(code); }, 500);
    } else if (code.length) {
      if (E.codeInput) E.codeInput.value = code.replace(/[01OIL]/g, '');
      NN.toast('That invite link holds an invalid key');
    }

    window.addEventListener('beforeunload', function () {
      if (NN.RTC.state.state === 'live') NN.RTC.hangup(false);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
