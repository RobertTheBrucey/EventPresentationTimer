import { getState, dispatch } from './state.js';
import { getLocalIPs, subnetPeers, generateCode, showToast } from './utils.js';
import { RelayClient, discoverRelay } from './relay-client.js';
import { PeerManager, startSyncBroadcast } from './webrtc.js';
import { renderQR } from './qrcode.js';

const RELAY_PORT = 7777;

export class PairingManager {
  constructor() {
    this._peerId = getState().peerId;
    this._peerManager = new PeerManager(this._peerId);
    this._relay = null;
    this._relayUrl = null;
    this._sessionCode = null;
    this._stopSync = null;
    this._localPeerIds = new Set();         // peers actively connecting via BroadcastChannel
    this._discoveredLocalPeers = new Map(); // peerId → { peerId, role } — for UI listing
    this._onDiscoveredChange = null;        // callback set by UI
    this._localBus = null;
    this._sdpPlaceholderId = null;
  }

  get peerManager() { return this._peerManager; }
  get discoveredLocalPeers() { return [...this._discoveredLocalPeers.values()]; }
  set onDiscoveredChange(cb) { this._onDiscoveredChange = cb; }

  async start() {
    this._sessionCode = generateCode();
    dispatch({ type: 'SESSION_CODE_SET', code: this._sessionCode });

    if (getState().role === 'controller' || getState().role === 'both') {
      this._stopSync = startSyncBroadcast(this._peerManager);
    }

    this._updateQRDisplays();

    // Same-device auto-link via BroadcastChannel
    this._startLocalBridge();

    // LAN relay discovery (non-blocking)
    this._discoverAndConnectRelay();

    // Auto-join if ?join=CODE is in URL
    const joinCode = new URLSearchParams(location.search).get('join');
    if (joinCode) {
      // Wait briefly for relay discovery first
      setTimeout(() => this.joinByCode(joinCode.toUpperCase()), 600);
    }
  }

  /** Join a remote session by 6-char code (works for both roles) */
  async joinByCode(code) {
    console.log('[pairing] joinByCode', code, 'relay:', this._relay ? 'present' : 'null');
    if (!this._relay) {
      showToast('No relay found on LAN — use QR scan or Offline SDP instead', 'error');
      return false;
    }
    try {
      this._relay.send({ type: 'HELLO', room: code, peerId: this._peerId });
      return true;
    } catch (err) {
      console.error('[pairing] joinByCode failed:', err);
      showToast(`Pairing failed: ${err.message}`, 'error');
      return false;
    }
  }

  broadcast(msg) {
    this._peerManager.broadcast(msg);
  }

  // ── Controller-initiated offline SDP ──────────────────────────────────

  /** Generate controller's offer blob (for display to paste/scan) */
  async getManualOffer() {
    const remotePeerId = `manual-${Date.now()}`;
    const { sdp } = await this._peerManager.createOffer(remotePeerId);
    return btoa(JSON.stringify({ offererId: this._peerId, sdp }));
  }

  /** Controller applies the display's answer */
  async applyManualAnswer(blob) {
    try {
      const { offererId, sdp } = JSON.parse(atob(blob));
      // offererId is the display's peerId; our offer used a different placeholder
      // Find any pending connection whose remote description type is 'offer'
      const pending = [...this._peerManager._peers.entries()]
        .find(([, p]) => p.pc.signalingState === 'have-local-offer');
      if (!pending) throw new Error('No pending offer found');
      await this._peerManager.applyAnswer(pending[0], sdp);
      showToast('Connected via manual SDP', 'success');
    } catch (err) {
      showToast(`SDP error: ${err.message}`, 'error');
    }
  }

  // ── Display-initiated offline SDP ─────────────────────────────────────

  /** Generate display's offer blob (for controller to paste/scan) */
  async generateDisplayOffer() {
    this._sdpPlaceholderId = `display-offer-${Date.now()}`;
    const { sdp } = await this._peerManager.createOffer(this._sdpPlaceholderId);
    return btoa(JSON.stringify({ offererId: this._peerId, sdp }));
  }

  /** Controller accepts a display's offer, returns answer blob */
  async acceptIncomingOffer(offerBlob) {
    const { offererId, sdp } = JSON.parse(atob(offerBlob));
    const answer = await this._peerManager.createAnswer(offererId, sdp);
    return btoa(JSON.stringify({ answererId: this._peerId, sdp: answer }));
  }

  /** Display applies the controller's answer blob */
  async applyDisplayAnswer(answerBlob) {
    try {
      const { sdp } = JSON.parse(atob(answerBlob));
      if (!this._sdpPlaceholderId) throw new Error('No pending offer');
      await this._peerManager.applyAnswer(this._sdpPlaceholderId, sdp);
      showToast('Connected via offline SDP', 'success');
    } catch (err) {
      showToast(`SDP error: ${err.message}`, 'error');
    }
  }

