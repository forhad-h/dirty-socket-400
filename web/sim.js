/* ------------------------------------------------------------------ *
   Simulator engine.

   This does not invent anything. It replays `traces.js`, which was
   recorded by `server/capture.js` from a real TCP connection to a real
   Node HTTP server. Every byte string and every event message rendered
   below came off that wire.
 * ------------------------------------------------------------------ */

(function () {
  'use strict';

  var TRACES = window.__TRACES;
  if (!TRACES) return;

  // ---- geometry, matching the SVG viewBox ---------------------------
  var WIRE = {
    a: { x1: 212, x2: 360, y: 130 },
    b: { x1: 540, x2: 688, y: 130 },
  };

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- DOM ----------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    provenance: $('provenance'),
    wireA: $('wire-a'), wireB: $('wire-b'),
    wireALabel: $('wire-a-label'), wireBLabel: $('wire-b-label'),
    nodeClient: $('node-client'), nodeProxy: $('node-proxy'), nodeUpstream: $('node-upstream'),
    stateClient: $('state-client'), stateProxy: $('state-proxy'), stateUpstream: $('state-upstream'),
    packets: $('packets'),
    caption: $('stage-caption'),
    pool: $('pool'), wireView: $('wire-view'), log: $('log'),
    verdict: $('verdict'), verdictStatus: $('verdict-status'), verdictText: $('verdict-text'),
    play: $('btn-play'), step: $('btn-step'), reset: $('btn-reset'),
    speed: $('speed'), speedOut: $('speed-out'),
    scrub: $('scrub'), scrubIdx: $('scrub-idx'), scrubMax: $('scrub-max'),
  };

  // ---- state --------------------------------------------------------
  var mode = 'broken';
  var idx = 0;            // number of steps applied
  var playing = false;
  var speed = 1;
  var timer = null;

  function trace() { return TRACES[mode]; }
  function steps() { return trace().steps; }

  // ---- helpers ------------------------------------------------------

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  /** Render raw wire bytes with CRLF made visible. */
  function bytesHtml(s) {
    return esc(s).replace(/\r\n/g, '<span style="opacity:.35">⏎</span>\n');
  }

  function seg(cls, s) {
    return '<span class="' + cls + '">' + bytesHtml(s) + '</span>';
  }

  /** Severity used for log colouring and node tinting. */
  function levelOf(kind) {
    if (/parse-error|bad-body|steals-bytes|client:error|abandon/.test(kind)) return 'bad';
    if (/client:ok|stream-complete|destroy-upstream/.test(kind)) return 'good';
    if (/abort|forward-partial|pool:state/.test(kind)) return 'warn';
    return '';
  }

  // ---- presentation for a single trace step -------------------------
  // Returns { caption, packet, focus } — packet is spawned only during
  // live playback, never when scrubbing.

  function present(step) {
    var k = step.kind;

    if (k === 'client:send') {
      var msg = /Hello/.test(step.detail) ? 'Hello' : 'follow-up';
      return {
        caption: step.detail,
        focus: 'client',
        packet: { wire: 'a', dir: 1, label: msg, tone: 'data' },
      };
    }
    if (k === 'proxy:forward-partial') {
      return {
        caption: 'Proxy forwards headers + a partial body. The upstream now expects ' +
                 step.owedBytes + ' more body bytes.',
        focus: 'proxy',
        packet: { wire: 'b', dir: 1, label: 'POST', tone: 'warn' },
      };
    }
    if (k === 'client:abort') {
      return { caption: 'User sends a follow-up — the browser aborts the first request.', focus: 'client' };
    }
    if (k === 'proxy:abandon-upstream') {
      return {
        caption: 'The proxy answers the client but never destroys its upstream request. ' +
                 step.owedBytes + ' promised body bytes will never arrive.',
        focus: 'proxy',
      };
    }
    if (k === 'proxy:destroy-upstream') {
      return { caption: 'proxyReq.destroy() — the upstream request is torn down and the socket leaves the pool.', focus: 'proxy' };
    }
    if (k === 'pool:checkout') {
      return { caption: step.detail, focus: 'proxy' };
    }
    if (k === 'proxy:forward') {
      return {
        caption: 'The follow-up is written onto ' + (step.socketId || 'the socket') + '.',
        focus: 'proxy',
        packet: { wire: 'b', dir: 1, label: 'POST', tone: mode === 'broken' ? 'bad' : 'data' },
      };
    }
    if (k === 'upstream:steals-bytes') {
      return {
        caption: 'The upstream is still owed ' + step.owedBytes +
                 ' body bytes — so it eats them from the front of the new request.',
        focus: 'upstream',
      };
    }
    if (k === 'upstream:parse-error') {
      var benign = /EOF_STATE/.test(step.detail);
      return {
        caption: benign
          ? 'Parser reports ' + step.detail.split(' ')[0] +
            ' — expected, the socket was deliberately destroyed mid-body. Nobody is waiting on it.'
          : 'Parser reads "1" as an HTTP method and gives up: ' + step.detail,
        focus: 'upstream',
        packet: benign ? null : { wire: 'b', dir: -1, label: '400', tone: 'bad' },
      };
    }
    if (k === 'upstream:bad-body') {
      return { caption: 'Request #1’s body ended up as a JSON fragment welded to a request line.', focus: 'upstream' };
    }
    if (k === 'upstream:stream-open') {
      return { caption: step.detail, focus: 'upstream', packet: { wire: 'b', dir: -1, label: 'SSE', tone: 'good' } };
    }
    if (k === 'upstream:stream-complete') {
      return { caption: step.detail, focus: 'upstream', packet: { wire: 'a', dir: -1, label: 'data', tone: 'good' } };
    }
    if (k === 'client:error') {
      return { caption: 'The client gets ' + step.detail + ' — on a request that was perfectly well formed.', focus: 'client',
               packet: { wire: 'a', dir: -1, label: '400', tone: 'bad' } };
    }
    if (k === 'client:ok') {
      return { caption: 'The client gets ' + step.detail + ' and the full token stream.', focus: 'client' };
    }
    if (k === 'socket:opened')  return { caption: step.detail };
    if (k === 'socket:closed')  return { caption: step.detail };

    return { caption: step.detail };
  }

  // ---- derive cumulative state --------------------------------------

  function derive(upto) {
    var s = {
      sockets: {},        // id -> { id, label, state, owed, note }
      wireB: 'idle',      // idle | busy | dirty | gone
      focus: null,
      caption: 'Press Play to run the scenario.',
      inspector: null,
      verdict: null,
    };

    var list = steps();

    for (var i = 0; i < upto; i++) {
      var st = list[i];
      var k = st.kind;
      var id = st.socketId;

      if (k === 'socket:opened' && id) {
        s.sockets[id] = { id: id, state: 'open', owed: 0, note: 'connected, idle' };
      }

      if (k === 'proxy:forward-partial' && s.sockets[id]) {
        s.sockets[id].state = 'busy';
        s.sockets[id].owed = st.owedBytes || 0;
        s.sockets[id].note = 'request #1 in flight';
        s.inspector = {
          title: 'Request #1 — headers + partial body',
          blocks: [{ cls: 'seg-warn', text: st.bytes }],
          note: 'Content-Length promised ' + (st.owedBytes + 20) + ' body bytes. Only 20 were sent.',
        };
        s.wireB = 'busy';
      }

      if (k === 'proxy:abandon-upstream' && s.sockets[id]) {
        s.sockets[id].state = 'dirty';
        s.sockets[id].owed = st.owedBytes || 0;
        s.sockets[id].note = 'returned to the pool mid-message';
        s.wireB = 'dirty';
      }

      if (k === 'proxy:destroy-upstream' && s.sockets[id]) {
        s.sockets[id].state = 'destroyed';
        s.sockets[id].owed = 0;
        s.sockets[id].note = 'destroyed — cannot be reused';
        s.wireB = 'gone';
      }

      if (k === 'pool:checkout' && s.sockets[id]) {
        if (s.sockets[id].state !== 'dirty') {
          s.sockets[id].state = 'busy';
          s.sockets[id].note = 'checked out for the follow-up';
        } else {
          s.sockets[id].note = 'reused for the follow-up — still owes ' + s.sockets[id].owed + ' bytes';
        }
      }

      if (k === 'proxy:forward' && st.bytes) {
        s.inspector = {
          title: 'Request #2 — the follow-up, as sent',
          blocks: [{ cls: 'seg-ok', text: st.bytes }],
          note: 'Nothing is wrong with these bytes.',
        };
      }

      if (k === 'upstream:steals-bytes') {
        s.inspector = {
          title: 'How the upstream reads request #2',
          split: {
            stolen: st.stolen,
            remainder: st.resyncRemainder,
            stitched: st.stitchedBody,
          },
        };
        if (s.sockets[id]) s.sockets[id].note = 'corrupted — messages have run together';
      }

      if (k === 'upstream:stream-open' || k === 'upstream:stream-complete') {
        if (s.sockets[id]) s.sockets[id].state = 'good';
      }

      if (k === 'socket:closed' && s.sockets[id]) {
        if (s.sockets[id].state !== 'destroyed') {
          s.sockets[id].state = s.sockets[id].state === 'good' ? 'good' : 'closed';
        }
        s.sockets[id].note = 'closed';
        s.sockets[id].owed = 0;
      }

      if (k === 'client:error') s.verdict = { ok: false, status: st.detail };
      if (k === 'client:ok')    s.verdict = { ok: true, status: st.detail };

      var p = present(st);
      if (p.caption) s.caption = p.caption;
      if (p.focus) s.focus = p.focus;
    }

    return s;
  }

  // ---- rendering ----------------------------------------------------

  function renderTopology(s) {
    [['client', el.nodeClient, el.stateClient],
     ['proxy', el.nodeProxy, el.stateProxy],
     ['upstream', el.nodeUpstream, el.stateUpstream]].forEach(function (t) {
      var name = t[0], node = t[1], label = t[2];
      node.classList.toggle('is-active', s.focus === name);
      node.classList.remove('is-bad', 'is-good');
      label.textContent = '';
      label.classList.remove('bad', 'good');
    });

    if (s.verdict) {
      el.nodeClient.classList.add(s.verdict.ok ? 'is-good' : 'is-bad');
      el.stateClient.textContent = s.verdict.ok ? '200 OK' : '400 Bad Request';
      el.stateClient.classList.add(s.verdict.ok ? 'good' : 'bad');
    }

    var dirtySock = Object.keys(s.sockets).map(function (k) { return s.sockets[k]; })
      .filter(function (x) { return x.state === 'dirty'; })[0];

    if (dirtySock) {
      el.stateProxy.textContent = 'pool: ' + dirtySock.id + ' (owes ' + dirtySock.owed + 'B)';
      el.stateProxy.classList.add('bad');
    }

    el.wireB.classList.toggle('is-dirty', s.wireB === 'dirty');
    el.wireB.classList.toggle('is-gone', s.wireB === 'gone');
    el.wireB.classList.toggle('is-clean', s.wireB === 'busy' && mode === 'fixed');
    el.wireBLabel.classList.toggle('is-dirty', s.wireB === 'dirty');
    el.wireBLabel.classList.toggle('is-gone', s.wireB === 'gone');
    el.wireBLabel.textContent =
      s.wireB === 'dirty' ? 'Dirty Socket' : s.wireB === 'gone' ? 'destroyed' : 'Socket';

    el.caption.innerHTML = esc(s.caption);
  }

  var SOCK_CLASS = {
    open: '', busy: 's-busy', dirty: 's-dirty',
    destroyed: 's-destroyed', closed: 's-destroyed', good: 's-good',
  };
  var SOCK_BADGE = {
    open: ['idle', ''], busy: ['in use', ''], dirty: ['mid-message', 'b-bad'],
    destroyed: ['destroyed', ''], closed: ['closed', ''], good: ['streaming', 'b-good'],
  };

  function renderPool(s) {
    var ids = Object.keys(s.sockets);
    if (!ids.length) {
      el.pool.innerHTML = '<p class="empty">No sockets yet.</p>';
      return;
    }
    el.pool.innerHTML = ids.map(function (id) {
      var k = s.sockets[id];
      var badge = SOCK_BADGE[k.state] || ['', ''];
      return '<div class="sock ' + (SOCK_CLASS[k.state] || '') + '">' +
        '<div class="sock-head"><span class="sock-id">' + esc(k.id) + '</span>' +
        '<span class="badge ' + badge[1] + '">' + esc(badge[0]) + '</span></div>' +
        '<p class="sock-note">' + esc(k.note) + '</p>' +
        (k.owed ? '<p class="sock-owed">still owes ' + k.owed + ' body bytes</p>' : '') +
        '</div>';
    }).join('');
  }

  function renderInspector(s) {
    var ins = s.inspector;
    if (!ins) {
      el.wireView.innerHTML = '<p class="empty">Nothing on the wire yet.</p>';
      return;
    }

    if (ins.split) {
      el.wireView.innerHTML =
        '<div>' +
          '<p class="bytes-label">Request #2 as the upstream parses it</p>' +
          '<pre class="bytes">' +
            seg('seg-bad', ins.split.stolen) +
            seg('seg-warn', ins.split.remainder) +
          '</pre>' +
        '</div>' +
        '<p class="legend">' +
          '<span class="l-bad">swallowed as request #1’s body</span>' +
          '<span class="l-warn">parsed as a new request line</span>' +
        '</p>' +
        '<div>' +
          '<p class="bytes-label">What request #1’s body became</p>' +
          '<pre class="bytes">' + seg('seg-bad', ins.split.stitched) + '</pre>' +
        '</div>' +
        '<p class="panel-hint" style="margin:0">' +
          'The parser then looks for a request line and finds <code>1</code>. ' +
          'That is not a method — <code>HPE_INVALID_METHOD</code>, and a 400.' +
        '</p>';
      return;
    }

    el.wireView.innerHTML =
      '<div><p class="bytes-label">' + esc(ins.title) + '</p>' +
      '<pre class="bytes">' + ins.blocks.map(function (b) { return seg(b.cls, b.text); }).join('') + '</pre></div>' +
      (ins.note ? '<p class="panel-hint" style="margin:0">' + esc(ins.note) + '</p>' : '');
  }

  function renderLog(upto, newestIdx) {
    var list = steps();
    var html = '';
    for (var i = 0; i < upto; i++) {
      var st = list[i];
      var lvl = levelOf(st.kind);
      html += '<li class="' + (lvl ? 'lv-' + lvl : '') + (i === newestIdx ? ' is-new' : '') + '">' +
        '<span class="t">' + st.t + 'ms</span>' +
        '<span class="m"><span class="who">' + esc(st.actor) + '</span>' + esc(st.detail) + '</span>' +
        '</li>';
    }
    el.log.innerHTML = html;
    el.log.scrollTop = el.log.scrollHeight;
  }

  function renderVerdict(s) {
    if (!s.verdict) { el.verdict.hidden = true; return; }
    el.verdict.hidden = false;
    el.verdict.className = 'verdict ' + (s.verdict.ok ? 'is-good' : 'is-bad');
    el.verdictStatus.textContent = s.verdict.status;
    el.verdictText.textContent = s.verdict.ok
      ? 'The abort was propagated, the dirty socket never entered the pool, and the follow-up ran on a clean connection.'
      : 'The follow-up was well formed. It failed because the previous request left ' +
        trace().owedBytes + ' unsent body bytes on a socket that went back into the pool.';
  }

  function renderAll(newestIdx) {
    var s = derive(idx);
    renderTopology(s);
    renderPool(s);
    renderInspector(s);
    renderLog(idx, typeof newestIdx === 'number' ? newestIdx : -1);
    renderVerdict(s);

    el.scrub.value = String(idx);
    el.scrubIdx.textContent = String(idx);
  }

  // ---- packets ------------------------------------------------------

  function spawnPacket(p) {
    if (!p) return;
    var w = WIRE[p.wire];
    var from = p.dir > 0 ? w.x1 : w.x2;
    var to = p.dir > 0 ? w.x2 : w.x1;

    var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'packet tone-' + p.tone);
    g.innerHTML =
      '<circle r="7" cy="0" cx="0"></circle>' +
      '<text x="0" y="-13">' + esc(p.label) + '</text>';
    g.setAttribute('transform', 'translate(' + from + ',' + w.y + ')');
    el.packets.appendChild(g);

    var dur = reduceMotion ? 1 : 620 / speed;
    var anim = g.animate(
      [
        { transform: 'translate(' + from + 'px,' + w.y + 'px)', opacity: 0 },
        { transform: 'translate(' + ((from + to) / 2) + 'px,' + w.y + 'px)', opacity: 1, offset: 0.25 },
        { transform: 'translate(' + to + 'px,' + w.y + 'px)', opacity: 1, offset: 0.85 },
        { transform: 'translate(' + to + 'px,' + w.y + 'px)', opacity: 0 },
      ],
      { duration: dur, easing: 'cubic-bezier(.4,0,.5,1)', fill: 'forwards' }
    );
    anim.onfinish = function () { g.remove(); };
  }

  function clearPackets() { el.packets.innerHTML = ''; }

  // ---- playback -----------------------------------------------------

  function advance() {
    var list = steps();
    if (idx >= list.length) { pause(); return; }

    var step = list[idx];
    idx += 1;
    spawnPacket(present(step).packet);
    renderAll(idx - 1);

    if (idx >= list.length) { pause(); return; }
    if (playing) timer = setTimeout(advance, delayBefore(idx));
  }

  /** Scale the real inter-step gap into something watchable. */
  function delayBefore(i) {
    var list = steps();
    var dt = i > 0 ? list[i].t - list[i - 1].t : 0;
    return Math.min(1100, Math.max(280, dt * 1.6)) / speed;
  }

  function play() {
    if (idx >= steps().length) resetSim();
    playing = true;
    el.play.textContent = 'Pause';
    advance();
  }

  function pause() {
    playing = false;
    if (timer) clearTimeout(timer);
    timer = null;
    el.play.textContent = idx >= steps().length ? 'Replay' : 'Play';
  }

  function resetSim() {
    pause();
    idx = 0;
    clearPackets();
    el.play.textContent = 'Play';
    renderAll();
  }

  function setMode(next) {
    mode = next;
    document.querySelectorAll('.mode').forEach(function (b) {
      var on = b.dataset.mode === next;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    });
    el.scrub.max = String(steps().length);
    el.scrubMax.textContent = String(steps().length);
    resetSim();
  }

  // ---- wiring -------------------------------------------------------

  document.querySelectorAll('.mode').forEach(function (b) {
    b.addEventListener('click', function () { setMode(b.dataset.mode); });
  });

  el.play.addEventListener('click', function () { playing ? pause() : play(); });

  el.step.addEventListener('click', function () {
    pause();
    if (idx >= steps().length) return;
    var step = steps()[idx];
    idx += 1;
    spawnPacket(present(step).packet);
    renderAll(idx - 1);
    el.play.textContent = idx >= steps().length ? 'Replay' : 'Play';
  });

  el.reset.addEventListener('click', resetSim);

  el.speed.addEventListener('input', function () {
    speed = parseFloat(el.speed.value);
    el.speedOut.textContent = speed + '×';
  });

  el.scrub.addEventListener('input', function () {
    pause();
    clearPackets();
    idx = parseInt(el.scrub.value, 10) || 0;
    renderAll();
    el.play.textContent = idx >= steps().length ? 'Replay' : 'Play';
  });

  document.addEventListener('keydown', function (e) {
    if (e.target.matches('input, button')) return;
    if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); el.step.click(); }
  });

  // ---- boot ---------------------------------------------------------

  el.provenance.textContent =
    'Captured ' + TRACES.meta.capturedAt.replace('T', ' ').slice(0, 19) + ' UTC · Node ' +
    TRACES.meta.nodeVersion + ' · ' + TRACES.meta.platform + ' · replaying real bytes';

  setMode('broken');
})();
