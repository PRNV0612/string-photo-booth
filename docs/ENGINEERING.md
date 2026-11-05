# string — the engineering walkthrough

How a long-distance photobooth actually works, layer by layer: what protocol
carries each byte, why it was chosen, what the alternatives were, and where the
code lives.

```
Files:
  server.js            Node + ws: static hosting + signaling (no media, no storage)
  public/app.js        client: rooms, WebRTC, clock sync, countdown, capture, frame exchange
  public/strip.js      on-device Canvas 2D: filters + strip composition
  public/index.html    4 screens: home → waiting → booth → strip
  public/style.css     paper-and-ink identity
```

---

## 0. The problem decomposition

Two browsers, different cities, must:

| Need | Chosen mechanism |
|---|---|
| Find each other | WebSocket signaling + 5-char room code |
| See each other live | WebRTC media (DTLS-SRTP) |
| Shoot at the same instant | NTP-style clock sync + pre-scheduled t0 |
| Hand each other the photos | WebRTC DataChannel (SCTP over DTLS) |
| Print the strip | Canvas 2D, on-device |

Everything else in this doc is the consequence of those five lines.

---

## 1. Transport & serving

**One port, two protocols.** `server.js` is plain Node: `http.createServer`
serves `public/` (safe path join + MIME map, `server.js:44-76`), and an
`upgrade` listener hands `GET /signaling` to a `WebSocketServer`
(`server.js:196-206`, `ws` library, the project's only dependency).

Why not Express/Fastify? A photobooth client is 4 static files. A framework
buys router middleware you don't need and hides the upgrade plumbing you *do*
need. Optional TLS is two env vars (`STRING_CERT/STRING_KEY`).

---

## 2. Discovery & signaling — WebSocket (RFC 6455)

**What flows:** JSON messages `join`, `joined`, `paired`, `signal`, `time`,
`schedule`, `scheduled` — all handled in `server.js:139-190`.

**Room model:** `code → { peers: [socket, socket] }` in memory
(`server.js:16`). First joiner becomes the **offerer** (the WebRTC side that
creates the DataChannel), second becomes **answerer**. Codes come from a
no-lookalike 31-char alphabet (`ABCDEFGHJKMNPQRSTUVWXYZ23456789` → ~28.6M
combinations), rooms hard-cap at two people, and the room is destroyed when
the offerer leaves (`server.js:112-135`) — so codes are effectively single-use.

**Why WebSocket over the alternatives:**

- **HTTP long-poll / Socket.IO**: Socket.IO's fallback engine (XHR polling,
  heartbeats, rooms, reconnection) duplicates what we just wrote in ~60 lines,
  and every modern browser has had WS since 2012. We don't need the fallbacks.
- **SSE (Server-Sent Events)**: one-way. Clients would need a second POST
  channel; two transports for one conversation is worse than one WS.
- **MQTT / XMPP / NATS**: brokers solve many-to-many fan-out and presence.
  We have exactly two subscribers per topic and a trivial presence model.
  The operational surface (broker deploy, ACLs, retained messages) isn't
  justified.
- **No server at all (pure WebRTC)**: impossible. WebRTC requires exchanging
  SDP offers and ICE candidates over *some* prior channel. The signaling
  server is a WebRTC tax — the design goal is to make the tax as blind as
  possible, which it is (§4).

**Security notes (honest limits):**

- Use WSS (TLS) in production; the code auto-switches `ws://`/`wss://` from
  `location.protocol` (`app.js connect()`).
