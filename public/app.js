// string — client: rooms, WebRTC pairing, synced countdown, frame exchange
'use strict';

const $ = (s) => document.querySelector(s);

const CODE_RE = /^[A-Z2-9]{5}$/;
const FRAMES = 4;      // frames per strip
const GAP = 4000;      // ms between shutters
const LEAD = 6000;     // ms from "start" to first shutter
const ICE = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

const S = {
  ws: null, pc: null, dc: null,
  code: '', name: '', peerName: '', role: '',
  localStream: null,
  own: [], peer: [], parts: new Map(),
  offset: 0, running: false, timers: [], cdInt: 0,
  filter: 'retro', sessionDate: null, autoTries: 0, leaving: false, peerHidden: false,
};

/* ---------------- helpers ---------------- */

function screen(id) {
  document.querySelectorAll('.scr').forEach((e) => e.classList.toggle('on', e.id === 'scr-' + id));
}

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 3400);
}

function wsSend(o) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o));
}

function setStatus(txt, cls) {
  const el = $('#linkStatus');
  el.textContent = txt;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

function genCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += A[Math.floor(Math.random() * A.length)];
  return c;
}

/* ---------------- camera ---------------- */

async function ensureCam() {
  if (S.localStream) return true;
  try {
    S.localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 960, facingMode: 'user' },
      audio: false,
    });
    $('#waitVid').srcObject = S.localStream;
    $('#selfVid').srcObject = S.localStream;
    return true;
  } catch {
    toast('camera blocked — allow access in your browser, then try again');
    return false;
  }
}

/* ---------------- signaling ---------------- */

function connect(name, code) {
  S.name = name;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/signaling');
  S.ws = ws;
  ws.onopen = () => wsSend({ t: 'join', room: code, name });
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    onMsg(m);
  };
  ws.onclose = () => {
    if (S.leaving) return;
    if (S.code && !S.running) toast('lost the thread — refresh to start a new booth');
  };
}

async function onMsg(m) {
  switch (m.t) {
    case 'joined':
      S.code = m.code;
      S.role = m.role;
      screen('wait');
      $('#bigCode').textContent = m.code;
      $('#shareLink').value = location.origin + '/?c=' + m.code;
      break;

    case 'paired': {
      S.peerName = m.peerName || '';
      S.role = m.role;
      if (!S.peerName) {
        // partner dropped; room kept open for their return
        setStatus('waiting for your person to rejoin…', 'bad');
        $('#btnStart').disabled = true;
        teardownPC();
        return;
      }
      $('#boothNames').textContent = `${S.name} & ${S.peerName}`;
      $('#pipName').textContent = S.peerName;
      setStatus('connecting…');
      await ensureCam();
      screen('booth');
      await setupPC();
      break;
    }

    case 'signal': {
      if (!S.pc) return;
      const d = m.d || {};
      try {
        if (d.sdp) {
          await S.pc.setRemoteDescription(d.sdp);
          if (d.sdp.type === 'offer') {
            const ans = await S.pc.createAnswer();
            await S.pc.setLocalDescription(ans);
            wsSend({ t: 'signal', d: { sdp: S.pc.localDescription } });
          }
        } else if (d.cand) {
          await S.pc.addIceCandidate(d.cand);
        }
      } catch (e) {
        console.warn('signal', e);
      }
      break;
    }

    case 'time':
      handleTime(m);
      break;

    case 'scheduled':
      S.sessionDate = new Date();
      runSession(m.t0);
      break;

    case 'peer-left':
      $('#btnStart').disabled = true;
      setStatus('your person disconnected — waiting for them to rejoin', 'bad');
      toast(`${S.peerName || 'your partner'} dropped off the line`);
      teardownPC();
      break;

    case 'room-closed':
      teardownPC();
      screen('home');
      toast('your partner ended the session — start a new booth anytime');
      break;

    case 'err':
      if (m.code === 'FULL' && S.autoTries < 4) {
        S.autoTries++;
        setTimeout(() => connect(S.name, genCode()), 300); // auto-generated code collided
      } else if (m.code === 'BAD_CODE') {
        toast('that code looks off — 5 letters and digits');
      } else {
        toast('that booth is already full');
      }
      break;
  }
}

/* ---------------- WebRTC ---------------- */

