/* ============================================================
   NullNode · shared board — vector strokes over the data channel
   ============================================================ */
(function () {
  'use strict';
  var VW = 1600, VH = 1000;
  var DPR = 1;

  var el = {}, ctx = null;
  var shapes = [];
  var redoStack = [];
  var mine = [];               // ids this client created, in order
  var tool = 'pen', color = '#ede9df', w = 5;
  var drawing = null, lastEmit = 0, lastCursor = 0;
  var remote = { x: 0, y: 0, on: false, at: 0 };
  var open = false, renderQueued = false, started = false;
  var uid = 0;

  function nextId() { return 's' + Date.now().toString(36) + (uid++).toString(36); }

  /* ---------------- render ---------------- */
  function fit() {
    if (!el.canvas) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    el.canvas.width = Math.round(VW * DPR);
    el.canvas.height = Math.round(VH * DPR);
    request();
  }

  function strokePath(pts) {
    if (!pts || !pts.length) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) { ctx.lineTo(pts[0][0] + 0.1, pts[0][1] + 0.1); }
    else for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  function arrowHead(a, b) {
    var ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    var len = Math.max(14, ctx.lineWidth * 3.2);
    ctx.beginPath();
    ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b[0] - len * Math.cos(ang - 0.42), b[1] - len * Math.sin(ang - 0.42));
    ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b[0] - len * Math.cos(ang + 0.42), b[1] - len * Math.sin(ang + 0.42));
    ctx.stroke();
  }

  function paint(s) {
    if (!s || !s.pts || !s.pts.length) return;
    ctx.save();
    if (s.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = s.w * 2;
    } else if (s.tool === 'hl') {
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.w * 2.8;
    } else {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.w;
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    var a = s.pts[0], b = s.pts[s.pts.length - 1];
    switch (s.tool) {
      case 'pen': case 'hl': case 'eraser':
        strokePath(s.pts); break;
      case 'line':
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); break;
      case 'arrow':
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        arrowHead(a, b); break;
      case 'rect':
        ctx.beginPath();
        ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        ctx.stroke(); break;
      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2,
          Math.max(1, Math.abs(b[0] - a[0]) / 2), Math.max(1, Math.abs(b[1] - a[1]) / 2), 0, 0, Math.PI * 2);
        ctx.stroke(); break;
      case 'text':
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = s.color;
        ctx.font = '600 ' + (s.w * 3.4 + 12) + 'px "JetBrains Mono", ui-monospace, monospace';
        ctx.textBaseline = 'top';
        ctx.fillText(s.text, a[0], a[1]);
        break;
    }
    ctx.restore();
  }

  function drawRemoteCursor() {
    if (!remote.on || Date.now() - remote.at > 4000) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(remote.x, remote.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(200,255,61,.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(8,9,10,.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = '600 13px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(200,255,61,.75)';
    ctx.textBaseline = 'top';
    ctx.fillText('peer', remote.x + 12, remote.y + 10);
    ctx.restore();
  }

  function render() {
    renderQueued = false;
    if (!ctx) return;
    var c = el.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    shapes.forEach(paint);
    if (drawing) paint(drawing);
    drawRemoteCursor();
  }

  function request() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  /* ---------------- geometry ---------------- */
  function toVirtual(e) {
    var r = el.canvas.getBoundingClientRect();
    return [
      NN.clamp((e.clientX - r.left) / r.width * VW, 0, VW),
      NN.clamp((e.clientY - r.top) / r.height * VH, 0, VH)
    ];
  }

  function broadcast(op) {
    if (!NN.RTC || !NN.RTC.channelOpen) return;
    NN.RTC.send({ t: 'wb', op: op });
  }

  /* ---------------- editing ---------------- */
  function upsert(shape) {
    for (var i = 0; i < shapes.length; i++) if (shapes[i].id === shape.id) { shapes[i] = shape; return; }
    shapes.push(shape);
  }

  function commit(shape) {
    shapes.push(shape);
    mine.push(shape.id);
    redoStack = [];
    broadcast({ k: 'add', shape: shape });
    request();
  }

  function undo() {
    for (var i = mine.length - 1; i >= 0; i--) {
      var id = mine[i];
      var idx = -1;
      for (var j = 0; j < shapes.length; j++) if (shapes[j].id === id) { idx = j; break; }
      if (idx >= 0) {
        var s = shapes.splice(idx, 1)[0];
        mine.splice(i, 1);
        redoStack.push(s);
        broadcast({ k: 'remove', id: id });
        request();
        return;
      }
      mine.splice(i, 1);
    }
    NN.toast('Nothing of yours left to undo');
  }

  function redo() {
    if (!redoStack.length) { NN.toast('Nothing to redo'); return; }
    var s = redoStack.pop();
    shapes.push(s);
    mine.push(s.id);
    broadcast({ k: 'add', shape: s });
    request();
  }

  function clear() {
    shapes = []; mine = []; redoStack = [];
    broadcast({ k: 'clear' });
    request();
    NN.toast('Board cleared');
  }

  function exportPng() {
    var out = document.createElement('canvas');
    out.width = VW; out.height = VH;
    var o = out.getContext('2d');
    if (!o) { NN.toast('Export unsupported here'); return; }
    o.fillStyle = '#0a0b0c';
    o.fillRect(0, 0, VW, VH);
    o.fillStyle = 'rgba(237,233,223,.14)';
    for (var x = 0; x < VW; x += 32) for (var y = 0; y < VH; y += 32) o.fillRect(x, y, 1.4, 1.4);
    var prev = ctx;
    ctx = o;
    shapes.forEach(paint);
    ctx = prev;
    out.toBlob(function (blob) {
      if (!blob) { NN.toast('Export failed'); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'nullnode-board-' + Date.now().toString(36) + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
      NN.toast('Board exported');
    }, 'image/png');
  }

  /* ---------------- pointer ---------------- */
  function supportsPressure(e) { return e.pointerType === 'pen' && e.pressure > 0; }

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    if (!open) return;
    e.preventDefault();
    var p = toVirtual(e);
    try { el.canvas.setPointerCapture(e.pointerId); } catch (err) {}

    if (tool === 'text') { openTextInput(e, p); return; }

    drawing = {
      id: nextId(),
      tool: tool,
      color: color,
      w: supportsPressure(e) ? Math.max(1.5, w * (0.5 + e.pressure)) : w,
      pts: [p]
    };
    request();
  }

  function onMove(e) {
    if (!open) return;
    var p = toVirtual(e);
    if (NN.RTC && NN.RTC.channelOpen) {
      var now = performance.now();
      if (now - lastCursor > 90) {
        lastCursor = now;
        broadcast({ k: 'cursor', x: p[0], y: p[1] });
      }
    }
    if (!drawing) return;
    e.preventDefault();
    var pts = drawing.pts;
    var last = pts[pts.length - 1];
    var dx = p[0] - last[0], dy = p[1] - last[1];
    if (dx * dx + dy * dy < 2.2) return;
    if (drawing.tool === 'pen' || drawing.tool === 'hl' || drawing.tool === 'eraser') {
      pts.push(p);
    } else {
      pts[1] = p;
    }
    var now = performance.now();
    if (now - lastEmit > 60) {
      lastEmit = now;
      broadcast({ k: 'live', shape: drawing });
    }
    request();
  }

  function onUp(e) {
    if (!drawing) return;
    var s = drawing;
    drawing = null;
    if (s.pts.length === 1 && (s.tool === 'pen' || s.tool === 'hl' || s.tool === 'eraser')) {
      s.pts.push([s.pts[0][0] + 0.6, s.pts[0][1] + 0.6]);
    }
    commit(s);
    try { el.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
  }

  function openTextInput(e, p) {
    var stage = el.stage.getBoundingClientRect();
    var input = el.text;
    if (!input) return;
    input.hidden = false;
    input.value = '';
    input.style.left = Math.round(e.clientX - stage.left) + 'px';
    input.style.top = Math.round(e.clientY - stage.top) + 'px';
    input.dataset.x = String(Math.round(p[0]));
    input.dataset.y = String(Math.round(p[1]));
    setTimeout(function () { input.focus(); }, 20);
  }

  function commitText() {
    var input = el.text;
    if (!input || input.hidden) return;
    var val = input.value.trim();
    var x = Number(input.dataset.x || 0), y = Number(input.dataset.y || 0);
    input.hidden = true;
    input.value = '';
    if (!val) return;
    commit({ id: nextId(), tool: 'text', color: color, w: w, text: val.slice(0, 90), pts: [[x, y], [x, y]] });
  }

  /* ---------------- incoming ---------------- */
  function onOp(op) {
    if (!op || !op.k) return;
    if (op.k === 'live' || op.k === 'add') {
      if (op.shape) { upsert(op.shape); request(); }
    } else if (op.k === 'remove') {
      shapes = shapes.filter(function (s) { return s.id !== op.id; });
      request();
    } else if (op.k === 'clear') {
      shapes = []; mine = []; redoStack = [];
      request();
    } else if (op.k === 'cursor') {
      remote.x = op.x; remote.y = op.y; remote.on = true; remote.at = Date.now();
      request();
    } else if (op.k === 'sync' && Array.isArray(op.shapes)) {
      var have = {};
      shapes.forEach(function (s) { have[s.id] = 1; });
      op.shapes.forEach(function (s) { if (s && s.id && !have[s.id]) shapes.push(s); });
      request();
    }
  }

  /* ---------------- tool ui ---------------- */
  function setTool(t) {
    tool = t;
    NN.$$('.tool', el.section).forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    });
    if (el.canvas) el.canvas.style.cursor = t === 'text' ? 'text' : 'crosshair';
  }
  function setColor(c) {
    color = c;
    NN.$$('.swatch', el.section).forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.color === c));
    });
  }
  function setWidth(n) {
    w = n;
    NN.$$('.width', el.section).forEach(function (b) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.w) === n));
    });
  }

  /* ---------------- open / close ---------------- */
  function show() {
    if (!el.section) return;
    open = true;
    el.section.classList.add('open');
    el.section.setAttribute('aria-hidden', 'false');
    document.body.classList.add('board-open');
    setTimeout(function () {
      fit();
      request();
      if (NN.RTC && NN.RTC.channelOpen && shapes.length) {
        NN.RTC.send({ t: 'wb', op: { k: 'sync', shapes: shapes } });
      }
    }, 60);
  }
  function hide() {
    open = false;
    el.section.classList.remove('open');
    el.section.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('board-open');
  }
  function toggle() { open ? hide() : show(); }

  /* ---------------- init ---------------- */
  function init() {
    if (started) return;
    started = true;
    el = {
      section: NN.$('#board'),
      canvas: NN.$('#boardCanvas'),
      stage: NN.$('#boardStage'),
      text: NN.$('#boardText'),
      hint: NN.$('#boardHint')
    };
    if (!el.canvas || !el.canvas.getContext) return;
    try { ctx = el.canvas.getContext('2d'); } catch (e) { ctx = null; }
    if (!ctx) return;

    fit();
    el.canvas.classList.add('grid');

    el.canvas.addEventListener('pointerdown', onDown);
    el.canvas.addEventListener('pointermove', onMove);
    el.canvas.addEventListener('pointerup', onUp);
    el.canvas.addEventListener('pointercancel', onUp);
    el.canvas.addEventListener('pointerleave', function (e) { if (drawing) onUp(e); });

    NN.$$('.tool', el.section).forEach(function (b) {
      b.addEventListener('click', function () { setTool(b.dataset.tool); });
    });
    NN.$$('.swatch', el.section).forEach(function (b) {
      b.addEventListener('click', function () { setColor(b.dataset.color); });
    });
    NN.$$('.width', el.section).forEach(function (b) {
      b.addEventListener('click', function () { setWidth(Number(b.dataset.w)); });
    });

    var undoBtn = NN.$('#boardUndo'), redoBtn = NN.$('#boardRedo'), gridBtn = NN.$('#boardGrid');
    var expBtn = NN.$('#boardExport'), clearBtn = NN.$('#boardClear'), closeBtn = NN.$('#boardClose');
    if (undoBtn) undoBtn.addEventListener('click', undo);
    if (redoBtn) redoBtn.addEventListener('click', redo);
    if (gridBtn) gridBtn.addEventListener('click', function () {
      var on = el.canvas.classList.toggle('grid');
      gridBtn.setAttribute('aria-pressed', String(on));
    });
    if (expBtn) expBtn.addEventListener('click', exportPng);
    if (clearBtn) clearBtn.addEventListener('click', clear);
    if (closeBtn) closeBtn.addEventListener('click', hide);

    if (el.text) {
      el.text.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commitText(); }
        if (e.key === 'Escape') { el.text.hidden = true; el.text.value = ''; }
      });
      el.text.addEventListener('blur', commitText);
    }

    window.addEventListener('resize', function () { if (open) fit(); });

    document.addEventListener('keydown', function (e) {
      if (!open) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      var k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
      if (k === 'escape') { hide(); return; }
      var map = { p: 'pen', b: 'pen', h: 'hl', e: 'eraser', l: 'line', r: 'rect', o: 'ellipse', a: 'arrow', t: 'text' };
      if (map[k] && !e.ctrlKey && !e.metaKey) setTool(map[k]);
    });

    NN.RTC.on('message', function (m) { if (m && m.t === 'wb') onOp(m.op); });
    NN.RTC.on('channel', function (st) {
      if (st === 'open' && el.hint) el.hint.textContent = 'shared with the room · strokes appear on both screens';
    });
    NN.RTC.on('channel', function (st) { if (st === 'close') { remote.on = false; request(); } });
  }

  NN.Board = {
    init: init,
    show: show,
    hide: hide,
    toggle: toggle,
    isOpen: function () { return open; },
    count: function () { return shapes.length; }
  };
})();
