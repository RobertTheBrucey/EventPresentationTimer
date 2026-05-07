// Cloudflare Worker — owns the RelayRoom Durable Object.
// Deploy with: npx wrangler deploy --config wrangler.toml
// The Pages project then binds to this DO via script_name = "wrapcue-relay".

export class RelayRoom {
  constructor(state) {
    this.state = state;
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
      ws.serializeAttachment({ peerId, room });

      for (const peer of this.state.getWebSockets()) {
        if (peer === ws) continue;
        const tag = peer.deserializeAttachment();
        if (tag?.room === room) {
          peer.send(JSON.stringify({ type: 'PEER_JOINED', peerId }));
        }
      }

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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/ping') {
      return new Response(JSON.stringify({ relay: true, version: 1 }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      const stub = env.ROOMS.get(env.ROOMS.idFromName('global'));
      return stub.fetch(request);
    }
    return new Response('wrapcue relay', { status: 200 });
  },
};
