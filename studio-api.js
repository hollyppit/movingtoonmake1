// 무빙툰 스튜디오 서버 API — 사주 무빙툰 관리자 페이지와 같은 규칙으로 동작한다.
//   · 인증: Authorization: Bearer <관리자 비밀번호>  (기존 /api/admin 과 같은 값)
//   · 파일: R2 에 저장하고 키를 돌려준다 → 기존 GET /api/clipfile?k=<키> 로 내려받는다
//   · 오류: { error } JSON (+ 이미지는 attempts, 폴백 결과는 /api/ai 와 같은 { provider, model, attempts })
//
// 저장소는 Supabase 하나로 쓴다: 프로젝트·사용량 기록은 Postgres 테이블, 이미지·영상·음성 파일은 Storage 버킷.
// Supabase 키(service_role)는 서버에만 두고 브라우저에는 내려보내지 않는다. 스키마는 supabase/schema.sql.
//
// 경로: /api/image /api/kling /api/file /api/projects /api/usage /api/tts /api/admin
// 연결 (Cloudflare Pages Functions): functions/api/*.js 가 아래 handleXxx 를 불러 쓴다.
// 단독 Worker 로 쓰면 아래 default export 의 fetch 가 경로를 나눠 준다.
//
// 환경변수 이름은 아래 ENV 에서 바꿀 수 있다.
const ENV = {
  pw: 'ADMIN_PASSWORD',      // 관리자 비밀번호
  sbUrl: 'SUPABASE_URL',                   // https://xxxx.supabase.co
  sbKey: 'SUPABASE_SERVICE_ROLE_KEY',      // service_role 키 (서버 전용 비밀)
  sbBucket: 'SUPABASE_BUCKET',             // 선택. 기본 studio (비공개 버킷)
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',   // 나레이션·대사 맞춤법 검사 / 다듬기 (Claude)
  klKey: 'KLING_API_KEY',    // 새 클링 API: 키 하나 (Authorization: Bearer 키). 있으면 이 방식을 쓴다
  klAK: 'KLING_ACCESS_KEY',  // 옛 클링 API: Access Key + Secret Key 로 JWT 서명 (KLING_API_KEY 가 없을 때)
  klSK: 'KLING_SECRET_KEY',
  klBase: 'KLING_API_BASE',  // 선택. 기본 https://api-singapore.klingai.com
};
const KEY_PREFIX = 'studio/';

const NO_TEXT = 'Strictly no text of any kind: no letters, no speech balloons, no captions, no sound-effect lettering, no watermark.';