function teardownPC() {
  try { S.dc && S.dc.close(); } catch {}
  try { S.pc && S.pc.close(); } catch {}
  S.dc = S.pc = null;
  resetFrames();
}

async function setupPC() {
  teardownPC();
  const pc = new RTCPeerConnection(ICE);
  S.pc = pc;
  if (S.localStream) for (const trk of S.localStream.getTracks()) pc.addTrack(trk, S.localStream);

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ t: 'signal', d: { cand: e.candidate } });
  };
  pc.ontrack = (e) => { $('#peerVid').srcObject = e.streams[0]; };
  pc.ondatachannel = (e) => setupDC(e.channel);
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') setStatus('connected — encrypted line', 'ok');
    else if (st === 'disconnected') setStatus('reconnecting…', 'bad');
    else if (st === 'failed') {
      setStatus('direct connection failed', 'bad');
      toast('you both sit behind strict networks — a TURN relay is needed (see README)');
    }
  };

  if (S.role === 'offerer') {
    setupDC(pc.createDataChannel('strip', { ordered: true }));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({ t: 'signal', d: { sdp: pc.localDescription } });
  }
}

function setupDC(dc) {
  S.dc = dc;
  dc.onopen = () => { $('#btnStart').disabled = S.running; };
  dc.onclose = () => { $('#btnStart').disabled = true; };
  dc.onmessage = (e) => onFrameMsg(e.data);
}

/* ---------------- frame exchange (chunked, P2P) ---------------- */

function b64enc(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64dec(str) {
  const bin = atob(str);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

async function sendFrame(i, blob) {
  if (!S.dc || S.dc.readyState !== 'open') return;
  const id = (S.role || 'x') + ':' + i; // role is unique per side, unlike names
  const buf = new Uint8Array(await blob.arrayBuffer());
  S.dc.send(JSON.stringify({ k: 'm', id, i }));
  const CH = 16384;
  for (let p = 0; p < buf.length; p += CH) {
    S.dc.send(JSON.stringify({ k: 'c', id, b: b64enc(buf.subarray(p, p + CH)) }));
  }
  S.dc.send(JSON.stringify({ k: 'e', id }));
}

function onFrameMsg(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (m.k === 'v') {
    S.peerHidden = !!m.hidden;
    toast(S.peerHidden
      ? 'your partner\'s screen went away — ask them to come back'
      : 'your partner is back');
    return;
  }
  if (m.k === 'm') S.parts.set(m.id, { i: m.i, chunks: [] });
  else if (m.k === 'c') { const p = S.parts.get(m.id); if (p) p.chunks.push(b64dec(m.b)); }
  else if (m.k === 'e') {
    const p = S.parts.get(m.id);
    if (!p) return;
    S.parts.delete(m.id);
    S.peer[p.i] = new Blob(p.chunks, { type: 'image/jpeg' });
    checkComplete();
  }
}

/* ---------------- clock sync + synced session ---------------- */

let clockJob = null;

function handleTime(m) {
  if (!clockJob) return;
  const before = clockJob.pend.get(m.id);
  if (before === undefined) return;
  clockJob.pend.delete(m.id);
  clockJob.samples.push(m.now - (before + Date.now()) / 2);
  if (clockJob.samples.length >= clockJob.N) clockJob.finish();
}

function syncClock() {
  return new Promise((resolve) => {
    const job = { pend: new Map(), samples: [], N: 5, finish, to: 0 };
    function finish() {
      if (clockJob !== job) return;
      clockJob = null;
      clearTimeout(job.to);
      if (job.samples.length) {
        job.samples.sort((a, b) => a - b);
        S.offset = job.samples[Math.floor(job.samples.length / 2)];
      }
      resolve();
    }
    clockJob = job;
    job.to = setTimeout(finish, 1600);
    for (let i = 0; i < job.N; i++) {
      setTimeout(() => {
        if (clockJob !== job) return;
        const id = Math.random().toString(36).slice(2, 9);
        job.pend.set(id, Date.now());
        wsSend({ t: 'time', id });
      }, i * 90);
    }
  });
}

const syncNow = () => Date.now() + S.offset;

async function startSession() {
  if (S.running || !S.dc || S.dc.readyState !== 'open') return;
  if (S.peerHidden) toast('your partner\'s tab looks hidden — the countdown works best when you both watch your screens');
  $('#btnStart').disabled = true;
  // preflight: fail fast if this side's camera is dead/black
  if (!(await grabFrame())) {
    toast(S.lastGrabFail === 'black'
      ? 'your camera is sending black frames — is another app using it? (macOS allows only one at a time)'
      : 'no camera frame yet — check the camera permission and try again');
    $('#btnStart').disabled = false;
    return;
  }
  await syncClock();
  wsSend({ t: 'schedule', t0: syncNow() + LEAD });
}

function runSession(t0) {
  if (S.running) return;
  resetFrames();
  S.running = true; // must come AFTER resetFrames, which clears it
  screen('booth');

  for (let i = 0; i < FRAMES; i++) {
    const fireLocal = t0 + i * GAP - S.offset; // server time -> local ms
    S.timers.push(setTimeout(() => capture(i), Math.max(0, fireLocal - Date.now())));
  }

  const cd = $('#countdown');
  const tick = () => {
    if (!S.running) { cd.textContent = ''; return; }
    const now = syncNow();
    let label = '';
    for (let i = 0; i < FRAMES; i++) {
      const rem = t0 + i * GAP - now;
      if (rem > 0 && rem <= 3000) { label = String(Math.ceil(rem / 1000)); break; }
    }
    cd.textContent = label;
    // setTimeout chain instead of rAF: keeps ticking in unfocused windows,
    // where requestAnimationFrame is paused entirely
    S.cdInt = setTimeout(tick, 120);
  };
  tick();
}

/* ---------------- capture ---------------- */

function videoReady(v) {
  return v.readyState >= 2 && v.videoWidth > 0;
}

function waitFrame(v, ms) {
  if (videoReady(v)) return Promise.resolve(true);
  return new Promise((res) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      v.removeEventListener('timeupdate', onT);
      clearTimeout(to);
      res(videoReady(v));
    };
    const onT = finish;
    v.addEventListener('timeupdate', onT);
    const to = setTimeout(finish, ms || 1400);
  });
}

