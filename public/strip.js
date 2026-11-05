// string — photo strip renderer with filter modes
// All processing happens on-device from frames received peer-to-peer.
'use strict';

const Strip = (() => {
  const FILTERS = {
    retro: 'Retro Color',
    bw: 'Retro B&W',
    modern: 'Modern',
    duotone: 'Duotone',
    golden: 'Golden Hour',
  };

  const CSS = {
    retro: 'brightness(1.05) contrast(0.92) saturate(0.8) sepia(0.26)',
    bw: 'grayscale(1) contrast(1.24) brightness(0.97)',
    modern: 'contrast(1.07) saturate(1.06) brightness(1.01)',
    duotone: 'grayscale(1) contrast(1.12)',
    golden: 'sepia(0.3) saturate(1.28) brightness(1.05) contrast(0.98)',
  };

  const GRAIN_A = { retro: 0.07, bw: 0.13, modern: 0.02, duotone: 0.05, golden: 0.05 };
  const VIG_A = { retro: 0.3, bw: 0.48, modern: 0.07, duotone: 0.16, golden: 0.2 };

  const PAPER = '#fbf7ee';
  const INK = '#191714';
  const SOFT = '#5c564c';
  const RED = '#d9482b';

  let grainTile = null;
  function getGrain() {
    if (grainTile) return grainTile;
    const c = document.createElement('canvas');
    c.width = c.height = 160;
    const g = c.getContext('2d');
    const img = g.createImageData(160, 160);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + (Math.random() * 2 - 1) * 110;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    grainTile = c;
    return c;
  }

  function hex(c) {
    return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  }

  function duotoneLUT(g, x, y, w, h, dark, light) {
    const d = hex(dark), l = hex(light);
    const reg = g.getImageData(x, y, w, h);
    const p = reg.data;
    for (let i = 0; i < p.length; i += 4) {
      const lum = (0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) / 255;
      p[i] = d[0] + (l[0] - d[0]) * lum;
      p[i + 1] = d[1] + (l[1] - d[1]) * lum;
      p[i + 2] = d[2] + (l[2] - d[2]) * lum;
    }
    g.putImageData(reg, x, y);
  }

  async function drawFrame(g, blob, x, y, w, h, filter) {
    const img = await createImageBitmap(blob);
    const s = Math.max(w / img.width, h / img.height);
    const dw = img.width * s, dh = img.height * s;
    const dx = x - (dw - w) / 2, dy = y - (dh - h) / 2;

    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();

    g.filter = CSS[filter] || 'none';
    g.drawImage(img, dx, dy, dw, dh);
    g.filter = 'none';

    if (filter === 'golden') {
      // halation: soft screen-blown glow
      g.globalCompositeOperation = 'screen';
      g.globalAlpha = 0.22;
      g.filter = 'blur(9px) brightness(1.15)';
      g.drawImage(img, dx, dy, dw, dh);
      g.filter = 'none';
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }
    if (filter === 'retro') {
      // warm cast + lifted blacks, like faded lab prints
      g.globalCompositeOperation = 'overlay';
      g.fillStyle = 'rgba(255,160,70,0.16)';
      g.fillRect(x, y, w, h);
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = 'rgba(255,238,214,0.07)';
      g.fillRect(x, y, w, h);
      g.globalCompositeOperation = 'source-over';
    }
    if (filter === 'duotone') duotoneLUT(g, x, y, w, h, '#2b2140', '#f4e7c8');

    const va = VIG_A[filter] || 0;
    if (va) {
      const cx = x + w / 2, cy = y + h / 2, r = Math.hypot(w, h) / 2;
      const grd = g.createRadialGradient(cx, cy, r * 0.45, cx, cy, r * 0.95);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(1, `rgba(0,0,0,${va})`);
      g.fillStyle = grd;
      g.fillRect(x, y, w, h);
    }

    // grain sits on top of everything, like real film
    const ga = GRAIN_A[filter] || 0;
    if (ga) {
      g.globalAlpha = ga;
      g.globalCompositeOperation = 'overlay';
      g.fillStyle = g.createPattern(getGrain(), 'repeat');
      g.fillRect(x, y, w, h);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    g.restore();
    img.close && img.close();
  }

  function zigzagPath(g, W, H, tooth, depth) {
    g.beginPath();
    g.moveTo(0, depth);
    for (let x = 0; x < W; x += tooth) g.lineTo(x + tooth / 2, 0), g.lineTo(Math.min(x + tooth, W), depth);
    g.lineTo(W, H - depth);
    for (let x = W; x > 0; x -= tooth) g.lineTo(x - tooth / 2, H), g.lineTo(Math.max(x - tooth, 0), H - depth);
    g.closePath();
  }

  function fmtDate(d) {
    const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const mons = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    let hh = d.getHours();
    const ampm = hh >= 12 ? 'PM' : 'AM';
    hh = hh % 12 || 12;
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${days[d.getDay()]} ${mons[d.getMonth()]} ${d.getDate()} ${d.getFullYear()} · ${hh}:${mm} ${ampm}`;
  }

  async function render({ left, right, filter, leftName, rightName, date }) {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;

    const PAD = 36, CW = 392, CH = 294, GX = 16, GY = 14;
    const ZIG = 12, HEAD = 150, FOOT = 76;
    const W = PAD * 2 + CW * 2 + GX;
    const H = ZIG + HEAD + 4 * CH + 3 * GY + FOOT + ZIG;

    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');

    // paper with cut edges
    zigzagPath(g, W, H, 22, ZIG);
    g.fillStyle = PAPER;
    g.fill();

    const cx = W / 2;

    // header: string mark
    g.save();
    g.translate(cx - 74, 26);
    g.strokeStyle = RED;
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(9, 11);
    g.quadraticCurveTo(74, 27, 139, 11);
    g.stroke();
    g.fillStyle = INK;
    for (const x of [9, 139]) {
      g.beginPath();
      g.arc(x, 11, 4.5, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    g.fillStyle = INK;
    g.textAlign = 'center';
    g.font = '600 44px Fraunces, Georgia, serif';
    g.fillText('string', cx, 96);

    g.font = 'italic 300 24px Fraunces, Georgia, serif';
    g.fillStyle = SOFT;
    g.fillText(`${leftName || 'you'}  &  ${rightName || 'your person'}`, cx, 132);

    // rows: you on the left, them on the right
    const y0 = ZIG + HEAD;
    for (let i = 0; i < 4; i++) {
      const y = y0 + i * (CH + GY);
      if (left[i]) await drawFrame(g, left[i], PAD, y, CW, CH, filter);
      if (right[i]) await drawFrame(g, right[i], PAD + CW + GX, y, CW, CH, filter);
    }

    // footer
    g.fillStyle = SOFT;
    g.font = 'italic 300 17px Fraunces, Georgia, serif';
    g.fillText('together at the same time', cx, H - FOOT + 22);
    g.font = '600 12px -apple-system, "Segoe UI", Arial, sans-serif';
    g.fillStyle = RED;
    g.fillText(fmtDate(date || new Date()), cx, H - FOOT + 48);

    return c;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function pickMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    for (const o of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
      if (MediaRecorder.isTypeSupported(o)) return o;
    }
    return '';
  }

  // Boomerang: the captured shots played forward then back, both faces side by side,
  // rendered on-device to a downloadable clip. Returns { blob, ext } or null if the
  // browser can't record canvas video.
  async function boomerang({ left, right, filter }) {
    const mime = pickMime();
    if (!mime || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null;

    const n = Math.min(left.length, right.length);
    if (!n) return null;

    const imgs = [];
    for (let i = 0; i < n; i++) {
      imgs.push({ l: await createImageBitmap(left[i]), r: await createImageBitmap(right[i]) });
    }

    // ping-pong order, no duplicated endpoints: 0..n-1, n-2..1, 0
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    for (let i = n - 2; i >= 1; i--) order.push(i);
    if (n > 1) order.push(0);

    const W = 640, H = 480, half = W / 2, gap = 4;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');

    const drawSide = (img, x) => {
      const cw = half - gap / 2;
      const s = Math.max(cw / img.width, H / img.height);
      const dw = img.width * s, dh = img.height * s;
      g.save();
      g.beginPath();
      g.rect(x, 0, cw, H);
      g.clip();
      g.fillStyle = '#100f0d';
      g.fillRect(x, 0, cw, H);
      g.filter = CSS[filter] || 'none';
      g.drawImage(img, x - (dw - cw) / 2, -(dh - H) / 2, dw, dh);
      g.filter = 'none';
      g.restore();
    };

    const draw = (i) => {
      drawSide(imgs[i].l, 0);
      drawSide(imgs[i].r, half + gap / 2);
      g.fillStyle = PAPER;
      g.fillRect(half - gap / 2, 0, gap, H);
    };

    const stream = c.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3000000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });

    draw(order[0]);
    rec.start();
    await sleep(450);
    for (let k = 1; k < order.length; k++) {
      draw(order[k]);
      await sleep(300);
    }
    await sleep(250); // hold the last frame so the loop reads
    rec.stop();
    await done;
    stream.getTracks().forEach((t) => t.stop());
    imgs.forEach((f) => { f.l.close && f.l.close(); f.r.close && f.r.close(); });

    return { blob: new Blob(chunks, { type: mime }), ext: mime.includes('mp4') ? 'mp4' : 'webm' };
  }

  return { render, boomerang, FILTERS };
})();
