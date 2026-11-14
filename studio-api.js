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
  open: 'OPEN_ACCESS',       // 'true' 면 비밀번호 없이 누구나 사용 (비용·데이터 노출 주의)
  sbAnon: 'SUPABASE_ANON_KEY',     // 공개용 anon 키 (브라우저의 Google 로그인에 쓰임. 비밀 아님)
  allow: 'ALLOWED_EMAILS',          // 선택. 쉼표로 구분한 이메일만 사용 허용 (예: me@gmail.com,friend@gmail.com)
  pw: 'ADMIN_PASSWORD',      // 관리자 비밀번호
  sbUrl: 'SUPABASE_URL',                   // https://xxxx.supabase.co
  sbKey: 'SUPABASE_SERVICE_ROLE_KEY',      // service_role 키 (서버 전용 비밀)
  sbBucket: 'SUPABASE_BUCKET',             // 선택. 기본 studio (비공개 버킷)
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  eleven: 'ELEVENLABS_API_KEY',     // 일레븐랩스 음성
  typecast: 'TYPECAST_API_KEY',     // 타입캐스트 음성 (한국어 캐릭터 목소리)
  gcTts: 'GOOGLE_TTS_API_KEY',      // 선택. Google Cloud Text-to-Speech (없으면 GEMINI_API_KEY 로 시도 — 그 프로젝트에서 TTS API 를 켜야 함)
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
async function readObject(req) {
  let value;
  try { value = await req.json(); }
  catch { throw Object.assign(new Error('잘못된 JSON'), { status: 400 }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('JSON 객체가 필요합니다'), { status: 400 });
  }
  return value;
}
/* 인증: ① Supabase(Google) 로그인 토큰 → 사용자별 ② OPEN_ACCESS=true → 누구나 ③ 관리자 비밀번호. 실패하면 null.
   돌려주는 who = { uid, email } (uid 가 null 이면 공용 영역) */
const tokCache = new Map();
async function authUser(req, env) {
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const base = (env[ENV.sbUrl] || '').replace(/\/+$/, ''), anon = env[ENV.sbAnon];
  if (got.split('.').length === 3 && base && anon) {
    const hit = tokCache.get(got);
    if (hit && hit.exp > Date.now()) return hit.who;
    try {
      const r = await fetch(base + '/auth/v1/user', { headers: { apikey: anon, Authorization: 'Bearer ' + got } });
      if (r.ok) {
        const u = await r.json(), email = String(u.email || '').toLowerCase(), list = String(env[ENV.allow] || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
        if (!list.length || list.includes(email)) {
          const who = { uid: u.id, email };
          if (tokCache.size > 300) tokCache.clear();
          tokCache.set(got, { who, exp: Date.now() + 60000 });
          return who;
        }
      }
    } catch (e) { /* 아래 다른 방식으로 계속 */ }
  }
  if (String(env[ENV.open] || '').toLowerCase() === 'true') return { uid: null, email: '' };
  const want = env[ENV.pw];
  if (want && got === want) return { uid: null, email: '', admin: true };
  return null;
}
function sb(env) {
  const url = (env[ENV.sbUrl] || '').replace(/\/+$/, ''), key = env[ENV.sbKey];
  if (!url || !key) throw new Error(ENV.sbUrl + ' / ' + ENV.sbKey + ' 가 설정되지 않았습니다');
  return { url, h: { apikey: key, Authorization: 'Bearer ' + key }, bucket: env[ENV.sbBucket] || 'studio' };
}
const objURL = (c, key, mid = '') => c.url + '/storage/v1/object/' + mid + c.bucket + '/' + key.split('/').map(encodeURIComponent).join('/');
const userDir = who => (who && who.uid ? who.uid + '/' : '');
const UUID_DIR = /^studio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;
function newKey(ext, who) { return KEY_PREFIX + userDir(who) + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8) + '.' + ext; }
const safeKey = (k, who) => {
  k = String(k || ''); if (!k.startsWith(KEY_PREFIX) || k.includes('..')) throw Object.assign(new Error('잘못된 파일 키'), { status: 400 });
  if (UUID_DIR.test(k) && !(who && who.uid && k.startsWith(KEY_PREFIX + userDir(who)))) throw Object.assign(new Error('이 파일에 접근할 수 없습니다'), { status: 403 }); // 남의 폴더 차단
  return k;
};
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
async function r2Put(env, data, type, ext, who) { return filePut(env, newKey(ext, who), data, type); }
async function r2Get(env, key, who) {
  const f = await fileGet(env, safeKey(key, who));
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
async function openaiImage(env, { prompt, refs, size, quality, model, mask }) {
  const key = env[ENV.openai]; if (!key) throw new GenError('auth', 'OPENAI_API_KEY 없음');
  let res;
  if (refs.length) {
    const fd = new FormData();
    fd.append('model', model); fd.append('prompt', prompt); fd.append('n', '1'); fd.append('size', size); fd.append('quality', quality);
    refs.forEach((r, i) => fd.append('image[]', new Blob([r.bytes], { type: r.type }), `ref${i + 1}.${/png/.test(r.type) ? 'png' : 'jpg'}`));
    if (mask) fd.append('mask', new Blob([mask.bytes], { type: 'image/png' }), 'mask.png');
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
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  let body; try { body = await readObject(req); } catch (e) { return json({ error: '잘못된 JSON' }, 400); }
  if (body.refs !== undefined && (!Array.isArray(body.refs) || body.refs.some(k => typeof k !== 'string'))) return json({ error: 'refs 는 파일 키 배열이어야 합니다' }, 400);
  const prompt = String(body.prompt || '').slice(0, 30000);
  if (!prompt) return json({ error: 'prompt 가 비었습니다' }, 400);
  const order = (Array.isArray(body.order) && body.order.length ? body.order : ['openai', 'gemini']).filter(p => p === 'openai' || p === 'gemini');
  if (!order.length) return json({ error: '지원하는 이미지 엔진이 없습니다' }, 400);
  if (body.mask !== undefined && (typeof body.mask !== 'string' || !body.refs?.length)) return json({ error: 'mask 는 참조 이미지와 함께 파일 키로 전달해야 합니다' }, 400);
  let refs, mask;
  try { if (body.mask) mask = await r2Get(env, body.mask, who); refs = await Promise.all((body.refs || []).slice(0, 16).map(k => r2Get(env, String(k), who))); }
  catch (e) { return json({ error: e.message }, 400); }

  const attempts = [];
  for (const provider of order) {
    const t0 = Date.now();
    const model = provider === 'openai' ? (body.oaModel || 'gpt-image-2') : (body.gmModel || 'gemini-2.5-flash-image');
    try {
      const img = provider === 'openai'
        ? await openaiImage(env, { prompt, refs, size: body.size || '1024x1536', quality: body.quality || 'medium', model, mask })
        : await geminiImage(env, { prompt, refs, aspect: body.aspect || '9:16', model });
      attempts.push({ provider, model, ok: true, ms: Date.now() - t0 });
      const key = await r2Put(env, img.bytes, img.type, /jpe?g/.test(img.type) ? 'jpg' : /webp/.test(img.type) ? 'webp' : 'png', who);
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
const doneKey = (id, who) => `${KEY_PREFIX}${userDir(who)}kling/${String(id).replace(/[^\w-]/g, '')}.mp4`;

/* 새 API: POST /image-to-video/<model> {contents, settings}, 조회 GET /tasks?task_ids= → data[0].status / outputs[].url */
async function klingNew(env, path, opt = {}) {
  const base = (env[ENV.klBase] || 'https://api-singapore.klingai.com').replace(/\/+$/, '');
  const r = await fetch(base + path, { ...opt, headers: { Authorization: 'Bearer ' + env[ENV.klKey], 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code !== undefined && j.code !== 0)) throw new GenError(r.status === 429 ? 'rate' : r.status === 401 ? 'auth' : 'bad', (j.message || 'HTTP ' + r.status) + ' (code ' + (j.code ?? r.status) + ')');
  return j.data;
}
/* 캐릭터(Element) = 외형 이미지 + 목소리. 영상 요청에 element 로 붙이면 같은 얼굴·목소리로 나온다.
   GET ?op=voices → 클링 기본 목소리 목록 / POST {op:'element'} → 등록 시작(taskId) / GET ?op=element&id= → 등록 결과(elementId) */
/* 비공개 저장소 파일을 클링이 내려받을 수 있게 1시간짜리 서명 주소를 만든다 */
async function signedUrl(env, key) {
  const c = sb(env);
  const r = await fetch(c.url + '/storage/v1/object/sign/' + c.bucket + '/' + key.split('/').map(encodeURIComponent).join('/'), { method: 'POST', headers: { ...c.h, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600 }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.signedURL) throw new Error('서명 주소를 만들지 못했습니다: ' + (j.message || j.error || r.status));
  return c.url + '/storage/v1' + j.signedURL;
}
async function handleKlingElement(req, env, who, op) {
  if (op === 'voices' && req.method === 'GET') {
    const pick = (list, own) => (Array.isArray(list) ? list : []).flatMap(t => t.task_result?.voices || []).map(v => ({ id: v.voice_id, name: v.voice_name + (own ? ' (내 목소리)' : ''), trial: v.trial_url, own }));
    const mine = await klingNew(env, '/v1/general/custom-voices?pageNum=1&pageSize=500').catch(() => []);
    const preset = await klingNew(env, '/v1/general/presets-voices?pageNum=1&pageSize=500');
    return json({ voices: [...pick(mine, true), ...pick(preset, false)] });
  }
  if (op === 'voicedel' && req.method === 'POST') {
    const b = await readObject(req);
    if (!b.voiceId) return json({ error: 'voiceId 가 없습니다' }, 400);
    await klingNew(env, '/v1/general/delete-voices', { method: 'POST', body: JSON.stringify({ voice_id: String(b.voiceId) }) });
    return json({ ok: true });
  }
  if (op === 'voice' && req.method === 'POST') {
    const b = await readObject(req);
    const d = await klingNew(env, '/v1/general/custom-voices', { method: 'POST', body: JSON.stringify({ voice_name: String(b.name || '내 목소리').slice(0, 20), voice_url: await signedUrl(env, safeKey(b.key, who)) }) });
    return json({ taskId: d.task_id });
  }
  if (op === 'voice' && req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return json({ error: 'id 가 없습니다' }, 400);
    const d = await klingNew(env, '/v1/general/custom-voices/' + encodeURIComponent(id));
    if (d?.task_status === 'succeed') {
      const v = d.task_result?.voices?.[0];
      return v?.voice_id ? json({ status: 'succeed', voice: { id: v.voice_id, name: v.voice_name, trial: v.trial_url, own: true } }) : json({ status: 'failed', error: '결과에 voice_id 가 없습니다' });
    }
    if (d?.task_status === 'failed') return json({ status: 'failed', error: d.task_status_msg || '클링에서 목소리 등록에 실패했습니다' });
    return json({ status: d?.task_status || 'processing' });
  }
  if (op === 'element' && req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return json({ error: 'id 가 없습니다' }, 400);
    const d = await klingNew(env, '/v1/general/advanced-custom-elements/' + encodeURIComponent(id));
    if (d?.task_status === 'succeed') {
      const el = d.task_result?.elements?.[0];
      return el?.element_id ? json({ status: 'succeed', elementId: String(el.element_id) }) : json({ status: 'failed', error: '결과에 element_id 가 없습니다' });
    }
    if (d?.task_status === 'failed') return json({ status: 'failed', error: d.task_status_msg || '클링에서 캐릭터 등록에 실패했습니다' });
    return json({ status: d?.task_status || 'processing' });
  }
  if (op === 'element' && req.method === 'POST') {
    const b = await readObject(req);
    const img = async k => b64((await r2Get(env, String(k || ''), who)).bytes);
    const refers = (Array.isArray(b.refers) && b.refers.length ? b.refers : [b.frontal]).slice(0, 3);
    const d = await klingNew(env, '/v1/general/advanced-custom-elements', { method: 'POST', body: JSON.stringify({
      element_name: String(b.name || '').slice(0, 20),
      element_description: String(b.desc || b.name || '').slice(0, 100),
      reference_type: 'image_refer',
      element_image_list: { frontal_image: await img(b.frontal), refer_images: await Promise.all(refers.map(async k => ({ image_url: await img(k) }))) },
      element_voice_id: String(b.voiceId || ''),
      tag_list: [{ tag_id: 'o_102' }],
    }) });
    return json({ taskId: d.task_id });
  }
  return json({ error: '지원하지 않는 요청입니다' }, 405);
}
async function handleKlingNew(req, env, who) {
  const op = new URL(req.url).searchParams.get('op') || (req.method === 'POST' ? await readObject(req.clone()).then(j => j.op) : '');
  if (op === 'voices' || op === 'element' || op === 'voice' || op === 'voicedel') return handleKlingElement(req, env, who, op);
  if (req.method === 'POST') {
    const b = await readObject(req);
    const img = await r2Get(env, String(b.image || ''), who);
    const model = /^kling-\d/.test(b.model || '') ? b.model : 'kling-3.0'; // 옛 이름(kling-v2-1)은 새 API 에 없으니 3.0 으로
    const prompt = String(b.prompt || '') + (b.negative ? '\n\nAvoid: ' + b.negative : '');
    const contents = [{ type: 'prompt', text: prompt.slice(0, 2500) }, { type: 'first_frame', url: b64(img.bytes) }];
    if (b.tail) contents.push({ type: 'last_frame', url: b64((await r2Get(env, String(b.tail), who)).bytes) });
    (Array.isArray(b.elements) ? b.elements : []).slice(0, 3).forEach((e, i) => contents.push({ type: 'element', element_id: String(e.id), id: 'element_' + (i + 1) }));
    const d = await klingNew(env, '/image-to-video/' + encodeURIComponent(model), { method: 'POST', body: JSON.stringify({
      contents,
      settings: { resolution: b.mode === 'pro' ? '1080p' : '720p', duration: Math.min(15, Math.max(3, +b.duration || 5)), audio: b.audio ? 'native' : 'off', multi_shot: false },
      options: { watermark_info: { enabled: false } },
    }) });
    return json({ taskId: d.id });
  }
  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return json({ error: 'id 가 없습니다' }, 400);
    const meta = await fileGet(env, doneKey(id, who) + '.json');
    if (meta) return json({ status: 'succeed', key: doneKey(id, who), duration: +(await meta.res.json().catch(() => ({}))).duration || undefined });
    const t = (await klingNew(env, '/tasks?task_ids=' + encodeURIComponent(id)))?.[0];
    if (!t) return json({ status: 'processing' });
    if (t.status === 'succeeded') {
      const v = t.outputs?.find(o => o.type === 'video');
      if (!v?.url) return json({ status: 'failed', error: '결과 영상 주소가 없습니다' });
      const r = await fetch(v.url);
      if (!r.ok) return json({ status: 'processing', error: '완성 영상 내려받기 재시도 중 (' + r.status + ')' });
      await filePut(env, doneKey(id, who), await r.arrayBuffer(), 'video/mp4');
      await filePut(env, doneKey(id, who) + '.json', JSON.stringify({ duration: +v.duration || 0 }), 'application/json');
      return json({ status: 'succeed', key: doneKey(id, who), duration: +v.duration || undefined });
    }
    if (t.status === 'failed') return json({ status: 'failed', error: t.message || '클링에서 실패로 처리했습니다' });
    return json({ status: t.status || 'processing' });
  }
  return json({ error: 'GET 또는 POST만 됩니다' }, 405);
}

export async function handleKling(req, env) {
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    if (env[ENV.klKey]) return await handleKlingNew(req, env, who);
    if (req.method === 'POST') {
      const b = await readObject(req);
      const img = await r2Get(env, String(b.image || ''), who);
      const body = {
        model_name: b.model || 'kling-v2-1',
        image: b64(img.bytes),
        prompt: String(b.prompt || '').slice(0, 2500),
        negative_prompt: String(b.negative || '').slice(0, 2500),
        cfg_scale: 0.5, mode: b.mode === 'pro' ? 'pro' : 'std', duration: +b.duration >= 8 ? '10' : '5', // 옛 API 는 5·10초만 (새 API 는 3~15초)
      };
      if (b.tail) body.image_tail = b64((await r2Get(env, String(b.tail), who)).bytes);
      const d = await kling(env, '/v1/videos/image2video', { method: 'POST', body: JSON.stringify(body) });
      return json({ taskId: d.task_id });
    }
    if (req.method === 'GET') {
      const id = new URL(req.url).searchParams.get('id');
      if (!id) return json({ error: 'id 가 없습니다' }, 400);
      // 이미 Storage 로 옮겼으면 다시 받지 않는다
      const meta = await fileGet(env, doneKey(id, who) + '.json');
      if (meta) return json({ status: 'succeed', key: doneKey(id, who), duration: +(await meta.res.json().catch(() => ({}))).duration || undefined });
      const d = await kling(env, '/v1/videos/image2video/' + encodeURIComponent(id));
      if (d.task_status === 'succeed') {
        const v = d.task_result?.videos?.[0];
        if (!v?.url) return json({ status: 'failed', error: '결과 영상 주소가 없습니다' });
        const r = await fetch(v.url);
        if (!r.ok) return json({ status: 'processing', error: '완성 영상 내려받기 재시도 중 (' + r.status + ')' });
        await filePut(env, doneKey(id, who), await r.arrayBuffer(), 'video/mp4');
        await filePut(env, doneKey(id, who) + '.json', JSON.stringify({ duration: v.duration || 0 }), 'application/json');
        return json({ status: 'succeed', key: doneKey(id, who), duration: +v.duration || undefined });
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
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    const u = new URL(req.url);
    if (req.method === 'POST') {
      const name = u.searchParams.get('name') || 'file.bin';
      const ext = (name.match(/\.([a-z0-9]{2,5})$/i)?.[1] || 'bin').toLowerCase();
      const type = req.headers.get('content-type') || 'application/octet-stream';
      return json({ key: await r2Put(env, await req.arrayBuffer(), type, ext, who) });
    }
    if (req.method === 'GET') {
      const f = await fileGet(env, safeKey(u.searchParams.get('k'), who));
      if (!f) return json({ error: '파일 없음' }, 404);
      return new Response(f.body, { headers: { 'content-type': f.type, 'cache-control': 'private, max-age=3600' } });
    }
    return json({ error: 'GET 또는 POST만 됩니다' }, 405);
  } catch (e) { return json({ error: e.message }, e.status || 502); }
}

/* ---------- 프로젝트: 목록 / 읽기 / 저장 / 이름변경 / 삭제 (테이블 projects, 로그인한 사용자별로 분리) ---------- */
export async function handleProjects(req, env) {
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    const id = new URL(req.url).searchParams.get('id'), q = encodeURIComponent;
    const own = who.uid ? 'owner=eq.' + q(who.uid) : 'owner=is.null';
    if (req.method === 'GET' && !id) return json({ projects: await db(env, 'projects?' + own + '&select=id,title,updated_at,thumb&order=updated_at.desc&limit=200'), user: who.email || null });
    if (req.method === 'GET') {
      const rows = await db(env, 'projects?id=eq.' + q(id) + '&' + own + '&select=id,title,data,updated_at,thumb');
      return rows?.[0] ? json(rows[0]) : json({ error: '프로젝트 없음' }, 404);
    }
    if (req.method === 'PUT') {
      const b = await readObject(req);
      const pid = String(b.id || crypto.randomUUID());
      if (b.id) { // 남의 프로젝트를 덮어쓰지 못하게
        const ex = await db(env, 'projects?id=eq.' + q(pid) + '&select=id,owner');
        if (ex?.[0] && (ex[0].owner || null) !== (who.uid || null)) return json({ error: '이 프로젝트에 접근할 수 없습니다' }, 403);
      }
      const row = { id: pid, owner: who.uid || null, title: String(b.title || '새 무빙툰').slice(0, 200), data: b.data || {}, updated_at: new Date().toISOString() };
      if (b.thumb) row.thumb = String(b.thumb).slice(0, 80000);
      await db(env, 'projects?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
      return json({ id: pid });
    }
    if (req.method === 'PATCH') {
      if (!id) return json({ error: 'id 가 없습니다' }, 400);
      const b = await readObject(req);
      await db(env, 'projects?id=eq.' + q(id) + '&' + own, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ title: String(b.title || '새 무빙툰').slice(0, 200), updated_at: new Date().toISOString() }) });
      return json({ ok: true });
    }
    if (req.method === 'DELETE') {
      if (!id) return json({ error: 'id 가 없습니다' }, 400);
      await db(env, 'projects?id=eq.' + q(id) + '&' + own, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json({ ok: true });
    }
    return json({ error: '지원하지 않는 메서드' }, 405);
  } catch (e) { return json({ error: e.message }, e.status || 502); }
}

/* ---------- 사용량·비용 기록 (테이블 usage_log) ---------- */
export async function handleUsage(req, env) {
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    if (req.method === 'POST') {
      const b = await readObject(req);
      await db(env, 'usage_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
        owner: who.uid || null, project_id: b.project_id || null, kind: String(b.kind || '').slice(0, 40), provider: String(b.provider || '').slice(0, 40),
        ok: !!b.ok, cost: +b.cost || 0, ms: +b.ms || null, error: b.msg ? String(b.msg).slice(0, 400) : null,
      }) });
      return json({ ok: true });
    }
    if (req.method === 'GET') {
      const pid = new URL(req.url).searchParams.get('project_id'), own = who.uid ? 'owner=eq.' + encodeURIComponent(who.uid) : 'owner=is.null';
      const rows = await db(env, 'usage_log?' + own + '&select=created_at,kind,provider,ok,cost,ms,error&order=created_at.desc&limit=200' + (pid ? '&project_id=eq.' + encodeURIComponent(pid) : ''));
      return json({ rows, total: rows.reduce((a, r) => a + (r.ok ? +r.cost || 0 : 0), 0) });
    }
    return json({ error: 'GET 또는 POST만 됩니다' }, 405);
  } catch (e) { return json({ error: e.message }, e.status || 502); }
}

/* ---------- 브라우저용 공개 설정 (Google 로그인에 쓰는 URL·anon 키: 둘 다 공개 값) ---------- */
export async function handleConfig(req, env) {
  const url = env[ENV.sbUrl] || '', anon = env[ENV.sbAnon] || '';
  return json({ google: !!(url && anon), url, anon, open: String(env[ENV.open] || '').toLowerCase() === 'true' });
}

/* ---------- 글 다듬기: 맞춤법만(spell) / 문장 다듬기(polish) — Claude ---------- */
const POLISH_MODEL = 'claude-haiku-5-5';
const KIND_HINT = { narration: '나레이션(차분하고 문어체에 가까운 서술)', speech: '말풍선 대사(자연스러운 구어체)', thought: '속마음 독백(짧고 담백하게)', shout: '외침(짧고 강렬하게)', caption: '자막(간결하게)' };
export async function handlePolish(req, env) {
  if (req.method !== 'POST') return json({ error: 'POST만 됩니다' }, 405);
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    const key = env[ENV.anthropic]; if (!key) return json({ error: 'ANTHROPIC_API_KEY 없음', kind: 'auth' }, 502);
    const b = await readObject(req);
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
  } catch (e) { return json({ error: e.message }, e.status || 502); }
}