async function grabFrame() {
  const v = $('#selfVid');
  if (!(await waitFrame(v))) { S.lastGrabFail = 'noframe'; return null; } // no decodable frame — caller retries
  const c = document.createElement('canvas');
  c.width = 640; c.height = 480;
  const g = c.getContext('2d', { willReadFrequently: true });
  const vw = v.videoWidth, vh = v.videoHeight;
  const s = Math.max(c.width / vw, c.height / vh);
  const w = vw * s, h = vh * s;
  g.drawImage(v, (c.width - w) / 2, (c.height - h) / 2, w, h);
  // Detect a dead feed: macOS hands a second camera-hungry app a "live" track
  // of pure black frames. Treat that like a missed frame so we warn instead of
  // silently printing a black column.
  const px = g.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, n = 0;
  for (let y = 4; y < c.height; y += 16) {
    for (let x = 4; x < c.width; x += 16) {
      const i = (y * c.width + x) * 4;
      sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      n++;
    }
  }
  if (sum / n < 8) { S.lastGrabFail = 'black'; return null; } // pitch-black capture
  S.lastGrabFail = null;
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
}

async function capture(i, attempt) {
  attempt = attempt || 0;
  if (!S.running) return;
  const blob = await grabFrame();
  if (!blob) {
    if (S.lastGrabFail === 'black') toast('your camera is sending a black image — is another app using it?');
    else if (document.hidden) toast('come back to this tab — the camera pauses when it is hidden');
    if (attempt < 2) {
      S.timers.push(setTimeout(() => capture(i, attempt + 1), 500));
      return;
    }
    giveUpSession();
    return;
  }
  S.own[i] = blob;
  document.querySelectorAll('#frameDots i')[i].classList.add('done');
  flash();
  shutter();
  sendFrame(i, blob);
  if (S.own.filter(Boolean).length === FRAMES) {
    endSession();
    checkComplete();
  }
}

function endSession() {
  S.running = false;
  clearTimeout(S.cdInt);
  $('#countdown').textContent = '';
}

