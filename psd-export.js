/* PSD export. ag-psd 29.0.0 (MIT) is bundled locally; no project data leaves the browser. */
let psdLibrary;
async function loadPsdLibrary() {
  if (window.agPsd) return window.agPsd;
  if (!psdLibrary) psdLibrary = new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = 'vendor/ag-psd-29.0.0.js';
    s.onload = () => resolve(window.agPsd); s.onerror = () => { psdLibrary = null; s.remove(); reject(new Error('PSD 라이브러리를 불러오지 못했습니다')); };
    document.head.append(s);
  });
  return psdLibrary;
}
const psdUploadedFonts = new Map();
function psdFontName(family, cssFont) {
  if (psdUploadedFonts.has(family)) return psdUploadedFonts.get(family);
  const weight = +(cssFont.match(/(?:^|\s)([1-9]00)(?:\s|$)/)?.[1] || (/\bbold\b/.test(cssFont) ? 700 : 400));
  // Adobe Technical Note #5902: an arbitrary variable-font instance encodes its
  // design coordinate in the PostScript name. Named instances alone lose wght
  // when Photoshop rebuilds text without the native Txt2 font-axis cache.
  if (family === 'Noto Sans KR') return 'NotoSansKR_' + Math.min(900, Math.max(100, weight)) + 'wght';
  if (family === 'Noto Serif KR') return 'NotoSerifKR_' + Math.min(900, Math.max(200, weight)) + 'wght';
  if (family === 'Arial') return weight >= 600 ? 'Arial-BoldMT' : 'ArialMT';
  if (family === 'sans-serif') return 'ArialMT';
  if (family === 'serif') return 'TimesNewRomanPSMT';
  if (family === 'Nanum Gothic') return 'NanumGothic' + (weight >= 800 ? 'ExtraBold' : weight >= 600 ? 'Bold' : '');
  if (family === 'Nanum Myeongjo') return 'NanumMyeongjo' + (weight >= 800 ? 'ExtraBold' : weight >= 600 ? 'Bold' : '');
  const special = { 'Nanum Pen Script': 'NanumPen', 'Nanum Brush Script': 'NanumBrush' };
  return special[family] || family.replace(/\s/g, '') + '-Regular';
}
async function psdPrepareFontNames() {
  for (const f of P.fonts || []) {
    const key = 'MF-' + f.id; if (psdUploadedFonts.has(key) || !assets.has(f.id)) continue;
    try {
      const view = new DataView(await assets.get(f.id).blob.arrayBuffer());
      // OpenType and TrueType name table: ID 6 is the actual PostScript font name.
      const count = view.getUint16(4);
      for (let i = 0; i < count; i++) {
        const off = 12 + i * 16;
        if (view.getUint32(off) !== 0x6e616d65) continue;
        const table = view.getUint32(off + 8), records = view.getUint16(table + 2), strings = table + view.getUint16(table + 4);
        for (let n = 0; n < records; n++) {
          const r = table + 6 + n * 12, platform = view.getUint16(r);
          if (view.getUint16(r + 6) !== 6) continue;
          const len = view.getUint16(r + 8), start = strings + view.getUint16(r + 10); let name = '';
          if (platform === 0 || platform === 3) for (let j = 0; j < len; j += 2) name += String.fromCharCode(view.getUint16(start + j));
          else for (let j = 0; j < len; j++) name += String.fromCharCode(view.getUint8(start + j));
          if (name) { psdUploadedFonts.set(key, name); break; }
        }
      }
    } catch (e) { console.warn('PSD font name:', f.name, e.message); }
  }
}
function psdCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function psdBuilder(w, h, dpi = 72) {
  if (w > 30000 || h > 30000) throw new Error('PSD는 한 변이 30,000px 이하여야 합니다');
  const surface = psdCanvas(w, h), ctx = surface.getContext('2d', { willReadFrequently: true });
  const composite = psdCanvas(w, h), layers = [];
  function take(name, text, cleanText) {
    const im = ctx.getImageData(0, 0, w, h), d = im.data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x1 >= x0) {
      const c = psdCanvas(x1 - x0 + 1, y1 - y0 + 1); c.getContext('2d').putImageData(ctx.getImageData(x0, y0, c.width, c.height), 0, 0);
      composite.getContext('2d').drawImage(c, x0, y0);
      const layer = { name, left: x0, top: y0, canvas: c };
      if (text) {
        layer.text = text;
        // Cache only glyph pixels. Photoshop applies editable effects once on this cache.
        if (cleanText) {
          ctx.save(); ctx.resetTransform(); ctx.clearRect(0, 0, w, h); ctx.restore();
          cleanText();
          c.getContext('2d').clearRect(0, 0, c.width, c.height);
          c.getContext('2d').putImageData(ctx.getImageData(x0, y0, c.width, c.height), 0, 0);
        }
      }
      layers.push(layer);
    }
    ctx.save(); ctx.resetTransform(); ctx.clearRect(0, 0, w, h); ctx.restore();
  }
  const raster = (name, fn) => { ctx.save(); fn(ctx); take(name); ctx.restore(); };
  function letters(name, fn) {
    let pendingStroke = null;
    const proxy = new Proxy(ctx, {
      get(t, key) {
        if (key === 'strokeText') return (...args) => { pendingStroke = { args, color: t.strokeStyle, width: t.lineWidth, shadowColor: t.shadowColor, shadowBlur: t.shadowBlur }; };
        if (key === 'fillText') return (value, x, y) => {
          if (!String(value).trim()) return;
          const match = t.font.match(/([\d.]+)px\s+(.+)/), size = match ? +match[1] : 14;
          const family = match ? match[2].split(',')[0].replace(/["']/g, '').trim() : 'Arial';
          const m = t.measureText(value), matrix = t.getTransform();
          let left = x; if (t.textAlign === 'center') left -= m.width / 2; else if (t.textAlign === 'right' || t.textAlign === 'end') left -= m.width;
          // Canvas middle is an em baseline, not the center of fontBoundingBox.
          // Compare the same glyphs at both baselines to obtain the actual offset.
          t.save(); t.textBaseline = 'alphabetic'; const alphabetic = t.measureText(value); t.restore();
          const baseline = y + alphabetic.actualBoundingBoxAscent - m.actualBoundingBoxAscent;
          const p = matrix.transformPoint({ x: left, y: baseline });
          const colorCanvas = psdCanvas(1, 1), cg = colorCanvas.getContext('2d'); cg.fillStyle = t.fillStyle; cg.fillRect(0, 0, 1, 1); const rgba = cg.getImageData(0, 0, 1, 1).data;
          if (pendingStroke) { t.save(); t.strokeStyle = pendingStroke.color; t.lineWidth = pendingStroke.width; t.shadowColor = pendingStroke.shadowColor; t.shadowBlur = pendingStroke.shadowBlur; t.strokeText(...pendingStroke.args); t.restore(); }
          t.fillText(value, x, y);
          take(name + ' · ' + String(value).slice(0, 24), {
            text: String(value), left: 0, top: 0, right: 0, bottom: 0, transform: [matrix.a, matrix.b, matrix.c, matrix.d, p.x, p.y],
            style: { font: { name: psdFontName(family, t.font), script: /KR|Nanum|Gothic|Batang|Myeongjo/.test(family) ? 4 : 0, type: 1, synthetic: 0 }, fontSize: size, fillColor: { r: rgba[0], g: rgba[1], b: rgba[2] } },
            paragraphStyle: { justification: 'left' },
          }, () => t.fillText(value, x, y));
          pendingStroke = null;
        };
        const v = t[key]; return typeof v === 'function' ? v.bind(t) : v;
      }, set(t, key, value) { t[key] = value; return true; },
    });
    ctx.save(); fn(proxy); ctx.restore();
  }
  return { ctx, raster, letters, layers, async blob() {
    const lib = await loadPsdLibrary();
    const psd = { width: w, height: h, canvas: composite, children: layers, imageResources: { resolutionInfo: { horizontalResolution: dpi, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: dpi, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' } } };
    if (!globalThis.PsdTextEngine) throw new Error('PSD 문자 엔진을 불러오지 못했습니다');
    PsdTextEngine.attach(psd);
    // invalidateTextLayers removes Txt2, including the variable-font weight axes.
    const data = lib.writePsd(psd, { invalidateTextLayers: !psd.engineData });
    return new Blob([data], { type: 'image/vnd.adobe.photoshop' });
  } };
}
async function psdPrepare(p) {
  await loadFontsNow(); await psdPrepareFontNames();
  for (const id of [curAsset(p), ...(p.layers || []).map(l => l.assetId), ...p.overlays.map(o => o.shapeImg)].filter(Boolean)) if (assets.has(id)) await waitImg(id);
}
function psdOverlay(b, o, name) {
  const L = layoutOv(b.ctx, o), x = o.x * W, y = o.y * H;
  const tip = o.tail && ['speech', 'thought', 'shout'].includes(o.kind) && !(o.shapeImg && assets.has(o.shapeImg)) ? { x: o.tail.x * W - x, y: o.tail.y * H - y } : null;
  b.raster(name + ' 말풍선', g => { g.translate(x, y); drawShape(g, o, L, tip); });
  const first = b.layers.length;
  b.letters(name + ' 텍스트', g => { g.translate(x, y); drawText(g, o, L, Infinity); });
  if (o.kind === 'caption') {
    const c = psdCanvas(1, 1), cg = c.getContext('2d'); cg.fillStyle = o.stroke || '#000'; cg.fillRect(0, 0, 1, 1); const rgb = cg.getImageData(0, 0, 1, 1).data;
    const m = b.ctx.getTransform(), scale = Math.hypot(m.a, m.b);
    b.layers.slice(first).forEach(l => { l.effects = { scale: 1, dropShadow: [{ enabled: true, blendMode: 'multiply', color: { r: 0, g: 0, b: 0 }, opacity: .55, useGlobalLight: false, angle: 0, distance: { units: 'Pixels', value: 0 }, size: { units: 'Pixels', value: 7 * scale }, choke: { units: 'Pixels', value: 0 }, noise: 0, contour: { name: 'Linear', curve: [{ x: 0, y: 0 }, { x: 255, y: 255 }] }, antialiased: false, present: true, showInDialog: true, layerConceals: true }], stroke: [{ enabled: true, position: 'outside', fillType: 'color', blendMode: 'normal', opacity: 1, size: { units: 'Pixels', value: Math.max(2, (+o.strokeW || 4) * 2.2) * scale / 2 }, color: { r: rgb[0], g: rgb[1], b: rgb[2] } }] }; });
  }
}
function psdCut(b, p, name) {
  b.raster(name + ' 그림', g => drawPanel(g, { ...p, layers: [], overlays: [] }, 0, { still: true, overlays: false }));
  (p.layers || []).forEach((l, i) => { if (l.vis) b.raster(name + (l.ink ? ' 효과음 ' : ' 이미지 ') + (l.name || i + 1), g => drawLayer(g, l, 0, { still: true })); });
}
async function exportCutPsd(p) {
  await psdPrepare(p); const b = psdBuilder(W, H); psdCut(b, p, '컷');
  p.overlays.forEach((o, i) => psdOverlay(b, o, String(i + 1)));
  return b.blob();
}
async function exportPrintPsd() {
  const button = $('#prPsd'), st = $('#prExSt'), cfg = PR(), dpi = +$('#prDpi').value || 300, k = dpi / 25.4, range = $('#prRange').value;
  const jobs = [];
  if (range !== 'body' && cfg.cover.items.length) jobs.push({ kind: 'cover', items: cfg.cover.items, mm: targetMM('cover'), name: '표지' });
  if (range !== 'cover') cfg.pages.forEach((pg, i) => jobs.push({ kind: 'body', items: pg.panels, page: pg, mm: prPageMM(), name: '본문_' + String(i + 1).padStart(2, '0') }));
  if (!jobs.length) return toast('내보낼 내용이 없습니다');
  button.disabled = true; const files = [];
  try {
    await loadPsdLibrary(); await loadFontsNow(); await psdPrepareFontNames();
    for (const job of jobs) {
      st.className = 'st'; st.textContent = job.name + ' PSD 만드는 중…';
      const [tw, th] = job.mm, M = cropMargin(), off = Math.round(M * k), pw = tw * k, ph = th * k;
      const b = psdBuilder(Math.round((tw + M * 2) * k), Math.round((th + M * 2) * k), dpi), g = b.ctx;
      b.raster('종이', c => { c.fillStyle = '#fff'; c.fillRect(0, 0, c.canvas.width, c.canvas.height); c.fillStyle = job.kind === 'cover' ? cfg.cover.bg : cfg.bg; c.fillRect(off - cropBleed() * k, off - cropBleed() * k, pw + cropBleed() * k * 2, ph + cropBleed() * k * 2); });
      g.translate(off, off);
      for (const it of job.items) {
        if (it.vis === false) continue;
        const f = itemFrac(it, job.kind), rx = f.x * pw, ry = f.y * ph, rw = f.w * pw, rh = f.h * ph;
        g.save(); if (M) { g.beginPath(); g.rect(0, 0, pw, ph); g.clip(); }
        const ovLayers = (xf, label) => ovList(it).forEach((original, i) => { // 칸 위의 말풍선(옮겨 온 것 포함)을 편집 가능한 레이어로
          const e = it.ov && it.ov[original.id]; if (e && e.vis === false) return;
          const o = withText(original, e), s = e && e.s != null ? e.s : 1;
          g.save(); if (!ovMoved(e)) { g.beginPath(); g.rect(rx, ry, rw, rh); g.clip(); }
          g.translate(xf.ox + (o.x * W + (e?.dx || 0) * W) * xf.kc, xf.oy + (o.y * H + (e?.dy || 0) * H) * xf.kc);
          g.scale(xf.kc * s, xf.kc * s); g.translate(-o.x * W, -o.y * H);
          psdOverlay(b, o, label + ' ' + (i + 1)); g.restore();
        });
        if (it.type === 'text') {
          b.raster('글상자 배경', c => drawTextItem(c, { ...it, text: '' }, rx, ry, rw, rh, k));
          b.letters('글상자', c => drawTextItem(c, { ...it, bgOp: 0 }, rx, ry, rw, rh, k));
        } else if (it.type === 'image') {
          if (assets.has(it.assetId)) await waitImg(it.assetId);
          b.raster(it.ink ? '효과음 · ' + (it.name || '') : '배치 이미지', c => drawItem(c, it, rx, ry, rw, rh, k, () => null, job.kind));
          if (hasOv(it)) ovLayers(cutXform(it, rx, ry, rw, rh), '이미지 말풍선');
        } else {
          const p = cutOf(it); if (p) {
            await psdPrepare(p); const xf = cutXform(it, rx, ry, rw, rh), name = prCutName(it.cut);
            g.save(); g.beginPath(); g.rect(rx, ry, rw, rh); g.clip(); g.translate(xf.ox, xf.oy); g.scale(xf.kc, xf.kc); psdCut(b, p, name); g.restore();
            const bs = itemBorderSpec(it); if (bs) b.raster(name + ' 테두리', c => { c.strokeStyle = bs.color; c.lineWidth = bs.w * k; c.strokeRect(rx, ry, rw, rh); });
            ovLayers(xf, name);
          }
        }
        g.restore();
      }
      if (job.kind === 'body' && cfg.pageNums) b.letters('쪽 번호', c => { c.fillStyle = /^#0|^#1/i.test(cfg.bg) ? '#fff' : '#222'; c.font = 3.4 * k + 'px sans-serif'; c.textAlign = 'center'; c.fillText(String(cfg.pages.indexOf(job.page) + 1), pw / 2, ph - Math.max(2.6, cfg.margin * .38) * k); });
      if (M) b.raster('재단선·도련', c => drawCropMarks(c, job.kind, k, tw, th, false));
      files.push({ name: safeName(P.title) + '_' + job.name + '.psd', blob: await b.blob() });
      await new Promise(r => setTimeout(r, 0));
    }
    download(await makeZip(files), safeName(P.title) + '_인쇄용_PSD.zip'); st.className = 'st ok'; st.textContent = '✓ PSD ' + files.length + '장 저장 (' + dpi + 'dpi)';
  } catch (e) { st.className = 'st err'; st.textContent = '실패: ' + e.message; }
  finally { button.disabled = false; }
}
