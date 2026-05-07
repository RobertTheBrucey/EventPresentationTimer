import { dispatch, getState } from './state.js';
import { buildSyncPayload } from './timer.js';
import { uuid } from './utils.js';

const DATACHANNEL_LABEL = 'ept-control';
const MSG_VERSION = 1;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * Manages a mesh of WebRTC peer connections.
 */
export class PeerManager {
  constructor(localPeerId) {
    this._localId = localPeerId;
    this._peers = new Map();  // peerId → { pc, dc, role }
    this._handlers = new Map();
  }

  /**
   * Initiate a connection to a remote peer (we are the offerer).
   * @param {string} remotePeerId
   * @returns {{ pc: RTCPeerConnection, offer: RTCSessionDescriptionInit }}
   */
  async createOffer(remotePeerId, { waitForIce = true } = {}) {
    const { pc, dc } = this._createPeer(remotePeerId, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (waitForIce) await this._waitForIce(pc);
    return { pc, dc, sdp: pc.localDescription };
  }

  /**
   * Accept an offer from a remote peer and produce an answer.
   * @param {string} remotePeerId
   * @param {RTCSessionDescriptionInit} offerSdp
   * @returns {RTCSessionDescriptionInit}
   */
  async createAnswer(remotePeerId, offerSdp, { waitForIce = true } = {}) {
    const { pc } = this._createPeer(remotePeerId, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (waitForIce) await this._waitForIce(pc);
    return pc.localDescription;
  }

  /**
   * Apply a remote answer to our existing offer.
   * @param {string} remotePeerId
   * @param {RTCSessionDescriptionInit} answerSdp
   */
  async applyAnswer(remotePeerId, answerSdp) {
    const peer = this._peers.get(remotePeerId);
    if (!peer) throw new Error(`No peer found: ${remotePeerId}`);
    await peer.pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
  }

  /**
   * Add a trickle ICE candidate for a peer.
   * @param {string} remotePeerId
   * @param {RTCIceCandidateInit} candidate
   */
  async addIceCandidate(remotePeerId, candidate) {
    const peer = this._peers.get(remotePeerId);
    if (!peer) return;
    try { await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* ignore */ }
  }

  /**
   * Broadcast a message to all connected peers.
   * @param {{ type: string, payload?: object }} msg
   */
  broadcast(msg) {
    const envelope = this._wrap(msg);
    const data = JSON.stringify(envelope);
    for (const [, peer] of this._peers) {
      if (peer.dc?.readyState === 'open') {
        peer.dc.send(data);
      }
    }
  }

  /**
   * Send a message to a specific peer.
   * @param {string} remotePeerId
   * @param {{ type: string, payload?: object }} msg
   */
  sendTo(remotePeerId, msg) {
    const peer = this._peers.get(remotePeerId);
    if (peer?.dc?.readyState === 'open') {
      peer.dc.send(JSON.stringify(this._wrap(msg)));
    }
  }

  /**
   * Close and remove a peer connection.
   * @param {string} remotePeerId
   */
  removePeer(remotePeerId) {
    const peer = this._peers.get(remotePeerId);
    if (!peer) return;
    peer.dc?.close();
    peer.pc.close();
    this._peers.delete(remotePeerId);
    dispatch({ type: 'PEER_DISCONNECTED', peerId: remotePeerId });
    this._emit('peer-disconnected', { peerId: remotePeerId });
  }

  /** Close all peer connections */
  closeAll() {
    for (const id of this._peers.keys()) this.removePeer(id);
  }

  get connectedCount() {
    return [...this._peers.values()].filter(p => p.dc?.readyState === 'open').length;
  }

  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return () => this._handlers.get(event)?.delete(handler);
  }

  // ── Private ──────────────────────────────────────────────────────────

  _createPeer(remotePeerId, isOfferer) {
    if (this._peers.has(remotePeerId)) {
      const existing = this._peers.get(remotePeerId);
      return { pc: existing.pc, dc: existing.dc };
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { pc, dc: null, role: null };
    this._peers.set(remotePeerId, entry);

    let dc;
    if (isOfferer) {
      dc = pc.createDataChannel(DATACHANNEL_LABEL, { ordered: true });
      entry.dc = dc;
      this._bindDC(dc, remotePeerId);
    } else {
      pc.ondatachannel = e => {
        entry.dc = e.channel;
        this._bindDC(e.channel, remotePeerId);
      };
    }

    pc.onicecandidate = e => {
      if (e.candidate) {
        this._emit('ice-candidate', { remotePeerId, candidate: e.candidate.toJSON() });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.removePeer(remotePeerId);
      }
    };

    return { pc, dc: entry.dc };
  }

  _bindDC(dc, remotePeerId) {
    dc.onopen = () => {
      this._emit('peer-connected', { peerId: remotePeerId });
      // Send a hello so the remote knows our role
      dc.send(JSON.stringify(this._wrap({
        type: 'PEER_HELLO',
        payload: { role: getState().role, displayName: _deviceName() },
      })));

      // If we are a controller, immediately send a full sync
      if (getState().role === 'controller' || getState().role === 'both') {
        this._sendSync(dc);
      }
    };

    dc.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._handleMessage(msg, remotePeerId);
    };

    dc.onclose = () => this.removePeer(remotePeerId);
    dc.onerror = () => this.removePeer(remotePeerId);
  }

  _handleMessage(msg, senderId) {
    if (!msg?.type) return;

    switch (msg.type) {
      case 'PEER_HELLO': {
        const peer = this._peers.get(senderId);
        if (peer) peer.role = msg.payload?.role;
        dispatch({
          type: 'PEER_CONNECTED',
          peer: { id: senderId, role: msg.payload?.role, displayName: msg.payload?.displayName },
        });
        break;
      }

      case 'SYNC':
        if (getState().role === 'display') {
          dispatch({ type: 'REMOTE_SYNC', payload: msg.payload });
        }
        break;

      case 'TICK_SYNC':
        if (getState().role === 'display') {
          dispatch({ type: 'REMOTE_TICK_SYNC', payload: msg.payload });
        }
        break;

      case 'TIMER_START':   dispatch({ type: 'TIMER_START' });   break;
      case 'TIMER_PAUSE':   dispatch({ type: 'TIMER_PAUSE' });   break;
      case 'TIMER_RESUME':  dispatch({ type: 'TIMER_RESUME' });  break;
      case 'TIMER_STOP':    dispatch({ type: 'TIMER_STOP' });    break;
      case 'TIMER_RESET':   dispatch({ type: 'TIMER_RESET' });   break;

      case 'SLOT_ADVANCE':
        dispatch({ type: 'SLOT_ADVANCE', toIndex: msg.payload?.toIndex });
        break;

      case 'SCHEDULE_SET':
        dispatch({ type: 'SCHEDULE_SET', slots: msg.payload?.slots ?? [] });
        break;

      case 'THRESHOLDS_SET':
        dispatch({ type: 'THRESHOLDS_SET', thresholds: msg.payload?.thresholds });
        break;

      case 'MESSAGE_SET':
        dispatch({ type: 'MESSAGE_SET', message: msg.payload?.message ?? '' });
        break;

      case 'MESSAGE_CLEAR':
        dispatch({ type: 'MESSAGE_CLEAR' });
        break;

      case 'THEME_SET':
        dispatch({ type: 'THEME_SET', theme: msg.payload?.theme });
        break;
    }

    this._emit('message', { msg, senderId });
  }

  _sendSync(dc) {
    const payload = buildSyncPayload(getState());
    const data = JSON.stringify(this._wrap({ type: 'SYNC', payload }));
    if (dc.readyState === 'open') dc.send(data);
  }

  _wrap(msg) {
    return {
      v: MSG_VERSION,
      type: msg.type,
      senderId: this._localId,
      ts: Date.now(),
      payload: msg.payload ?? {},
    };
  }

  _emit(event, data) {
    this._handlers.get(event)?.forEach(h => h(data));
  }

  _waitForIce(pc) {
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      const timeout = setTimeout(resolve, 3000);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); }
      };
    });
  }
}

/** Start the periodic SYNC broadcasts (controller only) */
export function startSyncBroadcast(peerManager) {
  // Full SYNC every 2s
  const syncInterval = setInterval(() => {
    if (peerManager.connectedCount === 0) return;
    const s = getState();
    if (s.role !== 'controller' && s.role !== 'both') return;
    peerManager.broadcast({ type: 'SYNC', payload: buildSyncPayload(s) });
  }, 2000);

  // Lightweight TICK_SYNC every 500ms while running
  const tickInterval = setInterval(() => {
    if (peerManager.connectedCount === 0) return;
    const s = getState();
    if (s.role !== 'controller' && s.role !== 'both') return;
    if (s.timerState !== 'running' && s.timerState !== 'overtime') return;
    peerManager.broadcast({
      type: 'TICK_SYNC',
      payload: {
        timerState: s.timerState,
        serverWallClock: Date.now(),
      },
    });
  }, 500);

  return () => { clearInterval(syncInterval); clearInterval(tickInterval); };
}

function _deviceName() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone/.test(ua)) return 'iOS Device';
  if (/Android/.test(ua)) return 'Android Device';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Win/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'Device';
}
