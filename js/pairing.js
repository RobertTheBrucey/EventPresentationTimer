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
    this._localPeerIds = new Set();
    this._localBus = null;
    this._sdpPlaceholderId = null;
  }

  get peerManager() { return this._peerManager; }

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

  // ── BroadcastChannel (same-device auto-link) ──────────────────────────

  _startLocalBridge() {
    if (!('BroadcastChannel' in window)) return;

    this._localBus = new BroadcastChannel('ept-local');

    // Announce ourselves; others will reply
    this._localBus.postMessage({
      type: 'EPT_HELLO', peerId: this._peerId, role: getState().role,
    });
    console.log('[local] BroadcastChannel started, announced peerId:', this._peerId);

    this._localBus.onmessage = async ({ data: msg }) => {
      if (!msg?.type?.startsWith('EPT_')) return;

      if (msg.type === 'EPT_HELLO') {
        if (msg.peerId === this._peerId) return;
        if (this._localPeerIds.has(msg.peerId)) return;
        console.log('[local] EPT_HELLO from', msg.peerId, 'role:', msg.role, 'isReply:', msg.isReply);

        // Reply so that tabs opening later discover us
        if (!msg.isReply) {
          this._localBus.postMessage({
            type: 'EPT_HELLO', peerId: this._peerId, role: getState().role, isReply: true,
          });
        }

        this._localPeerIds.add(msg.peerId);

        // Higher peerId initiates to prevent both sides creating offers simultaneously
        if (this._peerId > msg.peerId) {
          console.log('[local] initiating offer to', msg.peerId);
          const { sdp } = await this._peerManager.createOffer(msg.peerId, { waitForIce: false });
          this._localBus.postMessage({ type: 'EPT_OFFER', to: msg.peerId, from: this._peerId, sdp });
        } else {
          console.log('[local] waiting for offer from', msg.peerId);
        }

      } else if (msg.type === 'EPT_OFFER' && msg.to === this._peerId) {
        if (this._localPeerIds.has(msg.from)) return;
        console.log('[local] EPT_OFFER from', msg.from);
        this._localPeerIds.add(msg.from);
        const answer = await this._peerManager.createAnswer(msg.from, msg.sdp, { waitForIce: false });
        this._localBus.postMessage({ type: 'EPT_ANSWER', to: msg.from, from: this._peerId, sdp: answer });
        console.log('[local] sent EPT_ANSWER to', msg.from);

      } else if (msg.type === 'EPT_ANSWER' && msg.to === this._peerId) {
        console.log('[local] EPT_ANSWER from', msg.from);
        await this._peerManager.applyAnswer(msg.from, msg.sdp).catch(e => console.error('[local] applyAnswer failed:', e));

      } else if (msg.type === 'EPT_ICE' && msg.to === this._peerId) {
        await this._peerManager.addIceCandidate(msg.from, msg.candidate).catch(() => {});
      }
    };

    // Forward trickle ICE for local-bridge peers (needed because waitForIce=false)
    this._peerManager.on('ice-candidate', ({ remotePeerId, candidate }) => {
      if (this._localPeerIds.has(remotePeerId)) {
        this._localBus.postMessage({ type: 'EPT_ICE', to: remotePeerId, from: this._peerId, candidate });
      }
    });
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
        console.error('[relay] applyAnswer failed:', e);
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

    if (this._localPeerIds.has(remotePeerId)) {
      // Peer was seen via BroadcastChannel — only skip relay if the DC is already open
      const peer = this._peerManager._peers.get(remotePeerId);
      if (peer?.dc?.readyState === 'open') {
        console.log('[relay] skipping', remotePeerId, '— already connected via local bridge');
        return;
      }
      // Local bridge didn't fully connect; clean up and let relay try instead
      console.log('[relay] local bridge stalled for', remotePeerId, '(dc:', peer?.dc?.readyState ?? 'none', ') — falling back to relay');
      if (peer) this._peerManager.removePeer(remotePeerId);
    }

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
