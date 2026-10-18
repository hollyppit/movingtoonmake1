/* Hand-drawn sound effects. Normalized stroke data stays editable; PNG assets use existing persistence/export paths. */
const INK_DEFAULT = { size: 24, color: '#ffffff', outline: true, border: 5, borderColor: '#111111', opacity: 1, pressure: true };
function inkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function inkPath(g, stroke, w, h, extra = 0) {
  const points = stroke.points; if (!points.length) return;
  g.lineCap = g.lineJoin = 'round';
  const width = p => (stroke.size * (stroke.pressure ? .25 + .75 * (p.p ?? 1) : 1) + extra) * w;
  if (points.length === 1 || points.every(p => p.x === points[0].x && p.y === points[0].y)) { const p = points[0]; g.beginPath(); g.arc(p.x * w, p.y * h, width(p) / 2, 0, Math.PI * 2); g.fill(); return; }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]; g.lineWidth = (width(a) + width(b)) / 2;
    g.beginPath(); g.moveTo(a.x * w, a.y * h); g.lineTo(b.x * w, b.y * h); g.stroke();
  }
}
function inkPaint(strokes, w, h) {
  const border = inkCanvas(w, h), fill = inkCanvas(w, h), bg = border.getContext('2d'), fg = fill.getContext('2d');
  for (const stroke of strokes) {
    if (stroke.tool === 'eraser') {
      for (const g of [bg, fg]) { g.globalCompositeOperation = 'destination-out'; g.globalAlpha = 1; g.strokeStyle = g.fillStyle = '#000'; inkPath(g, stroke, w, h); }
    } else {
      bg.globalCompositeOperation = fg.globalCompositeOperation = 'source-over'; bg.globalAlpha = fg.globalAlpha = stroke.opacity ?? 1;
      if (stroke.outline && stroke.border > 0) { bg.strokeStyle = bg.fillStyle = stroke.borderColor; inkPath(bg, stroke, w, h, stroke.border * 2); }
      fg.strokeStyle = fg.fillStyle = stroke.color; inkPath(fg, stroke, w, h);
    }
  }
  bg.globalCompositeOperation = 'source-over'; bg.globalAlpha = 1; bg.drawImage(fill, 0, 0);
  fill.width = fill.height = 1; return border;
}
function inkCrop(canvas) {
  const { width: w, height: h } = canvas, g = canvas.getContext('2d'), data = g.getImageData(0, 0, w, h).data;
  let left = w, top = h, right = -1, bottom = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3]) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  if (right < left) return null;
  const out = inkCanvas(right - left + 1, bottom - top + 1); out.getContext('2d').drawImage(canvas, -left, -top);
  return { canvas: out, rect: { x: left / w, y: top / h, w: out.width / w, h: out.height / h } };
}
function inkRemap(target, mode, pageW, pageH, kind) {
  if (!target?.ink) return [];
  const source = target.ink, crop = source.crop; let geometry, a = 0, flip = 1;
  if (mode === 'make') { const g = layerGeom(target); geometry = { x: g.cx - g.w / 2, y: g.cy - g.h / 2, w: g.w, h: g.h }; a = g.a; flip = target.flip ? -1 : 1; }
  else {
    const f = itemFrac(target, kind), img = getImg(target.assetId), iw = img.naturalWidth, ih = img.naturalHeight;
    const rw = f.w * pageW, rh = f.h * pageH, scale = (target.fit === 'contain' ? Math.min(rw / iw, rh / ih) : Math.max(rw / iw, rh / ih)) * clamp(+target.zoom || 1, .2, 6);
    geometry = { x: f.x * pageW + (rw - iw * scale) * (target.fx ?? .5), y: f.y * pageH + (rh - ih * scale) * (target.fy ?? .5), w: iw * scale, h: ih * scale };
  }
  const g = geometry, scale = g.w / (crop.w * pageW), cos = Math.cos(a), sin = Math.sin(a);
  return source.strokes.map(s => ({ ...s, size: s.size * scale, border: s.border * scale, points: s.points.map(p => {
    const x = ((p.x - crop.x) / crop.w - .5) * g.w * flip, y = ((p.y - crop.y) / crop.h - .5) * g.h;
    return { ...p, x: (g.x + g.w / 2 + x * cos - y * sin) / pageW, y: (g.y + g.h / 2 + x * sin + y * cos) / pageH };
  }) }));
}
async function inkBackground(mode, owner, target, kind, w, h) {
  if (mode === 'make') return renderCutCanvas({ ...owner, layers: (owner.layers || []).filter(l => l !== target) }, { text: true });
  const items = (kind === 'cover' ? PR().cover.items : owner.panels).filter(it => it !== target), map = new Map();
  for (const it of items) {
    if ((it.type || 'cut') === 'cut' && !map.has(it.cut)) { const p = cutOf(it); if (p) map.set(it.cut, await renderCutCanvas(p)); }
    if (it.type === 'image' && assets.has(it.assetId)) await waitImg(it.assetId);
  }
  const cm = id => map.get(id) || null, parts = new Map(), keys = new Map();
  for (const it of items) if ((it.type || 'cut') === 'cut' && hasOv(it)) {
    const p = cutOf(it); if (p) { const entries = keys.get(it.cut) || new Map(); p.overlays.forEach(o => { const e = it.ov[o.id]; entries.set(ovKey(o, e), { o, e }); }); keys.set(it.cut, entries); }
  }
  for (const [id, entries] of keys) parts.set(id, await renderCutParts(P.panels.find(p => p.id === id), [...entries.values()], 0));
  cm.parts = id => parts.get(id) || null;
  const c = inkCanvas(w, h), [tw] = kind === 'cover' ? targetMM('cover') : prPageMM();
  drawTarget(c.getContext('2d'), kind, w / tw, cm, { page: owner, items, thumb: true, clip: true }); return c;
}
async function inkOpen(mode, requestedTarget) {
  if (document.querySelector('#inkDialog')) return;
  stop();
  const project = P, kind = mode === 'print' && prIsCover() ? 'cover' : 'body';
  let owner = mode === 'make' ? selPanel() : kind === 'cover' ? PR().cover : PR().pages[prPage];
  const draftPage = !owner && mode === 'print';
  if (draftPage) owner = { id: uid(), panels: [] };
  if (!owner) return toast('효과음을 그릴 컷이 없습니다');
  const target = requestedTarget?.ink ? requestedTarget : null;
  if (target && assets.has(target.assetId)) await waitImg(target.assetId);
  const mm = mode === 'print' ? kind === 'cover' ? targetMM('cover') : prPageMM() : null;
  const outputW = mode === 'make' ? W : Math.round(mm[0] * 300 / 25.4), outputH = mode === 'make' ? H : Math.round(mm[1] * 300 / 25.4);
  const w = 1000, h = Math.round(w * outputH / outputW), settings = { ...INK_DEFAULT, ...target?.ink?.settings };
  let strokes = inkRemap(target, mode, mode === 'make' ? W : outputW, mode === 'make' ? H : outputH, kind), undone = [], previous = [], active = null, pointer = null, dirty = false, busy = false, queued = false, tool = 'pen';
  const dialog = document.createElement('dialog'); dialog.id = 'inkDialog'; dialog.setAttribute('aria-labelledby', 'inkTitle');
  dialog.innerHTML = `<div class="ink-head"><strong id="inkTitle">✏ 효과음 펜 · ${mode === 'make' ? '현재 컷' : kind === 'cover' ? '표지' : '본문 ' + (prPage + 1) + '쪽'}</strong><button type="button" class="b ghost sm" id="inkClose">취소</button><button type="button" class="b sm" id="inkSave">효과음 레이어로 저장</button></div>
  <div class="ink-tools"><div class="row"><button type="button" class="b ghost sm" id="inkPen" aria-pressed="true">펜</button><button type="button" class="b ghost sm" id="inkEraser" aria-pressed="false">지우개</button><button type="button" class="b ghost sm" id="inkUndo">되돌리기</button><button type="button" class="b ghost sm" id="inkRedo">다시 하기</button><button type="button" class="b ghost sm" id="inkClear">전체 지우기</button></div>
  <label>브러시 크기 <input id="inkSize" type="range" min="2" max="100" value="${settings.size}"><output id="inkSizeValue">${settings.size}</output></label><label>색상 <input id="inkColor" type="color" value="${settings.color}"></label>
  <label><input id="inkOutline" type="checkbox" ${settings.outline ? 'checked' : ''}> 테두리</label><label>테두리 굵기 <input id="inkBorder" type="range" min="0" max="30" value="${settings.border}"><output id="inkBorderValue">${settings.border}</output></label><label>테두리 색 <input id="inkBorderColor" type="color" value="${settings.borderColor}"></label>
  <label>불투명도 <input id="inkOpacity" type="range" min="10" max="100" value="${settings.opacity * 100}"><output id="inkOpacityValue">${Math.round(settings.opacity * 100)}%</output></label><label><input id="inkPressure" type="checkbox" ${settings.pressure ? 'checked' : ''}> 펜 필압</label><label><input id="inkScene" type="checkbox" checked> 장면 보이기</label><label>확대 <input id="inkZoom" type="range" min="50" max="250" value="100"></label><button type="button" class="b ghost sm" id="inkApply">그린 선에 현재 설정 적용</button></div>
  ${mode === 'make' ? '<div class="ink-tools" id="inkAnimation"><strong>효과음 애니메이션</strong><label>등장 효과 <select id="inkAnim">' + opts(LAYER_ANIMS, target?.anim || 'none') + '</select></label><label>퇴장 효과 <select id="inkOut">' + opts(LAYER_OUTS, target?.out || 'fade') + '</select></label><label>등장(초) <input id="inkStart" type="number" min="0" max="' + Math.max(0, panelDur(owner) - .1) + '" step="0.1" value="' + (+target?.start || 0) + '" style="width:80px"></label><label>사라짐(초, 0=컷 끝) <input id="inkEnd" type="number" min="0" max="' + panelDur(owner) + '" step="0.1" value="' + (target?.dur > 0 ? +((+target.start || 0) + target.dur).toFixed(2) : 0) + '" style="width:80px"></label><span class="note">저장 후 ‘▶ 이 컷’으로 재생해 확인하세요. 영상에도 적용됩니다.</span></div>' : ''}
  <p class="note ink-note">마우스·펜·터치로 그립니다. 지우개는 효과음만 지웁니다. Ctrl+Z / Ctrl+Shift+Z · 저장 후 레이어를 이동·크기 조절할 수 있습니다. PSD에는 별도 효과음 레이어로 저장됩니다.</p>
  <div id="inkViewport"><div id="inkStage"><canvas id="inkReference"></canvas><canvas id="inkCanvas" tabindex="0" aria-label="효과음 그리기 캔버스"></canvas><i id="inkCursor" hidden></i></div></div><div class="st" id="inkStatus" aria-live="polite">장면을 불러오는 중…</div>`;
  document.body.append(dialog); dialog.showModal();
  const q = id => dialog.querySelector('#' + id), canvas = q('inkCanvas'), reference = q('inkReference'), stage = q('inkStage');
  canvas.width = reference.width = w; canvas.height = reference.height = h;
  function fit() { const room = q('inkViewport'), factor = Math.min((room.clientWidth - 24) / w, Math.max(120, room.clientHeight - 24) / h) * (+q('inkZoom').value / 100); stage.style.width = w * factor + 'px'; stage.style.height = h * factor + 'px'; }
  function readSettings() {
    settings.size = +q('inkSize').value; settings.color = q('inkColor').value; settings.outline = q('inkOutline').checked;
    settings.border = +q('inkBorder').value; settings.borderColor = q('inkBorderColor').value; settings.opacity = +q('inkOpacity').value / 100; settings.pressure = q('inkPressure').checked;
    q('inkSizeValue').value = settings.size; q('inkBorderValue').value = settings.border; q('inkOpacityValue').value = Math.round(settings.opacity * 100) + '%';
  }
  function paint() { queued = false; const image = inkPaint(active ? [...strokes, active] : strokes, w, h), g = canvas.getContext('2d'); g.clearRect(0, 0, w, h); g.drawImage(image, 0, 0); image.width = image.height = 1; q('inkUndo').disabled = !previous.length || busy; q('inkRedo').disabled = !undone.length || busy; }
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(() => { if (dialog.isConnected) paint(); }); } }
  function finish(commit) { if (!active) return; if (commit) { previous.push(strokes); strokes = [...strokes, active]; undone = []; dirty = true; } active = null; if (pointer !== null && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer); pointer = null; schedule(); }
  function point(e) { const r = canvas.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1), p: e.pointerType === 'pen' ? clamp(e.pressure || .5, .05, 1) : 1 }; }
  function cursor(e) { const r = canvas.getBoundingClientRect(), size = settings.size / 1000 * r.width, c = q('inkCursor'); c.hidden = false; c.style.width = c.style.height = size + 'px'; c.style.left = (e.clientX - r.left) + 'px'; c.style.top = (e.clientY - r.top) + 'px'; }
  canvas.addEventListener('pointerdown', e => { if (busy || pointer !== null || e.button !== 0) return; e.preventDefault(); canvas.focus({ preventScroll: true }); readSettings(); pointer = e.pointerId; canvas.setPointerCapture(pointer); active = { ...settings, tool, size: settings.size / 1000, border: settings.border / 1000, points: [point(e)] }; cursor(e); schedule(); });
  canvas.addEventListener('pointermove', e => { cursor(e); if (!active || e.pointerId !== pointer) return; e.preventDefault(); const samples = e.getCoalescedEvents?.(); for (const sample of samples?.length ? samples : [e]) { const p = point(sample), last = active.points[active.points.length - 1]; if (Math.hypot((p.x - last.x) * w, (p.y - last.y) * h) > .35) active.points.push(p); } schedule(); });
  canvas.addEventListener('pointerup', e => { if (e.pointerId === pointer) { active.points.push(point(e)); finish(true); } });
  canvas.addEventListener('pointercancel', () => finish(false)); canvas.addEventListener('lostpointercapture', () => { if (active) finish(false); }); canvas.addEventListener('pointerleave', () => q('inkCursor').hidden = true);
  const changeTool = next => { finish(true); tool = next; q('inkPen').setAttribute('aria-pressed', next === 'pen'); q('inkEraser').setAttribute('aria-pressed', next === 'eraser'); };
  q('inkPen').onclick = () => changeTool('pen'); q('inkEraser').onclick = () => changeTool('eraser');
  const undo = redo => { finish(true); if (busy) return; const from = redo ? undone : previous, to = redo ? previous : undone; if (from.length) { to.push(strokes); strokes = from.pop(); dirty = true; schedule(); } };
  q('inkUndo').onclick = () => undo(false); q('inkRedo').onclick = () => undo(true);
  q('inkClear').onclick = () => { finish(true); if (strokes.length) { previous.push(strokes); strokes = [...strokes, { tool: 'eraser', size: Math.hypot(w, h) * 2 / w + 1, pressure: false, points: [{ x: .5, y: .5, p: 1 }] }]; undone = []; dirty = true; schedule(); } };
  q('inkApply').onclick = () => { finish(true); readSettings(); if (!strokes.some(s => s.tool === 'pen')) return; previous.push(strokes); strokes = strokes.map(s => s.tool === 'pen' ? { ...s, ...settings, size: settings.size / 1000, border: settings.border / 1000 } : s); undone = []; dirty = true; schedule(); };
  dialog.querySelectorAll('.ink-tools input').forEach(input => input.addEventListener('input', readSettings));
  dialog.querySelectorAll('#inkAnimation input, #inkAnimation select').forEach(el => el.addEventListener('input', () => dirty = true));
  q('inkScene').onchange = () => reference.hidden = !q('inkScene').checked; q('inkZoom').oninput = fit;
  function close() { if (busy) return; finish(true); if (!dirty || confirm('저장하지 않은 효과음 변경을 버릴까요?')) dialog.close(); }
  q('inkClose').onclick = close; dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dialog.addEventListener('keydown', e => { if (e.ctrlKey || e.metaKey) { if (e.key.toLowerCase() === 'z' && !e.target.closest('input')) { e.preventDefault(); undo(e.shiftKey); } } });
  const resize = new ResizeObserver(fit); resize.observe(q('inkViewport')); dialog.addEventListener('close', () => { resize.disconnect(); dialog.remove(); });
  q('inkSave').onclick = async () => {
    finish(true); if (busy) return;
    if (P !== project) return toast('프로젝트가 바뀌었습니다. 효과음 편집기를 다시 열어 주세요');
    busy = true; dialog.querySelectorAll('button,input,select').forEach(el => el.disabled = true); q('inkStatus').className = 'st'; q('inkStatus').textContent = '효과음 레이어를 저장하는 중…';
    let assetId;
    try {
      const maxPixels = 24000000, factor = Math.min(1, Math.sqrt(maxPixels / (outputW * outputH))), rendered = inkPaint(strokes, Math.round(outputW * factor), Math.round(outputH * factor)), crop = inkCrop(rendered); rendered.width = rendered.height = 1;
      if (!crop) { q('inkStatus').textContent = '그려진 효과음이 없습니다. 선을 그린 뒤 저장해 주세요.'; return; }
      assetId = await addAsset(await canvasBlob(crop.canvas)); await waitImg(assetId); if (P !== project) throw new Error('프로젝트가 바뀌어 저장을 중단했습니다'); histSnap();
      const r = crop.rect, ink = { version: 1, crop: r, strokes: JSON.parse(JSON.stringify(strokes)), settings: { ...settings } };
      if (mode === 'make') {
        const layer = target || newLayer(assetId, '효과음 ' + ((owner.layers || []).filter(l => l.ink).length + 1));
        Object.assign(layer, { assetId, ink, x: r.x + r.w / 2, y: r.y + r.h / 2, w: r.w, rot: 0, flip: false });
        const start = clamp(+q('inkStart').value || 0, 0, Math.max(0, panelDur(owner) - .1)), end = clamp(+q('inkEnd').value || 0, 0, panelDur(owner));
        Object.assign(layer, { anim: q('inkAnim').value, out: q('inkOut').value, start, dur: end > 0 ? Math.max(.1, end - start) : 0 });
        if (!target) owner.layers.push(layer); selLayer = layer.id; selOv = null; tab = 'layer';
      } else {
        if (draftPage) { PR().pages.push(owner); prPage = PR().pages.length - 1; }
        const items = kind === 'cover' ? owner.items : owner.panels, layer = target || { id: uid(), type: 'image', name: '효과음 ' + (items.filter(it => it.ink).length + 1), vis: true };
        Object.assign(layer, { assetId, ink, fit: 'contain', fx: .5, fy: .5, zoom: 1, borderOn: false });
        if (kind === 'cover') Object.assign(layer, { zone: 'all', x: r.x * mm[0], y: r.y * mm[1], w: r.w * mm[0], h: r.h * mm[1] }); else Object.assign(layer, r);
        if (!target) items.push(layer); prSel = layer.id; prOv = null;
      }
      save(); histSnap(); // Keep previous assets available to project undo.
      if (mode === 'make') { renderTabs(); renderInspector(); renderPanels(); requestDraw(); } else renderPrint();
      dialog.close(); toast('효과음을 별도 레이어로 저장했습니다');
    } catch (error) { if (assetId) dropAssetIfUnused(assetId); q('inkStatus').className = 'st err'; q('inkStatus').textContent = '저장 실패: ' + error.message; }
    finally { busy = false; if (dialog.isConnected) { dialog.querySelectorAll('button,input,select').forEach(el => el.disabled = false); paint(); } }
  };
  fit(); paint();
  try { const bg = await inkBackground(mode, owner, target, kind, w, h); if (dialog.isConnected && !busy) { reference.getContext('2d').drawImage(bg, 0, 0, w, h); q('inkStatus').textContent = '테두리가 있는 펜이 기본값입니다. 설정은 다음 획부터 적용됩니다.'; } }
  catch (error) { if (dialog.isConnected) q('inkStatus').textContent = '장면 미리보기 없이도 그릴 수 있습니다: ' + error.message; }
}

async function openInkEditor(mode, target) { try { await inkOpen(mode, target); } catch (error) { toast('효과음 펜을 열지 못했습니다: ' + error.message, 5000); } }
