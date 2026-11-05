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

// Playful pose prompts, shown in sync on both screens (picked from room code + shot time)
const PROMPTS = [
  'biggest fake laugh', 'surprise face', 'make heart hands', 'best goofy grin',
  'wave hello', 'lean in close', 'kiss the camera', 'cool-guy pose',
  'show your pet or plant', 'one eyebrow up', 'air guitar', 'peace sign',
];
const REACTIONS = ['❤️', '😘', '👋', '🥳', '😍', '🤞'];

const S = {
  ws: null, pc: null, dc: null,
  code: '', name: '', peerName: '', role: '',
  localStream: null, micTrack: null,
  own: [], peer: [], parts: new Map(),
  offset: 0, running: false, timers: [], cdInt: 0,
  filter: 'retro', sessionDate: null, autoTries: 0, leaving: false, peerHidden: false,
  micOn: true, soundOn: true, gamesOn: true, t0: 0, promptShown: -1,
  shooting: false, pvUrls: [], runId: 0, initiated: false,
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

/* ---------------- session persistence (survive a page refresh) ---------------- */

const SS_KEY = 'string:session';
function saveSessionMeta() {
  try { sessionStorage.setItem(SS_KEY, JSON.stringify({ name: S.name, code: S.code })); } catch {}
}
function clearSessionMeta() {
  try { sessionStorage.removeItem(SS_KEY); } catch {}
}
function readSessionMeta() {
  try { return JSON.parse(sessionStorage.getItem(SS_KEY) || 'null'); } catch { return null; }
}

// On-device photo store. A refresh tears down WebRTC, but frames already captured
// live here so nothing is lost. Blobs are stored directly (structured clone).
let _dbp = null;
function openDB() {
  if (_dbp) return _dbp;
  _dbp = new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no indexedDB'));
    const rq = indexedDB.open('string', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('sessions', { keyPath: 'code' });
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return _dbp;
}

const dense = (arr) => Array.from({ length: FRAMES }, (_, i) => (arr[i] ? arr[i] : null));

async function storeFrames() {
  if (!S.code) return;
  try {
    const db = await openDB();
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put({
      code: S.code,
      name: S.name,
      peerName: S.peerName,
      date: (S.sessionDate || new Date()).toISOString(),
      filter: S.filter,
      own: dense(S.own),
      peer: dense(S.peer),
    });
  } catch {}
}

async function dropStored() {
  if (!S.code) return;
  try {
    const db = await openDB();
    db.transaction('sessions', 'readwrite').objectStore('sessions').delete(S.code);
  } catch {}
}

async function loadStored(code) {
  try {
    const db = await openDB();
    const rq = db.transaction('sessions', 'readonly').objectStore('sessions').get(code);
    return await new Promise((res) => { rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null); });
  } catch { return null; }
}

/* ---------------- camera ---------------- */

async function ensureCam() {
  if (S.localStream) return true;
  const video = { width: 1280, height: 960, facingMode: 'user' };
  try {
    // Prefer video + audio; fall back to video-only if the mic is denied/blocked
    // so losing the voice feature never blocks the booth.
    try {
      S.localStream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
    } catch (e) {
      S.localStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      S.micOn = false;
    }
    S.micTrack = S.localStream.getAudioTracks()[0] || null;
    if (S.micTrack) S.micTrack.enabled = S.micOn;
    $('#waitVid').srcObject = S.localStream;
    $('#selfVid').srcObject = S.localStream;
    syncMicBtn();
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
      saveSessionMeta();
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
        S.shooting = false;
        updateStartBtn();
        teardownPC();
        return;
      }
      $('#boothNames').textContent = `${S.name} & ${S.peerName}`;
      $('#pipName').textContent = S.peerName;
      setStatus('connecting…');
      await ensureCam();
      screen('booth');
      await setupPC();
      syncClock(); // warm the server-clock offset on BOTH sides, not just who presses Start
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

    case 'scheduled': {
      S.sessionDate = new Date();
      // Only the initiator can cancel its own run; a late schedule from a stopped
      // run carries an old rid and is ignored. The partner (by !== my name) always
      // runs. If the server didn't stamp a rid (older build), don't block the run.
      if (m.by === S.name && m.rid !== undefined && m.rid !== S.runId) return;
      S.initiated = (m.by === S.name);
      runSession(m.t0);
      break;
    }

    case 'session-cancel':
      // the partner stopped the run; tear it down locally (we didn't initiate, so no re-broadcast)
      if (!S.initiated && (S.running || S.shooting)) stopSession();
      break;

    case 'peer-left':
      S.shooting = false;
      updateStartBtn();
      setStatus('your person disconnected — waiting for them to rejoin', 'bad');
      toast(`${S.peerName || 'your partner'} dropped off the line`);
      teardownPC();
      break;

    case 'room-closed':
      clearSessionMeta();
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
  S.shooting = false;
  resetFrames();
  updateStartBtn();
}

async function setupPC() {
  teardownPC();
  const pc = new RTCPeerConnection(ICE);
  S.pc = pc;
  if (S.localStream) for (const trk of S.localStream.getTracks()) pc.addTrack(trk, S.localStream);

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ t: 'signal', d: { cand: e.candidate } });
  };
  pc.ontrack = (e) => {
    const pv = $('#peerVid');
    pv.srcObject = e.streams[0];
    pv.muted = !S.soundOn;
    // Remote audio can be blocked by autoplay policy until a gesture; the button
    // is the reliable unstick path, this is best-effort.
    const p = pv.play && pv.play();
    if (p && p.catch) p.catch(() => {});
    syncSoundBtn();
  };
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
  dc.onopen = () => { updateStartBtn(); };
  dc.onclose = () => { updateStartBtn(); };
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
  if (m.k === 'react') { showReact(m.e); return; }
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
    setThumb('r', p.i, S.peer[p.i]);
    storeFrames();
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
  if (S.shooting || !S.dc || S.dc.readyState !== 'open') return;
  if (S.peerHidden) toast('your partner\'s tab looks hidden — the countdown works best when you both watch your screens');
  S.shooting = true;
  updateStartBtn();
  // preflight: fail fast if this side's camera is dead/black
  if (!(await grabFrame())) {
    S.shooting = false;
    updateStartBtn();
    toast(S.lastGrabFail === 'black'
      ? 'your camera is sending black frames — is another app using it? (macOS allows only one at a time)'
      : 'no camera frame yet — check the camera permission and try again');
    return;
  }
  await syncClock();
  S.runId++;
  S.initiated = true;
  wsSend({ t: 'schedule', t0: syncNow() + LEAD, rid: S.runId });
}

