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
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  let body; try { body = await req.json(); } catch (e) { return json({ error: '잘못된 JSON' }, 400); }
  const prompt = String(body.prompt || '').slice(0, 30000);
  if (!prompt) return json({ error: 'prompt 가 비었습니다' }, 400);
  const order = (Array.isArray(body.order) && body.order.length ? body.order : ['openai', 'gemini']).filter(p => p === 'openai' || p === 'gemini');
  let refs;
  try { refs = await Promise.all((body.refs || []).slice(0, 16).map(k => r2Get(env, String(k), who))); }
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
    const b = await req.json();
    if (!b.voiceId) return json({ error: 'voiceId 가 없습니다' }, 400);
    await klingNew(env, '/v1/general/delete-voices', { method: 'POST', body: JSON.stringify({ voice_id: String(b.voiceId) }) });
    return json({ ok: true });
  }
  if (op === 'voice' && req.method === 'POST') {
    const b = await req.json();
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
    const b = await req.json();
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
  const op = new URL(req.url).searchParams.get('op') || (req.method === 'POST' ? await req.clone().json().then(j => j.op, () => '') : '');
  if (op === 'voices' || op === 'element' || op === 'voice' || op === 'voicedel') return handleKlingElement(req, env, who, op);
  if (req.method === 'POST') {
    const b = await req.json();
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
      const b = await req.json();
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
      const b = await req.json();
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
      const b = await req.json();
      await db(env, 'projects?id=eq.' + q(id) + '&' + own, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ title: String(b.title || '새 무빙툰').slice(0, 200), updated_at: new Date().toISOString() }) });
      return json({ ok: true });
    }
    if (req.method === 'DELETE') {
      if (!id) return json({ error: 'id 가 없습니다' }, 400);
      await db(env, 'projects?id=eq.' + q(id) + '&' + own, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json({ ok: true });
    }
    return json({ error: '지원하지 않는 메서드' }, 405);
  } catch (e) { return json({ error: e.message }, 502); }
}

/* ---------- 사용량·비용 기록 (테이블 usage_log) ---------- */
export async function handleUsage(req, env) {
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    if (req.method === 'POST') {
      const b = await req.json();
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
  } catch (e) { return json({ error: e.message }, 502); }
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
  motion: 'Task: write an IMAGE-TO-VIDEO MOTION prompt for a short clip (see "len" seconds) that animates a still frame ("scene" tells you what it shows). Describe only motion over time: character movement and expressions, hair/cloth/environment motion, camera movement (push-in, pan, tilt, handheld shake or static) and pacing, as a short sequence that fits the duration. Keep motion natural and moderate unless the draft asks for dramatic action. Do not change the composition, art style, character design or colors. Do not write dialogue. End the prompt with: Keep the exact same art style, character design and colors. No text.',
};
export async function handlePrompt(req, env) {
  if (req.method !== 'POST') return json({ error: 'POST만 됩니다' }, 405);
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    const key = env[ENV.anthropic]; if (!key) return json({ error: 'ANTHROPIC_API_KEY 없음', kind: 'auth' }, 502);
    const b = await req.json();
    const mode = PROMPT_TASK[b.mode] ? b.mode : 'scene', draft = String(b.draft || '').slice(0, 2000);
    if (!draft.trim() && !String(b.extra || '').trim()) return json({ error: '초안이 비었습니다' }, 400);
    const chars = (Array.isArray(b.characters) ? b.characters : []).slice(0, 6).map(c => ({ name: String(c.name || '').slice(0, 40), appearance: String(c.desc || '').slice(0, 300) }));
    const user = JSON.stringify({
      draft, extra: String(b.extra || '').slice(0, 1000), scene: String(b.scene || '').slice(0, 1000), characters: chars,
      aspect: String(b.aspect || '9:16').slice(0, 8), has_image: !!b.hasImage, len: +b.len || 5, audio: !!b.audio,
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
  } catch (e) { return json({ error: e.message }, 502); }
}

/* ---------- 출판만화 배치: 컷 순서는 그대로 두고 페이지·줄·칸 크기를 Claude 가 정한다 ---------- */
const LAYOUT_MODEL = 'claude-sonnet-5-5';
export async function handleLayout(req, env) {
  if (req.method !== 'POST') return json({ error: 'POST만 됩니다' }, 405);
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    const key = env[ENV.anthropic]; if (!key) return json({ error: 'ANTHROPIC_API_KEY 없음', kind: 'auth' }, 502);
    const b = await req.json();
    const cuts = (Array.isArray(b.cuts) ? b.cuts : []).slice(0, 120).map(c => ({ i: +c.i, ratio: +(+c.ratio).toFixed(3), big: !!c.big, desc: String(c.desc || '').slice(0, 160), texts: (c.texts || []).slice(0, 4), dur: +c.dur || 0 }));
    if (!cuts.length) return json({ error: '컷이 없습니다' }, 400);
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
    if (!Array.isArray(out.pages)) return json({ error: 'AI 응답에 pages 가 없습니다' }, 502);
    return json({ pages: out.pages, reason: String(out.reason || '').slice(0, 400), model: LAYOUT_MODEL });
  } catch (e) { return json({ error: e.message }, 502); }
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
  return json({ key: await r2Put(env, pcmToWav(unb64(data)), 'audio/wav', 'wav', who) });
}
export async function handleTts(req, env) {
  if (req.method !== 'POST') return json({ error: 'POST만 됩니다' }, 405);
  const who = await authUser(req, env); if (!who) return json({ error: '인증이 필요합니다. Google로 로그인하거나 관리자 비밀번호를 확인하세요.' }, 401);
  try {
    const b = await req.json();
    if (b.provider === 'gemini') return await geminiTts(env, b, who);
    if (b.provider !== 'openai') return json({ error: '이 서버는 OpenAI·Gemini 음성만 지원합니다 (일레븐랩스 미구현)' }, 400);
    const key = env[ENV.openai]; if (!key) return json({ error: 'OPENAI_API_KEY 없음', kind: 'auth' }, 502);
    const body = { model: b.model || 'gpt-4o-mini-tts', voice: b.voice || 'coral', input: String(b.text || '').slice(0, 4000), speed: +b.speed || 1, response_format: 'mp3' };
    if (b.instructions && !/^tts-1/.test(body.model)) body.instructions = String(b.instructions).slice(0, 1000);
    const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return json({ error: j.error?.message || 'HTTP ' + r.status, kind: r.status === 429 ? 'rate' : 'bad' }, 502); }
    return json({ key: await r2Put(env, await r.arrayBuffer(), 'audio/mpeg', 'mp3', who) });
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
    if (p === '/api/layout') return handleLayout(req, env);
    if (p === '/api/prompt') return handlePrompt(req, env);
    if (p === '/api/config') return handleConfig(req, env);
    return json({ error: 'not found' }, 404);
  },
};