/* ---------- 프롬프트 변환: 거친 초안(한국어 등)을 이미지·수정·영상 모델이 잘 알아듣는 영어 프롬프트로 바꾼다 — Claude ---------- */
const PROMPT_MODEL = 'claude-sonnet-5-5';
const PROMPT_COMMON = 'You are a prompt engineer for AI image and video generators that produce webtoon and motion-comic frames. The user writes a rough draft, usually in Korean and often vague or colloquial. Rewrite it into a precise English prompt. ' +
  'Keep every concrete fact the user stated (who, what, where, emotion, props, camera, lighting) and never contradict it. Resolve vague parts with sensible, cinematic webtoon choices instead of leaving them open. ' +
  'Left/right words, including Korean "카메라 오른쪽" or "화면 왼쪽", mean the left/right side AS SEEN IN THE IMAGE; "카메라를 바라본다" means looking straight into the lens. ' +
  'Refer to characters by the given names; do not re-describe their appearance (reference sheets are attached separately) and do not invent clothing or features that conflict with the given descriptions. ' +
  'Do not add text, speech balloons, captions or sound-effect lettering. Do not add characters, objects or story the user did not ask for. Do not mention art style (it is added separately). ' +
  'Reply with ONLY JSON, no markdown: {"prompt": "...", "note": "..."} where note is ONE short Korean sentence (max 70 characters) explaining how you interpreted anything ambiguous, or an empty string if nothing was ambiguous.';
const PROMPT_TASK = {
  scene: 'Task: write the SCENE prompt for ONE still frame (see "aspect"). Use 3-6 sentences covering: shot size and camera angle, composition (where each character and key object sits in the frame), pose and action, facial expression and gaze direction of each character, setting and time of day, lighting and mood. Merge the "extra" request into the scene. If has_image is true the frame is regenerated from an existing image; still describe the full intended scene.',
  edit: 'Task: write an EDIT INSTRUCTION to apply to an existing image. Output one or two imperative sentences stating exactly what to change (and where in the frame). Do not describe the unchanged parts of the picture.',
  mix: 'Task: write a COMPOSITING INSTRUCTION. The first image is the base picture; the other images are ATTACHMENT 1..N (see "attachments" for N). Write 1-3 imperative sentences stating exactly what to take from which ATTACHMENT and where and how to place or apply it in the base picture (position, size, pose, which part of the base to replace or keep). Always call them ATTACHMENT 1, ATTACHMENT 2, ... — Korean wording such as "첨부 1", "두 번째 첨부", "첨부한 이미지" maps to these numbers (an unnumbered "첨부한 이미지" with only one attachment means ATTACHMENT 1). Do not describe parts that stay unchanged.',
  motion: 'Task: write an IMAGE-TO-VIDEO MOTION prompt for a short clip (see "len" seconds) that animates a still frame ("scene" tells you what it shows). Describe only motion over time: character movement and expressions, hair/cloth/environment motion, camera movement (push-in, pan, tilt, handheld shake or static) and pacing, as a short sequence that fits the duration. Keep motion natural and moderate unless the draft asks for dramatic action. Do not change the composition, art style, character design or colors. Do not write dialogue. End the prompt with: Keep the exact same art style, character design and colors. No text.',
};
export async function handlePrompt(req, env) {
  if (req.method !== 'POST') return json({ error: 'POST만 됩니다' }, 405);
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    const key = env[ENV.anthropic]; if (!key) return json({ error: 'ANTHROPIC_API_KEY 없음', kind: 'auth' }, 502);
    const b = await readObject(req);
    const mode = PROMPT_TASK[b.mode] ? b.mode : 'scene', draft = String(b.draft || '').slice(0, 2000);
    if (!draft.trim() && !String(b.extra || '').trim()) return json({ error: '초안이 비었습니다' }, 400);
    const chars = (Array.isArray(b.characters) ? b.characters : []).slice(0, 6).map(c => ({ name: String(c.name || '').slice(0, 40), appearance: String(c.desc || '').slice(0, 300) }));
    const user = JSON.stringify({
      draft, extra: String(b.extra || '').slice(0, 1000), scene: String(b.scene || '').slice(0, 1000), characters: chars,
      aspect: String(b.aspect || '9:16').slice(0, 8), has_image: !!b.hasImage, len: +b.len || 5, audio: !!b.audio, attachments: Math.min(8, +b.attachments || 0),
    });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: PROMPT_MODEL, max_tokens: 1200, system: PROMPT_COMMON + ' ' + PROMPT_TASK[mode], messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: j.error?.message || 'HTTP ' + r.status, kind: r.status === 429 ? 'rate' : r.status === 401 ? 'auth' : 'bad' }, 502);
    const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    let out = null; const m = txt.match(/\{[\s\S]*\}/);
    if (m) { try { out = JSON.parse(m[0]); } catch (e) { out = null; } }
    const prompt = String(out?.prompt || (m ? '' : txt)).trim();
    if (!prompt) return json({ error: 'AI 응답에서 프롬프트를 읽지 못했습니다' }, 502);
    return json({ prompt: prompt.slice(0, 2400), note: String(out?.note || '').slice(0, 140), model: PROMPT_MODEL });
  } catch (e) { return json({ error: e.message }, e.status || 502); }
}

