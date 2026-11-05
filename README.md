# string

*a photobooth for two, across any distance.*

One countdown. Two faces. A photo strip you both keep.

string pairs two browsers over an encrypted peer-to-peer line. You and your partner
see and hear each other live, a synced 3‑2‑1 fires both shutters four times at the same
instant, and the app prints a classic photobooth strip — your frames and theirs,
side by side — that each of you can download.

## In the booth

Alongside the synced strip, the booth now has:

- **Voice** — two-way audio over the same encrypted peer-to-peer line (mic and speaker
  toggles in the top bar; falls back to video-only if a mic is denied).
- **Reactions** — tap an emoji (❤️ 😘 👋 🥳 😍 🤞) and it floats over your partner's
  video. Sent as one more message kind on the existing data channel — no extra transport.
- **Pose prompts** — a playful prompt per shot ("make heart hands", "best goofy grin"),
  identical on both screens because it's derived from the shared room code + shot time,
  so it needs no negotiation. Toggle with the 🎲 button.
- **Live shot preview** — a rail beside the video fills with each frame as you and your
  partner capture them, so nothing is a mystery until the strip renders.
- **Boomerang** — turn the captured shots into a short forward-and-back clip you can
  download (`.webm`/`.mp4`, rendered on-device with `MediaRecorder`).
- **Start / Stop** — the same button begins the countdown and, mid-run, stops it (for
  both sides) so you can retake.
- **Survives a refresh** — reload your tab and it rejoins the same room automatically
  and recovers the shots you'd already taken (see below).

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

Open the app in two browser windows (or two devices), enter your name, one person
taps **Start a booth** and shares the 5-letter code / link. When both are in, the
booth opens.

> The camera (`getUserMedia`) only works on `localhost` or HTTPS. For two windows
> on one machine, plain `http://localhost:3000` is enough.

## Using it across actual distance

You need HTTPS reachable from both places (browsers require it for cameras):

```bash
# easiest: Caddy in front (auto-TLS)
caddy reverse-proxy --from string.example.com --to :3000

# or local files
STRING_CERT=/path/cert.pem STRING_KEY=/path/key.pem npm start
```

For quick LAN/phone tests, [`mkcert`](https://github.com/FiloSottile/mkcert) gives
you a trusted local cert, e.g. `https://192.168.x.x:3000` opened on both phones.

If both partners sit behind symmetric NATs, direct WebRTC may fail — add a free or
self-hosted TURN relay to the `ICE` config at the top of `public/app.js`.

## How the two of you stay in sync

1. **Both** clients ping the server clock once at pairing (5 samples, median) to
   estimate their offset — not just whoever presses start — so a partner on a very
   different local clock still fires on time.
2. Either partner hits start → the server broadcasts a single `t0` (a server-time
   instant) plus a per-run id to both.
3. Each browser converts `t0` to its own wall clock and schedules the 4 shutters from
   its synced local clock. Accuracy depends on the network path — a few tens of ms on
   a good link, and always well inside the multi-second lead, so the frames line up.
4. Frames are exchanged over the encrypted WebRTC **data channel** and composed into
   the strip locally — so both people end up with the same keepsake.
5. Pressing **Stop** bumps the run id and relays a cancel, so a schedule still in
   flight is ignored and both sides drop back to idle.

## Session survives a refresh

A reload tears down the live connection (the peer connection and WebSocket die with
the tab), so "retaining the session" means fast, lossless **re-establishment**:

- Your name + room code live in `sessionStorage` (scoped to the tab, cleared when you
  close it); on reload the app reconnects to the same code automatically — no retyping.
- The server keeps the room for **either** peer's drop and promotes the survivor to
  offerer, so the partner re-pairs when you come back. Roles re-derive from join order.
- Shots already taken are recovered from on-device IndexedDB into the preview rail, and
  if the strip was finished you get a **View last strip** button.
- Refresh vs. intentional exit is distinguished by an explicit `leave` message: a
  refresh keeps the room, "leave/done" closes it for both.

## Filter modes

| Mode        | Look                                              |
| ----------- | ------------------------------------------------- |
| Retro Color | faded warm cast, lifted blacks, grain, vignette   |
| Retro B&W   | high-contrast monochrome, heavy grain, dark edges |
| Modern      | clean, crisp, lightly saturated                   |
| Duotone     | indigo shadows → cream highlights, printed-ink feel |
| Golden Hour | warm sepia glow with halation bloom               |

Filters are applied at render time — switch them on the strip screen as many
times as you like before downloading.

## Security model

- **Media never touches the server.** Video/audio go peer-to-peer, encrypted with
  DTLS-SRTP (standard WebRTC). Photos cross on an SCTP-encrypted data channel.
- **The server only relays signaling**: join codes, SDP/ICE blobs, clock pings and
  a session start timestamp. It cannot see pictures, and stores nothing — rooms
  live in memory and vanish when both people leave.
- **Codes are single-use** and drawn from a no-lookalike alphabet; rooms hard-cap
  at two people.
- Transport should be TLS (WSS) in real deployments — see hosting above.
- Frames are held in page memory and **mirrored to your own browser's IndexedDB** so a
  refresh can recover them — they never touch the server, and clearing site data
  removes them.

## Architecture

```
server.js          Node + ws: static hosting + signaling (join/pair/signal/time/cancel). Rooms are an in-memory Map — run one instance, or use sticky sessions if you scale
public/index.html  four screens: home → waiting → booth → strip
public/app.js      WebSocket client, WebRTC (video + audio + data channel), clock sync,
                   synced countdown, capture, chunked frame exchange, reactions, pose prompts, live
                   preview rail, Start/Stop, and sessionStorage + IndexedDB resume
public/strip.js    on-device canvas renderer: filters, grain, vignette, duotone LUT,
                   zigzag-cut strip composition, and the MediaRecorder boomerang clip
public/style.css   the paper-and-ink identity
```

## Troubleshooting

- *camera blocked* — allow permission; must be localhost or HTTPS.
- *my column is black in the strip* — your browser had the camera "granted" but
  another app was actually holding the hardware (macOS lets only one app stream
  from the camera; the second gets a live stream of pure black). Free the camera
  (Zoom, Photo Booth, FaceTime, another browser) and reshoot. Current builds
  detect this before the countdown starts and refuse to run.
- *black frames in my column* — browsers stop painting camera video in hidden or
  fully occluded tabs. Keep both windows visible during the countdown. The app
  now retries a missed frame and warns you if your partner's tab goes away.
- *no countdown* — update to the current build (previously a timer-ordering bug);
  the countdown now also ticks in unfocused windows.
- *direct connection failed* — strict NAT both ends; add a TURN server.
- *refreshed and lost the booth* — the current build **keeps the room alive when
  either side's tab drops** (including the one who created it) and auto-rejoins on
  reload, so the line re-establishes itself. An *intentional* "leave/done" still ends
  the room for both.
- *behaviour changed but the app didn't* — the client is re-served from disk on every
  refresh, but the **Node server only picks up `server.js` changes when you restart the
  process.** A stale server against a new client is a classic "still broken after the
  fix." Restart it (and run it under `pm2`/`systemd`) after deploys.

## Ideas for v2

- Custom countdown length / frame count
- QR code + animated "string pulling taut" pairing moment
- Share strip as image message / print-to-PDF with bleed margins
- Extra modes: Polaroid frame, film-strip sprockets, seasonal palettes
- Passphrase-protected rooms
