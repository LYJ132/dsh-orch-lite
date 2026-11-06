/* Voice Party — room / multiplayer transport (PeerJS, host authoritative) */
(function (global) {
  'use strict';

  var ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var PREFIX = 'vp-';

  function makeCode() {
    var s = '';
    for (var i = 0; i < 6; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)];
    return s;
  }

  function Room() {
    this.peer = null;
    this.isHost = false;
    this.code = null;
    this.myId = null;
    this.name = 'Player';
    this.conns = {};       // peerId -> conn
    this.remote = {};      // peerId -> meta
    this._h = {};
    this.status = 'offline';
    this.lastError = null;
  }

  Room.prototype.on = function (ev, fn) {
    (this._h[ev] = this._h[ev] || []).push(fn);
    return this;
  };
  Room.prototype.emit = function (ev, a, b) {
    (this._h[ev] || []).forEach(function (f) { try { f(a, b); } catch (e) { console.error(e); } });
  };

  Room.prototype._setStatus = function (s, err) {
    this.status = s; this.lastError = err || null;
    this.emit('status', s, err);
  };

  Room.prototype._newPeer = function (id) {
    if (!global.Peer) throw new Error('no-peer');
    var p = id ? new global.Peer(id, { debug: 0 }) : new global.Peer({ debug: 0 });
    p.on('error', function (err) {
      this.lastError = err.type || String(err.message || err);
      this.emit('error', this.lastError);
    }.bind(this));
    return p;
  };

  Room.prototype.create = function (name, attempts) {
    this.name = name || 'Host';
    this.isHost = true;
    var tries = attempts || 0;
    var self = this;
    this._setStatus('connecting');
    return new Promise(function (resolve, reject) {
      function attempt() {
        var code = makeCode();
        var peer;
        try { peer = self._newPeer(PREFIX + code); }
        catch (e) { reject(e); return; }
        var done = false;
        peer.on('open', function () {
          if (done) return; done = true;
          self.peer = peer; self.code = code; self.myId = peer.id;
          self._setStatus('online');
          self.emit('open', { code: code, id: peer.id });
          peer.on('connection', self._onConnection.bind(self));
          resolve({ code: code, id: peer.id });
        });
        peer.on('error', function (err) {
          if (done) return;
          done = true;
          try { peer.destroy(); } catch (e) {}
          if (tries < 3) { setTimeout(attempt, 300 + Math.random() * 400); }
          else { self._setStatus('error', err.type || 'signal'); reject(new Error(err.type || 'signal')); }
        });
      }
      attempt();
    });
  };

  Room.prototype.join = function (code, name) {
    this.name = name || 'Player';
    this.isHost = false;
    this.code = String(code || '').toUpperCase();
    var self = this;
    this._setStatus('connecting');
    return new Promise(function (resolve, reject) {
      var peer;
      try { peer = self._newPeer(null); } catch (e) { reject(e); return; }
      var done = false;
      var timer = setTimeout(function () {
        if (done) return; done = true;
        self._setStatus('error', 'timeout');
        try { peer.destroy(); } catch (e) {}
        reject(new Error('timeout'));
      }, 15000);

      peer.on('open', function () {
        self.peer = peer; self.myId = peer.id;
        var conn = peer.connect(PREFIX + self.code, { reliable: true, serialization: 'json' });
        conn.on('open', function () {
          if (done) return; done = true; clearTimeout(timer);
          self.conns['host'] = conn;
          self._bindConn(conn, 'host');
          self._setStatus('online');
          self.emit('open', { code: self.code, id: peer.id });
          resolve({ code: self.code, id: peer.id });
        });
        conn.on('error', function (e) {
          if (done) return; done = true; clearTimeout(timer);
          self._setStatus('error', 'signal');
          reject(new Error('signal'));
        });
      });
      peer.on('error', function (err) {
        if (done) return; done = true; clearTimeout(timer);
        self._setStatus('error', err.type || 'signal');
        reject(new Error(err.type || 'signal'));
      });
    });
  };

  Room.prototype._onConnection = function (conn) {
    this.conns[conn.peer] = conn;
    this._bindConn(conn, conn.peer);
    this.emit('peerjoin', conn.peer);
  };

  Room.prototype._bindConn = function (conn, id) {
    conn.on('data', function (data) {
      var msg = data;
      if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
      this.emit('message', id, msg);
    }.bind(this));
    conn.on('close', function () {
      delete this.conns[id];
      this.emit('peerleave', id);
    }.bind(this));
    conn.on('error', function () {});
  };

  Room.prototype.send = function (id, obj) {
    var c = this.conns[id];
    if (c && c.open) { try { c.send(obj); } catch (e) {} }
  };

  Room.prototype.broadcast = function (obj) {
    Object.keys(this.conns).forEach(function (id) { this.send(id, obj); }.bind(this));
  };

  Room.prototype.close = function () {
    try { this.broadcast({ t: 'bye' }); } catch (e) {}
    Object.keys(this.conns).forEach(function (id) {
      try { this.conns[id].close(); } catch (e) {}
    }.bind(this));
    this.conns = {};
    if (this.peer) { try { this.peer.destroy(); } catch (e) {} this.peer = null; }
    this.status = 'offline';
    this.emit('status', 'offline');
  };

  global.VPRoom = Room;
  global.VP_CODE = makeCode;
})(window);