/* ---------- 출판만화 배치: 컷 순서는 그대로 두고 페이지·줄·칸 크기를 Claude 가 정한다 ---------- */
const LAYOUT_MODEL = 'claude-sonnet-5-5';
export async function handleLayout(req, env) {
  if (req.method !== 'POST') return json({ error: 'POST만 됩니다' }, 405);
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    const key = env[ENV.anthropic]; if (!key) return json({ error: 'ANTHROPIC_API_KEY 없음', kind: 'auth' }, 502);
    const b = await readObject(req);
    if (!Array.isArray(b.cuts) || !b.cuts.length || b.cuts.length > 120 || b.cuts.some((c, i) => !c || c.i !== i || !Number.isFinite(c.ratio) || c.ratio <= 0 || (c.texts !== undefined && !Array.isArray(c.texts)))) return json({ error: '컷은 1~120개이며 순서대로 된 인덱스와 양수 비율이 필요합니다' }, 400);
    const cuts = b.cuts.map(c => ({ i: +c.i, ratio: +(+c.ratio).toFixed(3), big: !!c.big, desc: String(c.desc || '').slice(0, 160), texts: (c.texts || []).slice(0, 4), dur: +c.dur || 0 }));
    const system = 'You are an editor who lays out comic (webtoon / manga) pages for print. You receive cuts in reading order. Decide how to group them into pages and rows. ' +
      'Rules: (1) Keep the original order: every cut index 0..N-1 must appear exactly once, in order when reading pages -> rows -> cells left to right. (2) Each page holds 2-5 cuts in 1-4 rows. ' +
      '(3) Row "h" is a relative height weight and cell "w" a relative width weight (any positive numbers). Choose cell widths roughly proportional to (cut ratio x row height) so images are not heavily cropped; you may deviate for emphasis. ' +
      '(4) Emphasis: opening/establishing shots, climactic, shouting or impact cuts (big=true) get their own bigger row; quiet or transition cuts stay small; cuts with a lot of text need enough room. ' +
      '(5) When possible end a page on a suspenseful beat. (6) Reply with ONLY JSON, no markdown: {"pages":[{"rows":[{"h":number,"cells":[{"cut":number,"w":number}]}]}],"reason":"2-3 sentences in Korean explaining the layout"}.';
    const user = JSON.stringify({ page_mm: { w: +b.page?.w || 182, h: +b.page?.h || 257 }, margin_mm: +b.margin || 10, gutter_mm: +b.gutter || 4, reading_direction: b.dir === 'rtl' ? 'right-to-left' : 'left-to-right', cuts });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: LAYOUT_MODEL, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: j.error?.message || 'HTTP ' + r.status, kind: r.status === 429 ? 'rate' : r.status === 401 ? 'auth' : 'bad' }, 502);
    const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const m = txt.match(/\{[\s\S]*\}/); if (!m) return json({ error: 'AI 응답에서 배치를 읽지 못했습니다' }, 502);
    let out; try { out = JSON.parse(m[0]); } catch (e) { return json({ error: 'AI 응답 형식 오류' }, 502); }
    let nextCut = 0;
    const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
    const valid = out && Array.isArray(out.pages) && out.pages.length > 0 && out.pages.length <= cuts.length && out.pages.every(page =>
      page && Array.isArray(page.rows) && page.rows.length > 0 && page.rows.length <= 4 && page.rows.every(row =>
        row && positive(row.h) && Array.isArray(row.cells) && row.cells.length > 0 && row.cells.length <= cuts.length && row.cells.every(cell =>
          cell && positive(cell.w) && Number.isInteger(cell.cut) && cell.cut === nextCut++)));
    if (!valid || nextCut !== cuts.length) return json({ error: 'AI 배치에 컷 누락·중복·순서 또는 크기 오류가 있습니다. 다시 시도해 주세요.' }, 502);
    return json({ pages: out.pages, reason: String(out.reason || '').slice(0, 400), model: LAYOUT_MODEL });
  } catch (e) { return json({ error: e.message }, e.status || 502); }
}

/* ---------- AI 편집 어시스턴트: 타임라인 요약 + 사용자 지시 → Claude 가 편집 도구(tool use)로 수정안을 낸다 ----------
   서버는 수정안(ops)만 돌려주고, 실제 적용·범위 보정·되돌리기는 브라우저가 한다. */
const EDIT_MODEL = 'claude-sonnet-5-5';
const EDIT_TRANS = ['fade', 'cut', 'slide', 'flash'];
const EDIT_MOTION = ['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down', 'shake'];
const EDIT_ANIM = ['pop', 'fade', 'slideUp', 'typewriter', 'shake', 'wipe', 'none'];
const EDIT_KINDS = ['speech', 'rect', 'rrect', 'thought', 'shout', 'flash', 'wavy', 'whisper', 'narration', 'caption'];
const EDIT_COLOR_PROPS = {
  color: { type: 'string', description: '글자색 #RRGGBB' }, fill: { type: 'string', description: '배경(말풍선·나레이션 박스 안쪽)색 #RRGGBB. 자막에서는 쓰이지 않는다' },
  fillA: { type: 'number', description: '배경 불투명도 0~1 (자막은 해당 없음)' }, stroke: { type: 'string', description: '테두리색 #RRGGBB (자막은 글자 외곽선색)' }, strokeW: { type: 'number', description: '테두리 두께 0~12px' },
};
const EDIT_TOOLS = [
  { name: 'set_panel', description: '컷의 길이·전환·카메라 모션을 바꾼다. 바꿀 항목만 넣는다.', input_schema: { type: 'object', required: ['panel'], properties: {
    panel: { type: 'integer', description: '컷 번호(1부터)' }, dur: { type: 'number', description: '컷 길이(초) 0.3~15' },
    trans: { type: 'string', enum: EDIT_TRANS, description: '이 컷으로 들어오는 전환' }, motion: { type: 'string', enum: EDIT_MOTION }, motionAmt: { type: 'number', description: '모션 세기 0~0.3' } } } },
  { name: 'fit_reading_time', description: '글(말풍선·자막)을 다 읽을 시간이 모자란 컷의 길이를 한 번에 맞춘다(요약의 read_need 기준). 영상 클립이 있는 컷은 건드리지 않는다. 컷이 많을 때는 set_panel을 컷마다 부르지 말고 이것을 쓴다.', input_schema: { type: 'object', properties: {
    panels: { type: 'array', items: { type: 'integer' }, description: '대상 컷 번호들(1부터). 생략하면 전체' }, pad: { type: 'number', description: '글을 다 읽은 뒤 여유(초). 기본 0.4' },
    allow_shorten: { type: 'boolean', description: 'true면 글이 짧아 길이가 남는 컷은 줄인다(최소 2초). 기본 false' } } } },
  { name: 'set_overlay', description: '말풍선·나레이션·자막의 글·등장 시점·길이·애니메이션·크기·색을 바꾼다. 바꿀 항목만 넣는다.', input_schema: { type: 'object', required: ['panel', 'overlay'], properties: {
    panel: { type: 'integer', description: '컷 번호(1부터)' }, overlay: { type: 'integer', description: '그 컷 안 오버레이 번호(1부터)' },
    text: { type: 'string' }, start: { type: 'number', description: '컷 시작 기준 등장 시각(초)' }, dur: { type: 'number', description: '표시 길이(초). 0이면 컷 끝까지' },
    anim: { type: 'string', enum: EDIT_ANIM }, size: { type: 'number', description: '글자 크기 20~140' }, ...EDIT_COLOR_PROPS } } },
  { name: 'style_overlays', description: '같은 종류의 말풍선·나레이션·자막 여러 개의 색·크기를 한 번에 바꾼다(예: 나레이션 박스 전부 남색 배경). 여러 개를 바꿀 때는 set_overlay를 반복하지 말고 이것을 쓴다.', input_schema: { type: 'object', properties: {
    kind: { type: 'string', enum: EDIT_KINDS, description: '대상 종류. 생략하면 모든 종류' }, panels: { type: 'array', items: { type: 'integer' }, description: '대상 컷 번호들(1부터). 생략하면 전체' },
    size: { type: 'number', description: '글자 크기 20~140' }, ...EDIT_COLOR_PROPS } } },
  { name: 'add_overlay', description: '컷에 말풍선·나레이션·자막을 새로 추가한다.', input_schema: { type: 'object', required: ['panel', 'kind', 'text'], properties: {
    panel: { type: 'integer' }, kind: { type: 'string', enum: ['speech', 'thought', 'shout', 'whisper', 'narration', 'caption'] }, text: { type: 'string' },
    start: { type: 'number' }, dur: { type: 'number' }, anim: { type: 'string', enum: EDIT_ANIM }, ...EDIT_COLOR_PROPS } } },
  { name: 'delete_overlay', description: '오버레이를 지운다. 사용자가 지우라고 분명히 말했을 때만 쓴다.', input_schema: { type: 'object', required: ['panel', 'overlay'], properties: { panel: { type: 'integer' }, overlay: { type: 'integer' } } } },
  { name: 'move_panel', description: '컷의 순서를 옮긴다.', input_schema: { type: 'object', required: ['panel', 'to'], properties: { panel: { type: 'integer', description: '옮길 컷 번호(1부터)' }, to: { type: 'integer', description: '옮겨 갈 자리(1부터)' } } } },
  { name: 'set_audio', description: '오디오 트랙(배경음악 등)의 시작·볼륨·페이드를 바꾼다.', input_schema: { type: 'object', required: ['track'], properties: {
    track: { type: 'integer', description: '오디오 트랙 번호(1부터)' }, start: { type: 'number' }, vol: { type: 'number', description: '0~1' }, fadeIn: { type: 'number' }, fadeOut: { type: 'number' } } } },
  { name: 'set_dub', description: '대사 더빙(TTS)을 여러 줄 한꺼번에 고친다: 읽는 사람·감정·말투·음량·음소거. 대상은 speakers/panels/kinds/lines 조합(모두 만족하는 대사). 대상 조건을 하나도 안 주면 대사 전체. 같은 지시를 받는 대사들은 한 번에 묶어 부른다.', input_schema: { type: 'object', properties: {
    speakers: { type: 'array', items: { type: 'string' }, description: '대상 읽는 사람 이름(요약 cast의 name, 예: "나레이터", "백운 도사")' },
    panels: { type: 'array', items: { type: 'integer' }, description: '대상 컷 번호들(1부터)' },
    kinds: { type: 'array', items: { type: 'string', enum: EDIT_KINDS }, description: '대상 말풍선 종류' },
    lines: { type: 'array', items: { type: 'object', properties: { panel: { type: 'integer' }, overlay: { type: 'integer' } } }, description: '특정 대사들(컷 번호, 오버레이 번호)' },
    speaker: { type: 'string', description: '읽는 사람을 이 이름(cast의 name)으로 바꾼다' },
    emotion: { type: 'string', description: '감정 프리셋 이름(요약 emotion_presets 중 하나), "자동"(AI가 판단) 또는 "없음"' },
    intensity: { type: 'number', description: '감정 강도 0~1 (절제된 연기는 0.2~0.5)' },
    note: { type: 'string', description: '구체적인 한국어 말투 지시(예: "낮고 느긋하게, 문장 끝을 무겁게 내려"). 읽는 법을 바꿔 달라는 요청엔 이것을 쓴다' },
    volume: { type: 'number', description: '음성 음량 배율 0~2 (1=그대로)' }, mute: { type: 'boolean', description: '음소거' },
    remake: { type: 'boolean', description: '바뀐 대사의 음성을 바로 다시 만든다(크레딧 사용). 사용자가 음성을 새로 만들라/적용해서 들려 달라고 했을 때만 true' } } } },
  { name: 'make_voices', description: '음성이 없거나(⚠ 설정이 바뀐) 대사의 음성을 만든다(크레딧 사용 · 적용 전에 사용자에게 한 번 확인받음). 대상 생략 시 전체.', input_schema: { type: 'object', properties: {
    panels: { type: 'array', items: { type: 'integer' } }, speakers: { type: 'array', items: { type: 'string' } } } } },
  { name: 'sync_to_voices', description: '대사 등장 시각을 음성 길이(없으면 글 길이)에 맞춰 차례로 배치하고 컷 길이를 맞춘다. 음성을 만든 뒤에 적용된다. 대상 생략 시 전체.', input_schema: { type: 'object', properties: {
    panels: { type: 'array', items: { type: 'integer' } }, hold: { type: 'string', enum: ['end', 'read'], description: 'end=말풍선을 컷 끝까지 남김, read=읽는 동안만' } } } },
  { name: 'add_sfx', description: '효과음·환경음을 만들어 넣는다(크레딧 사용 · 사용자에게 한 번 확인받음). 요약의 audio에 이미 있는 소리는 다시 넣지 않는다. 환경음은 loop=true와 to_panel로 여러 컷에 걸친다.', input_schema: { type: 'object', required: ['items'], properties: {
    items: { type: 'array', maxItems: 30, items: { type: 'object', required: ['panel', 'prompt'], properties: {
      panel: { type: 'integer' }, at: { type: 'number', description: '컷 시작 기준 초' }, to_panel: { type: 'integer', description: '환경음이 끝나는 컷' },
      label: { type: 'string', description: '짧은 한국어 이름' }, prompt: { type: 'string', description: '효과음 생성기용 자세한 영어 설명' },
      dur: { type: 'number', description: '0.5~30초' }, loop: { type: 'boolean' }, vol: { type: 'number', description: '0.2~1' } } } } } } },
  { name: 'plan_sfx', description: '컷 그림과 이야기 흐름을 보는 효과음 전문 AI 에게 효과음·환경음 설계를 맡긴다(사용자가 목록을 확인한 뒤 생성). 전체 편집에서는 add_sfx 대신 이것을 쓴다.', input_schema: { type: 'object', properties: {
    panels: { type: 'array', items: { type: 'integer' }, description: '대상 컷(생략하면 전체)' }, max: { type: 'integer', description: '최대 개수(기본 20)' }, hint: { type: 'string', description: '원하는 소리 방향(선택)' } } } },
  { name: 'compose_bgm', description: '이야기 전개에 맞춘 배경음악 설계를 시작한다(사용자가 설계안을 확인한 뒤 작곡). 배경음악이 없거나 사용자가 원할 때.', input_schema: { type: 'object', properties: {
    hint: { type: 'string', description: '원하는 음악 느낌(선택)' } } } },
];
export async function handleEdit(req, env) {
  if (req.method !== 'POST') return json({ error: 'POST만 됩니다' }, 405);
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    const key = env[ENV.anthropic]; if (!key) return json({ error: 'ANTHROPIC_API_KEY 없음', kind: 'auth' }, 502);
    const b = await readObject(req);
    const instruction = String(b.instruction || '').trim().slice(0, 1000);
    if (!instruction) return json({ error: '지시 내용이 필요합니다' }, 400);
    const sm = b.summary;
    if (!sm || !Array.isArray(sm.panels) || !sm.panels.length || sm.panels.length > 120) return json({ error: '타임라인 요약(컷 1~120개)이 필요합니다' }, 400);
    const history = (Array.isArray(b.history) ? b.history : []).slice(-8).filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string' && h.text).map(h => ({ role: h.role, content: h.text.slice(0, 600) }));
    const system = '당신은 세로형 숏폼 "무빙툰"(컷 이미지 + 말풍선·자막 + 음악) 타임라인을 다루는 영상 편집자입니다. 사용자가 현재 타임라인 요약(JSON)과 수정 지시를 보냅니다. ' +
      '규칙: (1) 반드시 도구로만 수정하고, 컷·오버레이·트랙은 요약에 적힌 번호(1부터)로 가리킵니다. (2) 지시받은 것만 최소한으로 고치고, 요청하지 않은 글·그림·순서는 건드리지 않습니다. ' +
      '(3) 시간 단위는 초이며, 오버레이 등장 시각은 컷 길이 안에 있어야 합니다. 말풍선 글은 읽을 시간(한글 한 글자당 약 0.15초, 최소 1.2초)을 줍니다. ' +
      '색은 #RRGGBB로 지정하고, 글자색과 배경색의 대비를 충분히 두어 읽기 쉽게 합니다(밝은 배경엔 어두운 글자, 어두운 배경엔 밝은 글자). 사용자가 색을 말하면 그 색을 가장 가까운 #RRGGBB로 옮기고, 글자 대비가 나빠지면 글자색도 함께 맞춥니다. 요청하지 않은 색은 바꾸지 않습니다. ' +
      '(4) 사용자는 되묻는 것보다 알아서 판단해 주기를 원합니다. 도구 결과는 언제든 Ctrl+Z로 되돌릴 수 있으니, 지시가 다소 열려 있어도(예: "알아서 다듬어줘") 질문하지 말고 요약을 보고 스스로 문제를 찾아 보수적으로 고칩니다. ' +
      '다듬을 때 볼 것: 글 읽는 시간이 모자란 컷(read_need가 dur보다 큰 컷 → fit_reading_time), 한 컷에서 말풍선이 한꺼번에 뜨거나 겹쳐 읽기 어려운 타이밍, 너무 긴 컷, 음악이 대사를 덮는 볼륨. 사용자가 "그대로 둬"라고 한 항목과 요청하지 않은 글·그림·순서·음악 추가는 건드리지 않습니다. 정말로 진행할 수 없을 때(예: 대상이 전혀 특정되지 않음)만 짧게 한 번 되묻습니다. ' +
      '(5) 이전 대화에서 되물은 질문에 사용자가 답했다면 더 묻지 말고 그 답대로 바로 도구를 호출합니다. (6) 컷이 많으면 컷마다 도구를 부르지 말고 fit_reading_time처럼 한 번에 처리하는 도구를 우선합니다. ' +
      '(7) 마지막에 무엇을 어떻게 바꿨는지, 어떤 가정을 했는지 한국어로 1~3문장으로 알립니다. ' +
      '(8) 더빙(대사 음성): 요약의 cast(나레이터·캐릭터와 목소리·설명)와 각 오버레이의 reader·emotion·voice를 보고 set_dub로 고칩니다. 캐릭터 단위 요청("백운 도사는 더 무겁게")은 speakers로, 장면 단위("7~13컷 긴장감 있게")는 panels로 묶어 한두 번에 처리하고, 대사마다 따로 부르지 않습니다. ' +
      '감정은 emotion_presets 중 가장 가까운 것을 고르고, 미묘한 말투는 note에 구체적으로 적습니다. 캐릭터 나이·성격(cast desc)과 장면 흐름에 맞게, 과장하지 말고 자연스럽게. 사용자가 음성을 새로 만들어 달라고 했을 때만 remake:true를 씁니다(크레딧이 듭니다). ' +
      '(9) 전체 편집("알아서 전체 편집/다듬어", 자동 모드): 영상 전체를 완성도 있게 만듭니다 — ① 어색하거나 빠진 감정·말투를 set_dub로 다듬고 ② 음성이 없거나 ⚠인 대사가 있으면 make_voices ③ 그다음 sync_to_voices로 대사 타이밍과 컷 길이를 음성에 맞추고 ④ 장면에 소리가 비어 있으면 plan_sfx(그림과 이야기 흐름을 보는 효과음 설계)로 꼭 필요한 환경음·효과음만 — 특정 소리를 콕 집어 넣으라는 요청에만 add_sfx ⑤ 배경음악 트랙이 없으면 compose_bgm ⑥ 자막·말풍선 색·크기·전환이 들쭉날쭉하면 정리. ' +
      '이미 잘 된 것은 건드리지 말고, 크레딧이 드는 make_voices·add_sfx·plan_sfx·compose_bgm은 적용 전에 사용자가 한 번 확인합니다. ' +
      '(10) 이야기 흐름 분석([이야기 흐름])이 주어지면 그것이 기준입니다: 감정·말투는 각 대사가 속한 구간의 분위기·긴장도와 캐릭터 감정 흐름에 맞추고, 긴장도가 오르는 구간은 점점 강하게, 해소·여운 구간은 힘을 빼서 에피소드 전체가 하나의 감정선으로 이어지게 합니다.' + (b.auto ? ' [자동 모드] 이번 요청은 질문 없이 반드시 도구로 바로 적용합니다.' : '');
    const arcT = arcText(sm.arc); // 이야기 흐름 분석이 있으면 모든 판단의 기준으로 앞에 둔다
    const user = (arcT ? arcT + '\n(위 이야기 흐름과 캐릭터 감정선에 맞춰 판단하세요)\n\n' : '') + '현재 타임라인:\n' + JSON.stringify({ ...sm, arc: undefined }).slice(0, 150000) + '\n\n지시: ' + instruction;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: EDIT_MODEL, max_tokens: 12000, system, tools: EDIT_TOOLS, messages: [...history, { role: 'user', content: user }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: j.error?.message || 'HTTP ' + r.status, kind: r.status === 429 ? 'rate' : r.status === 401 ? 'auth' : 'bad' }, 502);
    const blocks = j.content || [];
    const ops = blocks.filter(c => c.type === 'tool_use' && c.input && typeof c.input === 'object').slice(0, 60).map(c => ({ tool: c.name, ...c.input }));
    let message = blocks.filter(c => c.type === 'text').map(c => c.text).join('').trim().slice(0, 800);
    const cut = j.stop_reason === 'max_tokens'; // 응답이 길이 한도에서 잘리면 마지막 도구 호출이 빠진다
    if (cut) message = (message ? message + '\n' : '') + '※ 응답이 길어 일부만 적용했습니다. 같은 요청을 한 번 더 보내면 나머지를 이어서 처리합니다.';
    if (!message && !ops.length) message = 'AI가 수정안을 내지 않았습니다. 요청을 조금 더 구체적으로(예: "글 읽는 시간만 맞춰줘") 다시 보내 주세요.';
    return json({ ops, message, truncated: cut, model: EDIT_MODEL });
  } catch (e) { return json({ error: e.message }, e.status || 502); }
}