- The server relays SDP/ICE as opaque blobs — it cannot decrypt media — but
  ICE candidates *do* reveal each peer's public/local IPs to the other peer
  (that's how NAT traversal works) and transit the server. Anyone who claims
  "WebRTC hides your IP" is selling something.
- MITM of the signaling channel would let an attacker substitute their own SDP.
  WebRTC defends this with the DTLS certificate fingerprint pinned inside SDP:
  each peer verifies the handshake key against the fingerprint relayed at
  `paired`-time. A tampering server breaks the fingerprint check, and the
  connection fails rather than leaking.

---

## 3. Live video — WebRTC (DTLS-SRTP) & ICE (RFC 8843/8445)

**Why not stream video over the WebSocket?** Because then every pixel passes
through a server that must (a) pay bandwidth, (b) add latency, and (c) *see the
couples' faces* — fatal for the privacy promise. WebRTC puts media directly
between browsers.

**The negotiation** (`app.js setupPC()`, `onMsg('signal')`):

1. Offerer: `createDataChannel('strip')` → `createOffer()` → SDP out via ws.
2. Answerer: `setRemoteDescription(offer)` → `createAnswer()` → SDP back.
3. Both trickle ICE candidates through the same `signal` relay.
4. ICE picks a candidate pair (host → srflx → relay), DTLS handshakes,
   SRTP keys are derived, video flows.

**STUN** (`stun.l.google.com:19302`, `app.js:11`): a UDP service answering
"what source address does my packet arrive from?" — i.e., your NAT's public
mapping. It never touches media; if STUN is down, host (LAN) candidates still
let same-network pairs connect.

**TURN** is deliberately *not* configured: a relay server sees encrypted media
but costs money and bandwidth. The README documents adding one as the
escape hatch for symmetric-NAT pairs; `connectionState === 'failed'` fires a
toast naming exactly that remedy (`app.js setupPC()`).

**Why not an SFU (LiveKit/mediasoup/jitsi)?** SFUs exist to multipoint:
N subscribers, recording, bandwidth fairness. A couple is a mesh of size two;
P2P is strictly better (latency, cost, privacy). Revisit only if you add
video calls with more participants.

**Why not libdatachannel/native or react-native-webrtc?** The user asked for
a web app; browsers already ship the whole stack.

---

## 4. Same-instant shutters — NTP math over the channel you already have

The hardest engineering problem in the app, and the code is ~30 lines.

**The naive approach fails:** partner presses start → server broadcasts
"capture now!" → each side fires. WS delivery jitter (10–100 ms) plus
independent event loops means shutters land up to ~200 ms apart — visible as
one partner mid-blink while the other is smiling.

**What we do instead** (`app.js syncClock()`, `startSession()`, `runSession()`):

1. **Clock sync, NTP-style.** Client sends 5 `time` pings; for each reply it
   computes `offset = serverNow − (tSend + tRecv)/2` — exactly NTP's clock
   offset estimator — and takes the **median** (robust to one jittery sample).
   `syncNow() = Date.now() + offset` estimates the server clock locally.
2. **Pre-schedule.** The starter computes `t0 = syncNow() + 6000` and sends
   `schedule{t0}`. Server broadcasts `scheduled{t0}` (server-clock time) to
   both (`server.js:181-187`).
3. **Local derivation.** Each side converts each shutter's server instant to
   local ms: `fireLocal = t0 + i·4000 − offset` and arms plain `setTimeout`s.
   Both clocks agree to within the sync error (~±30–80 ms on WAN), so four
   shutters fire ~simultaneously.

**Alternatives considered:** RTCP timestamps (no shared wall clock), GPS/NTP
directly (browsers can't do UDP NTP; `performance.now()` isn't wall time),
"sender sends photo after capture" (kills simultaneity), server-driven frame
events (jitter again). Precision is *deliberately* modest: a photobooth pose
tolerates ±50 ms; a lip-sync app would need PTP or audio clocks.

**Countdown rendering** is a `setTimeout` chain, not `requestAnimationFrame` —
rAF is *paused entirely* in unfocused windows, which would freeze the 3·2·1
the moment you alt-tabbed to check your partner's side. (This was an actual
bug in v1; the fix is annotated in `runSession()`.)

---

## 5. Photo exchange — SCTP DataChannel over DTLS (RFC 8831/8832)

Captured JPEGs (640×480, q0.92, ~40–80 KB) must reach the other side.

**Why not upload to the server and share a URL?** Same three reasons as video:
privacy, cost, storage duty. The DataChannel is already multiplexed onto the
*same UDP port and DTLS session* as the video — authenticated, encrypted,
server-blind.

**Protocol on the channel** (`app.js sendFrame()` / `onFrameMsg()`):

```
{ k:'m', id:'offerer:0', i }        meta: frame index
{ k:'c', id, b:<base64 16 KB> }     repeated chunks
{ k:'e', id }                        end → reassemble Blob
```

