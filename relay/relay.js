#!/usr/bin/env node
/**
 * EPTimer signaling relay — optional LAN companion server.
 * Enables WebRTC auto-discovery and peer pairing without internet.
 *
 * Usage:
 *   cd relay && npm install && node relay.js [port]
 *   Default port: 7777
 *
 * The PWA probes http://<LAN_IP>:<PORT>/ping on startup.
 * Devices in the same room (6-char code) are bridged for WebRTC signaling.
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.argv[2] ?? process.env.PORT ?? '7777', 10);

// rooms: Map<code, Set<WebSocket>>
const rooms = new Map();

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/ping' || req.url === '/ping/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ relay: true, version: 1 }));
    return;
  }

  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  let roomCode = null;
  let peerId = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'HELLO': {
        roomCode = String(msg.room ?? '').toUpperCase();
        peerId = String(msg.peerId ?? '');
        if (!roomCode) { ws.close(1008, 'Room code required'); return; }
        if (!rooms.has(roomCode)) rooms.set(roomCode, new Set());
        rooms.get(roomCode).add(ws);
        // Inform this peer of how many others are in the room
        _send(ws, { type: 'ROOM_INFO', room: roomCode, peers: rooms.get(roomCode).size - 1 });
        // Inform existing peers that someone joined
        _broadcast(roomCode, { type: 'PEER_JOINED', peerId }, ws);
        break;
      }

      case 'OFFER':
      case 'ANSWER':
      case 'ICE': {
        // Forward to a specific peer or broadcast to all others in room
        if (!roomCode) return;
        const target = msg.targetPeerId;
        if (target) {
          _sendToPeer(roomCode, target, msg);
        } else {
          _broadcast(roomCode, msg, ws);
        }
        break;
      }

      case 'BYE': {
        _cleanup(ws, roomCode);
        ws.close();
        break;
      }
    }
  });

  ws.on('close', () => _cleanup(ws, roomCode));
  ws.on('error', () => _cleanup(ws, roomCode));
});

function _send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}

function _broadcast(roomCode, data, exclude = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const payload = JSON.stringify(data);
  for (const peer of room) {
    if (peer !== exclude && peer.readyState === peer.OPEN) {
      peer.send(payload);
    }
  }
}

function _sendToPeer(roomCode, targetPeerId, data) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const peer of room) {
    if (peer._peerId === targetPeerId && peer.readyState === peer.OPEN) {
      peer.send(JSON.stringify(data));
      return;
    }
  }
}

function _cleanup(ws, roomCode) {
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) rooms.delete(roomCode);
  else _broadcast(roomCode, { type: 'PEER_LEFT', peerId: ws._peerId });
}

server.listen(PORT, '0.0.0.0', () => {
  const networkInterfaces = require('os').networkInterfaces();
  const localIPs = Object.values(networkInterfaces)
    .flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => i.address);

  console.log(`EPTimer relay running on port ${PORT}`);
  console.log('Devices on the same network can connect at:');
  localIPs.forEach(ip => console.log(`  http://${ip}:${PORT}/ping`));
  console.log('\nPress Ctrl+C to stop.');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: node relay.js ${PORT + 1}`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