/* ---------- 대본 자동 자막: 오디오를 Whisper 로 전사(단어별 시각) → 대본이 있으면 Claude 가 대본 문장에 시각을 맞춘다 ----------
   글은 들은 내용보다 대본을 기준으로 하고, 시각만 전사에서 가져온다. 대본이 없으면 전사 구간을 그대로 쓴다.
   요청: multipart { file(오디오), script(선택), lang(기본 ko) } → { captions:[{text,start,end}], duration, source:'script'|'whisper' } (시각은 오디오 파일 기준 초) */
const CAPTION_MODEL = 'claude-sonnet-5-5';
const CAPTION_MAX_BYTES = 25 * 1024 * 1024; // Whisper 업로드 한도
/* 자막 목록 정리: 숫자·순서·겹침을 바로잡고 쓸 수 없는 항목은 버린다 */
export function cleanCaptions(list, duration) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(c => {
    const text = String(c && c.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    let s = +(c && c.start), e = +(c && c.end);
    if (!text || !Number.isFinite(s) || !Number.isFinite(e)) return;
    s = Math.max(0, s); if (duration > 0) e = Math.min(duration, e);
    if (e - s < 0.2) return;
    out.push({ text, start: +s.toFixed(2), end: +e.toFixed(2) });
  });
  out.sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) out[i - 1].end = +Math.max(out[i - 1].start + 0.2, out[i].start).toFixed(2);
  return out.filter(c => c.end - c.start >= 0.2).slice(0, 400);
}
export async function handleCaptions(req, env) {
  if (req.method !== 'POST') return json({ error: 'POST만 됩니다' }, 405);
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    const oaKey = env[ENV.openai]; if (!oaKey) return json({ error: 'OPENAI_API_KEY 없음', kind: 'auth' }, 502);
    let form; try { form = await req.formData(); } catch { return json({ error: 'multipart 형식이 필요합니다' }, 400); }
    const file = form.get('file');
    if (!file || typeof file === 'string' || !file.size) return json({ error: '오디오 파일이 필요합니다' }, 400);
    if (file.size > CAPTION_MAX_BYTES) return json({ error: '오디오가 25MB를 넘습니다. 더 짧게 나누거나 줄여서 올려 주세요.' }, 413);
    const script = String(form.get('script') || '').trim().slice(0, 12000);
    const lang = /^[a-z]{2}$/.test(String(form.get('lang') || '')) ? String(form.get('lang')) : 'ko';
    const fd = new FormData();
    fd.append('file', file, file.name || 'audio.mp3'); fd.append('model', 'whisper-1'); fd.append('language', lang); fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'word'); fd.append('timestamp_granularities[]', 'segment');
    const w = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + oaKey }, body: fd });
    const wj = await w.json().catch(() => ({}));
    if (!w.ok) return json({ error: wj.error?.message || 'HTTP ' + w.status, kind: w.status === 429 ? 'rate' : w.status === 401 ? 'auth' : 'bad' }, 502);
    const duration = +wj.duration || 0;
    const words = (wj.words || []).map(x => ({ w: String(x.word || '').trim(), s: +(+x.start).toFixed(2), e: +(+x.end).toFixed(2) })).filter(x => x.w && Number.isFinite(x.s) && Number.isFinite(x.e));
    const segs = (wj.segments || []).map(x => ({ text: String(x.text || '').trim(), start: +x.start, end: +x.end }));
    if (!words.length && !segs.length) return json({ error: '오디오에서 말소리를 찾지 못했습니다' }, 422);
    if (!script) return json({ captions: cleanCaptions(segs, duration), duration, source: 'whisper' });
    const key = env[ENV.anthropic]; if (!key) return json({ error: 'ANTHROPIC_API_KEY 없음', kind: 'auth' }, 502);
    const system = '당신은 숏폼 영상 자막 편집자입니다. 대본과, 음성을 전사한 단어별 시각(w=단어, s=시작초, e=끝초)을 받습니다. ' +
      '규칙: (1) 자막 글은 반드시 대본의 글(맞춤법 포함)을 쓰고, 전사 글은 시각을 찾는 데만 씁니다. (2) 대본을 한 자막당 한국어 기준 약 8~18자(길어도 25자)의 의미 단위로 나눕니다. 대본의 줄바꿈은 가급적 경계로 존중합니다. ' +
      '(3) 각 자막의 start/end는 해당 대목을 말한 첫·끝 단어의 시각에 맞춥니다. 자막은 시간순이고 겹치지 않으며 대본 순서를 바꾸지 않습니다. ' +
      '(4) 대본에 있지만 말하지 않은 대목은 건너뛰고, 말했는데 대본에 없는 대목은 자막으로 만들지 않습니다. (5) JSON만 답합니다(마크다운 금지): {"captions":[{"text":string,"start":number,"end":number}]}';
    const user = JSON.stringify({ duration, script, words: words.length ? words : undefined, segments: words.length ? undefined : segs }).slice(0, 90000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: CAPTION_MODEL, max_tokens: 8000, system, messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: j.error?.message || 'HTTP ' + r.status, kind: r.status === 429 ? 'rate' : r.status === 401 ? 'auth' : 'bad' }, 502);
    const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const m = txt.match(/\{[\s\S]*\}/); if (!m) return json({ error: 'AI 응답에서 자막을 읽지 못했습니다' }, 502);
    let out; try { out = JSON.parse(m[0]); } catch { return json({ error: 'AI 응답 형식 오류' }, 502); }
    const captions = cleanCaptions(out && out.captions, duration);
    if (!captions.length) return json({ error: '대본과 음성을 맞추지 못했습니다. 대본이 오디오와 같은 내용인지 확인해 주세요.' }, 502);
    return json({ captions, duration, source: 'script', model: CAPTION_MODEL });
  } catch (e) { return json({ error: e.message }, e.status || 502); }
}