  // ── BroadcastChannel (same-device discovery) ─────────────────────────

  _startLocalBridge() {
    if (!('BroadcastChannel' in window)) return;

    this._localBus = new BroadcastChannel('ept-local');

    // Announce ourselves; other tabs reply
    this._localBus.postMessage({
      type: 'EPT_HELLO', peerId: this._peerId, role: getState().role,
    });

    this._localBus.onmessage = async ({ data: msg }) => {
      if (!msg?.type?.startsWith('EPT_')) return;

      if (msg.type === 'EPT_HELLO') {
        if (msg.peerId === this._peerId) return;

        // Reply to new announcements so tabs that open later discover us
        if (!msg.isReply) {
          this._localBus.postMessage({
            type: 'EPT_HELLO', peerId: this._peerId, role: getState().role, isReply: true,
          });
        }

        // Register in discovered list and notify UI (idempotent)
        if (!this._discoveredLocalPeers.has(msg.peerId)) {
          this._discoveredLocalPeers.set(msg.peerId, { peerId: msg.peerId, role: msg.role });
          this._onDiscoveredChange?.(this.discoveredLocalPeers);
        }

      } else if (msg.type === 'EPT_OFFER' && msg.to === this._peerId) {
        // Incoming offer from a peer who clicked Connect — accept automatically
        if (this._localPeerIds.has(msg.from)) return;
        this._localPeerIds.add(msg.from);
        const answer = await this._peerManager.createAnswer(msg.from, msg.sdp, { waitForIce: false });
        this._localBus.postMessage({ type: 'EPT_ANSWER', to: msg.from, from: this._peerId, sdp: { type: answer.type, sdp: answer.sdp } });

      } else if (msg.type === 'EPT_ANSWER' && msg.to === this._peerId) {
        await this._peerManager.applyAnswer(msg.from, msg.sdp).catch(() => {});

      } else if (msg.type === 'EPT_ICE' && msg.to === this._peerId) {
        await this._peerManager.addIceCandidate(msg.from, msg.candidate).catch(() => {});
      }
    };

    // Forward trickle ICE for local-bridge peers (waitForIce=false means we trickle)
    this._peerManager.on('ice-candidate', ({ remotePeerId, candidate }) => {
      if (this._localPeerIds.has(remotePeerId)) {
        this._localBus.postMessage({ type: 'EPT_ICE', to: remotePeerId, from: this._peerId, candidate });
      }
    });
  }

  /** Connect to a peer discovered on the same device via BroadcastChannel */
  async connectToLocalPeer(peerId) {
    if (this._localPeerIds.has(peerId)) return;
    this._localPeerIds.add(peerId);
    const { sdp } = await this._peerManager.createOffer(peerId, { waitForIce: false });
    this._localBus.postMessage({ type: 'EPT_OFFER', to: peerId, from: this._peerId, sdp: { type: sdp.type, sdp: sdp.sdp } });
  }

  // ── Relay ─────────────────────────────────────────────────────────────

  async _discoverAndConnectRelay() {
    // 1. Try same-origin cloud relay (works when online)
    try {
      console.log('[relay] probing cloud relay at', `${location.origin}/ping`);
      const resp = await fetch(`${location.origin}/ping`, { signal: AbortSignal.timeout(2000) });
      const data = await resp.json();
      console.log('[relay] /ping response:', data);
      if (data?.relay) {
        const wsUrl = `${location.origin.replace(/^http/, 'ws')}/relay`;
        this._relayUrl = wsUrl;
        this._connectRelay(wsUrl);
        return; // skip LAN probing
      }
    } catch (e) {
      console.warn('[relay] cloud relay probe failed:', e.message);
    }

    // 2. LAN subnet probe fallback
    try {
      const localIPs = await getLocalIPs();
      const probeIPs = [];
      for (const ip of localIPs) probeIPs.push(...subnetPeers(ip));
      probeIPs.push('127.0.0.1');
      console.log('[relay] probing LAN IPs:', probeIPs.length, 'addresses');

      const relayUrl = await discoverRelay([...new Set(probeIPs)], RELAY_PORT);
      if (relayUrl) {
        console.log('[relay] LAN relay found at', relayUrl);
        this._relayUrl = relayUrl;
        this._connectRelay(relayUrl);
      } else {
        console.warn('[relay] no relay found on LAN or cloud');
      }
    } catch (e) {
      console.warn('[relay] LAN probe error:', e.message);
    }
  }

