# string

*a photobooth for two, across any distance.*

One countdown. Two faces. A photo strip you both keep.

string pairs two browsers over an encrypted peer-to-peer line. You and your partner
see each other live, a synced 3‑2‑1 fires both shutters four times at the same
instant, and the app prints a classic photobooth strip — your frames and theirs,
side by side — that each of you can download.

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

1. Each client pings the server clock (5 samples, median) to estimate its offset.
2. Either partner hits start → the server broadcasts `t0` to both.
3. Both browsers schedule the 4 shutters from their synced local clocks (~±30 ms).
4. Frames are exchanged over the encrypted WebRTC **data channel** and composed
   into the strip locally — so both people end up with the same keepsake.

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
- Frames are ephemeral: held in page memory only, gone on refresh.

## Architecture

```
server.js          Node + ws: static hosting + signaling (join/pair/signal/time/schedule)
public/index.html  four screens: home → waiting → booth → strip
public/app.js      WebSocket client, WebRTC (video + data channel), clock sync,
                   synced countdown, capture, chunked frame exchange
public/strip.js    on-device canvas renderer: filters, grain, vignette, duotone LUT,
                   zigzag-cut strip composition
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
- *partner rejoined but no video* — the booth renegotiates automatically; if the
  offerer closed the tab, the room is gone and a new code is needed.

## Ideas for v2

- Custom countdown length / frame count
- QR code + animated "string pulling taut" pairing moment
- Share strip as image message / print-to-PDF with bleed margins
- Extra modes: Polaroid frame, film-strip sprockets, seasonal palettes
- Passphrase-protected rooms