/* ---------- 출판만화 배치: 한 컷 칸 안의 말풍선·글 자리를 그림을 보고 정한다 ---------- */
export async function handleOvLayout(req, env) {
  if (req.method !== 'POST') return json({ error: 'POST만 됩니다' }, 405);
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    const key = env[ENV.anthropic]; if (!key) return json({ error: 'ANTHROPIC_API_KEY 없음', kind: 'auth' }, 502);
    const b = await readObject(req);
    const img = String(b.image || '').replace(/^data:image\/jpeg;base64,/, '');
    if (!img || img.length > 4_000_000 || !/^[A-Za-z0-9+/=]+$/.test(img)) return json({ error: '컷 그림(JPEG base64)이 필요합니다' }, 400);
    const num = (v, d) => (Number.isFinite(+v) ? +v : d);
    if (!Array.isArray(b.bubbles) || !b.bubbles.length || b.bubbles.length > 12) return json({ error: '말풍선은 1~12개여야 합니다' }, 400);
    const bubbles = b.bubbles.map((o, i) => ({
      id: String(o && o.id || '').slice(0, 40), order: i + 1, kind: String(o.kind || '').slice(0, 12), text: String(o.text || '').slice(0, 80),
      w: +Math.min(1, Math.max(0.02, num(o.w, 0.3))).toFixed(3), h: +Math.min(1, Math.max(0.02, num(o.h, 0.15))).toFixed(3),
      cx: +Math.min(1, Math.max(0, num(o.cx, 0.5))).toFixed(3), cy: +Math.min(1, Math.max(0, num(o.cy, 0.3))).toFixed(3), has_tail: !!o.tail,
    }));
    if (bubbles.some(o => !o.id)) return json({ error: '말풍선 id 가 필요합니다' }, 400);
    const system = 'You place speech bubbles, thought bubbles, narration boxes and captions on ONE comic panel for print. You see the panel image exactly as it is cropped in the page (without any text). ' +
      'Each bubble has a size (w,h = fraction of the panel width/height), a current centre (cx,cy in 0..1 of the panel) and reading order. ' +
      'Rules: (1) Do not cover faces, eyes, hands doing the action or the main subject; use empty or low-detail areas (sky, walls, background, corners). (2) Keep each whole bubble inside the panel with ~3% margin: centre must satisfy w/2*scale+0.03 <= cx <= 1-w/2*scale-0.03, same for y. ' +
      '(3) Reading order: ' + (b.dir === 'rtl' ? 'right-to-left, top-to-bottom' : 'left-to-right, top-to-bottom') + ' - earlier bubbles sit higher and nearer the start side; bubbles must not overlap each other. ' +
      '(4) Narration boxes ("narration") go to the top or bottom edge, captions ("caption") near the bottom, bubbles with has_tail stay reasonably near the speaker if one is visible. ' +
      '(5) If the bubbles cannot all fit without covering the subject, shrink them with "scale" (0.55-1.0); never enlarge beyond 1.15. Keep the current position when it is already good. ' +
      '(6) Reply with ONLY JSON, no markdown: {"placements":[{"id":string,"cx":number,"cy":number,"scale":number}],"reason":"1 short sentence in Korean"} - one entry per bubble, same ids.';
    const user = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } },
      { type: 'text', text: JSON.stringify({ panel_aspect_w_over_h: +num(b.aspect, 0.56).toFixed(3), bubbles }) },
    ];
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: LAYOUT_MODEL, max_tokens: 1200, system, messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: j.error?.message || 'HTTP ' + r.status, kind: r.status === 429 ? 'rate' : r.status === 401 ? 'auth' : 'bad' }, 502);
    const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const m = txt.match(/\{[\s\S]*\}/); if (!m) return json({ error: 'AI 응답에서 배치를 읽지 못했습니다' }, 502);
    let out; try { out = JSON.parse(m[0]); } catch (e) { return json({ error: 'AI 응답 형식 오류' }, 502); }
    const ids = new Set(bubbles.map(o => o.id));
    const placements = (Array.isArray(out?.placements) ? out.placements : []).filter(p => p && ids.has(p.id) && Number.isFinite(p.cx) && Number.isFinite(p.cy))
      .map(p => ({ id: p.id, cx: Math.min(1, Math.max(0, p.cx)), cy: Math.min(1, Math.max(0, p.cy)), scale: Number.isFinite(p.scale) ? Math.min(1.15, Math.max(0.4, p.scale)) : 1 }));
    if (!placements.length) return json({ error: 'AI 배치에 쓸 수 있는 좌표가 없습니다' }, 502);
    return json({ placements, reason: String(out.reason || '').slice(0, 200), model: LAYOUT_MODEL });
  } catch (e) { return json({ error: e.message }, e.status || 502); }
}

/* ---------- 로그인 확인 / 음성(OpenAI TTS) ---------- */
export async function handleAdmin(req, env) {
  const who = await authUser(req, env);
  return who ? json({ ok: true, uid: who.uid, email: who.email }) : json({ error: '인증되지 않았습니다' }, 401);
}
/* Gemini TTS 는 16bit 24kHz 모노 PCM 을 주므로 WAV 헤더를 붙여 돌려준다 */
function pcmToWav(pcm, rate = 24000) {
  const h = new DataView(new ArrayBuffer(44)), w = (o, t) => [...t].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); h.setUint32(4, 36 + pcm.length, true); w(8, 'WAVEfmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, 'data'); h.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length); out.set(new Uint8Array(h.buffer)); out.set(pcm, 44); return out;
}
async function geminiTts(env, b, who) {
  const key = env[ENV.gemini]; if (!key) return json({ error: 'GEMINI_API_KEY 없음', kind: 'auth' }, 502);
  const model = String(b.model || 'gemini-2.5-flash-preview-tts').trim();
  const text = String(b.text || '').slice(0, 4000);
  // 말투 지시는 짧게: 너무 길면 Gemini 가 음성 대신 글로 답하거나 빈 응답을 낸다
  const style = String(b.instructions || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const call = prompt => fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: b.voice || 'Kore' } } } },
    }),
  });
  const audioOf = j => { const d = j?.candidates?.[0]?.content?.parts?.find(p => p.inlineData || p.inline_data); return (d?.inlineData || d?.inline_data)?.data || ''; };
  const tries = style ? [`${style}:\n${text}`, text] : [text]; // 지시를 붙여 한 번, 음성이 안 오면 글만으로 한 번 더
  let last = null, lastStatus = 0;
  for (let i = 0; i < tries.length; i++) {
    let r = await call(tries[i]);
    if (r.status === 429 || r.status === 500 || r.status === 503) { await new Promise(x => setTimeout(x, 1500)); r = await call(tries[i]); } // 바쁘면 잠깐 뒤 한 번 더
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j.error?.message || 'HTTP ' + r.status;
      const hint = r.status === 404 || /not found|is not supported/i.test(msg) ? ` — Gemini 음성 모델 ‘${model}’ 을 찾을 수 없습니다. 설정의 ‘Gemini 음성 모델’을 확인하세요` : r.status === 429 ? ' — 요청이 많아 잠시 막혔습니다. 조금 뒤 다시 시도하세요' : /voice/i.test(msg) ? ` — 목소리 이름 ‘${b.voice}’ 을 확인하세요` : '';
      return json({ error: 'Gemini: ' + msg + hint, kind: r.status === 429 ? 'rate' : r.status === 401 || r.status === 403 ? 'auth' : 'bad' }, 502);
    }
    const data = audioOf(j);
    if (data) return json({ key: await r2Put(env, pcmToWav(unb64(data)), 'audio/wav', 'wav', who), retried: i > 0 });
    last = j; lastStatus = r.status;
  }
  const why = last?.candidates?.[0]?.finishReason || last?.promptFeedback?.blockReason || '이유 불명';
  return json({ error: `Gemini 가 음성을 돌려주지 않았습니다 (${why})${why === 'SAFETY' || last?.promptFeedback?.blockReason ? ' — 안전 필터에 걸렸을 수 있습니다' : ' — 잠시 뒤 다시 시도하거나 다른 목소리·엔진으로 바꿔 보세요'}`, kind: 'empty', status: lastStatus }, 502);
}
const ttsKind = s => (s === 429 ? 'rate' : s === 401 || s === 403 ? 'auth' : 'bad');
const noKey = name => json({ error: name + ' 없음 (서버 환경변수에 넣어 주세요)', kind: 'auth' }, 502);
async function openaiTts(env, b, who) {
  const key = env[ENV.openai]; if (!key) return noKey('OPENAI_API_KEY');
  const body = { model: b.model || 'gpt-4o-mini-tts', voice: b.voice || 'coral', input: String(b.text || '').slice(0, 4000), speed: +b.speed || 1, response_format: 'mp3' };
  if (b.instructions && !/^tts-1/.test(body.model)) body.instructions = String(b.instructions).slice(0, 1000);
  const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); return json({ error: j.error?.message || 'HTTP ' + r.status, kind: ttsKind(r.status) }, 502); }
  return json({ key: await r2Put(env, await r.arrayBuffer(), 'audio/mpeg', 'mp3', who) });
}
/* 일레븐랩스: voice ID 로 부른다. 속도는 0.7~1.2 만 받는다 */
async function elevenTts(env, b, who) {
  const key = env[ENV.eleven]; if (!key) return noKey('ELEVENLABS_API_KEY');
  const voice = String(b.voice || b.voiceId || '').trim(); if (!voice) return json({ error: '일레븐랩스 voice ID 가 비어 있습니다', kind: 'bad' }, 400);
  const body = { text: String(b.text || '').slice(0, 5000), model_id: b.model || 'eleven_multilingual_v2', voice_settings: { speed: Math.min(1.2, Math.max(0.7, +b.speed || 1)) } };
  // 감정 연출: 안정성↓·스타일↑ 일수록 감정 폭이 커진다 (v3 는 대신 [태그] 를 글에 넣는다)
  for (const [k, n] of [['stability', 'stability'], ['similarity', 'similarity_boost'], ['style', 'style']]) if (b[k] != null && b[k] !== '' && Number.isFinite(+b[k])) body.voice_settings[n] = Math.min(1, Math.max(0, +b[k]));
  // 앞뒤 문장: 줄마다 따로 만들어도 이야기 흐름처럼 억양이 이어진다 (eleven_v3 는 받지 않는다)
  if (!/(^|_)v3/.test(body.model_id)) for (const k of ['previous_text', 'next_text']) { const t = String(b[k] || '').trim(); if (t) body[k] = t.slice(0, 500); }
  const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voice) + '?output_format=mp3_44100_128', {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(body),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); const m = j.detail?.message || (typeof j.detail === 'string' ? j.detail : '') || 'HTTP ' + r.status; return json({ error: m, kind: ttsKind(r.status) }, 502); }
  return json({ key: await r2Put(env, await r.arrayBuffer(), 'audio/mpeg', 'mp3', who) });
}
const elErr = async r => { const j = await r.json().catch(() => ({})); const m = j.detail?.message || (typeof j.detail === 'string' ? j.detail : '') || j.error?.message || 'HTTP ' + r.status; return json({ error: m, kind: ttsKind(r.status) }, 502); };
/* 일레븐랩스 목소리 변환(Speech to Speech): 올려 둔 녹음(key)을 다른 목소리로 바꾼다. 말투·호흡·감정은 녹음을 따른다 */
async function elevenSts(env, b, who) {
  const key = env[ENV.eleven]; if (!key) return noKey('ELEVENLABS_API_KEY');
  const voice = String(b.voice || '').trim(); if (!voice) return json({ error: '바꿀 일레븐랩스 voice ID 가 비어 있습니다', kind: 'bad' }, 400);
  if (!b.key) return json({ error: '변환할 녹음 파일(key)이 없습니다' }, 400);
  const src = await r2Get(env, String(b.key), who);
  if (src.bytes.length > 50 * 1024 * 1024) return json({ error: '녹음 파일이 너무 큽니다 (50MB 이하)' }, 400);
  const fd = new FormData();
  fd.append('audio', new Blob([src.bytes], { type: src.type || 'audio/mpeg' }), 'input');
  fd.append('model_id', String(b.model || 'eleven_multilingual_sts_v2'));
  fd.append('remove_background_noise', b.denoise ? 'true' : 'false');
  const vs = {};
  if (b.stability != null && b.stability !== '') vs.stability = Math.min(1, Math.max(0, +b.stability));
  if (b.similarity != null && b.similarity !== '') vs.similarity_boost = Math.min(1, Math.max(0, +b.similarity));
  if (b.style != null && b.style !== '') vs.style = Math.min(1, Math.max(0, +b.style));
  if (Object.keys(vs).length) fd.append('voice_settings', JSON.stringify(vs));
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-speech/' + encodeURIComponent(voice) + '?output_format=mp3_44100_128', { method: 'POST', headers: { 'xi-api-key': key, Accept: 'audio/mpeg' }, body: fd });
  if (!r.ok) return elErr(r);
  return json({ key: await r2Put(env, await r.arrayBuffer(), 'audio/mpeg', 'mp3', who) });
}
/* 일레븐랩스 효과음: 글 설명 → 효과음. 길이 0 = 자동 (0.5~30초) */
async function elevenSfx(env, b, who) {
  const key = env[ENV.eleven]; if (!key) return noKey('ELEVENLABS_API_KEY');
  const text = String(b.text || '').trim().slice(0, 1000); if (!text) return json({ error: '효과음 설명이 비어 있습니다' }, 400);
  const body = { text, model_id: String(b.model || 'eleven_text_to_sound_v2'), prompt_influence: Math.min(1, Math.max(0, b.influence == null || b.influence === '' ? 0.3 : +b.influence)) };
  const dur = +b.duration; if (dur > 0) body.duration_seconds = Math.min(30, Math.max(0.5, dur));
  if (b.loop) body.loop = true;
  const r = await fetch('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', { method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(body) });
  if (!r.ok) return elErr(r);
  return json({ key: await r2Put(env, await r.arrayBuffer(), 'audio/mpeg', 'mp3', who) });
}
/* 일레븐랩스 배경음악(Music): 글 설명 → 곡. 길이 3~600초, 기본은 가사 없는 연주곡 */
async function elevenMusic(env, b, who) {
  const key = env[ENV.eleven]; if (!key) return noKey('ELEVENLABS_API_KEY');
  let body;
  if (b.plan) { // AI 설계안 → 섹션별 분위기가 바뀌는 한 곡 (composition_plan · music_v1)
    const secs = (Array.isArray(b.plan.sections) ? b.plan.sections : []).slice(0, 30).map(s => ({
      section_name: String(s?.name || 'section').slice(0, 100) || 'section', positive_local_styles: strs(s?.styles, 10, 80), negative_local_styles: strs(s?.negative, 8, 80),
      duration_ms: Math.round(Math.min(120000, Math.max(3000, +s?.ms || 0))), lines: [],
    }));
    if (!secs.length) return json({ error: '음악 설계안에 섹션이 없습니다' }, 400);
    if (secs.reduce((a, s) => a + s.duration_ms, 0) > 600000) return json({ error: '한 곡은 600초를 넘을 수 없습니다' }, 400);
    const neg = strs(b.plan.global?.negative, 10, 80); if (b.instrumental !== false && !neg.some(n => /vocal/i.test(n))) neg.push('vocals', 'singing');
    body = { model_id: 'music_v1', respect_sections_durations: true, composition_plan: { positive_global_styles: strs(b.plan.global?.positive, 10, 80), negative_global_styles: neg, sections: secs } };
  } else {
    const prompt = String(b.text || '').trim().slice(0, 2000); if (!prompt) return json({ error: '음악 설명이 비어 있습니다' }, 400);
    const model = /^music_v(1|2|2_5)$/.test(b.model || '') ? b.model : 'music_v1';
    body = { prompt, model_id: model, force_instrumental: b.instrumental !== false };
    const sec = +b.duration; if (sec > 0) body.music_length_ms = Math.round(Math.min(600, Math.max(3, sec)) * 1000);
  }
  const r = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', { method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(body) });
  if (!r.ok) return elErr(r);
  return json({ key: await r2Put(env, await r.arrayBuffer(), 'audio/mpeg', 'mp3', who) });
}
/* 타입캐스트: 감정은 프리셋(emotion) 또는 스마트(앞뒤 문장을 보고 알아서) — ssfm-v21 은 프리셋만 */
const TC_EMO = ['normal', 'happy', 'sad', 'angry', 'whisper', 'toneup', 'tonedown'];
async function typecastTts(env, b, who) {
  const key = env[ENV.typecast]; if (!key) return noKey('TYPECAST_API_KEY');
  const voice = String(b.voice || '').trim(); if (!/^(tc|uc)_[A-Za-z0-9]+$/.test(voice)) return json({ error: '타입캐스트 voice ID 가 비어 있거나 형식이 다릅니다 (tc_… / uc_…)', kind: 'bad' }, 400);
  const model = /^ssfm-v(21|30|31)$/.test(b.model || '') ? b.model : 'ssfm-v30', v21 = model === 'ssfm-v21';
  const emo = TC_EMO.includes(b.emotion) && !(v21 && !['normal', 'happy', 'sad', 'angry'].includes(b.emotion)) ? b.emotion : '';
  const inten = Math.min(2, Math.max(0, Number.isFinite(+b.emotion_intensity) ? +b.emotion_intensity : 1));
  const prompt = emo ? (v21 ? { emotion_preset: emo, emotion_intensity: inten } : { emotion_type: 'preset', emotion_preset: emo, emotion_intensity: inten })
    : v21 ? undefined : { emotion_type: 'smart', previous_text: String(b.previous_text || '').slice(0, 2000), next_text: String(b.next_text || '').slice(0, 2000) };
  const body = { voice_id: voice, text: String(b.text || '').slice(0, 2000), model, output: { audio_format: 'mp3', audio_tempo: Math.min(2, Math.max(0.5, +b.speed || 1)), audio_pitch: Math.round(Math.min(12, Math.max(-12, +b.pitch || 0))), volume: 100 } };
  if (b.language) body.language = String(b.language).slice(0, 3);
  if (prompt) body.prompt = prompt;
  const r = await fetch('https://api.typecast.ai/v1/text-to-speech', { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); return json({ error: j.message || (typeof j.detail === 'string' ? j.detail : '') || j.error_code || 'HTTP ' + r.status, kind: r.status === 402 ? 'credit' : ttsKind(r.status) }, 502); }
  return json({ key: await r2Put(env, await r.arrayBuffer(), 'audio/mpeg', 'mp3', who) });
}
/* Google Cloud TTS: 목소리 이름(ko-KR-Chirp3-HD-Kore 등)의 앞 두 마디가 언어 코드 */
async function googleTts(env, b, who) {
  const key = env[ENV.gcTts] || env[ENV.gemini]; if (!key) return noKey('GOOGLE_TTS_API_KEY');
  const name = String(b.voice || 'ko-KR-Chirp3-HD-Kore').trim(), lang = name.split('-').slice(0, 2).join('-') || 'ko-KR';
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { text: String(b.text || '').slice(0, 4000) }, voice: { languageCode: lang, name }, audioConfig: { audioEncoding: 'MP3', speakingRate: Math.min(2, Math.max(0.25, +b.speed || 1)) } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: j.error?.message || 'HTTP ' + r.status, kind: ttsKind(r.status) }, 502);
  if (!j.audioContent) return json({ error: '음성이 반환되지 않았습니다', kind: 'empty' }, 502);
  return json({ key: await r2Put(env, unb64(j.audioContent), 'audio/mpeg', 'mp3', who) });
}
/* ---- AI 감정 연출: 대본 흐름·장면·캐릭터를 보고 대사마다 감정과 읽는 법을 정한다 ----
   반환 { lines: [{ id, emotion, intensity, instr, tags[], speed }] } — 엔진마다 브라우저가 알맞게 적용한다 */
