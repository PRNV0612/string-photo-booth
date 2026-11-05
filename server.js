// string — signaling server
// Serves the static client and relays WebSocket signaling for WebRTC pairing.
// It NEVER sees or stores photos or video: media flows peer-to-peer (DTLS-SRTP),
// and photo frames travel over an encrypted WebRTC data channel.
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUB = path.join(__dirname, 'public');
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

// ---------- rooms ----------
// code -> { peers: [conn, conn], } ; first joiner = offerer, second = answerer.
const rooms = new Map();

function makeCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += A[crypto.randomInt(A.length)];
  return c;
}

function other(room, conn) {
  return room.peers.find((p) => p !== conn);
}

function send(conn, obj) {
  if (conn && conn.readyState === 1) conn.send(JSON.stringify(obj));
}

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUB, urlPath));
  if (!file.startsWith(PUB + path.sep) && file !== PUB) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  });
}

// ---------- http(s) server ----------
let server;
const certPath = process.env.STRING_CERT;
const keyPath = process.env.STRING_KEY;
if (certPath && keyPath) {
  server = https.createServer(
    { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
    serveStatic
  );
  console.log('[string] HTTPS enabled');
} else {
  server = http.createServer(serveStatic);
}

// ---------- websocket signaling ----------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, sock, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p !== '/signaling') {
    sock.destroy();
    return;
  }
  wss.handleUpgrade(req, sock, head, (ws) => onConn(ws));
});

function onConn(ws) {
  ws.meta = null; // { code, name, role }
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handle(ws, m);
  });

  ws.on('close', () => {
    const meta = ws.meta;
    if (!meta) return;
    const room = rooms.get(meta.code);
    if (!room) return;
    room.peers = room.peers.filter((p) => p !== ws);
    const peer = room.peers[0];
    if (!peer) {
      // last peer gone — nothing to rejoin
      rooms.delete(meta.code);
      return;
    }
    // One peer remains — keep the room rejoinable regardless of who dropped.
    // A page refresh tears down the socket but the survivor can re-offer when the
    // dropped side rejoins with the same code. Promote the survivor to offerer so
    // there is always exactly one offerer; the rejoiner comes back as answerer.
    peer.meta.role = 'offerer';
    send(peer, { t: 'peer-left', rejoinable: true });
    send(peer, { t: 'paired', peerName: null, role: 'offerer' });
  });
}

function handle(ws, m) {
  switch (m.t) {
    case 'join': {
      if (ws.meta) return;
      const name = String(m.name || '').trim().slice(0, 24) || 'you';
      let code = String(m.room || '').trim().toUpperCase();
      if (!code) code = makeCode();
      if (!CODE_RE.test(code)) return send(ws, { t: 'err', code: 'BAD_CODE' });
      let room = rooms.get(code);
      if (!room) {
        room = { peers: [] };
        rooms.set(code, room);
      }
      if (room.peers.length >= 2) return send(ws, { t: 'err', code: 'FULL' });
      const role = room.peers.length === 0 ? 'offerer' : 'answerer';
      ws.meta = { code, name, role };
      room.peers.push(ws);
      send(ws, { t: 'joined', code, role, name });
      if (room.peers.length === 2) {
        const [a, b] = room.peers;
        // a is offerer, b is answerer
        send(a, { t: 'paired', peerName: b.meta.name, role: 'offerer' });
        send(b, { t: 'paired', peerName: a.meta.name, role: 'answerer' });
        console.log(`[string] room ${code} paired: ${a.meta.name} <-> ${b.meta.name}`);
      }
      break;
    }

    case 'signal': {
      if (!ws.meta) return;
      const room = rooms.get(ws.meta.code);
      if (!room) return;
      const peer = other(room, ws);
      if (peer) send(peer, { t: 'signal', d: m.d, from: ws.meta.name });
      break;
    }

    case 'time': {
      // Clock sync: client measures round-trip and derives a server offset so
      // both shutters fire at the same wall-clock instant.
      send(ws, { t: 'time', id: m.id, now: Date.now() });
      break;
    }

    case 'schedule': {
      if (!ws.meta) return;
      const room = rooms.get(ws.meta.code);
      if (!room) return;
      const rid = Number(m.rid) || 0;
      for (const p of room.peers) send(p, { t: 'scheduled', t0: Number(m.t0), rid, by: ws.meta.name });
      break;
    }

    case 'cancel': {
      if (!ws.meta) return;
      const room = rooms.get(ws.meta.code);
      if (!room) return;
      const peer = other(room, ws);
      if (peer) send(peer, { t: 'session-cancel', by: ws.meta.name });
      break;
    }

    case 'leave': {
      // Intentional exit (not a refresh): tear the room down for both sides.
      const meta = ws.meta;
      if (meta) {
        const room = rooms.get(meta.code);
        if (room) {
          const peer = room.peers.find((p) => p !== ws);
          rooms.delete(meta.code);
          if (peer) send(peer, { t: 'room-closed' });
        }
      }
      ws.close();
      break;
    }
  }
}

// liveness sweep: drop dead sockets every 30s
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, HOST, () => {
  const proto = certPath && keyPath ? 'https' : 'http';
  console.log(`[string] ready on ${proto}://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!(certPath && keyPath)) {
    console.log('[string] tip: getUserMedia (camera) needs HTTPS or localhost. See README for hosting.');
  }
});
