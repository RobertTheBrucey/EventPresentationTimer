// Cloudflare Pages Function — WebSocket signaling relay backed by a Durable Object.
// The RelayRoom DO maintains room state (peers, WebSocket connections) across requests.

export class RelayRoom {
  constructor(state) {
    this.state = state;
    this.peers = new Map(); // peerId → WebSocket
    this.rooms = new Map(); // roomCode → Set<peerId>
  }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const { type, peerId, room, targetPeerId } = msg;

    if (type === 'HELLO') {
      ws._peerId = peerId;
      ws._room = room;
      this.peers.set(peerId, ws);
      if (!this.rooms.has(room)) this.rooms.set(room, new Set());
      this.rooms.get(room).add(peerId);

      // Notify existing room members
      for (const pid of this.rooms.get(room)) {
        if (pid !== peerId) {
          this.peers.get(pid)?.send(JSON.stringify({ type: 'PEER_JOINED', peerId }));
        }
      }
      // Inform the joining peer of who's already in the room
      ws.send(JSON.stringify({
        type: 'ROOM_INFO',
        peers: [...this.rooms.get(room)].filter(p => p !== peerId),
      }));
      return;
    }

    if (type === 'OFFER' || type === 'ANSWER' || type === 'ICE') {
      if (targetPeerId) {
        this.peers.get(targetPeerId)?.send(data);
      } else {
        for (const pid of (this.rooms.get(ws._room) ?? [])) {
          if (pid !== ws._peerId) this.peers.get(pid)?.send(data);
        }
      }
      return;
    }

    if (type === 'BYE') this._cleanup(ws);
  }

  webSocketClose(ws) { this._cleanup(ws); }
  webSocketError(ws)  { this._cleanup(ws); }

  _cleanup(ws) {
    const peerId = ws._peerId;
    const room   = ws._room;
    if (!peerId) return;
    this.peers.delete(peerId);
    const r = this.rooms.get(room);
    if (!r) return;
    r.delete(peerId);
    for (const pid of r) {
      this.peers.get(pid)?.send(JSON.stringify({ type: 'PEER_LEFT', peerId }));
    }
    if (!r.size) this.rooms.delete(room);
  }
}

export async function onRequest({ request, env }) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('WebSocket upgrade required', { status: 426 });
  }
  const room = env.ROOMS.get(env.ROOMS.idFromName('global'));
  return room.fetch(request);
}