  _connectRelay(wsUrl) {
    console.log('[relay] connecting to', wsUrl, 'room:', this._sessionCode);
    this._relay = new RelayClient(wsUrl, this._peerId);
    this._relay.connect(this._sessionCode);

    this._relay.on('connected', () => {
      console.log('[relay] connected, peerId:', this._peerId, 'room:', this._sessionCode);
      showToast('Relay connected — auto-discovery active', 'success');
    });

    this._relay.on('OFFER', async msg => {
      console.log('[relay] OFFER received from', msg.senderId, '→', msg.targetPeerId);
      if (msg.targetPeerId && msg.targetPeerId !== this._peerId) {
        console.log('[relay] OFFER not for us, ignoring');
        return;
      }
      const remotePeerId = msg.senderId;

      // Glare: both sides created offers simultaneously — resolve via peerId ordering.
      // Lower peerId is "impolite" (its offer wins); higher peerId is "polite" (rolls back).
      const existing = this._peerManager._peers.get(remotePeerId);
      if (existing?.pc.signalingState === 'have-local-offer') {
        if (this._peerId < remotePeerId) {
          console.log('[relay] glare: our offer wins (lower peerId), ignoring incoming offer');
          return;
        }
        console.log('[relay] glare: rolling back our offer, accepting incoming offer');
        this._peerManager.removePeer(remotePeerId);
      }

      try {
        console.log('[relay] creating answer for', remotePeerId);
        const answer = await this._peerManager.createAnswer(remotePeerId, msg.payload.sdp);
        console.log('[relay] sending ANSWER to', remotePeerId);
        this._relay.send({
          type: 'ANSWER', senderId: this._peerId, targetPeerId: remotePeerId,
          room: msg.room ?? this._sessionCode, payload: { sdp: answer },
        });
      } catch (e) {
        console.error('[relay] createAnswer failed:', e);
      }
    });

    this._relay.on('ANSWER', async msg => {
      console.log('[relay] ANSWER received from', msg.senderId);
      if (msg.targetPeerId && msg.targetPeerId !== this._peerId) return;
      try {
        await this._peerManager.applyAnswer(msg.senderId, msg.payload.sdp);
        console.log('[relay] answer applied for', msg.senderId);
      } catch (e) {
        // Expected when glare resolution caused our offer to be rolled back
        console.log('[relay] applyAnswer skipped (glare resolved):', e.message);
      }
    });

    this._relay.on('ICE', async msg => {
      if (msg.targetPeerId && msg.targetPeerId !== this._peerId) return;
      await this._peerManager.addIceCandidate(msg.senderId, msg.payload.candidate);
    });

    this._relay.on('PEER_JOINED', async msg => {
      const role = getState().role;
      console.log('[relay] PEER_JOINED', msg.peerId, '(our role:', role, ')');
      if (role === 'controller' || role === 'both') {
        await this._initiateConnectionToPeer(msg.peerId);
      }
    });

    // ROOM_INFO fires when we join a room that already has members.
    // The controller must initiate connections to those existing peers.
    this._relay.on('ROOM_INFO', async msg => {
      const role = getState().role;
      console.log('[relay] ROOM_INFO peers:', msg.peers, '(our role:', role, ')');
      if (role === 'controller' || role === 'both') {
        for (const peerId of (msg.peers ?? [])) {
          await this._initiateConnectionToPeer(peerId);
        }
      }
    });

    // Forward relay ICE — but skip local-bridge peers (they use BroadcastChannel)
    this._peerManager.on('ice-candidate', ({ remotePeerId, candidate }) => {
      if (this._localPeerIds.has(remotePeerId)) return;
      this._relay?.send({
        type: 'ICE', senderId: this._peerId, targetPeerId: remotePeerId,
        room: this._sessionCode, payload: { candidate },
      });
    });
  }

  async _initiateConnectionToPeer(remotePeerId) {
    if (remotePeerId === this._peerId) return;

    // Skip if already connected (either via local bridge or a previous relay attempt)
    const existing = this._peerManager._peers.get(remotePeerId);
    if (existing?.dc?.readyState === 'open') return;

    console.log('[relay] initiating offer to', remotePeerId);
    try {
      const { sdp } = await this._peerManager.createOffer(remotePeerId);
      console.log('[relay] sending OFFER to', remotePeerId);
      this._relay?.send({
        type: 'OFFER', senderId: this._peerId, targetPeerId: remotePeerId,
        room: this._sessionCode, payload: { sdp },
      });
    } catch (e) {
      console.error('[relay] createOffer failed:', e);
    }
  }

  _updateQRDisplays() {
    const code = this._sessionCode;
    const joinUrl = `${location.origin}${location.pathname}?join=${code}&role=display`;

    const render = (id, url) => { const el = document.getElementById(id); if (el) renderQR(el, url); };
    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

    render('display-qr', joinUrl);
    setText('display-code', code);
    render('modal-qr', joinUrl);
    setText('modal-code', code);
    setText('modal-join-url', joinUrl);

    this.getManualOffer().then(offer => {
      setText('sdp-offer-out', offer);
      render('ctrl-offer-qr', offer); // raw blob — smaller than full URL
    }).catch(() => {});
  }

  destroy() {
    this._localBus?.close();
    this._relay?.close();
    this._peerManager.closeAll();
    this._stopSync?.();
  }
}
