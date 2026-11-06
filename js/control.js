/* Voice Party — voice control law
 *
 * PRD 3.1 / 3.2 / 3.4 resolution:
 *   UP   channel : incremental vs the PREVIOUS valid sample  (PRD 3.2 "accumulated")
 *   DOWN channel : deviation BELOW a personal running anchor (slow EMA of the
 *                  player's own voice) — a deliberate, sustained lowering steers
 *                  down, while jitter/noise never does.
 * Both are RELATIVE to the player, so no absolute pitch/volume target is needed.
 */
(function (global) {
  'use strict';

  var PRESET = {
    pitch: { dz: 0.60, dzDown: 0.90, range: 6.0, label: 'pitch' },   // semitones
    volume: { dz: 3.0, dzDown: 4.5, range: 18.0, label: 'volume' }   // dB above floor
  };

  function VoiceControl(opts) {
    opts = opts || {};
    this.mode = opts.mode || 'pitch';
    this.channels = opts.channels || ['up', 'down'];   // which channel this player owns
    this.stepMax = opts.stepMax || 7.5;                // degrees per full-scale event
    this.silenceMs = opts.silenceMs || 380;            // PRD 3.4 buffer
    this.maxRate = opts.maxRate || 46;                 // deg/s cap on accumulation
    this.recenter = opts.recenter !== false;           // slow auto-level when idle
    this.recenterAfter = opts.recenterAfter || 2600;

    this.prev = null;        // last valid signal value
    this.anchor = null;      // slow EMA of the player's own voice level
    this.anchorTau = 7000;   // ms
    this.lastChange = 0;
    this.angle = 0;          // accumulated angle (deg, + = up) for this player
    this.state = 'silent';
    this.meter = 0;          // -1..1 normalised deviation from the anchor
    this.voicing = false;
    this.silentFor = 9999;
    this._acc = 0;
    this._lastUpd = 0;
  }

  VoiceControl.prototype.setMode = function (m) {
    if (!PRESET[m]) return;
    this.mode = m;
    this.prev = null;       // re-baseline on switch so no phantom jump
  };

  VoiceControl.prototype.reset = function () {
    this.prev = null; this.anchor = null; this.angle = 0;
    this.state = 'silent'; this.meter = 0; this.silentFor = 9999;
  };

  VoiceControl.prototype.signalOf = function (s) {
    return this.mode === 'pitch' ? s.semitone : s.dbAbove;
  };

  /* sample -> { up, down, state, meter, active } */
  VoiceControl.prototype.update = function (s) {
    var P = PRESET[this.mode];
    var dt = Math.min(200, Math.max(1, s.dt || 16));
    var sig = this.signalOf(s);

    /* --- silence gate (PRD 3.4) ------------------------------------ */
    var voiced = !!s.voicing;
    if (voiced) { this.silentFor = 0; } else { this.silentFor += dt; }
    var inBuffer = this.silentFor <= this.silenceMs;

    if (!voiced) {
      this.state = 'silent';
      this.voicing = false;
      this.meter *= 0.9;
      if (this.silentFor > this.silenceMs) {
        this.prev = null;            // re-baseline on the next voiced frame
        if (this.recenter) this.angle *= 0.995;
      }
      return { up: 0, down: 0, state: 'silent', meter: this.meter, active: false, angle: this.angle };
    }

    if (this.prev === null || this.anchor === null) {
      this.prev = sig; this.anchor = sig; this.lastChange = performance.now();
      this.state = 'hold';
      this.voicing = true;
      this.meter = 0;
      return { up: 0, down: 0, state: 'hold', meter: 0, active: inBuffer, angle: this.angle };
    }

    /* --- anchor (personal baseline) -------------------------------- */
    var a = 1 - Math.exp(-dt / this.anchorTau);
    this.anchor += (sig - this.anchor) * a;

    /* --- UP: incremental vs previous valid sample ------------------ */
    var dUp = sig - this.prev;
    var up = 0;
    if (dUp > P.dz) up = this._scale(dUp - P.dz, P);

    /* --- DOWN: deviation below the personal anchor ----------------- */
    var dDown = this.anchor - sig;
    var down = 0;
    if (dDown > P.dzDown) down = this._scale(dDown - P.dzDown, P);

    this.prev = sig;

    /* --- cap accumulation rate ------------------------------------- */
    var maxStep = this.maxRate * (dt / 1000);
    if (up + down > maxStep) {
      var k = maxStep / (up + down);
      up *= k; down *= k;
    }

    if (up > 0 || down > 0) this.lastChange = performance.now();

    /* --- optional slow auto-level ---------------------------------- */
    if (this.recenter && (performance.now() - this.lastChange) > this.recenterAfter) {
      var decay = 7 * (dt / 1000);
      if (this.angle > 0) this.angle = Math.max(0, this.angle - decay);
      else if (this.angle < 0) this.angle = Math.min(0, this.angle + decay);
    }

    this.angle += up - down;
    this.meter = Math.max(-1, Math.min(1, (sig - this.anchor) / P.range));
    this.state = up > 0.01 ? 'up' : (down > 0.01 ? 'down' : 'hold');
    this.voicing = true;

    return {
      up: this.channels.indexOf('up') >= 0 ? up : 0,
      down: this.channels.indexOf('down') >= 0 ? down : 0,
      state: this.state, meter: this.meter, active: inBuffer, angle: this.angle
    };
  };

  VoiceControl.prototype._scale = function (excess, P) {
    var scale = P.dz * 2;
    return this.stepMax * (1 - Math.exp(-excess / scale));
  };

  global.VoiceControl = VoiceControl;
  global.VP_PRESET = PRESET;
})(window);
