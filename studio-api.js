// 무빙툰 스튜디오 서버 API — 사주 무빙툰 관리자 페이지와 같은 규칙으로 동작한다.
//   · 인증: Authorization: Bearer <관리자 비밀번호>  (기존 /api/admin 과 같은 값)
//   · 파일: R2 에 저장하고 키를 돌려준다 → 기존 GET /api/clipfile?k=<키> 로 내려받는다
//   · 오류: { error } JSON (+ 이미지는 attempts, 폴백 결과는 /api/ai 와 같은 { provider, model, attempts })
//
// 기존 /api/clipfile, /api/tts 는 이미 있으므로 여기서는 /api/image, /api/kling 두 개만 추가한다.
//
// 연결 (Cloudflare Pages Functions 예):
//   functions/api/image.js  →  import { handleImage } from '../../studio-api.js'; export const onRequest = c => handleImage(c.request, c.env);
//   functions/api/kling.js  →  import { handleKling } from '../../studio-api.js'; export const onRequest = c => handleKling(c.request, c.env);
// 단독 Worker 로 쓰면 아래 default export 의 fetch 가 두 경로를 나눠 준다.
//
// 환경변수·바인딩 이름은 기존 함수에 맞게 아래 ENV 에서 바꾸세요.
const ENV = {
  pw: 'ADMIN_PASSWORD',      // 관리자 비밀번호
  bucket: 'CLIPS',           // R2 버킷 바인딩 (기존 /api/clipfile 이 쓰는 것과 같은 버킷)
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  klAK: 'KLING_ACCESS_KEY',
  klSK: 'KLING_SECRET_KEY',
  klBase: 'KLING_API_BASE',  // 선택. 기본 https://api-singapore.klingai.com
};
// 기존 /api/clipfile 이 특정 접두어의 키만 내려준다면 거기에 맞추세요.
const KEY_PREFIX = 'studio/';

const NO_TEXT = 'Strictly no text of any kind: no letters, no speech balloons, no captions, no sound-effect lettering, no watermark.';

/* ---------- 공통 ---------- */
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
function authed(req, env) {
  const want = env[ENV.pw];
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return !!want && got === want;
}
const bucket = env => { const b = env[ENV.bucket]; if (!b) throw new Error(`R2 바인딩 ${ENV.bucket} 이 없습니다`); return b; };
function newKey(ext) { return `${KEY_PREFIX}${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${ext}`; }
async function r2Put(env, data, type, ext) {
  const key = newKey(ext);
  await bucket(env).put(key, data, { httpMetadata: { contentType: type } });
  return key;
}
async function r2Get(env, key) {
  const o = await bucket(env).get(key);
  if (!o) throw Object.assign(new Error('파일을 찾지 못했습니다: ' + key), { status: 400 });
  return { bytes: new Uint8Array(await o.arrayBuffer()), type: o.httpMetadata?.contentType || 'image/jpeg' };
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

export async function handleKling(req, env) {
  if (!authed(req, env)) return json({ error: '관리자 인증 실패' }, 401);
  try {
    if (req.method === 'POST') {
      const b = await req.json();
      const img = await r2Get(env, String(b.image || ''));
      const body = {
        model_name: b.model || 'kling-v2-1',
        image: b64(img.bytes),
        prompt: String(b.prompt || '').slice(0, 2500),
        negative_prompt: String(b.negative || '').slice(0, 2500),
        cfg_scale: 0.5, mode: b.mode === 'pro' ? 'pro' : 'std', duration: b.duration === '10' ? '10' : '5',
      };
      if (b.tail) body.image_tail = b64((await r2Get(env, String(b.tail))).bytes);
      const d = await kling(env, '/v1/videos/image2video', { method: 'POST', body: JSON.stringify(body) });
      return json({ taskId: d.task_id });
    }
    if (req.method === 'GET') {
      const id = new URL(req.url).searchParams.get('id');
      if (!id) return json({ error: 'id 가 없습니다' }, 400);
      // 이미 R2 로 옮겼으면 다시 받지 않는다
      const saved = await bucket(env).head(doneKey(id));
      if (saved) return json({ status: 'succeed', key: doneKey(id), duration: +(saved.customMetadata?.duration || 0) || undefined });
      const d = await kling(env, '/v1/videos/image2video/' + encodeURIComponent(id));
      if (d.task_status === 'succeed') {
        const v = d.task_result?.videos?.[0];
        if (!v?.url) return json({ status: 'failed', error: '결과 영상 주소가 없습니다' });
        const r = await fetch(v.url);
        if (!r.ok) return json({ status: 'processing', error: '완성 영상 내려받기 재시도 중 (' + r.status + ')' });
        await bucket(env).put(doneKey(id), await r.arrayBuffer(), { httpMetadata: { contentType: 'video/mp4' }, customMetadata: { duration: String(v.duration || '') } });
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

/* 단독 Worker 로 쓸 때 */
export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (p === '/api/image') return handleImage(req, env);
    if (p === '/api/kling') return handleKling(req, env);
    return json({ error: 'not found' }, 404);
  },
};
