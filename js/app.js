/* Voice Party — app orchestration */
(function () {
  'use strict';

  var T = function (k, v) { return I18N.t(k, v); };
  var $ = function (id) { return document.getElementById(id); };

  var NAMES = ['小明', '阿花', '大壮', '小雨', '阿飞', '豆豆', 'Luna', 'Kai', 'Momo', 'Leo', 'Nina', '阿宝'];
  var S = {
    screen: 'home',
    room: null, isHost: false, myId: null, code: null,
    name: NAMES[Math.floor(Math.random() * NAMES.length)],
    players: [], designerId: null, mode: 'solo',
    level: { points: [], difficulty: 'normal', seed: 7, locked: false },
    levelData: null,
    phase: 'lobby',
    game: null,
    ctl: null, audio: null,
    ctlMode: 'pitch',
    sim: false, keys: {},
    lastSnap: null, lastMeters: { a: 0, b: 0 },
    myVoice: false, myMeter: 0, myState: 'silent',
    draw: [], drawing: false
  };

  /* ------------------------------------------------------------------ */
  /* helpers                                                            */
  /* ------------------------------------------------------------------ */
  function toast(msg, ms) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg; el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, ms || 2200);
  }
  function show(name) {
    S.screen = name;
    ['scrHome', 'scrLobby', 'scrGame', 'scrResult'].forEach(function (id) {
      $(id).classList.toggle('active', id === 'scr' + name.charAt(0).toUpperCase() + name.slice(1));
    });
    if (name === 'game') { try { $('gameCanvas').focus(); } catch (e) {} }
  }
  function me() {
    for (var i = 0; i < S.players.length; i++) if (S.players[i].id === S.myId) return S.players[i];
    return null;
  }
  function byId(id) {
    for (var i = 0; i < S.players.length; i++) if (S.players[i].id === id) return S.players[i];
    return null;
  }
  function upId() { var p = S.players.filter(function (x) { return x.role === 'up'; })[0]; return p ? p.id : null; }
  function downId() { var p = S.players.filter(function (x) { return x.role === 'down'; })[0]; return p ? p.id : null; }
  function canEdit() { return S.isHost || S.designerId === S.myId; }

  function defaultPoints() {
    var pts = [], n = 16;
    for (var i = 0; i <= n; i++) {
      pts.push({ x: 18 + i * 21, y: 320 + Math.sin(i / 2.3) * 96 });
    }
    return pts;
  }
  function regenerateLevel() {
    var pts = (S.level.points && S.level.points.length > 1) ? S.level.points : defaultPoints();
    S.levelData = LevelGen.generate(pts, S.level.difficulty, S.level.seed);
    return S.levelData;
  }

  /* ------------------------------------------------------------------ */
  /* screens wiring                                                      */
  /* ------------------------------------------------------------------ */
  $('btnLang').addEventListener('click', function () { I18N.toggle(); renderLobby(); });

  $('btnCreate').addEventListener('click', function () {
    S.isHost = true;
    var room = new VPRoom();
    S.room = room;
    room.on('status', function (st) { setNet(st); });
    room.on('error', function (e) { toast(T('net.error') + ': ' + e); });
    room.on('message', onRoomMessage);
    room.on('peerjoin', function (id) { /* state is pushed on 'hello' */ });
    room.on('peerleave', function (id) {
      var p = byId(id);
      if (p) { p.online = false; p.state = 'left'; }
      renderLobby();
      if (S.isHost) pushState();
    });
    room.create(S.name).then(function (r) {
      S.code = r.code; S.myId = r.id;
      S.players = [{ id: S.myId, name: S.name, ready: false, role: 'host', ctl: S.ctlMode, meter: 0, voice: false, online: true, join: 0 }];
      S.designerId = S.myId;
      $('roomCode').textContent = S.code;
      show('lobby');
      renderLobby();
      pushState();
      setInterval(pushState, 900);
    }).catch(function (e) {
      toast(T('err.signal'));
      setNet('error');
    });
  });

  $('btnJoin').addEventListener('click', function () {
    var code = ($('inpCode').value || '').trim().toUpperCase();
    if (code.length < 4) { toast(T('home.codePh')); return; }
    S.isHost = false;
    var room = new VPRoom();
    S.room = room;
    room.on('status', function (st) { setNet(st); });
    room.on('error', function (e) { toast(T('net.error') + ': ' + e); });
    room.on('message', onRoomMessage);
    room.on('peerleave', function () { toast(T('err.disconnected')); });
    room.join(code, S.name).then(function (r) {
      S.code = r.code; S.myId = r.id;
      $('roomCode').textContent = S.code;
      show('lobby');
      room.send('host', { t: 'hello', name: S.name, ctl: S.ctlMode });
    }).catch(function () { toast(T('err.noRoom')); setNet('error'); });
  });

  $('btnSolo').addEventListener('click', function () {
    S.isHost = true; S.code = 'SOLO';
    S.players = [{ id: 'solo', name: S.name, ready: true, role: 'host', ctl: S.ctlMode, meter: 0, voice: false, online: true, join: 0 }];
    S.myId = 'solo'; S.designerId = 'solo';
    $('roomCode').textContent = 'SOLO';
    show('lobby'); renderLobby();
    startGame();
  });

  $('chkSim').addEventListener('change', function (e) { S.sim = e.target.checked; });

  $('btnShare').addEventListener('click', function () {
    var url = location.href.split('?')[0] + '?room=' + S.code;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { toast(T('lobby.copied')); },
        function () { prompt(T('lobby.share'), url); });
    } else prompt(T('lobby.share'), url);
  });

  $('btnLeave').addEventListener('click', function () {
    if (S.room) S.room.close();
    S.room = null; S.players = []; S.game = null;
    show('home'); setNet('offline');
  });

  $('btnReady').addEventListener('click', function () {
    var m = me(); if (!m) return;
    m.ready = !m.ready;
    if (S.isHost) { pushState(); } else { S.room.send('host', { t: 'ready', v: m.ready }); }
    renderLobby();
  });

  $('btnStart').addEventListener('click', function () {
    if (!S.isHost) { toast(T('lobby.hint.hostOnly')); return; }
    var ready = S.players.filter(function (p) { return p.online; });
    if (S.mode === 'dual' && ready.length < 2) { toast(T('lobby.hint.needDual')); return; }
    var notReady = ready.filter(function (p) { return !p.ready; });
    if (notReady.length) { toast(T('lobby.hint.needReady')); return; }
    startGame();
  });

  /* mode + control mode --------------------------------------------- */
  $('modeBtns').addEventListener('click', function (e) {
    var b = e.target.closest('[data-mode]'); if (!b) return;
    if (!S.isHost) { toast(T('lobby.hint.hostOnly')); return; }
    S.mode = b.dataset.mode;
    assignRoles(); pushState(); renderLobby();
  });
  $('ctlModeBtns').addEventListener('click', function (e) {
    var b = e.target.closest('[data-ctl]'); if (!b) return;
    setCtlMode(b.dataset.ctl);
  });
  $('ctlRow').addEventListener('click', function (e) {
    var b = e.target.closest('[data-ctl]'); if (!b) return;
    setCtlMode(b.dataset.ctl);
  });
  function setCtlMode(m) {
    S.ctlMode = m;
    var p = me(); if (p) p.ctl = m;
    if (S.ctl) S.ctl.setMode(m);
    if (S.isHost) pushState();
    else if (S.room) S.room.send('host', { t: 'ctlmode', v: m });
    renderLobby();
  }

  /* designer ---------------------------------------------------------- */
  $('btnTakeDesign').addEventListener('click', function () {
    if (S.isHost) { S.designerId = S.myId; pushState(); renderLobby(); }
    else if (S.room) S.room.send('host', { t: 'design' });
  });
  $('btnClear').addEventListener('click', function () { commitLevel({ points: [] }); });
  $('btnRoll').addEventListener('click', function () {
    commitLevel({ seed: LevelGen.randomSeed() });
  });
  $('btnLock').addEventListener('click', function () {
    if (S.level.locked) commitLevel({ locked: false });
    else commitLevel({ locked: true });
  });
  $('diffBtns').addEventListener('click', function (e) {
    var b = e.target.closest('[data-diff]'); if (!b) return;
    commitLevel({ difficulty: b.dataset.diff, seed: LevelGen.randomSeed() });
  });

  function commitLevel(patch) {
    if (!canEdit()) { toast(T('designer.onlyDesigner')); return; }
    if (S.level.locked && patch.locked !== false) { toast(T('designer.state.locked')); return; }
    var lv = {
      points: patch.points || S.level.points,
      difficulty: patch.difficulty || S.level.difficulty,
      seed: (patch.seed !== undefined) ? patch.seed : S.level.seed,
      locked: (patch.locked !== undefined) ? patch.locked : S.level.locked
    };
    S.level = lv;
    regenerateLevel();
    if (S.isHost) pushState();
    else if (S.room) S.room.send('host', { t: 'level', level: lv });
    renderLobby(); drawDesign();
  }

  /* game -------------------------------------------------------------- */
  $('btnQuit').addEventListener('click', function () {
    if (S.room) S.room.send('host', { t: 'quit' });
    if (S.isHost && S.room) { S.room.broadcast({ t: 'back' }); }
    S.game = null;
    S.phase = 'lobby';
    show('lobby'); renderLobby();
  });
  $('btnRetry').addEventListener('click', function () {
    S.game = null; show('lobby'); renderLobby();
    if (S.isHost) startGame();
  });
  $('btnBackLobby').addEventListener('click', function () {
    S.game = null; show('lobby'); renderLobby();
  });

  function startGame() {
    var data = regenerateLevel();
    S.game = new VPGame({ mode: S.mode, level: data });
    S.phase = 'countdown';
    S.game.state = 'countdown';
    show('game');
    resetHud();
    if (S.isHost) {
      if (S.room && S.code !== 'SOLO') {
        S.room.broadcast({
          t: 'start', mode: S.mode, obstacles: data.obstacles, level: S.level,
          path: data.path, gap: data.gap, count: data.count
        });
        S.room.broadcast({ t: 'msg', text: T('game.countdown') });
      }
      countDown();
    }
  }

  var cdTimer = null;
  function countDown() {
    var n = 3;
    showCountdown(String(n));
    clearInterval(cdTimer);
    cdTimer = setInterval(function () {
      n--;
      if (n > 0) showCountdown(String(n));
      else {
        clearInterval(cdTimer);
        showCountdown('');
        S.game.state = 'playing';
        S.phase = 'playing';
        if (S.room && S.code !== 'SOLO') S.room.broadcast({ t: 'go' });
      }
    }, 1000);
  }
  /* clients wait for the host's authoritative "go" — they must not start on
   * their own clock, otherwise the two sides drift apart. */
  function waitForGo() {
    var n = 3;
    showCountdown(String(n));
    clearInterval(cdTimer);
    cdTimer = setInterval(function () {
      n--;
      if (n > 0) showCountdown(String(n));
      else { clearInterval(cdTimer); showCountdown(''); }
    }, 1000);
  }
  function showCountdown(txt) {
    var el = $('countdown');
    el.textContent = txt || '';
    el.style.opacity = txt ? '1' : '0';
  }

  function onRoomMessage(from, msg) {
    if (!msg || !msg.t) return;
    switch (msg.t) {
      case 'hello':                       // host side
        if (S.isHost) {
          var p = byId(from);
          if (!p) {
            p = { id: from, name: msg.name || 'Player', ready: false, role: 'player', ctl: msg.ctl || 'pitch', meter: 0, voice: false, online: true, join: Date.now() };
            S.players.push(p);
          }
          p.name = msg.name; p.ctl = msg.ctl; p.online = true;
          assignRoles(); pushState(); renderLobby();
        }
        break;
      case 'state':                       // client side
        if (!S.isHost) {
          S.players = msg.players; S.mode = msg.mode;
          S.designerId = msg.designerId; S.level = msg.level;
          if (msg.level && msg.level.points && msg.level.points.length) {
            regenerateLevel();
          }
          syncCtlChannels();
          renderLobby(); drawDesign();
        }
        break;
      case 'ready':
        if (S.isHost) { var q = byId(from); if (q) { q.ready = msg.v; pushState(); renderLobby(); } }
        break;
      case 'ctlmode':
        if (S.isHost) { var r = byId(from); if (r) { r.ctl = msg.v; pushState(); } }
        else { var mm = me(); if (mm) mm.ctl = msg.v; }
        break;
      case 'level':
        if (S.isHost) {
          if (!canEditFor(from)) return;
          if (S.level.locked && msg.level.locked !== false) return;
          S.level = msg.level;
          regenerateLevel(); pushState(); renderLobby();
        }
        break;
      case 'design':
        if (S.isHost) { S.designerId = from; pushState(); renderLobby(); }
        break;
      case 'ctl':                         // client -> host, during the game
        if (S.isHost) {
          var c = byId(from);
          if (c) { c.meter = msg.meter; c.voice = !!msg.voice; }
          if (S.game && S.game.state === 'playing') {
            S.game.applyControl(msg.up || 0, msg.down || 0);
          }
        }
        break;
      case 'start':
        if (!S.isHost) {
          S.mode = msg.mode; S.level = msg.level;
          S.game = new VPGame({ mode: msg.mode, level: { obstacles: msg.obstacles } });
          S.game.state = 'countdown';
          show('game'); resetHud();
          waitForGo();
        }
        break;
      case 'go':
        if (!S.isHost && S.game) { S.game.state = 'playing'; S.phase = 'playing'; showCountdown(''); }
        break;
      case 'g':
        if (!S.isHost) { S.lastSnap = msg.s; S.lastMeters = msg.m || { a: 0, b: 0 }; S.lastSnapAt = performance.now(); }
        break;
      case 'pause':
        if (!S.isHost && S.game) {
          S.game.paused = !!msg.v;
          $('pauseVeil').classList.toggle('show', !!msg.v);
          if (msg.v) $('pauseVeil').firstElementChild.textContent = T('game.hostAway');
        }
        break;
      case 'end':
        if (!S.isHost) { finishGame(msg.stats); }
        break;
      case 'msg':
        toast(msg.text);
        break;
      case 'back':
        S.game = null; show('lobby'); renderLobby();
        break;
      case 'quit':
        if (!S.isHost) { S.game = null; show('lobby'); renderLobby(); }
        break;
    }
  }
  function canEditFor(id) { return id === S.designerId || id === S.myId; }

  function assignRoles() {
    var ps = S.players.slice().sort(function (a, b) { return (a.join || 0) - (b.join || 0); });
    ps.forEach(function (p) { if (p.id !== S.myId || !S.isHost) p.role = 'player'; });
    if (S.isHost) {
      var meIdx = ps.map(function (p) { return p.id; }).indexOf(S.myId);
      if (meIdx >= 0) ps[meIdx].role = 'host';
    }
    if (S.mode === 'dual') {
      var slots = ps.filter(function (p) { return p.online; });
      if (slots[0]) slots[0].role = 'up';
      if (slots[1]) slots[1].role = 'down';
    }
    if (!S.designerId || !byId(S.designerId)) S.designerId = S.myId;
    syncCtlChannels();
  }

  /* the control channel a player owns follows their role (PRD 5.2) */
  function syncCtlChannels() {
    if (!S.ctl) return;
    var p = me();
    if (S.mode === 'dual' && p && p.role === 'up') S.ctl.channels = ['up'];
    else if (S.mode === 'dual' && p && p.role === 'down') S.ctl.channels = ['down'];
    else S.ctl.channels = ['up', 'down'];
  }

  function pushState() {
    if (!S.isHost || !S.room || S.code === 'SOLO') return;
    S.room.broadcast({
      t: 'state', players: S.players, mode: S.mode, designerId: S.designerId, level: S.level
    });
  }

  /* ------------------------------------------------------------------ */
  /* lobby rendering                                                     */
  /* ------------------------------------------------------------------ */
  function setNet(st) {
    var el = $('netPill');
    el.className = 'chip net ' + (st === 'online' ? 'on' : (st === 'error' ? 'bad' : ''));
    el.textContent = T(st === 'online' ? 'net.online' : st === 'connecting' ? 'net.connecting' : st === 'error' ? 'net.error' : 'net.offline');
  }

  function renderLobby() {
    var roleMap = { host: 'lobby.role.host', designer: 'lobby.role.designer', up: 'lobby.role.up', down: 'lobby.role.down', player: 'lobby.role.player' };
    var ul = $('playerList'); ul.innerHTML = '';
    S.players.forEach(function (p) {
      var li = document.createElement('li');
      var dot = p.online ? (p.ready ? 'ready' : 'joined') : 'gone';
      var role = p.role === 'host' && p.id === S.designerId ? 'designer' : p.role;
      li.innerHTML = '<span class="dot ' + dot + '"></span>' +
        '<span class="pname">' + esc(p.name) + (p.id === S.myId ? ' <em>(' + T('game.you') + ')</em>' : '') + '</span>' +
        '<span class="prole">' + T(roleMap[role] || 'lobby.role.player') + '</span>' +
        '<span class="pstate">' + T(p.online ? (p.ready ? 'lobby.state.ready' : 'lobby.state.joined') : 'lobby.state.left') + '</span>';
      ul.appendChild(li);
    });

    Array.prototype.forEach.call($('modeBtns').children, function (b) {
      b.classList.toggle('active', b.dataset.mode === S.mode);
    });
    Array.prototype.forEach.call($('ctlModeBtns').children, function (b) {
      b.classList.toggle('active', b.dataset.ctl === S.ctlMode);
    });
    Array.prototype.forEach.call($('diffBtns').children, function (b) {
      b.classList.toggle('active', b.dataset.diff === S.level.difficulty);
    });

    var m = me();
    $('btnReady').textContent = T(m && m.ready ? 'lobby.unready' : 'lobby.ready');
    $('btnStart').style.display = S.isHost ? '' : 'none';

    var chip = $('levelState');
    chip.textContent = T(S.level.locked ? 'designer.state.locked' : 'designer.state.draft');
    chip.className = 'statechip ' + (S.level.locked ? 'locked' : 'draft');

    var edit = canEdit() && !S.level.locked;
    $('designCanvas').style.pointerEvents = edit ? 'auto' : 'none';
    $('designCanvas').style.opacity = edit ? '1' : '.6';
    $('btnClear').disabled = !edit;
    $('btnRoll').disabled = !edit;
    $('btnLock').disabled = !canEdit();
    $('btnLock').textContent = T(S.level.locked ? 'designer.unlock' : 'designer.lock');
    Array.prototype.forEach.call($('diffBtns').children, function (b) { b.disabled = !edit; });
    $('btnTakeDesign').style.display = (S.designerId === S.myId) ? 'none' : '';

    var meta = $('levelMeta');
    if (S.levelData) {
      meta.textContent = T('designer.meta', {
        n: S.levelData.count, g: S.levelData.gap,
        s: T('diff.' + S.level.difficulty)
      }) + (S.levelData.relaxed ? ' · ' + T('designer.meta.relaxed') : '');
    } else {
      meta.textContent = T('designer.meta.empty');
    }

    var hint = $('lobbyHint'), h = '';
    if (S.isHost) {
      var online = S.players.filter(function (p) { return p.online; });
      if (S.mode === 'dual' && online.length < 2) h = T('lobby.hint.needDual');
      else if (online.some(function (p) { return !p.ready; })) h = T('lobby.hint.needReady');
      else h = T('lobby.hint.ready');
    } else h = T('lobby.hint.wait');
    if (canEdit()) h += '<br>' + T('lobby.hint.designer');
    hint.innerHTML = h;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------------------------------ */
  /* design canvas                                                       */
  /* ------------------------------------------------------------------ */
  var dcv = $('designCanvas'), dctx = dcv.getContext('2d');
  function dpt(ev) {
    var r = dcv.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(360, (ev.clientX - r.left) * (360 / r.width))),
      y: Math.max(0, Math.min(640, (ev.clientY - r.top) * (640 / r.height)))
    };
  }
  dcv.addEventListener('pointerdown', function (e) {
    if (!canEdit() || S.level.locked) return;
    e.preventDefault();
    dcv.setPointerCapture(e.pointerId);
    S.drawing = true; S.draw = [dpt(e)];
  });
  dcv.addEventListener('pointermove', function (e) {
    if (!S.drawing) return;
    var p = dpt(e), last = S.draw[S.draw.length - 1];
    if (Math.abs(p.x - last.x) > 4 || Math.abs(p.y - last.y) > 4) {
      S.draw.push(p);
      drawDesign();
    }
  });
  dcv.addEventListener('pointerup', function (e) {
    if (!S.drawing) return;
    S.drawing = false;
    if (S.draw.length > 1) commitLevel({ points: S.draw.slice(), seed: LevelGen.randomSeed() });
  });

  function drawDesign() {
    dctx.clearRect(0, 0, 360, 640);
    dctx.fillStyle = '#070b18'; dctx.fillRect(0, 0, 360, 640);
    dctx.strokeStyle = 'rgba(94,231,255,.08)'; dctx.lineWidth = 1;
    for (var x = 0; x < 360; x += 36) { dctx.beginPath(); dctx.moveTo(x, 0); dctx.lineTo(x, 640); dctx.stroke(); }
    for (var y = 0; y < 640; y += 40) { dctx.beginPath(); dctx.moveTo(0, y); dctx.lineTo(360, y); dctx.stroke(); }
    dctx.fillStyle = 'rgba(255,107,107,.10)'; dctx.fillRect(0, 0, 360, 34); dctx.fillRect(0, 606, 360, 34);

    var data = S.levelData || regenerateLevel();
    if (data) {
      data.obstacles.forEach(function (o) {
        var top = o.gapY - o.gapH / 2, bot = o.gapY + o.gapH / 2;
        dctx.fillStyle = 'rgba(120,220,190,.5)';
        dctx.fillRect(o.x - 22, 0, 44, top);
        dctx.fillRect(o.x - 22, bot, 44, 640 - bot);
        dctx.fillStyle = 'rgba(94,231,255,.55)';
        dctx.fillRect(o.x - 26, top - 10, 52, 10);
        dctx.fillRect(o.x - 26, bot, 52, 10);
      });
      /* centre line */
      dctx.strokeStyle = 'rgba(255,209,102,.85)'; dctx.lineWidth = 3; dctx.setLineDash([7, 6]);
      dctx.beginPath();
      data.path.forEach(function (p, i) { i ? dctx.lineTo(p.x, p.y) : dctx.moveTo(p.x, p.y); });
      dctx.stroke(); dctx.setLineDash([]);
    }
    $('drawTip').style.display = (S.draw && S.draw.length > 1) ? 'none' : '';
  }

  /* ------------------------------------------------------------------ */
  /* input + game loop                                                   */
  /* ------------------------------------------------------------------ */
  var cvs = $('gameCanvas'), ctx = cvs.getContext('2d');
  function fitCanvas() {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cvs.width = 360 * dpr; cvs.height = 640 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', fitCanvas); fitCanvas();

  var lastT = performance.now();
  function frame(ts) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, (ts - lastT) / 1000); lastT = ts;

    var res = readInput(dt);
    S.myVoice = res.voice; S.myMeter = res.meter; S.myState = res.state;

    if (S.game) {
      if (S.isHost) {
        /* keep the local player's live state in the roster (used for the gate) */
        var mp = me();
        if (mp) { mp.voice = res.voice; mp.meter = res.meter; }
        if (S.game.state === 'playing') {
          var u = upId(), d = downId();
          var upP = byId(u), dnP = byId(d);
          var va, vb;
          if (S.mode === 'dual') {
            va = upP ? (upP.id === S.myId ? res.voice : !!upP.voice) : false;
            vb = dnP ? (dnP.id === S.myId ? res.voice : !!dnP.voice) : false;
          } else { va = res.voice; vb = false; }
          S.game.setVoices(va, vb);
          S.game.applyControl(res.up, res.down);
        }
        S.game.update(dt);
      } else if (S.lastSnap) {
        S.game.applyRemote(dt, S.lastSnap);
      }
      S.game.draw(ctx);
      updateHud();
    }
  }
  requestAnimationFrame(frame);

  /* ---- host liveness: the host tab going to background freezes rAF, so the
   * whole round would silently stall for everybody. Detect it and pause the
   * round explicitly instead (PRD 8.4 "network anomaly handling"). ------- */
  var hostAway = false;
  document.addEventListener('visibilitychange', function () {
    if (!S.isHost || !S.game || S.game.state !== 'playing') return;
    var away = document.hidden;
    if (away === hostAway) return;
    hostAway = away;
    S.game.paused = away;
    if (S.room && S.code !== 'SOLO') S.room.broadcast({ t: 'pause', v: away });
    if (away) toast(T('game.hostAway'), 3000);
  });
  /* client side: if the host stops sending snapshots, show a soft overlay */
  setInterval(function () {
    if (!S.game || S.game.state !== 'playing' || S.isHost) return;
    if (!S.lastSnap) return;
    var stale = performance.now() - (S.lastSnapAt || 0);
    if (stale > 2500) {
      S.game.paused = true;
      $('pauseVeil').classList.add('show');
      $('pauseVeil').firstElementChild.textContent = T('game.hostLost');
    } else if (S.game.paused && !document.hidden) {
      S.game.paused = false;
      $('pauseVeil').classList.remove('show');
      $('pauseVeil').firstElementChild.textContent = T('game.paused');
    }
  }, 500);

  var ctlSendT = 0;
  function readInput(dt) {
    var out = { up: 0, down: 0, voice: false, meter: 0, state: 'silent' };
    if (S.sim) {
      var k = S.keys;
      var up = (k.up ? 1 : 0), down = (k.down ? 1 : 0);
      var owns = function (c) { return !S.ctl || S.ctl.channels.indexOf(c) >= 0; };
      if (!owns('up')) up = 0;
      if (!owns('down')) down = 0;
      out.voice = !!(up || down || k.voice);
      out.up = up * 34 * dt;
      out.down = down * 34 * dt;
      out.meter = up ? 0.8 : (down ? -0.8 : 0);
      out.state = up ? 'up' : down ? 'down' : (out.voice ? 'hold' : 'silent');
    } else if (S.audio && S.audio.active) {
      var s = S.audio.sample();
      var r = S.ctl.update(s);
      out.up = r.up; out.down = r.down; out.voice = r.active; out.meter = r.meter; out.state = r.state;
    }
    if (!S.isHost && S.room && S.game && S.game.state === 'playing') {
      var now = performance.now();
      if (now - ctlSendT > 50) {
        ctlSendT = now;
        S.room.send('host', { t: 'ctl', up: out.up, down: out.down, voice: out.voice, meter: out.meter });
      }
    }
    return out;
  }

  /* keyboard simulation */
  window.addEventListener('keydown', function (e) {
    var k = e.key.toLowerCase();
    if (k === 'arrowup' || k === 'w') { S.keys.up = true; e.preventDefault(); }
    if (k === 'arrowdown' || k === 's') { S.keys.down = true; e.preventDefault(); }
    if (k === ' ') { S.keys.voice = true; e.preventDefault(); }
    if (k === 'p') { S.paused = !S.paused; $('pauseVeil').classList.toggle('show', !!S.paused); }
  });
  window.addEventListener('keyup', function (e) {
    var k = e.key.toLowerCase();
    if (k === 'arrowup' || k === 'w') S.keys.up = false;
    if (k === 'arrowdown' || k === 's') S.keys.down = false;
    if (k === ' ') S.keys.voice = false;
  });
  /* touch simulation on the game canvas */
  cvs.addEventListener('pointerdown', function (e) {
    var r = cvs.getBoundingClientRect();
    if ((e.clientY - r.top) < r.height / 2) S.keys.up = true; else S.keys.down = true;
    S.keys.voice = true;
  });
  window.addEventListener('pointerup', function () { S.keys.up = false; S.keys.down = false; S.keys.voice = false; });

  /* ------------------------------------------------------------------ */
  /* HUD                                                                 */
  /* ------------------------------------------------------------------ */
  function resetHud() {
    $('hudScore').textContent = '0';
    $('hudMode').textContent = T(S.mode === 'dual' ? 'game.mode.dual' : 'game.mode.solo');
    $('meters').innerHTML = '';
    if (S.mode === 'dual') {
      $('meters').innerHTML =
        '<div class="meter" id="mA"><div class="mtop"><span>' + T('game.p1') + '</span><span class="st">—</span></div><div class="bar"><i></i><span class="mid"></span></div></div>' +
        '<div class="meter" id="mB"><div class="mtop"><span>' + T('game.p2') + '</span><span class="st">—</span></div><div class="bar"><i></i><span class="mid"></span></div></div>';
    } else {
      $('meters').innerHTML =
        '<div class="meter" id="mA"><div class="mtop"><span id="mName">' + esc(S.name) + ' · <span id="mCtl"></span></span><span class="st">—</span></div><div class="bar"><i></i><span class="mid"></span></div></div>';
    }
    $('mCtl') && ($('mCtl').textContent = T('ctl.' + S.ctlMode));
  }

  function meterSet(id, val, state, label) {
    var box = $(id); if (!box) return;
    var bar = box.querySelector('.bar i');
    var st = box.querySelector('.st');
    var w = Math.min(50, Math.abs(val) * 50);
    bar.style.width = w + '%';
    bar.style.left = val >= 0 ? '50%' : (50 - w) + '%';
    bar.className = val > 0.05 ? 'up' : (val < -0.05 ? 'down' : '');
    st.textContent = label || T('game.state.' + state);
  }

  function updateHud() {
    if (!S.game) return;
    $('hudScore').textContent = S.game.score;
    if (S.mode === 'dual') {
      var up = upId(), dn = downId();
      var ma = (up === S.myId) ? S.myMeter : (S.lastMeters ? S.lastMeters.a : 0);
      var mb = (dn === S.myId) ? S.myMeter : (S.lastMeters ? S.lastMeters.b : 0);
      var sa = (up === S.myId) ? S.myState : (S.game.voices && S.game.voices.a ? 'hold' : 'silent');
      var sb = (dn === S.myId) ? S.myState : (S.game.voices && S.game.voices.b ? 'hold' : 'silent');
      meterSet('mA', ma, sa);
      meterSet('mB', mb, sb);
    } else {
      meterSet('mA', S.myMeter, S.myState);
    }
  }

  /* ------------------------------------------------------------------ */
  /* game over                                                           */
  /* ------------------------------------------------------------------ */
  function finishGame(stats) {
    if (!S.game) return;
    S.game = null;
    S.phase = 'result';
    var box = $('resultStats');
    var rows = [
      ['result.score', stats.score], ['result.passed', stats.passed],
      ['result.dist', stats.dist]
    ];
    if (S.mode === 'dual') rows.push(['result.synergy', stats.synergy + '%']);
    box.innerHTML = rows.map(function (r) {
      return '<div class="stat"><b>' + r[1] + '</b><span>' + T(r[0]) + '</span></div>';
    }).join('');
    $('resultNote').textContent = T(canEdit() ? 'result.note.designer' : 'result.note.host');
    show('result');
    /* PRD: after a round the level returns to draft so it can still be tuned */
    if (S.isHost) {
      S.level.locked = false;
      pushState();
      toast(T('designer.reverted'), 3000);
    }
    renderLobby();
  }

  /* host: watch for the end of the round */
  setInterval(function () {
    if (!S.isHost || !S.game) return;
    if (S.game.state === 'over' && S.phase === 'playing') {
      S.phase = 'result';
      var st = {
        score: S.game.score, passed: S.game.passed,
        dist: Math.floor(S.game.scroll / 10), synergy: S.game.synergy
      };
      if (S.room && S.code !== 'SOLO') S.room.broadcast({ t: 'end', stats: st });
      finishGame(st);
    }
  }, 120);

  /* host: broadcast the authoritative snapshot */
  setInterval(function () {
    if (!S.isHost || !S.game || S.game.state !== 'playing') return;
    var u = upId(), d = downId();
    var m = { a: 0, b: 0 };
    S.players.forEach(function (p) {
      if (p.id === u) m.a = p.meter || 0;
      if (p.id === d) m.b = p.meter || 0;
    });
    if (S.mode !== 'dual') m.a = S.myMeter;
    if (S.room && S.code !== 'SOLO') S.room.broadcast({ t: 'g', s: S.game.snapshot(), m: m });
  }, 50);

  /* ------------------------------------------------------------------ */
  /* mic + control wiring                                                */
  /* ------------------------------------------------------------------ */
  function ensureCtl() {
    if (!S.ctl) S.ctl = new VoiceControl({ mode: S.ctlMode, channels: ['up', 'down'] });
    return S.ctl;
  }
  function startMic() {
    if (!S.audio) S.audio = new AudioInput();
    ensureCtl();
    if (S.audio.active) return;
    S.audio.start().then(function () {
      toast(T('game.state.hint'), 1800);
    }).catch(function (e) {
      toast(e && e.message === 'mic-insecure' ? T('err.micInsecure') : T('err.mic'));
      S.sim = true; $('chkSim').checked = true;
    });
  }
  ['btnCreate', 'btnJoin', 'btnSolo'].forEach(function (id) {
    $(id).addEventListener('click', function () { if (!S.sim) startMic(); });
  });
  document.addEventListener('vp:lang', function () {
    resetHud();
    if (S.screen === 'lobby') renderLobby();
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */
  var q = location.search.match(/room=([A-Za-z0-9]+)/);
  if (q) { $('inpCode').value = q[1].toUpperCase(); }
  ensureCtl();
  setNet('offline');
  show('home');
  renderLobby();
  drawDesign();
  window.__VP = S;   /* exposed for automated testing / debugging */
})();
