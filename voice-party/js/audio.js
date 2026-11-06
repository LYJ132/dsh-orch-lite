/* Voice Party — audio front-end
 * Web Audio capture -> pitch (MPM/NSDF autocorrelation) + level (RMS/dBFS)
 * Voice-oriented: relative measures only, no absolute thresholds for the player.
 */
(function (global) {
  'use strict';

  var CFG = {
    fftSize: 2048,
    minHz: 75,        // low male voice
    maxHz: 800,       // high female / child voice
    minRms: 0.006,    // absolute gate to skip silence
    smoothMs: 380,    // silence buffer (PRD 3.4)
    floorStart: -52   // initial noise floor dBFS
  };

  function dbFromRms(rms) { return 20 * Math.log10(Math.max(rms, 1e-7)); }

  /* --- McLeod Pitch Method (NSDF) ---------------------------------- */
  function detectPitch(buf, sampleRate) {
    var N = buf.length, i, j, lag, maxLag, minLag;
    var rms = 0;
    for (i = 0; i < N; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / N);
    if (rms < CFG.minRms) return { freq: 0, clarity: 0, rms: rms };

    minLag = Math.max(2, Math.floor(sampleRate / CFG.maxHz));
    maxLag = Math.min(N - 2, Math.floor(sampleRate / CFG.minHz));
    if (maxLag <= minLag) return { freq: 0, clarity: 0, rms: rms };

    var nsdf = new Float32Array(maxLag + 1);
    var peak = 0, peakLag = -1;

    for (lag = minLag; lag <= maxLag; lag++) {
      var acf = 0, m = 0;
      for (i = 0, j = lag; j < N; i++, j++) {
        acf += buf[i] * buf[j];
        m += buf[i] * buf[i] + buf[j] * buf[j];
      }
      var v = m > 0 ? (2 * acf) / m : 0;
      nsdf[lag] = v;
      if (v > peak) { peak = v; peakLag = lag; }
    }
    if (peakLag < 0 || peak < 0.35) return { freq: 0, clarity: peak, rms: rms };

    /* pick the smallest lag whose value is close to the global peak
       (avoids picking the octave BELOW the true fundamental) */
    var chosen = peakLag;
    for (lag = minLag; lag <= peakLag; lag++) {
      if (nsdf[lag] >= peak * 0.88) { chosen = lag; break; }
    }
    /* parabolic interpolation for sub-sample accuracy */
    var x = chosen;
    if (chosen > minLag && chosen < maxLag) {
      var a = nsdf[chosen - 1], b = nsdf[chosen], c = nsdf[chosen + 1];
      var denom = 2 * (2 * b - a - c);
      if (Math.abs(denom) > 1e-9) x = chosen + (c - a) / denom;
    }
    var freq = sampleRate / x;
    if (freq < CFG.minHz || freq > CFG.maxHz) return { freq: 0, clarity: nsdf[chosen], rms: rms };
    return { freq: freq, clarity: nsdf[chosen], rms: rms };
  }

  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return (s.length % 2) ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* ------------------------------------------------------------------ */
  function AudioInput() {
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.buf = null;
    this.pbuf = new Float32Array(1024);
    this.active = false;
    this.error = null;
    this._lastPitchT = 0;
    this._lastFreq = 0;
    this._lastClarity = 0;

    this.level = -90;       // dBFS (instant, smoothed)
    this.pitch = 0;         // Hz (median filtered)
    this.clarity = 0;
    this.voicing = false;
    this.noiseFloor = CFG.floorStart;
    this.sinceVoice = 9999; // ms since last valid voice
    this._rawPitch = [];
    this._lastPitch = 0;
    this._lastT = performance.now();
  }

  AudioInput.prototype.available = function () {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  };

  AudioInput.prototype.start = function () {
    var self = this;
    if (!this.available()) {
      return Promise.reject(new Error('mic-insecure'));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,   // keep the signal raw; AGC is handled in software
        channelCount: 1
      }
    }).then(function (stream) {
      var Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) throw new Error('mic-insecure');
      self.ctx = new Ctx();
      self.stream = stream;
      self.analyser = self.ctx.createAnalyser();
      self.analyser.fftSize = CFG.fftSize;
      self.analyser.smoothingTimeConstant = 0;
      var src = self.ctx.createMediaStreamSource(stream);
      src.connect(self.analyser);          // analyser only: no output feedback
      self.buf = new Float32Array(self.analyser.fftSize);
      self.active = true;
      self.error = null;
      if (self.ctx.state === 'suspended') self.ctx.resume();
      return self;
    });
  };

  AudioInput.prototype.stop = function () {
    this.active = false;
    if (this.stream) { this.stream.getTracks().forEach(function (t) { t.stop(); }); this.stream = null; }
    if (this.ctx) { try { this.ctx.close(); } catch (e) {} this.ctx = null; }
    this.analyser = null; this.buf = null;
    this.pitch = 0; this.level = -90; this.voicing = false;
  };

  AudioInput.prototype.resume = function () {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  };

  /* returns { t, rms, db, pitch, clarity, voicing, sinceVoice } */
  AudioInput.prototype.sample = function () {
    var now = performance.now();
    var dt = now - this._lastT; this._lastT = now;
    var out = {
      t: now, dt: dt, rms: 0, db: -90, pitch: 0, clarity: 0,
      voicing: false, sinceVoice: this.sinceVoice, semitone: 0, dbAbove: 0
    };
    if (!this.active || !this.analyser) { out.sinceVoice += dt; this.sinceVoice = out.sinceVoice; return out; }

    this.analyser.getFloatTimeDomainData(this.buf);
    var i, rms = 0;
    for (i = 0; i < this.buf.length; i++) rms += this.buf[i] * this.buf[i];
    rms = Math.sqrt(rms / this.buf.length);
    var db = dbFromRms(rms);
    out.rms = rms; out.db = db;

    /* adaptive noise floor (slow, only tracks downward) */
    if (db < this.noiseFloor + 30) {
      this.noiseFloor += (db - this.noiseFloor) * 0.02;
      if (this.noiseFloor < CFG.floorStart) this.noiseFloor = CFG.floorStart;
    }
    var gate = this.noiseFloor + 9;
    if (gate < -46) gate = -46;
    var voiced = db > gate && rms >= CFG.minRms;
    out.voiced = voiced;

    /* pitch detection is the expensive part: skip it in silence and cap it at ~30 Hz */
    var p = { freq: 0, clarity: 0 };
    if (voiced && (now - this._lastPitchT) > 32) {
      this._lastPitchT = now;
      for (i = 0; i < this.pbuf.length; i++) this.pbuf[i] = this.buf[i];
      p = detectPitch(this.pbuf, this.ctx.sampleRate);
      this._lastFreq = p.freq;
      this._lastClarity = p.clarity;
    } else if (voiced) {
      p.freq = this._lastFreq; p.clarity = this._lastClarity;
    }
    out.pitch = p.freq; out.clarity = p.clarity;

    if (voiced && p.freq > 0) {
      /* continuity: prefer a candidate close to the previous pitch (kills octave jumps) */
      var cand = p.freq, last = this._lastPitch;
      if (last > 0) {
        var oct = Math.log2(cand / last);
        if (Math.abs(oct - 1) < 0.08) cand = last * 2;
        else if (Math.abs(oct + 1) < 0.08) cand = last / 2;
      }
      this._rawPitch.push(cand);
      if (this._rawPitch.length > 5) this._rawPitch.shift();
      var med = median(this._rawPitch);
      this.pitch = med;
      this._lastPitch = med;
      this.sinceVoice = 0;
      out.pitch = med;
    } else {
      this._rawPitch.length = 0;
      this.pitch = 0;
      this.sinceVoice += dt;
    }

    this.level = db;
    out.sinceVoice = this.sinceVoice;
    /* semitone scale relative to a fixed reference (deltas are what matter) */
    out.semitone = out.pitch > 0 ? 12 * Math.log2(out.pitch / 261.63) : 0;
    /* volume expressed as dB above the personal noise floor (kills device gain) */
    out.dbAbove = db - this.noiseFloor;
    return out;
  };

  global.AudioInput = AudioInput;
  global.VP_AUDIO_CFG = CFG;
})(window);