/* ---------- 공통 ---------- */
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
function authed(req, env) {
  const want = env[ENV.pw];
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return !!want && got === want;
}
function sb(env) {
  const url = (env[ENV.sbUrl] || '').replace(/\/+$/, ''), key = env[ENV.sbKey];
  if (!url || !key) throw new Error(ENV.sbUrl + ' / ' + ENV.sbKey + ' 가 설정되지 않았습니다');
  return { url, h: { apikey: key, Authorization: 'Bearer ' + key }, bucket: env[ENV.sbBucket] || 'studio' };
}
const objURL = (c, key, mid = '') => c.url + '/storage/v1/object/' + mid + c.bucket + '/' + key.split('/').map(encodeURIComponent).join('/');
function newKey(ext) { return KEY_PREFIX + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8) + '.' + ext; }
const safeKey = k => { k = String(k || ''); if (!k.startsWith(KEY_PREFIX) || k.includes('..')) throw Object.assign(new Error('잘못된 파일 키'), { status: 400 }); return k; };
async function filePut(env, key, data, type) {
  const c = sb(env);
  const r = await fetch(objURL(c, key), { method: 'POST', headers: { ...c.h, 'Content-Type': type || 'application/octet-stream', 'x-upsert': 'true' }, body: data });
  if (!r.ok) throw new Error('Storage 저장 실패: ' + (await r.text().catch(() => r.status)));
  return key;
}
async function fileGet(env, key) {
  const c = sb(env);
  const r = await fetch(objURL(c, key, 'authenticated/'), { headers: c.h });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error('Storage 읽기 실패: ' + r.status);
  return { body: r.body, type: r.headers.get('content-type') || 'application/octet-stream', res: r };
}
async function r2Put(env, data, type, ext) { return filePut(env, newKey(ext), data, type); }
async function r2Get(env, key) {
  const f = await fileGet(env, safeKey(key));
  if (!f) throw Object.assign(new Error('파일을 찾지 못했습니다: ' + key), { status: 400 });
  return { bytes: new Uint8Array(await f.res.arrayBuffer()), type: f.type };
}
async function db(env, path, opt = {}) {
  const c = sb(env);
  const r = await fetch(c.url + '/rest/v1/' + path, { ...opt, headers: { ...c.h, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* 본문 없음 */ }
  if (!r.ok) throw new Error('DB 오류: ' + (j?.message || t || r.status));
  return j;
}
function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(str) { const bin = atob(str); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
class GenError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }

/* ---------- 이미지: OpenAI → Gemini (순서는 요청의 order) ---------- */
async function openaiImage(env, { prompt, refs, size, quality, model }) {
  const key = env[ENV.openai]; if (!key) throw new GenError('auth', 'OPENAI_API_KEY 없음');
  let res;
  if (refs.length) {
    const fd = new FormData();
    fd.append('model', model); fd.append('prompt', prompt); fd.append('n', '1'); fd.append('size', size); fd.append('quality', quality);
    refs.forEach((r, i) => fd.append('image[]', new Blob([r.bytes], { type: r.type }), `ref${i + 1}.${/png/.test(r.type) ? 'png' : 'jpg'}`));
    res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd });
  } else {
    res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, n: 1, size, quality }),
    });
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = j.error?.code || j.error?.type || '', msg = j.error?.message || `HTTP ${res.status}`;
    const kind = /moderation|safety|content_policy/i.test(code + ' ' + msg) ? 'refused' : res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate' : res.status >= 500 ? 'server' : 'bad';
    throw new GenError(kind, msg);
  }
  const d = j.data?.[0];
  if (d?.b64_json) return { bytes: unb64(d.b64_json), type: 'image/png' };
  if (d?.url) { const r = await fetch(d.url); return { bytes: new Uint8Array(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/png' }; }
  throw new GenError('empty', '이미지가 반환되지 않았습니다');
}
async function geminiImage(env, { prompt, refs, aspect, model }) {
  const key = env[ENV.gemini]; if (!key) throw new GenError('auth', 'GEMINI_API_KEY 없음');
  const parts = refs.map(r => ({ inlineData: { mimeType: r.type, data: b64(r.bytes) } }));
  parts.push({ text: prompt });
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspect } } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j.error?.message || `HTTP ${res.status}`;
    throw new GenError(res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate' : res.status >= 500 ? 'server' : 'bad', msg);
  }
  if (j.promptFeedback?.blockReason) throw new GenError('refused', '프롬프트 차단: ' + j.promptFeedback.blockReason);
  const cand = j.candidates?.[0];
  const part = cand?.content?.parts?.find(p => p.inlineData || p.inline_data);
  if (!part) {
    const fr = cand?.finishReason || '';
    throw new GenError(/SAFETY|PROHIBITED|BLOCK|RECITATION|SPII/i.test(fr) ? 'refused' : 'empty', '이미지 없음' + (fr ? ` (${fr})` : ''));
  }
  const d = part.inlineData || part.inline_data;
  return { bytes: unb64(d.data), type: d.mimeType || d.mime_type || 'image/png' };
}

export async function handleImage(req, env) {
  if (req.method !== 'POST') return json({ error: 'POST만 됩니다' }, 405);
  if (!authed(req, env)) return json({ error: '관리자 인증 실패' }, 401);
  let body; try { body = await req.json(); } catch (e) { return json({ error: '잘못된 JSON' }, 400); }
  const prompt = String(body.prompt || '').slice(0, 30000);
  if (!prompt) return json({ error: 'prompt 가 비었습니다' }, 400);
  const order = (Array.isArray(body.order) && body.order.length ? body.order : ['openai', 'gemini']).filter(p => p === 'openai' || p === 'gemini');
  let refs;
  try { refs = await Promise.all((body.refs || []).slice(0, 16).map(k => r2Get(env, String(k)))); }
  catch (e) { return json({ error: e.message }, 400); }

  const attempts = [];
  for (const provider of order) {
    const t0 = Date.now();
    const model = provider === 'openai' ? (body.oaModel || 'gpt-image-2') : (body.gmModel || 'gemini-2.5-flash-image');
    try {
      const img = provider === 'openai'
        ? await openaiImage(env, { prompt, refs, size: body.size || '1024x1536', quality: body.quality || 'medium', model })
        : await geminiImage(env, { prompt, refs, aspect: body.aspect || '9:16', model });
      attempts.push({ provider, model, ok: true, ms: Date.now() - t0 });
      const key = await r2Put(env, img.bytes, img.type, /jpe?g/.test(img.type) ? 'jpg' : /webp/.test(img.type) ? 'webp' : 'png');
      return json({ key, provider, model, attempts });
    } catch (e) {
      attempts.push({ provider, model, ok: false, kind: e.kind || 'bad', error: String(e.message).slice(0, 400), ms: Date.now() - t0 });
    }
  }
  return json({ error: '모든 엔진이 실패했습니다', attempts }, 502);
}