const DIRECT_MODEL = 'claude-sonnet-5-5', DIRECT_MODEL_HIGH = 'claude-opus-5-5'; // ‘정밀’ 은 더 섬세하지만 비싸다
const EL_TAGS = ['happy', 'sad', 'excited', 'angry', 'whispers', 'sighs', 'laughs', 'chuckles', 'crying', 'nervous', 'curious', 'sarcastic', 'shouting', 'calm', 'mischievously', 'surprised', 'scared', 'tired', 'thoughtful', 'gasps', 'exhales', 'hesitates', 'serious', 'tender', 'cold', 'pleading', 'determined', 'embarrassed'];
async function directLines(env, b) {
  const key = env[ENV.anthropic]; if (!key) return json({ error: 'ANTHROPIC_API_KEY 없음', kind: 'auth' }, 502);
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 200) return json({ error: '대사는 1~200개여야 합니다' }, 400);
  const lines = b.lines.map(l => {
    const x = { id: String(l?.id || '').slice(0, 40), cut: +l?.cut || 0, who: String(l?.who || '').slice(0, 30), kind: String(l?.kind || '').slice(0, 20), text: String(l?.text || '').slice(0, 400), target: !!l?.target };
    if (l?.beat) x.beat = String(l.beat).slice(0, 60); // 이 대사가 속한 이야기 구간(긴장도 포함)
    const note = String(l?.note || '').trim().slice(0, 300), emo = String(l?.want || '').trim().slice(0, 20);
    if (x.target && note) x.note = note;   // 연출자가 직접 적은 말투 — 그대로 따른다
    if (x.target && emo) x.want = emo;     // 연출자가 고른 감정
    return x;
  }).filter(l => l.id && l.text.trim());
  const targets = new Set(lines.filter(l => l.target).map(l => l.id));
  if (!targets.size) return json({ error: '연출할 대사가 없습니다' }, 400);
  const chars = (Array.isArray(b.chars) ? b.chars : []).slice(0, 30).map(c => ({ name: String(c?.name || '').slice(0, 30), desc: String(c?.desc || '').slice(0, 400), voice: String(c?.voice || '').slice(0, 200) }));
  const scenes = (Array.isArray(b.scenes) ? b.scenes : []).slice(0, 120).map(s => ({ cut: +s?.cut || 0, desc: String(s?.desc || '').slice(0, 240) }));
  const hint = String(b.hint || '').trim().slice(0, 400);
  const model = b.quality === 'high' ? DIRECT_MODEL_HIGH : DIRECT_MODEL;
  const system = 'You are an experienced Korean voice-acting director (애니메이션·웹툰 더빙 연출) for a Korean motion webtoon. You get the whole script in order (cut number, speaker, bubble kind, text), scene notes and character notes (age, personality). ' +
    'For every line marked "target": true, direct a NATURAL, believable performance the way a good Korean dubbing actor would actually say it - not a label pasted on the line.\n' +
    'How to judge:\n' +
    '1. Read the whole exchange first. Each line answers or reacts to the previous one (often another speaker): find the subtext - what the character feels but does not say, their relationship, what just happened, and what they want from the other person.\n' +
    '2. Fit the character: age and personality change everything (a scared 13-year-old boy sounds small, breathy and fast; a calm master speaks low and unhurried). Keep each character\'s voice consistent across lines and let emotions shift gradually unless the story turns.\n' +
    '3. Read the punctuation as acting: leading ".."/"…" = hesitation or trailing in; "?" = real question vs. rhetorical; "!" = not always shouting; short broken lines = breathless or holding back.\n' +
    '4. Be restrained and realistic. Most lines are mixed and subtle (intensity 0.2-0.6); only real climaxes go above 0.75. Never make every line dramatic. Plain informative lines stay natural with low intensity.\n' +
    '5. Bubble kinds: thought = inner voice, close and quiet; shout = projected but with the real emotion under it; whisper = whispered; caption = neutral.\n' +
    '6. Narration = skilled audiobook storyteller, flowing intonation, breaths at commas, mood fitting the scene; title-like lines are calm scene introductions.\n' +
    (hint ? 'Director\'s note for this project (follow it): ' + hint + '\n' : '') +
    (arcText(b.arc) ? 'Whole-episode story arc (shared by every step - keep each character consistent with their journey across the episode and match each line to its beat and tension; lines carry "beat"):\n' + arcText(b.arc) + '\n' : '') +
    '7. If a target line has "note", it is the director\'s explicit instruction for THAT line - follow it faithfully over your own judgment, and make every output field realize it (some TTS engines cannot read text, so tags, perf, tc, intensity, speed and pitch must carry the note: e.g. "숨죽여 작게" → whisper/tonedown, low intensity, slightly slower, pitch -1; "들떠서 빠르게" → happy/toneup, faster, pitch +2). If it has "want", keep that emotion as the core.\n' +
    'Output per target line:\n' +
    '- "emotion": nuanced Korean label, can be mixed (e.g. 겁먹은 걱정, 애써 태연한 척, 안도 섞인 울먹임).\n' +
    '- "intensity": 0..1 (see rule 4).\n' +
    '- "instr": 1-2 concrete Korean sentences for a TTS voice actor covering voice quality, volume, pace, pitch movement, where to breathe or pause and how the ending falls or rises (e.g. "숨을 삼키고 작게, 이름을 조심스럽게 부르듯 끝을 살짝 올려. 대답을 기다리는 짧은 침묵").\n' +
    '- "tags": up to 2 ElevenLabs v3 audio tags that open the line, from: ' + EL_TAGS.join(', ') + '.\n' +
    '- "perf": the SAME text with only ElevenLabs v3 audio tags in square brackets and pause punctuation ("…", ",") inserted where the actor would really breathe, hesitate, sigh or laugh. Do not change, add or remove any words. Use "" if nothing helps.\n' +
    '- "tc": the closest Typecast preset (normal, happy, sad, angry, whisper, toneup, tonedown), or "smart" when the feeling is subtle or mixed so the engine should infer it from context. Prefer "smart" unless one preset clearly fits.\n' +
    '- "speed": 0.85..1.15 pace multiplier (small changes only; up to 0.75..1.3 when a note asks for clearly slow/fast).\n' +
    '- "pitch": integer -4..4 semitone shift of the voice (0 normally; lower for hushed/heavy/cold, higher for excited/childish/surprised), used by engines that cannot read text.\n' +
    'Reply with ONLY JSON, no markdown: {"lines":[{"id":string,"emotion":string,"intensity":number,"instr":string,"tags":[string],"perf":string,"tc":string,"speed":number,"pitch":number}]}. Include every target id exactly once.';
  const user = JSON.stringify({ characters: chars, scenes, script: lines });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: Math.min(32000, 600 + targets.size * 320), system, messages: [{ role: 'user', content: user }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: j.error?.message || 'HTTP ' + r.status, kind: r.status === 429 ? 'rate' : r.status === 401 ? 'auth' : 'bad' }, 502);
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = txt.match(/\{[\s\S]*\}/); if (!m) return json({ error: 'AI 응답에서 연출을 읽지 못했습니다' }, 502);
  let out; try { out = JSON.parse(m[0]); } catch (e) { return json({ error: 'AI 응답 형식 오류' }, 502); }
  const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
  const textOf = new Map(lines.map(l => [l.id, l.text])), noted = new Set(lines.filter(l => l.note).map(l => l.id));
  const bare = s => String(s || '').replace(/\[[^\]]*\]/g, '').replace(/[\s.,…!?~'"“”‘’·\-]/g, '');
  const res = (Array.isArray(out?.lines) ? out.lines : []).filter(l => l && targets.has(String(l.id))).map(l => {
    const id = String(l.id), tc = String(l.tc || '').toLowerCase();
    // perf: 단어는 그대로, 태그·쉼만 넣었는지 확인 (허용한 태그만)
    let perf = String(l.perf || '').replace(/\[([^\]]*)\]/g, (m, t) => { t = t.toLowerCase().replace(/[^a-z]/g, ''); return EL_TAGS.includes(t) ? `[${t}]` : ''; }).replace(/\s{2,}/g, ' ').trim().slice(0, 600);
    if (!perf || bare(perf) !== bare(textOf.get(id))) perf = '';
    return {
      id, emotion: String(l.emotion || '평온').slice(0, 20), intensity: +num(l.intensity, 0, 1, 0.3).toFixed(2),
      instr: String(l.instr || '').slice(0, 260), tags: (Array.isArray(l.tags) ? l.tags : []).map(t => String(t).toLowerCase().replace(/[^a-z]/g, '')).filter(t => EL_TAGS.includes(t)).slice(0, 2),
      perf, tc: ['smart', 'normal', 'happy', 'sad', 'angry', 'whisper', 'toneup', 'tonedown'].includes(tc) ? tc : 'smart',
      speed: +num(l.speed, noted.has(id) ? 0.75 : 0.85, noted.has(id) ? 1.3 : 1.15, 1).toFixed(2), pitch: Math.round(num(l.pitch, -4, 4, 0)),
    };
  });
  const seen = new Set(), uniq = res.filter(l => !seen.has(l.id) && seen.add(l.id));
  if (!uniq.length) return json({ error: 'AI 가 연출을 내지 못했습니다. 다시 시도해 주세요.' }, 502);
  return json({ lines: uniq, missing: [...targets].filter(id => !seen.has(id)), model, usage: j.usage || null });
}
/* ---- AI 음악 감독 · 사운드 디자이너: 컷(이미지·장면·대사·길이)을 보고 배경음악 설계와 효과음 목록을 만든다 ---- */
const SCORE_MODEL = 'claude-sonnet-5-5';
function storyCuts(b) {
  if (!Array.isArray(b.cuts) || !b.cuts.length || b.cuts.length > 200) throw Object.assign(new Error('컷은 1~200개여야 합니다'), { status: 400 });
  let t = 0;
  return b.cuts.map((c, i) => {
    const dur = Math.min(15, Math.max(0.3, +c?.dur || 4)), cut = {
      i, start: +t.toFixed(2), dur, scene: String(c?.scene || '').slice(0, 300),
      lines: (Array.isArray(c?.lines) ? c.lines : []).slice(0, 12).map(l => ({ who: String(l?.who || '').slice(0, 20), kind: String(l?.kind || '').slice(0, 12), text: String(l?.text || '').slice(0, 200), emotion: String(l?.emotion || '').slice(0, 12) })),
      img: typeof c?.img === 'string' && /^[A-Za-z0-9+/=]+$/.test(c.img) && c.img.length < 200000 ? c.img : '',
    };
    t += dur; return cut;
  });
}
async function askClaude(env, system, cuts, extra, maxTokens) {
  const key = env[ENV.anthropic]; if (!key) throw Object.assign(new Error('ANTHROPIC_API_KEY 없음'), { status: 502, kind: 'auth' });
  const content = [];
  cuts.forEach(c => {
    if (c.img) content.push({ type: 'text', text: `cut ${c.i}` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: c.img } });
  });
  content.push({ type: 'text', text: JSON.stringify({ ...extra, total_seconds: +cuts.reduce((a, c) => a + c.dur, 0).toFixed(1), cuts: cuts.map(({ img, ...c }) => c) }) });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: SCORE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || 'HTTP ' + r.status), { status: 502, kind: r.status === 429 ? 'rate' : r.status === 401 ? 'auth' : 'bad' });
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = txt.match(/\{[\s\S]*\}/); if (!m) throw Object.assign(new Error('AI 응답을 읽지 못했습니다'), { status: 502 });
  try { return JSON.parse(m[0]); } catch (e) { throw Object.assign(new Error('AI 응답 형식 오류'), { status: 502 }); }
}
const strs = (a, n, len) => (Array.isArray(a) ? a : []).map(s => String(s || '').trim().slice(0, len)).filter(Boolean).slice(0, n);
/* ---- 이야기 흐름 분석: 모든 AI 단계(감정 연출·편집·효과음·작곡)가 함께 쓰는 전체 감정선 ----
   반환 { title, logline, tone, beats:[{from,to,name,phase,mood,tension,note}], characters:[{name,journey:[{from,to,emotion}],note}] } */