- 16 KB chunks because browser SCTP message limits historically ranged 64–256 KB
  and vary per platform; 16 KB is universally safe with headroom.
- The channel is `ordered: true` (SCTP reliable-stream mode), so chunk order
  is guaranteed — no sequence numbers needed.
- IDs are role-prefixed (`offerer:`/`answerer:`) so two people named "Alex"
  can't collide.

**Alternatives:** WebSocket transfer (breaks the privacy model), WebTransport
(QUIC; great future path, needs an HTTPS server with h3 and is less universal
in 2026 browsers), blob URL sharing via signaling (base64 in JSON over ws =
server sees photos — never).

---

## 6. The strip — Canvas 2D, on-device

`strip.js` composes 8 cells + header/footer into one 872×1468 canvas:

- **Tone**: `ctx.filter = 'sepia(0.26) contrast(0.92) …'` — the CSS filter
  shorthand applied to `drawImage`. Free in Chrome/Firefox/Safari ≥18.
- **Duotone**: per-pixel luminance LUT via `getImageData` mapping shadows→
  indigo, highlights→cream (`duotoneLUT()`).
- **Warm cast / lifted blacks / halation**: `globalCompositeOperation`
  (`overlay`, `lighter`, `screen`) fills over the clipped cell.
- **Grain**: a pre-generated 160×160 noise tile used as a `createPattern`
  fill — drawn *last*, over the vignette, like real film (also dodges a
  node-canvas Cairo quirk discovered in testing).
- **Paper edge**: a zigzag `Path2D` clip top and bottom — the tear you'd get
  from a mall photolab.

Filters are applied at **render time** from raw frames, so switching modes
re-composites instantly without re-shooting.

**Why not WebGL/GPU?** Eight 640×480 stills is trivial CPU work (~50 ms).
WebGL earns its complexity for *live* filtered video; we filter stills only.
**Why not server-side composition?** Privacy + the server would need image
libs and storage. **Why not CSS screenshots?** Canvas is the only path to a
pixel-identical downloadable PNG.

---

## 7. Capture robustness (bugs that became features)

- **Hidden-tab black frames**: browsers stop painting camera video in hidden
  tabs. `grabFrame()` now waits for a decodable frame (`waitFrame()`),
  retries a missed shot 3×, and refuses to run a session whose feed is dead
  (`startSession()` preflight).
- **Occupied-camera black feeds**: macOS lets one app hold the camera; the
  second gets a *valid stream of black pixels*. Per-frame luminance sampling
  in `grabFrame()` rejects it with an explicit toast.
- **Presence**: `visibilitychange` sends `{k:'v',hidden}` over the DataChannel;
  each side is told when the partner leaves the screen.

---

## 8. Security model — summary table

| Threat | Mitigation |
|---|---|
| Passive server | Media/photos never transit it (P2P only) |
| Signaling MITM | DTLS fingerprint pinned in SDP fails the handshake on tamper |
| Room guessing | 28.6M codes, single-use semantics, hard cap of 2 |
| Data retention | Zero storage; frames live in page memory only |
| DoS on rooms | ws ping/pong sweep drops dead sockets (`server.js:208-218`) |
| Eavesdropping on wire | WSS + DTLS-SRTP; TLS deployment documented |
| **Known limit** | ICE candidates expose peer IPs (inherent to WebRTC) |
| **Known limit** | No authentication — a code leak = a booth-crasher (v2: passphrase) |

---

## 9. How it was verified (the toolchain)

| Gate | Tool | What it proves |
|---|---|---|
| Syntax | `node --check` | parse-level correctness of all JS |
| Protocol | custom ws smoke tests (2 fake clients) | join/roles/pair/time/schedule + FULL/peer-left/room-closed edge paths |
| Rendering | node-canvas harness | strip layout, all 5 filters, no runtime errors |
| End-to-end | two headless Chrome instances + CDP, `--use-fake-device-for-media-stream` | real pairing, countdown visible both sides, 4+4 frames exchanged, strips mirrored, black-feed guard fires |
| Diagrams | archify (sequence + architecture, showcase gates incl. real-browser check) | this doc's visuals |
| Structure map | graphify (tree-sitter AST knowledge graph) | hub functions (`onMsg`, `capture`), community boundaries |