/* ---------- Kling: 서명·전송·조회, 완성 영상은 R2 로 옮겨 키로 돌려준다 ---------- */
const b64url = u8 => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function klingJWT(env) {
  const ak = env[ENV.klAK], sk = env[ENV.klSK];
  if (!ak || !sk) throw new GenError('auth', 'KLING 키 없음');
  const now = Math.floor(Date.now() / 1000), enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify({ iss: ak, exp: now + 1800, nbf: now - 5 })));
  const key = await crypto.subtle.importKey('raw', enc.encode(sk), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(h + '.' + p)));
  return `${h}.${p}.${b64url(sig)}`;
}
async function kling(env, path, opt = {}) {
  const base = (env[ENV.klBase] || 'https://api-singapore.klingai.com').replace(/\/+$/, '');
  const r = await fetch(base + path, { ...opt, headers: { Authorization: 'Bearer ' + await klingJWT(env), 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code !== undefined && j.code !== 0)) throw new GenError(r.status === 429 ? 'rate' : 'bad', `${j.message || 'HTTP ' + r.status} (code ${j.code ?? r.status})`);
  return j.data || {};
}
const doneKey = id => `${KEY_PREFIX}kling/${String(id).replace(/[^\w-]/g, '')}.mp4`;

/* 새 API: POST /image-to-video/<model> {contents, settings}, 조회 GET /tasks?task_ids= → data[0].status / outputs[].url */
async function klingNew(env, path, opt = {}) {
  const base = (env[ENV.klBase] || 'https://api-singapore.klingai.com').replace(/\/+$/, '');
  const r = await fetch(base + path, { ...opt, headers: { Authorization: 'Bearer ' + env[ENV.klKey], 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code !== undefined && j.code !== 0)) throw new GenError(r.status === 429 ? 'rate' : r.status === 401 ? 'auth' : 'bad', (j.message || 'HTTP ' + r.status) + ' (code ' + (j.code ?? r.status) + ')');
  return j.data;
}
async function handleKlingNew(req, env) {
  if (req.method === 'POST') {
    const b = await req.json();
    const img = await r2Get(env, String(b.image || ''));
    const model = /^kling-\d/.test(b.model || '') ? b.model : 'kling-3.0'; // 옛 이름(kling-v2-1)은 새 API 에 없으니 3.0 으로
    const prompt = String(b.prompt || '') + (b.negative ? '\n\nAvoid: ' + b.negative : '');
    const contents = [{ type: 'prompt', text: prompt.slice(0, 2500) }, { type: 'first_frame', url: b64(img.bytes) }];
    if (b.tail) contents.push({ type: 'last_frame', url: b64((await r2Get(env, String(b.tail))).bytes) });
    const d = await klingNew(env, '/image-to-video/' + encodeURIComponent(model), { method: 'POST', body: JSON.stringify({
      contents,
      settings: { resolution: b.mode === 'pro' ? '1080p' : '720p', duration: Math.min(15, Math.max(3, +b.duration || 5)), audio: 'off', multi_shot: false },
      options: { watermark_info: { enabled: false } },
    }) });
    return json({ taskId: d.id });
  }
  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return json({ error: 'id 가 없습니다' }, 400);
    const meta = await fileGet(env, doneKey(id) + '.json');
    if (meta) return json({ status: 'succeed', key: doneKey(id), duration: +(await meta.res.json().catch(() => ({}))).duration || undefined });
    const t = (await klingNew(env, '/tasks?task_ids=' + encodeURIComponent(id)))?.[0];
    if (!t) return json({ status: 'processing' });
    if (t.status === 'succeeded') {
      const v = t.outputs?.find(o => o.type === 'video');
      if (!v?.url) return json({ status: 'failed', error: '결과 영상 주소가 없습니다' });
      const r = await fetch(v.url);
      if (!r.ok) return json({ status: 'processing', error: '완성 영상 내려받기 재시도 중 (' + r.status + ')' });
      await filePut(env, doneKey(id), await r.arrayBuffer(), 'video/mp4');
      await filePut(env, doneKey(id) + '.json', JSON.stringify({ duration: +v.duration || 0 }), 'application/json');
      return json({ status: 'succeed', key: doneKey(id), duration: +v.duration || undefined });
    }
    if (t.status === 'failed') return json({ status: 'failed', error: t.message || '클링에서 실패로 처리했습니다' });
    return json({ status: t.status || 'processing' });
  }
  return json({ error: 'GET 또는 POST만 됩니다' }, 405);
}

export async function handleKling(req, env) {
  if (!authed(req, env)) return json({ error: '관리자 인증 실패' }, 401);
  try {
    if (env[ENV.klKey]) return await handleKlingNew(req, env);
    if (req.method === 'POST') {
      const b = await req.json();
      const img = await r2Get(env, String(b.image || ''));
      const body = {
        model_name: b.model || 'kling-v2-1',
        image: b64(img.bytes),
        prompt: String(b.prompt || '').slice(0, 2500),
        negative_prompt: String(b.negative || '').slice(0, 2500),
        cfg_scale: 0.5, mode: b.mode === 'pro' ? 'pro' : 'std', duration: +b.duration >= 8 ? '10' : '5', // 옛 API 는 5·10초만 (새 API 는 3~15초)
      };
      if (b.tail) body.image_tail = b64((await r2Get(env, String(b.tail))).bytes);
      const d = await kling(env, '/v1/videos/image2video', { method: 'POST', body: JSON.stringify(body) });
      return json({ taskId: d.task_id });
    }
    if (req.method === 'GET') {
      const id = new URL(req.url).searchParams.get('id');
      if (!id) return json({ error: 'id 가 없습니다' }, 400);
      // 이미 Storage 로 옮겼으면 다시 받지 않는다
      const meta = await fileGet(env, doneKey(id) + '.json');
      if (meta) return json({ status: 'succeed', key: doneKey(id), duration: +(await meta.res.json().catch(() => ({}))).duration || undefined });
      const d = await kling(env, '/v1/videos/image2video/' + encodeURIComponent(id));
      if (d.task_status === 'succeed') {
        const v = d.task_result?.videos?.[0];
        if (!v?.url) return json({ status: 'failed', error: '결과 영상 주소가 없습니다' });
        const r = await fetch(v.url);
        if (!r.ok) return json({ status: 'processing', error: '완성 영상 내려받기 재시도 중 (' + r.status + ')' });
        await filePut(env, doneKey(id), await r.arrayBuffer(), 'video/mp4');
        await filePut(env, doneKey(id) + '.json', JSON.stringify({ duration: v.duration || 0 }), 'application/json');
        return json({ status: 'succeed', key: doneKey(id), duration: +v.duration || undefined });
      }
      if (d.task_status === 'failed') return json({ status: 'failed', error: d.task_status_msg || '클링에서 실패로 처리했습니다' });
      return json({ status: d.task_status || 'processing' });
    }
    return json({ error: 'GET 또는 POST만 됩니다' }, 405);
  } catch (e) {
    return json({ error: e.message, kind: e.kind || 'bad', provider: 'kling' }, e.status || 502);
  }
}

/* ---------- 파일: 올리기(POST ?name=) / 내려받기(GET ?k=) — 비공개 버킷이라 인증 필요 ---------- */
export async function handleFile(req, env) {
  if (!authed(req, env)) return json({ error: '관리자 인증 실패' }, 401);
  try {
    const u = new URL(req.url);
    if (req.method === 'POST') {
      const name = u.searchParams.get('name') || 'file.bin';
      const ext = (name.match(/\.([a-z0-9]{2,5})$/i)?.[1] || 'bin').toLowerCase();
      const type = req.headers.get('content-type') || 'application/octet-stream';
      return json({ key: await r2Put(env, await req.arrayBuffer(), type, ext) });
    }
    if (req.method === 'GET') {
      const f = await fileGet(env, safeKey(u.searchParams.get('k')));
      if (!f) return json({ error: '파일 없음' }, 404);
      return new Response(f.body, { headers: { 'content-type': f.type, 'cache-control': 'private, max-age=3600' } });
    }
    return json({ error: 'GET 또는 POST만 됩니다' }, 405);
  } catch (e) { return json({ error: e.message }, e.status || 502); }
}

/* ---------- 프로젝트: 목록 / 읽기 / 저장 / 삭제 (테이블 projects) ---------- */
export async function handleProjects(req, env) {
  if (!authed(req, env)) return json({ error: '관리자 인증 실패' }, 401);
  try {
    const id = new URL(req.url).searchParams.get('id');
    const q = encodeURIComponent;
    if (req.method === 'GET' && !id) return json({ projects: await db(env, 'projects?select=id,title,updated_at&order=updated_at.desc&limit=100') });
    if (req.method === 'GET') {
      const rows = await db(env, 'projects?id=eq.' + q(id) + '&select=id,title,data,updated_at');
      return rows?.[0] ? json(rows[0]) : json({ error: '프로젝트 없음' }, 404);
    }
    if (req.method === 'PUT') {
      const b = await req.json();
      const pid = String(b.id || crypto.randomUUID());
      await db(env, 'projects?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ id: pid, title: String(b.title || '새 무빙툰').slice(0, 200), data: b.data || {}, updated_at: new Date().toISOString() }) });
      return json({ id: pid });
    }
    if (req.method === 'DELETE') {
      if (!id) return json({ error: 'id 가 없습니다' }, 400);
      await db(env, 'projects?id=eq.' + q(id), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json({ ok: true });
    }
    return json({ error: '지원하지 않는 메서드' }, 405);
  } catch (e) { return json({ error: e.message }, 502); }
}

/* ---------- 사용량·비용 기록 (테이블 usage_log) ---------- */
export async function handleUsage(req, env) {
  if (!authed(req, env)) return json({ error: '관리자 인증 실패' }, 401);
  try {
    if (req.method === 'POST') {
      const b = await req.json();
      await db(env, 'usage_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
        project_id: b.project_id || null, kind: String(b.kind || '').slice(0, 40), provider: String(b.provider || '').slice(0, 40),
        ok: !!b.ok, cost: +b.cost || 0, ms: +b.ms || null, error: b.msg ? String(b.msg).slice(0, 400) : null,
      }) });
      return json({ ok: true });
    }
    if (req.method === 'GET') {
      const pid = new URL(req.url).searchParams.get('project_id');
      const rows = await db(env, 'usage_log?select=created_at,kind,provider,ok,cost,ms,error&order=created_at.desc&limit=200' + (pid ? '&project_id=eq.' + encodeURIComponent(pid) : ''));
      return json({ rows, total: rows.reduce((a, r) => a + (r.ok ? +r.cost || 0 : 0), 0) });
    }
    return json({ error: 'GET 또는 POST만 됩니다' }, 405);
  } catch (e) { return json({ error: e.message }, 502); }
}