function giveUpSession() {
  endSession();
  toast(S.lastGrabFail === 'black'
    ? 'your camera keeps producing black frames — on macOS only one app can use it at a time: close Zoom/Photo Booth/other browsers, or check your light, then shoot again'
    : 'a frame was missed — keep both screens visible and shoot again');
  $('#btnStart').disabled = !(S.dc && S.dc.readyState === 'open');
}

function flash() {
  const f = $('#flash');
  f.classList.add('go');
  setTimeout(() => f.classList.remove('go'), 70);
}

let AC;
function shutter() {
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    const n = Math.floor(AC.sampleRate * 0.06);
    const buf = AC.createBuffer(1, n, AC.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = AC.createBufferSource();
    src.buffer = buf;
    const f = AC.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2200;
    const gain = AC.createGain();
    gain.gain.value = 0.5;
    src.connect(f).connect(gain).connect(AC.destination);
    src.start();
  } catch {}
}

/* ---------------- strip ---------------- */

function framesReady() {
  return S.own.filter(Boolean).length === FRAMES && S.peer.filter(Boolean).length === FRAMES;
}

function checkComplete() {
  if (!framesReady()) return;
  setTimeout(async () => {
    screen('strip');
    await renderStrip();
  }, 900);
}

async function renderStrip() {
  const canvas = await Strip.render({
    left: S.own.filter(Boolean),
    right: S.peer.filter(Boolean),
    filter: S.filter,
    leftName: S.name,
    rightName: S.peerName,
    date: S.sessionDate || new Date(),
  });
  const holder = $('#stripHolder');
  holder.innerHTML = '';
  holder.appendChild(canvas);
}

function resetFrames() {
  S.own = [];
  S.peer = [];
  S.parts.clear();
  S.timers.forEach(clearTimeout);
  S.timers = [];
  clearTimeout(S.cdInt);
  S.running = false;
  document.querySelectorAll('#frameDots i').forEach((d) => d.classList.remove('done'));
}

/* ---------------- filter chips ---------------- */

function buildChips() {
  for (const sel of ['#filterChips', '#filterChips2']) {
    const box = $(sel);
    box.innerHTML = '';
    for (const [key, label] of Object.entries(Strip.FILTERS)) {
      const b = document.createElement('button');
      b.className = 'chip' + (key === S.filter ? ' on' : '');
      b.textContent = label;
      b.onclick = async () => {
        S.filter = key;
        document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.textContent === label));
        if (framesReady()) await renderStrip();
      };
      box.appendChild(b);
    }
  }
}

/* ---------------- wiring ---------------- */

document.addEventListener('visibilitychange', () => {
  if (S.dc && S.dc.readyState === 'open') {
    S.dc.send(JSON.stringify({ k: 'v', hidden: document.hidden }));
  }
});

$('#btnCreate').onclick = async () => {
  const name = $('#inName').value.trim();
  if (!name) { toast('tell us your name first'); return; }
  if (!(await ensureCam())) return;
  connect(name, genCode());
};

$('#btnJoin').onclick = async () => {
  const name = $('#inName').value.trim();
  const code = $('#inCode').value.trim().toUpperCase();
  if (!name) { toast('tell us your name first'); return; }
  if (!CODE_RE.test(code)) { toast('that code looks off — 5 letters and digits'); return; }
  if (!(await ensureCam())) return;
  connect(name, code);
};

$('#inCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoin').click(); });
$('#btnStart').onclick = startSession;

$('#btnCopy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('#shareLink').value);
    toast('link copied — send it to your person');
  } catch {
    $('#shareLink').select();
    toast('select and copy the link');
  }
};

$('#btnDownload').onclick = () => {
  const c = $('#stripHolder canvas');
  if (!c) return;
  c.toBlob((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `string-${S.code || 'strip'}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
};

$('#btnAgain').onclick = () => {
  resetFrames();
  screen('booth');
  $('#btnStart').disabled = !(S.dc && S.dc.readyState === 'open');
};

for (const id of ['#btnHome1', '#btnHome2', '#btnHome3']) {
  $(id).onclick = () => { S.leaving = true; location.href = '/'; };
}

// prefill code from ?c=CODE share links
{
  const c = (new URLSearchParams(location.search).get('c') || '').toUpperCase();
  if (CODE_RE.test(c)) {
    $('#inCode').value = c;
    $('#inName').focus();
  } else {
    $('#inName').focus();
  }
}

buildChips();
