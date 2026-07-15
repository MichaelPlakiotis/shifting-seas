/* Shifting Seas — PeerJS networking (host = authoritative room owner for handshake only;
   each client keeps its own fleet secret and answers shots against it). */
'use strict';

const Net = {
  peer: null,
  conn: null,
  isHost: false,
  code: null,
  handlers: {},           // type -> fn(payload)
  onOpen: null,
  onClose: null,
  onError: null,

  PREFIX: 'shifting-seas-v1-',

  makeCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    const buf = new Uint32Array(5);
    crypto.getRandomValues(buf);
    for (let i = 0; i < 5; i++) code += alphabet[buf[i] % alphabet.length];
    return code;
  },

  host(cb) {
    this.isHost = true;
    this.code = this.makeCode();
    this.peer = new Peer(this.PREFIX + this.code);
    this.peer.on('open', () => cb(null, this.code));
    this.peer.on('error', err => {
      if (err.type === 'unavailable-id') { // rare collision: retry with a new code
        this.peer.destroy();
        this.host(cb);
      } else cb(err);
    });
    this.peer.on('connection', conn => {
      if (this.conn) { conn.close(); return; } // room is full
      this.wire(conn);
    });
  },

  join(code, cb) {
    this.isHost = false;
    this.code = code.toUpperCase().trim();
    this.peer = new Peer();
    this.peer.on('open', () => {
      const conn = this.peer.connect(this.PREFIX + this.code, { reliable: true });
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled && (!this.conn || !this.conn.open)) { settled = true; cb(new Error('timeout')); }
      }, 12000);
      conn.on('open', () => { settled = true; clearTimeout(timer); cb(null); });
      conn.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); cb(err); } });
      this.wire(conn);
    });
    this.peer.on('error', err => {
      if (err.type === 'peer-unavailable') cb(new Error('Room not found. Check the code.'));
      else cb(err);
    });
  },

  wire(conn) {
    this.conn = conn;
    conn.on('open', () => { if (this.onOpen) this.onOpen(); });
    conn.on('data', msg => {
      if (msg && typeof msg === 'object' && this.handlers[msg.type]) this.handlers[msg.type](msg);
    });
    conn.on('close', () => { if (this.onClose) this.onClose(); });
    conn.on('error', err => { if (this.onError) this.onError(err); });
  },

  on(type, fn) { this.handlers[type] = fn; },

  send(type, payload) {
    if (this.conn && this.conn.open) this.conn.send(Object.assign({ type }, payload || {}));
  },

  reset() {
    try { if (this.conn) this.conn.close(); } catch (e) {}
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.peer = null; this.conn = null; this.isHost = false; this.code = null; this.handlers = {};
    this.onOpen = this.onClose = this.onError = null;
  },

  joinUrl() {
    const base = location.origin + location.pathname;
    return base + '?room=' + this.code;
  },
};