/* ---------- 글 다듬기: 맞춤법만(spell) / 문장 다듬기(polish) — Claude ---------- */
const POLISH_MODEL = 'claude-haiku-5-5';
const KIND_HINT = { narration: '나레이션(차분하고 문어체에 가까운 서술)', speech: '말풍선 대사(자연스러운 구어체)', thought: '속마음 독백(짧고 담백하게)', shout: '외침(짧고 강렬하게)', caption: '자막(간결하게)' };
export async function handlePolish(req, env) {
  if (req.method !== 'POST') return json({ error: 'POST만 됩니다' }, 405);
  if (!authed(req, env)) return json({ error: '관리자 인증 실패' }, 401);
  try {
    const key = env[ENV.anthropic]; if (!key) return json({ error: 'ANTHROPIC_API_KEY 없음', kind: 'auth' }, 502);
    const b = await req.json();
    const text = String(b.text || '').slice(0, 2000);
    if (!text.trim()) return json({ error: '텍스트가 비었습니다' }, 400);
    const spell = b.mode !== 'polish';
    const system = '당신은 한국어 웹툰·무빙툰 대본 편집자입니다. 사용자가 준 글만 고쳐서 결과 문장만 출력하세요. 설명, 따옴표, 머리말을 붙이지 마세요. 줄바꿈은 그대로 유지하세요. ' +
      (spell
        ? '맞춤법, 띄어쓰기, 문장부호 오류만 바로잡고 단어와 어투는 바꾸지 마세요. 고칠 곳이 없으면 원문 그대로 출력하세요.'
        : '의미와 분량은 비슷하게 유지하면서 문장을 더 매끄럽고 생생하게 다듬고, 맞춤법도 바로잡으세요. 글의 종류: ' + (KIND_HINT[b.kind] || '대사') + '. 말투(존댓말/반말)는 원문을 따르세요.');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: POLISH_MODEL, max_tokens: 1000, system, messages: [{ role: 'user', content: text }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: j.error?.message || 'HTTP ' + r.status, kind: r.status === 429 ? 'rate' : r.status === 401 ? 'auth' : 'bad' }, 502);
    const out = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    if (!out) return json({ error: '결과가 비었습니다' }, 502);
    return json({ text: out, model: POLISH_MODEL });
  } catch (e) { return json({ error: e.message }, 502); }
}

