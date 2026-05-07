/**
 * WebSocket adapter for the EPTimer signaling relay.
 * Handles connect/disconnect/reconnect and message routing.
 */
export class RelayClient {
  constructor(url, peerId) {
    this._url = url;
    this._peerId = peerId;
    this._ws = null;
    this._handlers = new Map();
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 30000;
    this._closed = false;
    this._room = null;
    this._pending = []; // messages queued before socket is open
  }

  /** Connect and join a room */
  connect(roomCode) {
    this._room = roomCode;
    this._closed = false;
    this._open();
    return this;
  }

  _open() {
    if (this._closed) return;
    try {
      this._ws = new WebSocket(this._url);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }

    this._ws.onopen = () => {
      this._reconnectDelay = 1000;
      console.log('[ws] open →', this._url);
      this._send({ type: 'HELLO', room: this._room, peerId: this._peerId });
      // Flush messages queued before socket opened
      for (const msg of this._pending) this._ws.send(msg);
      this._pending = [];
      this._emit('connected');
    };

    this._ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      console.log('[ws] ←', msg.type, msg);
      this._emit('message', msg);
      if (msg.type) this._emit(msg.type, msg);
    };

    this._ws.onclose = e => {
      console.warn('[ws] closed', e.code, e.reason);
      this._emit('disconnected');
      this._scheduleReconnect();
    };

    this._ws.onerror = e => {
      console.error('[ws] error', e);
    };
  }

  _scheduleReconnect() {
    if (this._closed) return;
    setTimeout(() => this._open(), this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
  }

  _send(data) {
    const serialised = JSON.stringify(data);
    if (this._ws?.readyState === WebSocket.OPEN) {
      console.log('[ws] →', data.type, data);
      this._ws.send(serialised);
    } else if (!this._closed) {
      console.log('[ws] queued (not open):', data.type);
      if (this._pending.length < 32) this._pending.push(serialised);
    }
  }

  /** Send a signaling message to the relay */
  send(msg) {
    this._send(msg);
  }

  /** Close permanently */
  close() {
    this._closed = true;
    this._ws?.close();
    this._ws = null;
  }

  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return () => this._handlers.get(event)?.delete(handler);
  }

  _emit(event, data) {
    this._handlers.get(event)?.forEach(h => h(data));
  }
}

/**
 * Probe a single LAN address for the relay
 * @param {string} ip
 * @param {number} port
 * @returns {Promise<string|null>} relay URL or null
 */
export async function probeRelay(ip, port = 7777) {
  try {
    const res = await fetch(`http://${ip}:${port}/ping`, {
      signal: AbortSignal.timeout(300),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.relay === true) return `ws://${ip}:${port}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * Scan a list of IPs concurrently for a relay.
 * @param {string[]} ips
 * @param {number} port
 * @returns {Promise<string|null>} first relay URL found, or null
 */
export async function discoverRelay(ips, port = 7777) {
  return new Promise(resolve => {
    let pending = ips.length;
    if (pending === 0) { resolve(null); return; }

    let resolved = false;
    for (const ip of ips) {
      probeRelay(ip, port).then(url => {
        if (url && !resolved) { resolved = true; resolve(url); }
        pending--;
        if (pending === 0 && !resolved) resolve(null);
      });
    }
  });
}