const ARC_PHASES = ['도입', '전개', '회상', '위기', '절정', '반전', '해소', '여운'];
function arcText(a) { // 다른 AI 에 넘길 짧은 요약 (컷 번호는 1부터)
  if (!a || !Array.isArray(a.beats)) return '';
  const beats = a.beats.slice(0, 24).map(b => `컷${+b.from + 1}-${+b.to + 1} ${String(b.phase || '')} "${String(b.name || '')}" 분위기:${String(b.mood || '')} 긴장도:${Math.round((+b.tension || 0) * 10)}/10${b.note ? ' — ' + String(b.note).slice(0, 80) : ''}`).join('\n');
  const chars = (Array.isArray(a.characters) ? a.characters : []).slice(0, 12).map(c => `${String(c.name || '')}: ${(Array.isArray(c.journey) ? c.journey : []).slice(0, 8).map(j => `컷${+j.from + 1}-${+j.to + 1} ${String(j.emotion || '')}`).join(' → ')}${c.note ? ' (' + String(c.note).slice(0, 80) + ')' : ''}`).join('\n');
  return `[이야기 흐름] ${String(a.logline || '').slice(0, 200)} / 톤: ${String(a.tone || '').slice(0, 80)}\n${beats}${chars ? '\n[캐릭터 감정 흐름]\n' + chars : ''}`.slice(0, 4000);
}
async function arcPlan(env, b) {
  const cuts = storyCuts(b), n = cuts.length;
  const chars = (Array.isArray(b.chars) ? b.chars : []).slice(0, 20).map(c => ({ name: String(c?.name || '').slice(0, 30), desc: String(c?.desc || '').slice(0, 200) }));
  const system = 'You are a story editor and director for a Korean motion webtoon. You get every cut in order (image if provided, scene note, dialogue/narration with speaker, duration) and the character notes. ' +
    'Read the WHOLE episode first and map its dramatic structure so that voice acting, sound effects and music can follow one consistent emotional arc. ' +
    'Split the episode into 3-12 beats covering contiguous cut ranges [from,to] (0-based, inclusive, in order, covering every cut once). For each beat give a Korean name, phase (one of ' + ARC_PHASES.join(', ') + '), mood (short Korean), tension 0..1 (the curve should rise and fall like real drama, not stay flat), and a one-sentence Korean note on what the audience should feel. ' +
    'For each speaking character (and "나레이터" if there is narration) describe their emotional journey across cut ranges in short Korean emotion words, plus a note on how their voice should evolve. ' +
    (b.hint ? 'Director\'s note: ' + String(b.hint).slice(0, 300) + '. ' : '') +
    'Reply with ONLY JSON, no markdown: {"title":"short Korean","logline":"one Korean sentence","tone":"overall tone in Korean","beats":[{"from":0,"to":0,"name":"","phase":"","mood":"","tension":0.5,"note":""}],"characters":[{"name":"","journey":[{"from":0,"to":0,"emotion":""}],"note":""}]}';
  const out = await askClaude(env, system, cuts, { request: 'story arc', characters: chars }, 5000);
  let next = 0; const beats = [];
  (Array.isArray(out?.beats) ? out.beats : []).map(x => ({ from: Math.trunc(+x?.from), to: Math.trunc(+x?.to), name: String(x?.name || '').slice(0, 30), phase: ARC_PHASES.includes(x?.phase) ? x.phase : '전개', mood: String(x?.mood || '').slice(0, 30), tension: +Math.min(1, Math.max(0, +x?.tension || 0)).toFixed(2), note: String(x?.note || '').slice(0, 160) }))
    .filter(x => Number.isFinite(x.from) && Number.isFinite(x.to)).sort((a, c) => a.from - c.from)
    .forEach(x => { if (x.to < next || next >= n || x.from >= n) return; /* 없는 컷을 가리키는 구간은 버린다 */ x.from = next; x.to = Math.min(n - 1, Math.max(x.from, x.to)); beats.push(x); next = x.to + 1; });
  if (!beats.length) beats.push({ from: 0, to: n - 1, name: '전체', phase: '전개', mood: '', tension: 0.5, note: '' });
  beats[beats.length - 1].to = n - 1;
  const characters = (Array.isArray(out?.characters) ? out.characters : []).slice(0, 20).map(c => ({ name: String(c?.name || '').slice(0, 30),
    journey: (Array.isArray(c?.journey) ? c.journey : []).slice(0, 12).map(j => ({ from: Math.max(0, Math.min(n - 1, Math.trunc(+j?.from) || 0)), to: Math.max(0, Math.min(n - 1, Math.trunc(+j?.to) || 0)), emotion: String(j?.emotion || '').slice(0, 30) })).filter(j => j.emotion),
    note: String(c?.note || '').slice(0, 160) })).filter(c => c.name);
  return json({ title: String(out?.title || '').slice(0, 40), logline: String(out?.logline || '').slice(0, 200), tone: String(out?.tone || '').slice(0, 80), beats, characters, model: SCORE_MODEL });
}
/* ---- 대본으로 컷 채우기: 대본 전체 + 컷 그림 → 컷마다 들어갈 나레이션·말풍선·자막·지문 ----
   반환 { items:[{cut,kind,speaker,text,x,y,tx,ty}], scenes:[{cut,note}], newChars:[{name,desc}], unplaced:[text], summary } (cut 은 0부터) */
