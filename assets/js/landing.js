/* ============================================================
   NullNode · product page — scroll, type, strip, plate
   Everything here is additive: without GSAP, Lenis or JS the page
   still renders, reads and navigates as a normal long document.
   ============================================================ */
(function () {
  'use strict';
  var $ = NN.$, $$ = NN.$$;

  /* ---------- smooth scroll ---------- */
  var lenis = null;
  if (window.Lenis && !NN.reduce) {
    try {
      lenis = new window.Lenis({ duration: 1.15, smoothWheel: true, wheelMultiplier: 1, touchMultiplier: 1.6,
        easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); } });
      if (window.gsap && window.ScrollTrigger) {
        window.gsap.registerPlugin(window.ScrollTrigger);
        lenis.on('scroll', window.ScrollTrigger.update);
        window.gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
        window.gsap.ticker.lagSmoothing(0);
      } else {
        var raf = function (t) { lenis.raf(t); requestAnimationFrame(raf); };
        requestAnimationFrame(raf);
      }
    } catch (e) { lenis = null; }
  }
  $$('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href');
      if (!id || id.length < 2) return;
      var target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      if (lenis) lenis.scrollTo(target, { offset: -60, duration: 1.3 });
      else target.scrollIntoView({ behavior: NN.reduce ? 'auto' : 'smooth', block: 'start' });
      if (history.replaceState) history.replaceState(null, '', id);
    });
  });

  /* ---------- reveals ---------- */
  function reveals() {
    var els = $$('.reveal, .mask-lines');
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.01, rootMargin: '0px 0px -6% 0px' });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ---------- hero: letter-by-letter, kept inside the line mask ---------- */
  function splitHero() {
    var sc = $('.split-chars');
    if (!sc) return;
    var txt = sc.textContent;
    sc.textContent = '';
    Array.prototype.slice.call(txt).forEach(function (ch, i) {
      var s = document.createElement('span');
      s.textContent = ch === ' ' ? '\u00A0' : ch;
      s.style.transitionDelay = (140 + i * 46) + 'ms';
      sc.appendChild(s);
    });
    sc.setAttribute('aria-label', txt);
  }

  /* ---------- preloader ---------- */
  var boot = $('#boot'), bootNum = $('#bootNum'), bootBar = $('#bootBar'), bootLogs = $$('#bootLog p');
  var bootStart = performance.now(), bootDur = NN.reduce ? 1 : 1060, bootDone = false;

  function endBoot(thenReveal) {
    if (bootDone) return;
    bootDone = true;
    if (boot) {
      boot.classList.add('done');
      setTimeout(function () { boot.style.display = 'none'; }, 1200);
    }
    document.body.classList.remove('is-locked');
    if (thenReveal !== false) reveals();
  }

  function bootTick(now) {
    if (!boot) { endBoot(); return; }
    var k = NN.clamp((now - bootStart) / bootDur, 0, 1);
    var eased = 1 - Math.pow(1 - k, 3);
    if (bootNum) bootNum.textContent = String(Math.round(eased * 100)).padStart(3, '0');
    if (bootBar) bootBar.style.transform = 'scaleX(' + eased + ')';
    bootLogs.forEach(function (el, i) { el.classList.toggle('on', eased * 4 > i + 0.1); });
    if (k < 1) requestAnimationFrame(bootTick);
    else endBoot();
  }

  splitHero();
  if (NN.reduce || NN.arrived) {
    if (boot) boot.style.display = 'none';
    endBoot();
  } else {
    document.body.classList.add('is-locked');
    setTimeout(function () { if (!bootDone) { if (boot) boot.style.display = 'none'; endBoot(); } }, 3200);
    requestAnimationFrame(bootTick);
  }

  /* ---------- masthead: hide on the way down, reading progress on the rule ---------- */
  var nav = $('#nav'), progress = $('#navProgress i'), lastY = 0;
  function onScroll() {
    var y = window.scrollY || window.pageYOffset;
    if (nav) {
      nav.classList.toggle('scrolled', y > 24);
      if (y > 520 && y > lastY + 4) nav.classList.add('hide');
      else if (y < lastY - 4 || y < 380) nav.classList.remove('hide');
    }
    if (progress) {
      var doc = document.documentElement;
      var max = (doc.scrollHeight - window.innerHeight) || 1;
      progress.style.transform = 'scaleX(' + Math.min(1, Math.max(0, y / max)).toFixed(4) + ')';
      progress.style.transformOrigin = '0 50%';
      progress.style.width = '100%';
    }
    lastY = y;
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- magnetic controls ---------- */
  if (NN.fine && !NN.reduce) {
    $$('.magnetic').forEach(function (el) {
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        var x = (e.clientX - r.left - r.width / 2) / r.width;
        var y = (e.clientY - r.top - r.height / 2) / r.height;
        el.style.transform = 'translate(' + (x * 8).toFixed(2) + 'px,' + (y * 5).toFixed(2) + 'px)';
      });
      el.addEventListener('mouseleave', function () { el.style.transform = ''; });
    });
  }

  /* ---------- the protocol strip: vertical scroll becomes horizontal ---------- */
  function rail() {
    var section = $('#protocol'), track = $('#railTrack'), steps = $('#railSteps'), dots = $$('#railDots i');
    if (!section || !track || !steps) return;
    var wide = window.matchMedia('(min-width: 980px)');
    var st = null, tween = null;

    function paintDots(p) {
      var active = Math.min(dots.length - 1, Math.max(0, Math.floor(p * dots.length + 0.001)));
      dots.forEach(function (d, i) { d.classList.toggle('on', i === active); });
    }

    function build() {
      if (!window.gsap || !window.ScrollTrigger || NN.reduce || !wide.matches) return;
      section.classList.add('is-pinned');
      var distance = function () { return Math.max(0, steps.scrollWidth - track.clientWidth); };
      if (distance() < 40) { destroy(); return; }
      tween = window.gsap.to(steps, {
        x: function () { return -distance(); },
        ease: 'none',
        scrollTrigger: {
          trigger: section,
          start: 'top top',
          end: function () { return '+=' + distance(); },
          pin: true,
          scrub: 0.6,
          anticipatePin: 1,
          invalidateOnRefresh: true,
          onUpdate: function (self) { paintDots(self.progress); }
        }
      });
      st = tween.scrollTrigger;
      paintDots(0);
    }

    function destroy() {
      section.classList.remove('is-pinned');
      if (tween) { if (tween.scrollTrigger) tween.scrollTrigger.kill(); tween.kill(); }
      tween = st = null;
      steps.style.transform = '';
    }

    build();
    window.addEventListener('resize', function () {
      if (!st && wide.matches && window.gsap) build();
      else if (st && !wide.matches) destroy();
    });
    if (window.ScrollTrigger) window.ScrollTrigger.addEventListener('refreshInit', function () { steps.style.transform = ''; });
  }
  rail();

  /* ---------- the ghost word drifts slower than the page ---------- */
  if (window.gsap && window.ScrollTrigger && !NN.reduce) {
    var ghost = $('.hero-ghost');
    if (ghost) {
      window.gsap.to(ghost, { yPercent: -16, ease: 'none',
        scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
    }
    $$('.entry').forEach(function (entry, i) {
      window.gsap.fromTo(entry, { y: 16 }, { y: 0, ease: 'none',
        scrollTrigger: { trigger: entry, start: 'top bottom', end: 'top 62%', scrub: true } });
    });
  }

  /* ---------- signal plate ---------- */
  var canvas = $('#signal');
  if (canvas && canvas.getContext) {
    try {
      var ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no ctx');
      var W = 0, H = 0, dpr = 1, t = 0, raf2 = null;
      function sizeCanvas() {
        dpr = Math.min(devicePixelRatio || 1, 2);
        var r = canvas.getBoundingClientRect();
        W = Math.max(1, r.width); H = Math.max(1, r.height);
        canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      sizeCanvas();
      window.addEventListener('resize', sizeCanvas);
      function node(x, y, r, on) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.strokeStyle = on ? 'rgba(200,255,61,.8)' : 'rgba(236,232,222,.3)';
        ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fillStyle = on ? '#c8ff3d' : 'rgba(236,232,222,.42)'; ctx.fill();
      }
      function draw() {
        if (!W || !H) sizeCanvas();
        ctx.clearRect(0, 0, W, H);
        var pad = 24, ax = pad + 8, ay = H * 0.46, bx = W - pad - 8, by = H * 0.46;
        ctx.setLineDash([1, 6]); ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(236,232,222,.18)';
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.setLineDash([]);
        for (var k = 0; k < 3; k++) {
          var p = ((t / 90) + k / 3) % 1;
          var px = ax + (bx - ax) * p;
          ctx.beginPath(); ctx.arc(px, by, 2.2, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(200,255,61,' + (0.62 * (1 - Math.abs(p - 0.5) * 1.2)).toFixed(3) + ')';
          ctx.fill();
        }
        node(ax, ay, 9 + Math.sin(t / 40) * 0.8, true);
        node(bx, by, 9 + Math.sin(t / 40 + 1.6) * 0.8, false);
        ctx.font = '400 8px "JetBrains Mono", monospace';
        ctx.fillStyle = 'rgba(236,232,222,.44)';
        ctx.textAlign = 'left'; ctx.fillText('YOU', ax - 8, ay + 27);
        ctx.textAlign = 'right'; ctx.fillText('PEER', bx + 8, by + 27);
        t += 1;
      }
      function loopCanvas() { draw(); raf2 = requestAnimationFrame(loopCanvas); }
      if (NN.reduce) draw(); else loopCanvas();
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) { if (raf2) cancelAnimationFrame(raf2); raf2 = null; }
        else if (!NN.reduce && !raf2) loopCanvas();
      });
    } catch (e) {}
  }

  /* ---------- deploy runbook ---------- */
  var openDeploy = $('#openDeploy');
  if (openDeploy) openDeploy.addEventListener('click', function (e) { e.preventDefault(); NN.modal('deployModal', true); });
  var copyDeploy = $('#copyDeploy');
  if (copyDeploy) copyDeploy.addEventListener('click', function () {
    var t = $('#deployBlob');
    NN.copy(t ? t.value : '', 'Deploy commands copied');
  });
  var copyCmds = $('#copyCmds');
  if (copyCmds) copyCmds.addEventListener('click', function () {
    var pre = $('#deployCmds');
    NN.copy(pre ? pre.innerText : '', 'Commands copied');
  });
})();