/* ---------- 로그인 확인 / 음성(OpenAI TTS) ---------- */
export async function handleAdmin(req, env) {
  return authed(req, env) ? json({ ok: true }) : json({ error: '비밀번호가 맞지 않습니다' }, 401);
}
/* Gemini TTS 는 16bit 24kHz 모노 PCM 을 주므로 WAV 헤더를 붙여 돌려준다 */
function pcmToWav(pcm, rate = 24000) {
  const h = new DataView(new ArrayBuffer(44)), w = (o, t) => [...t].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); h.setUint32(4, 36 + pcm.length, true); w(8, 'WAVEfmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, 'data'); h.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length); out.set(new Uint8Array(h.buffer)); out.set(pcm, 44); return out;
}
async function geminiTts(env, b) {
  const key = env[ENV.gemini]; if (!key) return json({ error: 'GEMINI_API_KEY 없음', kind: 'auth' }, 502);
  const model = b.model || 'gemini-2.5-flash-preview-tts';
  const text = String(b.text || '').slice(0, 4000), style = String(b.instructions || '').slice(0, 500);
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: style ? style + ': ' + text : text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: b.voice || 'Kore' } } } },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: j.error?.message || 'HTTP ' + r.status, kind: r.status === 429 ? 'rate' : r.status === 401 || r.status === 403 ? 'auth' : 'bad' }, 502);
  const d = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData || p.inline_data);
  const data = (d?.inlineData || d?.inline_data)?.data;
  if (!data) return json({ error: '음성이 반환되지 않았습니다 (' + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || '이유 불명') + ')', kind: 'empty' }, 502);
  return json({ key: await r2Put(env, pcmToWav(unb64(data)), 'audio/wav', 'wav') });
}
export async function handleTts(req, env) {
  if (req.method !== 'POST') return json({ error: 'POST만 됩니다' }, 405);
  if (!authed(req, env)) return json({ error: '관리자 인증 실패' }, 401);
  try {
    const b = await req.json();
    if (b.provider === 'gemini') return await geminiTts(env, b);
    if (b.provider !== 'openai') return json({ error: '이 서버는 OpenAI·Gemini 음성만 지원합니다 (일레븐랩스 미구현)' }, 400);
    const key = env[ENV.openai]; if (!key) return json({ error: 'OPENAI_API_KEY 없음', kind: 'auth' }, 502);
    const body = { model: b.model || 'gpt-4o-mini-tts', voice: b.voice || 'coral', input: String(b.text || '').slice(0, 4000), speed: +b.speed || 1, response_format: 'mp3' };
    if (b.instructions && !/^tts-1/.test(body.model)) body.instructions = String(b.instructions).slice(0, 1000);
    const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return json({ error: j.error?.message || 'HTTP ' + r.status, kind: r.status === 429 ? 'rate' : 'bad' }, 502); }
    return json({ key: await r2Put(env, await r.arrayBuffer(), 'audio/mpeg', 'mp3') });
  } catch (e) { return json({ error: e.message }, 502); }
}

/* 단독 Worker 로 쓸 때 */
export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (p === '/api/image') return handleImage(req, env);
    if (p === '/api/kling') return handleKling(req, env);
    if (p === '/api/file') return handleFile(req, env);
    if (p === '/api/projects') return handleProjects(req, env);
    if (p === '/api/usage') return handleUsage(req, env);
    if (p === '/api/tts') return handleTts(req, env);
    if (p === '/api/admin') return handleAdmin(req, env);
    if (p === '/api/polish') return handlePolish(req, env);
    return json({ error: 'not found' }, 404);
  },
};