const FILL_KINDS = ['narration', 'speech', 'thought', 'shout', 'whisper', 'caption'];
async function scriptFill(env, b) {
  const cuts = storyCuts(b), n = cuts.length;
  const script = String(b.script || '').replace(/\r/g, '').trim().slice(0, 20000);
  if (!script) return json({ error: '대본이 비어 있습니다' }, 400);
  const chars = (Array.isArray(b.chars) ? b.chars : []).slice(0, 30).map(c => ({ name: String(c?.name || '').slice(0, 30), desc: String(c?.desc || '').slice(0, 200) }));
  const system = 'You are a webtoon letterer and editor for a Korean motion webtoon. You get the cut images in order (with existing text and scene notes) and a pasted Korean script that may mix narration, dialogue (often "이름: 대사"), inner thoughts, sound/stage directions (지문) and captions. ' +
    'Distribute the script over the cuts the way a professional would: read each image to see who is in it and what happens, keep the script order, put each line in the cut whose picture matches it, and spread lines so no cut is overcrowded (about 1-4 text items per cut; use more cuts rather than cramming). ' +
    'Every narration, dialogue, thought and caption line of the script must be placed exactly once; do not rewrite or invent lines (you may split a very long narration into 2 items at a sentence boundary). Stage directions are NOT text items: summarize them into that cut\'s scene note. ' +
    'kind: "narration" for narrator/storytelling text, "speech" for normal dialogue, "thought" for inner voice (often in parentheses or described as 속마음/생각), "shout" for yelling (short lines with !), "whisper" for whispering, "caption" only for on-screen captions like time/place cards. ' +
    'speaker: the character name exactly as in the character list when the line is theirs (match nicknames sensibly), "나레이터" for narration, or a new name if the script introduces someone not in the list (also list them in newChars with a short Korean description from the script). ' +
    'Position: x,y = center of the bubble in 0..1 of the image, placed in empty/low-detail areas near the speaker without covering faces; for speech-type bubbles give tx,ty = the speaker\'s mouth/head position (where the tail points). Narration usually top (y≈0.1-0.18), captions bottom (y≈0.82). ' +
    'Lines you truly cannot place go to "unplaced". ' + (b.replace ? 'Existing text in the cuts will be replaced, so ignore it. ' : 'Cuts may already have text; place new lines so they continue naturally and avoid those spots. ') +
    'Reply with ONLY JSON, no markdown: {"summary":"1-2 Korean sentences","items":[{"cut":0,"kind":"speech","speaker":"","text":"","x":0.5,"y":0.3,"tx":0.4,"ty":0.45}],"scenes":[{"cut":0,"note":"short Korean scene/action note"}],"newChars":[{"name":"","desc":""}],"unplaced":[""]}';
  const out = await askClaude(env, system, cuts, { request: 'distribute script', characters: chars, script }, 16000);
  const num = (v, d) => (Number.isFinite(+v) ? Math.min(0.95, Math.max(0.05, +v)) : d);
  const items = (Array.isArray(out?.items) ? out.items : []).map(x => {
    const cut = Math.trunc(+x?.cut), text = String(x?.text || '').trim().slice(0, 300);
    if (!(cut >= 0 && cut < n) || !text) return null;
    const kind = FILL_KINDS.includes(x?.kind) ? x.kind : 'speech';
    const it = { cut, kind, speaker: String(x?.speaker || '').trim().slice(0, 30), text };
    if (Number.isFinite(+x?.x) && Number.isFinite(+x?.y)) { it.x = num(x.x, 0.5); it.y = num(x.y, 0.3); }
    if (kind !== 'narration' && kind !== 'caption' && Number.isFinite(+x?.tx) && Number.isFinite(+x?.ty)) { it.tx = num(x.tx, 0.4); it.ty = num(x.ty, 0.45); }
    return it;
  }).filter(Boolean).slice(0, 400);
  const scenes = (Array.isArray(out?.scenes) ? out.scenes : []).map(s => ({ cut: Math.trunc(+s?.cut), note: String(s?.note || '').trim().slice(0, 200) })).filter(s => s.cut >= 0 && s.cut < n && s.note);
  const known = new Set(chars.map(c => c.name));
  const newChars = (Array.isArray(out?.newChars) ? out.newChars : []).map(c => ({ name: String(c?.name || '').trim().slice(0, 30), desc: String(c?.desc || '').trim().slice(0, 160) })).filter(c => c.name && c.name !== '나레이터' && !known.has(c.name)).slice(0, 20);
  const unplaced = (Array.isArray(out?.unplaced) ? out.unplaced : []).map(t => String(t || '').trim().slice(0, 300)).filter(Boolean).slice(0, 100);
  if (!items.length) return json({ error: 'AI 가 대본을 컷에 나누지 못했습니다. 대본이나 컷 그림을 확인하고 다시 시도해 주세요.' }, 502);
  return json({ summary: String(out?.summary || '').slice(0, 300), items, scenes, newChars, unplaced, model: SCORE_MODEL });
}
/* 배경음악 설계: 이야기 전개에 맞춰 컷 구간마다 섹션(분위기·악기·템포)을 나눈다. 섹션 길이 = 그 컷들 길이의 합 (3~120초) */
async function scorePlan(env, b) {
  const cuts = storyCuts(b);
  const system = 'You are the music supervisor/composer for a Korean motion webtoon (moving comic video). You get every cut in order (image if provided, scene note, dialogue/narration with speaker and emotion, duration). ' +
    'Design ONE continuous background score that follows the story: split it into sections at real story beats (mood/tension/location changes), usually 2-10 sections. Sections cover contiguous cut ranges [from,to] (inclusive), in order, covering every cut exactly once. ' +
    'Keep it underscore: it must sit under narration and dialogue, so avoid busy melodies where there is a lot of speech; build and release energy with the story; transitions between sections should feel musical, not abrupt. ' +
    (arcText(b.arc) ? 'Use this story arc analysis (shared by every step) - section boundaries and energy should follow its beats and tension curve:\n' + arcText(b.arc) + '\n' : '') + (b.vocals ? 'Vocals are allowed. ' : 'Strictly instrumental: no vocals, no singing, no lyrics. ') + (b.hint ? 'Director\'s note: ' + String(b.hint).slice(0, 300) + '. ' : '') +
    'Styles are short English music-style tags for a text-to-music model (genre, instruments, tempo e.g. "90 bpm", mood, energy, mix). Never name real artists or songs. ' +
    'Reply with ONLY JSON, no markdown: {"title":"short Korean title","summary":"2 sentences in Korean explaining the musical arc","global":{"positive":[up to 8 tags],"negative":[up to 8 tags]},' +
    '"sections":[{"from":cut,"to":cut,"name":"short Korean section name","mood":"short Korean mood","styles":[up to 8 English tags],"negative":[up to 5 English tags]}]}';
  const out = await askClaude(env, system, cuts, { request: 'background score plan' }, 4000);
  let secs = (Array.isArray(out?.sections) ? out.sections : []).map(s => ({ from: Math.trunc(+s?.from), to: Math.trunc(+s?.to), name: String(s?.name || '').slice(0, 30), mood: String(s?.mood || '').slice(0, 30), styles: strs(s?.styles, 8, 60), negative: strs(s?.negative, 5, 60) }))
    .filter(s => Number.isFinite(s.from) && Number.isFinite(s.to)).sort((a, b) => a.from - b.from);
  // 빈틈·겹침 정리: 앞 섹션 끝 다음 컷에서 시작, 마지막 섹션은 끝 컷까지
  const fixed = []; let next = 0;
  for (const s of secs) { if (s.to < next) continue; s.from = next; s.to = Math.min(cuts.length - 1, Math.max(s.from, s.to)); fixed.push(s); next = s.to + 1; if (next >= cuts.length) break; }
  if (!fixed.length) fixed.push({ from: 0, to: cuts.length - 1, name: '전체', mood: '', styles: [], negative: [] });
  fixed[fixed.length - 1].to = cuts.length - 1;
  const ms = s => Math.round(cuts.slice(s.from, s.to + 1).reduce((a, c) => a + c.dur, 0) * 1000);
  let list = [];
  fixed.forEach(s => { // 120초 넘는 섹션은 나눈다
    const total = ms(s); if (total <= 120000) { list.push({ ...s, ms: total }); return; }
    const n = Math.ceil(total / 120000); for (let k = 0; k < n; k++) list.push({ ...s, name: s.name + ` (${k + 1}/${n})`, ms: Math.round(total / n), part: k });
  });
  for (let k = 0; k < list.length; k++) { // 3초 안 되는 섹션은 이웃과 합친다
    if (list[k].ms >= 3000 || list.length === 1) continue;
    const into = k > 0 ? k - 1 : k + 1; list[into].ms += list[k].ms; list[into].to = Math.max(list[into].to, list[k].to); list[into].from = Math.min(list[into].from, list[k].from); list.splice(k, 1); k--;
  }
  if (list.length === 1 && list[0].ms < 3000) list[0].ms = 3000;
  let at = 0; list.forEach(s => { s.start = +(at / 1000).toFixed(2); at += s.ms; });
  // 한 번에 만들 수 있는 곡은 600초·30섹션까지 → 넘으면 여러 곡(piece)으로 나눈다
  const pieces = []; let cur = [], curMs = 0;
  list.forEach((s, k) => { if (cur.length && (curMs + s.ms > 600000 || cur.length >= 30)) { pieces.push(cur); cur = []; curMs = 0; } cur.push(k); curMs += s.ms; });
  if (cur.length) pieces.push(cur);
  return json({ title: String(out?.title || '배경음악').slice(0, 40), summary: String(out?.summary || '').slice(0, 400), global: { positive: strs(out?.global?.positive, 8, 60), negative: strs(out?.global?.negative, 8, 60) }, sections: list, pieces, model: SCORE_MODEL });
}
/* 효과음 설계: 컷마다 필요한 효과음·환경음을 시각과 함께 고른다 */
async function sfxPlan(env, b) {
  const cuts = storyCuts(b), max = Math.min(60, Math.max(1, +b.max || 30));
  const existing = (Array.isArray(b.existing) ? b.existing : []).slice(0, 80).map(x => ({ start: +(+x?.start || 0).toFixed(1), name: String(x?.name || '').slice(0, 40) }));
  const system = 'You are the sound designer for a Korean motion webtoon (moving comic video). You get every cut in order (image if provided, scene note, dialogue/narration, duration, start time). ' +
    `Propose at most ${max} sound effects that make it feel alive: ambience beds for locations (one ambience spanning consecutive cuts in the same place, loop=true), foley (footsteps, cloth, doors, water, objects), impacts and whooshes on action, and a few subtle emotional stingers. ` +
    'Be selective and cinematic: do not stack many sounds at once, keep them under speech, and do not duplicate the existing sounds listed. Time each effect to the moment it happens inside the cut ("at" seconds from the cut start). ' +
    (arcText(b.arc) ? 'Follow this story arc (shared by every step): quiet beats get sparse ambience, high-tension beats and climaxes get stronger accents and stingers:\n' + arcText(b.arc) + '\n' : '') +
    (b.hint ? 'Director\'s note: ' + String(b.hint).slice(0, 300) + '. ' : '') +
    'Reply with ONLY JSON, no markdown: {"summary":"1-2 sentences in Korean","items":[{"cut":number,"at":seconds,"to_cut":number (ambience only, last cut it covers),"label":"short Korean name","prompt":"detailed English description for a sound-effect generator","dur":0.5..30,"loop":boolean,"vol":0.2..1}]}';
  const out = await askClaude(env, system, cuts, { request: 'sound effect plan', existing_sounds: existing }, 6000);
  const total = cuts.reduce((a, c) => a + c.dur, 0);
  const items = (Array.isArray(out?.items) ? out.items : []).map(x => {
    const ci = Math.trunc(+x?.cut); if (!(ci >= 0 && ci < cuts.length)) return null;
    const c = cuts[ci], at = Math.min(Math.max(0, +x?.at || 0), Math.max(0, c.dur - 0.3)), start = +(c.start + at).toFixed(2);
    const loop = !!x?.loop, toCut = loop ? Math.min(cuts.length - 1, Math.max(ci, Math.trunc(+x?.to_cut) || ci)) : ci;
    const span = loop ? +(cuts[toCut].start + cuts[toCut].dur - start).toFixed(2) : 0;
    const prompt = String(x?.prompt || '').trim().slice(0, 400); if (!prompt) return null;
    return { cut: ci, at: +at.toFixed(2), start, toCut, label: String(x?.label || '효과음').slice(0, 24), prompt, dur: +Math.min(30, Math.max(0.5, +x?.dur || (loop ? 10 : 2))).toFixed(1), loop, len: loop ? Math.min(span, total - start) : 0, vol: +Math.min(1, Math.max(0.2, +x?.vol || 0.7)).toFixed(2) };
  }).filter(Boolean).sort((a, b) => a.start - b.start).slice(0, max);
  return json({ summary: String(out?.summary || '').slice(0, 300), items, model: SCORE_MODEL });
}
const elKey = env => { const k = env[ENV.eleven]; if (!k) throw Object.assign(new Error('ELEVENLABS_API_KEY 없음 (서버 환경변수에 넣어 주세요)'), { status: 502 }); return k; };
/* 일레븐랩스 음성 라이브러리(공유 목소리) 검색 — 사이트의 ‘탐색’ 화면과 같은 필터 */
const LIB_PARAMS = { search: 120, language: 10, locale: 20, accent: 40, gender: 20, age: 20, category: 20, sort: 30, page: 4 };
async function elevenLibrary(env, q) {
  const key = elKey(env), u = new URL('https://api.elevenlabs.io/v1/shared-voices');
  u.searchParams.set('page_size', String(Math.min(100, Math.max(1, +q.get('page_size') || 40))));
  for (const [k, max] of Object.entries(LIB_PARAMS)) { const v = (q.get(k) || '').trim(); if (v) u.searchParams.set(k, v.slice(0, max)); }
  for (const k of ['use_cases', 'descriptives']) q.getAll(k).filter(Boolean).slice(0, 10).forEach(v => u.searchParams.append(k, v.slice(0, 40)));
  if (q.get('featured') === 'true') u.searchParams.set('featured', 'true');
  const r = await fetch(u, { headers: { 'xi-api-key': key } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.detail?.message || (typeof j.detail === 'string' ? j.detail : '') || 'HTTP ' + r.status), { status: 502 });
  const lang = (q.get('language') || '').trim();
  return {
    hasMore: !!j.has_more, total: +j.total_count || 0,
    voices: (j.voices || []).map(v => {
      const vl = (v.verified_languages || []).filter(x => x && x.language);
      const mine = vl.find(x => x.language === lang && x.preview_url) || null;
      return {
        id: v.voice_id, owner: v.public_owner_id, name: v.name, description: v.description || '',
        gender: v.gender || '', age: v.age || '', accent: mine?.accent || v.accent || '', descriptive: v.descriptive || '', useCase: v.use_case || '',
        category: v.category || '', language: mine?.language || v.language || '', locale: mine?.locale || v.locale || '',
        trial: mine?.preview_url || v.preview_url || '', image: v.image_url || '',
        langs: [...new Set(vl.map(x => x.language))].length, users1y: +v.cloned_by_count || 0, chars1y: +v.usage_character_count_1y || 0,
        added: !!v.is_added_by_user, freeOk: v.free_users_allowed !== false, rate: v.fiat_rate ?? v.rate ?? null, notice: v.notice_period ?? null,
      };
    }),
  };
}
/* 라이브러리 목소리를 내 계정 목소리로 추가 → 계정에서 쓰는 voice_id. 이미 추가돼 있으면 내 목록에서 찾아 돌려준다 */
async function elevenAddVoice(env, b) {
  const key = elKey(env), owner = String(b.owner || '').trim(), voice = String(b.voice || '').trim();
  if (!owner || !voice || /[/?#]/.test(owner + voice)) return json({ error: 'owner 와 voice 가 필요합니다' }, 400);
  const r = await fetch('https://api.elevenlabs.io/v1/voices/add/' + encodeURIComponent(owner) + '/' + encodeURIComponent(voice), {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ new_name: String(b.name || voice).slice(0, 100) }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.voice_id) return json({ voiceId: j.voice_id });
  const mine = await TTS.eleven.voices(env).catch(() => []);
  const hit = mine.find(v => v.original === voice || v.id === voice);
  if (hit) return json({ voiceId: hit.id, already: true });
  return json({ error: j.detail?.message || (typeof j.detail === 'string' ? j.detail : '') || 'HTTP ' + r.status, kind: ttsKind(r.status) }, 502);
}
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const GEMINI_VOICES = ['Kore', 'Puck', 'Zephyr', 'Charon', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];
/* 엔진 하나 = { synth, voices } — 새 엔진은 여기에 한 줄 더하면 된다 */
const TTS = {
  openai: { synth: openaiTts, voices: async () => OPENAI_VOICES.map(v => ({ id: v, name: v })) },
  gemini: { synth: geminiTts, voices: async () => GEMINI_VOICES.map(v => ({ id: v, name: v })) },
  eleven: {
    synth: elevenTts,
    voices: async env => {
      const key = elKey(env);
      const r = await fetch('https://api.elevenlabs.io/v2/voices?page_size=100', { headers: { 'xi-api-key': key } });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.detail?.message || 'HTTP ' + r.status), { status: 502 });
      return (j.voices || []).map(v => ({
        id: v.voice_id, name: v.name + (v.category && v.category !== 'premade' ? ' (내 목소리)' : ''), trial: v.preview_url || '',
        gender: v.labels?.gender || '', age: v.labels?.age || '', accent: v.labels?.accent || '', descriptive: v.labels?.descriptive || v.labels?.description || '',
        useCase: v.labels?.use_case || '', language: v.labels?.language || '', category: v.category || '', description: v.description || '',
        original: v.sharing?.original_voice_id || '',
      }));
    },
  },
  typecast: {
    synth: typecastTts,
    voices: async (env, lang, q) => {
      const key = env[ENV.typecast]; if (!key) throw Object.assign(new Error('TYPECAST_API_KEY 없음 (서버 환경변수에 넣어 주세요)'), { status: 502 });
      const u = new URL('https://api.typecast.ai/v3/voices');
      const pick = (k, ok) => { const v = (q?.get(k) || '').trim(); if (v && ok.test(v)) u.searchParams.set(k, v); };
      pick('model', /^ssfm-v(21|30|31)$/); pick('gender', /^(male|female)$/); pick('age', /^(child|teenager|young_adult|middle_age|elder)$/); pick('voice_type', /^(original|custom)$/); pick('use_cases', /^[A-Za-z/ -]{2,30}$/);
      const r = await fetch(u, { headers: { 'X-API-KEY': key } });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw Object.assign(new Error(j?.message || 'HTTP ' + r.status), { status: 502 });
      const want = q?.get('model') || 'ssfm-v30';
      return (Array.isArray(j) ? j : j?.voices || []).map(v => {
        const m = (v.models || []).find(x => x.version === want) || (v.models || [])[0] || {};
        return { id: v.voice_id, name: (typeof v.voice_name === 'object' ? v.voice_name?.kor || v.voice_name?.eng : v.voice_name) || v.voice_id, nameEn: typeof v.voice_name === 'object' ? v.voice_name?.eng || '' : '',
          trial: v.preview_url || '', gender: v.gender || '', age: v.age || '', useCase: (v.use_cases || []).join(', '), category: v.voice_type || '', emotions: m.emotions || [], models: (v.models || []).map(x => x.version) };
      });
    },
  },
  google: {
    synth: googleTts,
    voices: async (env, lang) => {
      const key = env[ENV.gcTts] || env[ENV.gemini]; if (!key) throw Object.assign(new Error('GOOGLE_TTS_API_KEY 없음'), { status: 502 });
      const r = await fetch('https://texttospeech.googleapis.com/v1/voices?languageCode=' + encodeURIComponent(lang || 'ko-KR'), { headers: { 'x-goog-api-key': key } });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error?.message || 'HTTP ' + r.status), { status: 502 });
      return (j.voices || []).map(v => ({ id: v.name, name: v.name + (v.ssmlGender ? ' · ' + (v.ssmlGender === 'FEMALE' ? '여' : v.ssmlGender === 'MALE' ? '남' : '중성') : '') }))
        .sort((a, b) => (/Chirp3/.test(b.id) - /Chirp3/.test(a.id)) || a.id.localeCompare(b.id));
    },
  },
};
/* POST {provider, text, voice, model, speed, instructions} → {key}
   POST {op:'sts', key, voice, model?, denoise?, stability?, similarity?, style?} → {key}   (목소리 변환)
   POST {op:'sfx', text, duration?, influence?, loop?} → {key}                              (효과음)
   POST {op:'music', text, duration?(초), instrumental?, model?} → {key}                    (배경음악)
   GET ?op=voices&provider= → {voices:[{id,name,trial?}]} */
export async function handleTts(req, env) {
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    if (req.method === 'GET') {
      const u = new URL(req.url);
      if (u.searchParams.get('op') === 'library') return json(await elevenLibrary(env, u.searchParams));
      const eng = TTS[u.searchParams.get('provider') || ''];
      if (u.searchParams.get('op') !== 'voices' || !eng) return json({ error: 'op=voices 와 provider(openai·gemini·google·eleven·typecast)가 필요합니다' }, 400);
      return json({ voices: await eng.voices(env, u.searchParams.get('lang'), u.searchParams) });
    }
    if (req.method !== 'POST') return json({ error: 'GET·POST만 됩니다' }, 405);
    const b = await readObject(req);
    if (b.op === 'sts') return await elevenSts(env, b, who);
    if (b.op === 'sfx') return await elevenSfx(env, b, who);
    if (b.op === 'music') return await elevenMusic(env, b, who);
    if (b.op === 'addvoice') return await elevenAddVoice(env, b);
    if (b.op === 'direct') return await directLines(env, b);
    if (b.op === 'scoreplan') return await scorePlan(env, b);
    if (b.op === 'sfxplan') return await sfxPlan(env, b);
    if (b.op === 'arc') return await arcPlan(env, b);
    if (b.op === 'scriptfill') return await scriptFill(env, b);
    const prov = b.provider || (b.voiceId ? 'eleven' : 'openai'); // 예전 클라이언트는 일레븐랩스를 provider 없이 보냈다
    const eng = TTS[prov]; if (!eng) return json({ error: '모르는 음성 엔진: ' + prov }, 400);
    if (!String(b.text || '').trim()) return json({ error: '텍스트가 비어 있습니다' }, 400);
    return await eng.synth(env, b, who);
  } catch (e) { return json({ error: e.message }, e.status || 502); }
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
    if (p === '/api/layout') return handleLayout(req, env);
    if (p === '/api/edit') return handleEdit(req, env);
    if (p === '/api/captions') return handleCaptions(req, env);
    if (p === '/api/ovlayout') return handleOvLayout(req, env);
    if (p === '/api/prompt') return handlePrompt(req, env);
    if (p === '/api/config') return handleConfig(req, env);
    return json({ error: 'not found' }, 404);
  },
};
