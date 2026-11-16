/* ============================================================
   NullNode · chat + peer-to-peer file transfer
   Frames on the shared data channel:
     control  JSON  { t: 'chat' | 'file-offer' | 'file-accept' | ... }
     binary   [0]=1, [1..2]=transfer id (big endian), rest = payload
   ============================================================ */
(function () {
  'use strict';
  var MAX_FILE = 64 * 1024 * 1024;
  var CHUNK = 16 * 1024;

  var el = {};
  var pending = {};     // id → job (outgoing, awaiting accept)
  var queue = [];       // outgoing files waiting for their turn
  var sending = null;
  var incoming = {};    // id → { meta, chunks, received, row }
  var nextId = 1;
  var unread = 0;
  var started = false;

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function clock() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function linkify(safe) {
    return safe.replace(/(https?:\/\/[^\s<]+)/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
    });
  }

  /* ---------------- thread ---------------- */
  function addMessage(kind, text, mine) {
    if (!el.thread) return;
    if (el.threadEmpty) el.threadEmpty.hidden = true;
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + (kind === 'sys' ? 'sys' : mine ? 'me' : 'peer');
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = kind === 'sys' ? esc(text) : linkify(esc(text));
    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = (mine ? 'you · ' : kind === 'sys' ? '' : 'them · ') + clock();
    wrap.appendChild(bubble);
    if (kind !== 'sys') wrap.appendChild(meta);
    el.thread.appendChild(wrap);
    el.thread.scrollTop = el.thread.scrollHeight;
    if (!mine && kind !== 'sys' && NN.App && !NN.App.isChatVisible()) bumpUnread();
  }

  function system(text) { addMessage('sys', text, false); }

  function bumpUnread() {
    unread += 1;
    if (el.unread) { el.unread.hidden = false; el.unread.textContent = unread > 9 ? '9+' : String(unread); }
    if (NN.App) NN.App.ping('chat');
  }
  function clearUnread() {
    unread = 0;
    if (el.unread) el.unread.hidden = true;
  }

  function sendText(text) {
    text = String(text || '').trim();
    if (!text) return false;
    if (!NN.RTC.channelOpen) { NN.toast('The channel is not open yet'); return false; }
    var payload = { t: 'chat', id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: text, ts: Date.now() };
    NN.RTC.send(payload);
    addMessage('text', text, true);
    return true;
  }

  /* ---------------- transfers ---------------- */
  function row(meta, dir) {
    if (!el.transfers) return null;
    var d = document.createElement('div');
    d.className = 'transfer';
    d.dataset.status = 'active';
    d.innerHTML =
      '<div class="transfer-top">' + NN.icon(dir === 'in' ? 'download' : 'upload') +
      '<span class="transfer-name">' + esc(meta.name) + '</span>' +
      '<span class="transfer-size">' + fmtBytes(meta.size) + '</span></div>' +
      '<div class="bar-track"><div class="bar-fill"></div></div>' +
      '<div class="transfer-foot"><span class="transfer-state">' +
      (dir === 'in' ? 'incoming · 0%' : 'waiting') + '</span></div>';
    el.transfers.prepend(d);
    return d;
  }
  function rowProgress(r, frac, label) {
    if (!r) return;
    var fill = r.querySelector('.bar-fill');
    var state = r.querySelector('.transfer-state');
    if (fill) fill.style.transform = 'scaleX(' + Math.max(0.01, Math.min(1, frac)).toFixed(3) + ')';
    if (state && label) state.textContent = label;
  }
  function rowDone(r, blob, meta) {
    if (!r) return;
    r.dataset.status = 'done';
    rowProgress(r, 1, 'received · ' + fmtBytes(meta.size));
    var foot = r.querySelector('.transfer-foot');
    if (!foot || !blob) return;
    var url;
    try { url = URL.createObjectURL(blob); } catch (e) { foot.insertAdjacentHTML('beforeend', '<span class="transfer-save">received</span>'); return; }
    var a = document.createElement('a');
    a.className = 'transfer-save';
    a.href = url;
    a.download = meta.name || 'nullnode-file';
    a.innerHTML = NN.icon('download') + 'Save';
    foot.appendChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10 * 60 * 1000);
  }
  function rowError(r, msg) {
    if (!r) return;
    r.dataset.status = 'error';
    rowProgress(r, 0, msg || 'failed');
  }

  function queueFiles(files) {
    if (!files || !files.length) return;
    if (!NN.RTC.channelOpen) { NN.toast('Open a call before sending files'); return; }
    Array.prototype.forEach.call(files, function (file) {
      if (file.size > MAX_FILE) { NN.toast(file.name + ' is larger than 64 MB'); return; }
      if (!file.size) { NN.toast(file.name + ' is empty'); return; }
      queue.push({ file: file, id: nextId++ & 0xffff, row: row({ name: file.name, size: file.size }, 'out') });
    });
    pump();
  }

  function pump() {
    if (sending || !queue.length) return;
    var job = queue.shift();
    sending = job;
    pending[job.id] = job;
    job.accept = function () { onAccepted(job); };
    job.reject = function (why) {
      clearTimeout(job.timer);
      rowError(job.row, why || 'declined');
      if (sending === job) sending = null;
      delete pending[job.id];
      pump();
    };
    job.timer = setTimeout(function () {
      if (sending === job && !job.started) {
        rowError(job.row, 'no answer');
        sending = null; delete pending[job.id]; pump();
      }
    }, 15000);
    rowProgress(job.row, 0.02, 'offering');
    NN.RTC.send({ t: 'file-offer', id: job.id, name: job.file.name, size: job.file.size, type: job.file.type || 'application/octet-stream' });
  }

  function onAccepted(job) {
    if (job.started) return;
    job.started = true;
    clearTimeout(job.timer);
    var file = job.file, offset = 0, id = job.id;
    rowProgress(job.row, 0, 'sending · 0%');
    (function next() {
      if (sending !== job) return;
      if (offset >= file.size) {
        NN.RTC.send({ t: 'file-done', id: id });
        rowProgress(job.row, 1, 'sent · ' + fmtBytes(file.size));
        job.row.dataset.status = 'done';
        sending = null; delete pending[id]; pump();
        return;
      }
      NN.RTC.drain().then(function () {
        var slice = file.slice(offset, offset + CHUNK);
        var reader = new FileReader();
        reader.onload = function () {
          var buf = reader.result;
          var frame = new Uint8Array(3 + buf.byteLength);
          frame[0] = 1;
          frame[1] = (id >> 8) & 255;
          frame[2] = id & 255;
          frame.set(new Uint8Array(buf), 3);
          if (!NN.RTC.sendRaw(frame.buffer)) { setTimeout(next, 60); return; }
          offset += buf.byteLength;
          rowProgress(job.row, offset / file.size, 'sending · ' + Math.round((offset / file.size) * 100) + '%');
          next();
        };
        reader.onerror = function () { rowError(job.row, 'read failed'); sending = null; delete pending[id]; pump(); };
        reader.readAsArrayBuffer(slice);
      });
    })();
  }

  /* ---------------- incoming ---------------- */
  function onControl(m) {
    if (m.t === 'chat' && typeof m.text === 'string') {
      addMessage('text', m.text.slice(0, 2000), false);
      return true;
    }
    if (m.t === 'file-offer') {
      var meta = { name: String(m.name || 'file').slice(0, 120), size: Number(m.size) || 0, type: String(m.type || 'application/octet-stream') };
      if (meta.size > MAX_FILE) { NN.RTC.send({ t: 'file-reject', id: m.id, reason: 'too large' }); return true; }
      var r = row(meta, 'in');
      incoming[m.id] = { meta: meta, chunks: [], received: 0, row: r };
      NN.RTC.send({ t: 'file-accept', id: m.id });
      rowProgress(r, 0.01, 'incoming · 0%');
      return true;
    }
    if (m.t === 'file-accept') {
      var job = pending[m.id];
      if (job) job.accept();
      return true;
    }
    if (m.t === 'file-reject') {
      var j2 = pending[m.id];
      if (j2) j2.reject(m.reason === 'too large' ? 'too large' : 'declined');
      return true;
    }
    if (m.t === 'file-cancel') {
      var j3 = pending[m.id];
      if (j3) j3.reject('cancelled');
      delete incoming[m.id];
      return true;
    }
    if (m.t === 'file-done') {
      var inc = incoming[m.id];
      if (inc && inc.received >= inc.meta.size) finishIncoming(m.id);
      return true;
    }
    return false;
  }

  function onBinary(buf) {
    var u8 = new Uint8Array(buf);
    if (u8.length < 4 || u8[0] !== 1) return;
    var id = (u8[1] << 8) | u8[2];
    var inc = incoming[id];
    if (!inc) return;
    inc.chunks.push(buf.slice(3));
    inc.received += u8.length - 3;
    if (inc.received >= inc.meta.size) finishIncoming(id);
    else rowProgress(inc.row, inc.received / inc.meta.size, 'incoming · ' + Math.round((inc.received / inc.meta.size) * 100) + '%');
  }

  function finishIncoming(id) {
    var inc = incoming[id];
    if (!inc) return;
    var blob = new Blob(inc.chunks, { type: inc.meta.type });
    rowDone(inc.row, blob, inc.meta);
    delete incoming[id];
    if (NN.App) NN.App.ping('files');
  }

  /* ---------------- wiring ---------------- */
  function init() {
    if (started) return;
    started = true;
    el = {
      thread: NN.$('#thread'),
      threadEmpty: NN.$('#threadEmpty'),
      form: NN.$('#composer'),
      input: NN.$('#chatInput'),
      unread: NN.$('#chatUnread'),
      fileUnread: NN.$('#fileUnread'),
      drop: NN.$('#drop'),
      fileInput: NN.$('#fileInput'),
      transfers: NN.$('#transfers')
    };

    if (el.form) {
      el.form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (sendText(el.input.value)) { el.input.value = ''; el.input.style.height = 'auto'; }
      });
    }
    if (el.input) {
      el.input.addEventListener('input', function () {
        el.input.style.height = 'auto';
        el.input.style.height = Math.min(120, el.input.scrollHeight) + 'px';
      });
      el.input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (sendText(el.input.value)) { el.input.value = ''; el.input.style.height = 'auto'; }
        }
      });
    }
    if (el.drop && el.fileInput) {
      el.drop.addEventListener('click', function () { el.fileInput.click(); });
      el.drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); } });
      el.fileInput.addEventListener('change', function () { queueFiles(el.fileInput.files); el.fileInput.value = ''; });
      ['dragenter', 'dragover'].forEach(function (ev) {
        el.drop.addEventListener(ev, function (e) { e.preventDefault(); el.drop.classList.add('over'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        el.drop.addEventListener(ev, function (e) { e.preventDefault(); el.drop.classList.remove('over'); });
      });
      el.drop.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files) queueFiles(e.dataTransfer.files);
      });
    }

    NN.RTC.on('channel', function (st) {
      if (st === 'open') {
        system('channel open · everything below is peer-to-peer');
        if (el.form) el.form.classList.remove('disabled');
      } else {
        if (sending) { sending.reject('channel closed'); }
      }
    });
    NN.RTC.on('message', function (m) { onControl(m); });
    NN.RTC.on('binary', onBinary);
    NN.RTC.on('relay-offline', function () {});
  }

  NN.Chat = {
    init: init,
    sendText: sendText,
    queueFiles: queueFiles,
    clearUnread: clearUnread,
    system: system,
    fmtBytes: fmtBytes
  };
})();