function runSession(t0) {
  if (S.running) return; // already mid-session
  resetFrames();
  dropStored(); // a fresh run starts with no stored photos
  S.running = true; // must come AFTER resetFrames, which clears it
  S.shooting = true; // both sides show the Stop control while the session runs
  updateStartBtn();
  S.t0 = t0;
  S.promptShown = -1;
  screen('booth');

  for (let i = 0; i < FRAMES; i++) {
    const fireLocal = t0 + i * GAP - S.offset; // server time -> local ms
    S.timers.push(setTimeout(() => capture(i), Math.max(0, fireLocal - Date.now())));
  }

  const cd = $('#countdown');
  const tick = () => {
    if (!S.running) { cd.textContent = ''; $('#prompt').textContent = ''; return; }
    const now = syncNow();
    let label = '';
    for (let i = 0; i < FRAMES; i++) {
      const rem = t0 + i * GAP - now;
      if (rem > 0 && rem <= 3000) { label = String(Math.ceil(rem / 1000)); break; }
    }
    cd.textContent = label;
    updatePrompt(now);
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
  setThumb('l', i, blob);
  storeFrames();
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
  S.shooting = false;
  clearTimeout(S.cdInt);
  $('#countdown').textContent = '';
  $('#prompt').textContent = '';
  updateStartBtn();
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
  // keep the live call visible on the results screen (audio still comes from #peerVid)
  const ps = $('#peerVidStrip');
  if (ps) ps.srcObject = $('#peerVid').srcObject;
  const lbl = $('#peerVidStripLabel');
  if (lbl) lbl.textContent = S.peerName || 'your person';
}

function resetFrames() {
  S.own = [];
  S.peer = [];
  S.parts.clear();
  S.timers.forEach(clearTimeout);
  S.timers = [];
  clearTimeout(S.cdInt);
  S.running = false;
  S.promptShown = -1;
  const pr = $('#prompt'); if (pr) pr.textContent = '';
  document.querySelectorAll('#frameDots i').forEach((d) => d.classList.remove('done'));
  revokePreview();
  buildPreview();
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

/* ---------------- voice controls ---------------- */

function syncMicBtn() {
  const b = $('#btnMic');
  if (!b) return;
  const has = !!S.micTrack;
  b.disabled = !has;
  b.classList.toggle('off', !S.micOn || !has);
  b.title = has ? (S.micOn ? 'mute your mic' : 'unmute your mic') : 'no microphone';
}

function toggleMic() {
  if (!S.micTrack) return;
  S.micOn = !S.micOn;
  S.micTrack.enabled = S.micOn;
  syncMicBtn();
}

function syncSoundBtn() {
  const b = $('#btnSound');
  if (!b) return;
  b.classList.toggle('off', !S.soundOn);
  b.title = S.soundOn ? 'mute their audio' : 'unmute their audio';
}

function toggleSound() {
  S.soundOn = !S.soundOn;
  const pv = $('#peerVid');
  pv.muted = !S.soundOn;
  if (S.soundOn) { const p = pv.play && pv.play(); if (p && p.catch) p.catch(() => {}); }
  syncSoundBtn();
}

/* ---------------- reactions (over the DataChannel) ---------------- */

function sendReact(emoji) {
  if (!S.dc || S.dc.readyState !== 'open') return;
  S.dc.send(JSON.stringify({ k: 'react', e: emoji }));
  showReact(emoji);
}

function showReact(emoji) {
  const stage = $('#stage');
  if (!stage) return;
  const b = document.createElement('span');
  b.className = 'react-bubble';
  b.textContent = emoji;
  b.style.left = (12 + Math.random() * 76) + '%';
  stage.appendChild(b);
  setTimeout(() => b.remove(), 2600);
}

/* ---------------- pose prompts (deterministic, no negotiation) ---------------- */

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Both peers hold the identical room code and the identical server t0, so the
// same (code, shot) always maps to the same prompt on both screens — no message needed.
function promptFor(i) {
  const nonce = Math.floor((S.t0 + i * GAP) / 60000);
  return PROMPTS[(hashStr(S.code + ':' + nonce) + i) % PROMPTS.length];
}

function updatePrompt(now) {
  const el = $('#prompt');
  if (!el) return;
  if (!S.gamesOn) { el.textContent = ''; S.promptShown = -1; return; }
  let nextI = -1;
  for (let i = 0; i < FRAMES; i++) { if (S.t0 + i * GAP > now) { nextI = i; break; } }
  if (nextI < 0) { el.textContent = ''; S.promptShown = -1; return; }
  if (nextI !== S.promptShown) {
    el.textContent = 'shot ' + (nextI + 1) + ' of ' + FRAMES + ' — ' + promptFor(nextI);
    S.promptShown = nextI;
  }
}

/* ---------------- boomerang (downloadable clip from the captured frames) ---------------- */

async function downloadBoomerang() {
  const btn = $('#btnBoomerang');
  if (!btn || btn.disabled) return;
  const left = S.own.filter(Boolean), right = S.peer.filter(Boolean);
  if (!left.length) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Making…';
  try {
    const res = await Strip.boomerang({ left, right, filter: S.filter });
    if (!res) { toast('this browser can’t record video — try Chrome or Firefox'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(res.blob);
    a.download = `string-${S.code || 'boomerang'}.${res.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  } catch (e) {
    console.warn('boomerang', e);
    toast('couldn’t make the boomerang this time');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ---------------- shot preview rail ---------------- */

function buildPreview() {
  const box = $('#previewRows');
  if (!box) return;
  box.innerHTML = '';
  for (let i = 0; i < FRAMES; i++) {
    const row = document.createElement('div');
    row.className = 'pv-row';
    row.innerHTML =
      '<span class="pv-n">' + (i + 1) + '</span>' +
      '<div class="pv-cell"><img data-side="l" data-i="' + i + '" alt="your shot ' + (i + 1) + '"></div>' +
      '<div class="pv-cell"><img data-side="r" data-i="' + i + '" alt="their shot ' + (i + 1) + '"></div>';
    box.appendChild(row);
  }
}

function setThumb(side, i, blob) {
  const img = document.querySelector('#previewRows img[data-side="' + side + '"][data-i="' + i + '"]');
  if (!img || !blob) return;
  const url = URL.createObjectURL(blob);
  S.pvUrls.push(url);
  img.src = url;
  img.classList.add('filled');
}

function revokePreview() {
  S.pvUrls.forEach((u) => URL.revokeObjectURL(u));
  S.pvUrls = [];
}

/* ---------------- start / stop ---------------- */

function updateStartBtn() {
  const b = $('#btnStart');
  if (!b) return;
  const open = S.dc && S.dc.readyState === 'open';
  if (S.shooting) {
    b.disabled = false;
    b.classList.add('is-stop');
    b.innerHTML = '<span class="rec"></span> Stop';
  } else {
    b.classList.remove('is-stop');
    b.innerHTML = '<span class="rec"></span> Start the countdown';
    b.disabled = !open;
  }
}

function stopSession() {
  if (!S.shooting) return;
  S.shooting = false;
  S.runId++; // invalidate any schedule still in flight from this run
  if (S.initiated) wsSend({ t: 'cancel' }); // partner stops too
  resetFrames(); // clears timers, frames, dots, prompt — and rebuilds an empty preview
  $('#countdown').textContent = '';
  updateStartBtn();
  toast('stopped — start again whenever you\'re ready');
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
$('#btnStart').onclick = () => { if (S.shooting) stopSession(); else startSession(); };
$('#btnKeepTalk').onclick = () => { screen('booth'); updateStartBtn(); };

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
  S.shooting = false;
  resetFrames();
  screen('booth');
  updateStartBtn();
};

$('#btnMic').onclick = toggleMic;
$('#btnSound').onclick = toggleSound;
$('#btnGames').onclick = toggleGames;
$('#btnBoomerang').onclick = downloadBoomerang;

function toggleGames() {
  S.gamesOn = !S.gamesOn;
  $('#btnGames').classList.toggle('off', !S.gamesOn);
  if (!S.gamesOn) { $('#prompt').textContent = ''; S.promptShown = -1; }
  toast(S.gamesOn ? 'pose prompts on' : 'pose prompts off');
}

// reaction bar
{
  const bar = $('#reacts');
  for (const e of REACTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'react';
    b.textContent = e;
    b.setAttribute('aria-label', 'send reaction');
    b.onclick = () => sendReact(e);
    bar.appendChild(b);
  }
}

for (const id of ['#btnHome1', '#btnHome2', '#btnHome3']) {
  $(id).onclick = () => {
    S.leaving = true;
    wsSend({ t: 'leave' }); // intentional exit — server tears the room down for both
    clearSessionMeta();
    dropStored();
    location.href = '/';
  };
}

$('#btnResumeStrip').onclick = () => screen('strip');

// resume a session across a page refresh (same tab)
{
  const urlCode = (new URLSearchParams(location.search).get('c') || '').toUpperCase();
  const saved = readSessionMeta();
  const code = CODE_RE.test(urlCode) ? urlCode : (saved && CODE_RE.test(saved.code) ? saved.code : '');
  const name = saved && saved.name ? saved.name : '';
  if (code) $('#inCode').value = code;
  if (name) $('#inName').value = name;
  if (code && name) {
    const b = $('#resumeBanner');
    if (b) b.classList.add('show');
    connect(name, code); // rejoin the same room automatically
    restore(code); // pull back any photos captured before the reload
  } else {
    $('#inName').focus();
  }
}

async function restore(code) {
  const rec = await loadStored(code);
  if (!rec) return;
  if (rec.name) S.name = rec.name;
  if (rec.peerName) S.peerName = rec.peerName;
  if (rec.filter) S.filter = rec.filter;
  if (rec.date) S.sessionDate = new Date(rec.date);
  if (Array.isArray(rec.own)) rec.own.forEach((b, i) => { if (b) { S.own[i] = b; setThumb('l', i, b); } });
  if (Array.isArray(rec.peer)) rec.peer.forEach((b, i) => { if (b) { S.peer[i] = b; setThumb('r', i, b); } });
  if (framesReady()) {
    await renderStrip();
    const btn = $('#btnResumeStrip');
    if (btn) btn.hidden = false;
  }
}

buildChips();
buildPreview();
updateStartBtn();
