/* Voice Party — game simulation & rendering */
(function (global) {
  'use strict';

  var W = 360, H = 640, BIRD_R = 13;
  var SPEED = 172;              // world units / s
  var MAX_ANG_RATE = 165;       // deg / s the bird can rotate
  var ANG_MIN = -62, ANG_MAX = 68;
  var HAZARD = 34;              // top / bottom danger bands

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function Game(opts) {
    opts = opts || {};
    this.mode = opts.mode || 'solo';
    this.level = opts.level || null;
    this.base = (this.level && this.level.obstacles) ? this.level.obstacles.slice() : [];
    this.span = 0;
    if (this.base.length) {
      this.span = (this.base[this.base.length - 1].x - this.base[0].x) + 210;
    }
    this.tiles = 0;
    this.obstacles = this.base.map(function (o) { return Object.assign({}, o); });

    this.bird = { x: 96, y: H / 2, angle: 0, target: 0 };
    this.state = 'idle';         // idle | countdown | playing | over
    this.scroll = 0;
    this.score = 0;
    this.passed = 0;
    this.alive = true;
    this.gate = false;           // is the bird allowed to move forward
    this.paused = false;         // host away / link lost -> freeze for everyone
    this.voices = { a: false, b: false };
    this.synergy = 0;            // % of the round both players voiced
    this._synergyAcc = 0;
    this._synergyT = 0;
    this.shake = 0;
  }

  Game.prototype.reset = function () {
    this.bird = { x: 96, y: H / 2, angle: 0, target: 0 };
    this.scroll = 0; this.score = 0; this.passed = 0;
    this.alive = true; this.shake = 0;
    this._synergyAcc = 0; this._synergyT = 0;
    this.tiles = 0;
    this.obstacles = this.base.map(function (o) { return Object.assign({}, o); });
  };

  /* control input in DEGREES (up positive) */
  Game.prototype.applyControl = function (upDeg, downDeg) {
    if (this.state !== 'playing') return;
    this.bird.target = clamp(this.bird.target + (upDeg || 0) - (downDeg || 0), ANG_MIN, ANG_MAX);
  };

  Game.prototype.setVoices = function (a, b) {
    this.voices.a = !!a; this.voices.b = !!b;
  };

  Game.prototype._ensureObstacles = function () {
    if (!this.span) return;
    while (this.obstacles.length &&
           this.obstacles[this.obstacles.length - 1].x - this.scroll < 1000) {
      var off = this.span * this.tiles;
      for (var i = 0; i < this.base.length; i++) {
        var o = Object.assign({}, this.base[i]);
        o.x += off;
        o.gapY += (this.tiles % 2 ? 12 : -12);
        this.obstacles.push(o);
      }
      this.tiles++;
    }
  };

  Game.prototype.update = function (dt) {
    if (this.state !== 'playing' || !this.alive || this.paused) return;
    dt = Math.min(0.05, dt);

    /* gate: the bird only keeps flying while somebody is voicing */
    this.gate = (this.mode === 'dual')
      ? (this.voices.a || this.voices.b)
      : this.voices.a;

    /* rotate towards the target angle */
    var d = this.bird.target - this.bird.angle;
    var maxStep = MAX_ANG_RATE * dt;
    if (Math.abs(d) > maxStep) d = Math.sign(d) * maxStep;
    this.bird.angle += d;

    if (this.gate) {
      var rad = this.bird.angle * Math.PI / 180;
      this.bird.x += Math.cos(rad) * SPEED * dt;
      this.bird.y += Math.sin(rad) * SPEED * dt;
      this.scroll += Math.cos(rad) * SPEED * dt;
    }
    this._ensureObstacles();

    /* synergy: both players voicing at the same time (dual only) */
    if (this.mode === 'dual') {
      this._synergyT += dt;
      if (this.voices.a && this.voices.b) this._synergyAcc += dt;
      this.synergy = this._synergyT > 0.5 ? Math.round(this._synergyAcc / this._synergyT * 100) : 0;
    }

    /* scoring */
    this.score = this.passed * 10 + Math.floor(this.scroll / 10);

    /* collision */
    var bx = this.bird.x, by = this.bird.y;
    for (var i = 0; i < this.obstacles.length; i++) {
      var o = this.obstacles[i];
      if (o.x + 30 < bx - BIRD_R) { if (!o.passed && o.x < bx) { o.passed = true; this.passed++; } continue; }
      if (o.x - 30 > bx + BIRD_R) break;
      if (!o.passed && o.x < bx) { o.passed = true; this.passed++; }
      var top = o.gapY - o.gapH / 2, bot = o.gapY + o.gapH / 2;
      var ox = o.x;
      if (o.type === 'stagger') ox += 9;
      if (circleRect(bx, by, BIRD_R, ox, 0, 26, top)) { this.die(); return; }
      if (circleRect(bx, by, BIRD_R, ox, bot, 26, H)) { this.die(); return; }
    }
    if (by - BIRD_R < HAZARD || by + BIRD_R > H - HAZARD) this.die();
  };

  function circleRect(cx, cy, r, rx, ry, rw, rh) {
    var nx = clamp(cx, rx, rx + rw), ny = clamp(cy, ry, ry + rh);
    var dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  Game.prototype.die = function () {
    if (!this.alive) return;
    this.alive = false;
    this.state = 'over';
    this.shake = 1;
  };

  Game.prototype.snapshot = function () {
    return {
      y: this.bird.y, angle: this.bird.angle, target: this.bird.target,
      scroll: this.scroll, score: this.score, passed: this.passed,
      alive: this.alive, gate: this.gate, synergy: this.synergy,
      voices: this.voices
    };
  };

  /* client side: follow the host's authoritative state with smoothing */
  Game.prototype.applyRemote = function (dt, s) {
    if (this.paused) return;
    this._ensureObstacles();
    var k = Math.min(1, dt * 14);
    this.bird.y += (s.y - this.bird.y) * k;
    this.bird.angle += (s.angle - this.bird.angle) * k;
    this.bird.target = s.target;
    this.scroll += (s.scroll - this.scroll) * k;
    this.score = s.score; this.passed = s.passed;
    this.alive = s.alive; this.gate = s.gate; this.synergy = s.synergy || 0;
    if (s.voices) this.voices = s.voices;
    if (!this.alive && this.state === 'playing') this.state = 'over';
  };

  /* ---------------- rendering ---------------- */
  function drawPipes(ctx, o, scroll) {
    var x = o.x - scroll;
    if (x < -60 || x > W + 60) return;
    var top = o.gapY - o.gapH / 2, bot = o.gapY + o.gapH / 2;
    var ox = (o.type === 'stagger') ? 9 : 0;
    var w = 46;

    ctx.fillStyle = 'rgba(120,220,190,.92)';
    ctx.strokeStyle = 'rgba(6,20,26,.9)';
    ctx.lineWidth = 2;
    ctx.fillRect(x + ox, 0, w, top);
    ctx.strokeRect(x + ox, 0, w, top);
    ctx.fillRect(x + ox, bot, w, H - bot);
    ctx.strokeRect(x + ox, bot, w, H - bot);

    /* lips */
    ctx.fillStyle = 'rgba(94,231,255,.95)';
    ctx.fillRect(x + ox - 5, top - 14, w + 10, 14);
    ctx.strokeRect(x + ox - 5, top - 14, w + 10, 14);
    ctx.fillRect(x + ox - 5, bot, w + 10, 14);
    ctx.strokeRect(x + ox - 5, bot, w + 10, 14);

    if (o.type === 'saw') {
      ctx.fillStyle = 'rgba(255,122,217,.95)';
      var step = 16;
      for (var y = top - 14; y > top - 14 - 46; y -= step) {
        ctx.beginPath();
        ctx.moveTo(x + ox - 4, y);
        ctx.lineTo(x + ox + w / 2, y - 11);
        ctx.lineTo(x + ox + w + 4, y);
        ctx.closePath(); ctx.fill();
      }
      for (var y2 = bot; y2 < bot + 46; y2 += step) {
        ctx.beginPath();
        ctx.moveTo(x + ox - 4, y2);
        ctx.lineTo(x + ox + w / 2, y2 + 11);
        ctx.lineTo(x + ox + w + 4, y2);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  Game.prototype.draw = function (ctx) {
    var i;
    ctx.save();
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - 0.04);
      ctx.translate((Math.random() - 0.5) * this.shake * 10, (Math.random() - 0.5) * this.shake * 10);
    }
    /* background */
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0d1533'); g.addColorStop(1, '#080c1d');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    /* parallax grid */
    ctx.strokeStyle = 'rgba(94,231,255,.07)'; ctx.lineWidth = 1;
    var off = -(this.scroll * 0.35) % 40;
    for (i = -1; i < 11; i++) {
      var gx = off + i * 40;
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
    }
    for (i = 0; i < 16; i++) {
      var gy = (i * 44 - (this.scroll * 0.18) % 44 + H) % H;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }

    /* hazard bands */
    ctx.fillStyle = 'rgba(255,107,107,.10)';
    ctx.fillRect(0, 0, W, HAZARD); ctx.fillRect(0, H - HAZARD, W, HAZARD);
    ctx.strokeStyle = 'rgba(255,107,107,.45)';
    ctx.setLineDash([8, 8]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, HAZARD); ctx.lineTo(W, HAZARD);
    ctx.moveTo(0, H - HAZARD); ctx.lineTo(W, H - HAZARD); ctx.stroke();
    ctx.setLineDash([]);

    /* obstacles */
    for (i = 0; i < this.obstacles.length; i++) drawPipes(ctx, this.obstacles[i], this.scroll);

    /* bird */
    var b = this.bird;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle * Math.PI / 180);
    var body = this.alive ? '#ffd166' : '#7a8099';
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#ff9f43';
    ctx.beginPath(); ctx.moveTo(BIRD_R - 2, 0); ctx.lineTo(BIRD_R + 10, 4); ctx.lineTo(BIRD_R - 2, 8);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(4, -5, 4.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#101425';
    ctx.beginPath(); ctx.arc(5.2, -5, 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    /* voice indicator ring */
    if (this.gate) {
      ctx.strokeStyle = 'rgba(92,255,177,.75)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(b.x, b.y, BIRD_R + 6, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  };

  global.VPGame = Game;
  global.VP_CONST = { W: W, H: H, SPEED: SPEED, BIRD_R: BIRD_R, HAZARD: HAZARD };
})(window);
