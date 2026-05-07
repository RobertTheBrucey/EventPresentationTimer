// Cloudflare Pages Function — WebSocket signaling relay backed by a Durable Object.
// Uses the hibernatable WebSockets API so DO sleeps between messages.

export class RelayRoom {
  constructor(state) {
    this.state = state;
    // peerId → { room } — stored in DO memory, rebuilt on wake from attachment tags
  }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    // acceptWebSocket with no tag yet — tag set on HELLO
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const { type, peerId, room, targetPeerId } = msg;

    if (type === 'HELLO') {
      // Store identity on the WebSocket via serialised tag (max 2048 bytes)
      ws.serializeAttachment({ peerId, room });

      // Notify existing peers in the room
      for (const peer of this.state.getWebSockets()) {
        if (peer === ws) continue;
        const tag = peer.deserializeAttachment();
        if (tag?.room === room) {
          peer.send(JSON.stringify({ type: 'PEER_JOINED', peerId }));
        }
      }

      // Tell the new peer who's already in the room
      const existing = this.state.getWebSockets()
        .filter(p => p !== ws)
        .map(p => p.deserializeAttachment())
        .filter(t => t?.room === room)
        .map(t => t.peerId);
      ws.send(JSON.stringify({ type: 'ROOM_INFO', peers: existing }));
      return;
    }

    if (type === 'OFFER' || type === 'ANSWER' || type === 'ICE') {
      const senderTag = ws.deserializeAttachment();
      if (!senderTag) return;

      for (const peer of this.state.getWebSockets()) {
        if (peer === ws) continue;
        const tag = peer.deserializeAttachment();
        if (!tag) continue;
        if (targetPeerId) {
          if (tag.peerId === targetPeerId) { peer.send(data); break; }
        } else {
          if (tag.room === senderTag.room) peer.send(data);
        }
      }
      return;
    }

    if (type === 'BYE') this._cleanup(ws);
  }

  webSocketClose(ws) { this._cleanup(ws); }
  webSocketError(ws)  { this._cleanup(ws); }

  _cleanup(ws) {
    const tag = ws.deserializeAttachment();
    if (!tag) return;
    const { peerId, room } = tag;
    for (const peer of this.state.getWebSockets()) {
      if (peer === ws) continue;
      const t = peer.deserializeAttachment();
      if (t?.room === room) {
        peer.send(JSON.stringify({ type: 'PEER_LEFT', peerId }));
      }
    }
    try { ws.close(); } catch {}
  }
}

export async function onRequest({ request, env }) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('WebSocket upgrade required', { status: 426 });
  }
  if (!env.ROOMS) {
    return new Response('Relay not configured (missing DO binding)', { status: 503 });
  }
  const stub = env.ROOMS.get(env.ROOMS.idFromName('global'));
  return stub.fetch(request);
}
