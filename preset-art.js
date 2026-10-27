/* 카메라 앵글·조명 방향 버튼에 붙이는 설명용 일러스트(직접 그린 벡터).
   같은 인물 흉상을 각 앵글·조명대로 그려 한눈에 차이가 보이게 한다. 외부 이미지·영화 장면은 쓰지 않는다.
   window.PRESET_ART = { cam: { <CAMERA k>: '<svg>…' }, lit: { <LIGHTS k>: '<svg>…' } } */
(function () {
  const W = 120, H = 90;
  const SKIN = '#f4d9c0', SKIN_D = '#d9a889', HAIR = '#1f2a4a', SUIT = '#3b4a6b', SHIRT = '#e8ecf4', LINE = '#b5715a';
  const svg = (body, defs = '') => '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><defs>' + defs + '</defs>' + body + '</svg>';
  const fill = (el, c) => el.replace('/>', ' fill="' + c + '"/>');
  const f1 = n => (Math.round(n * 10) / 10);

  /* 정면 흉상의 부분들(조명 그림에서는 같은 모양을 클리핑에도 쓴다) */
  const SH = '<path d="M20 90 Q20 63 44 60 L76 60 Q100 63 100 90Z"/>';
  const NECK = '<rect x="53" y="50" width="14" height="14" rx="3"/>';
  const HEAD = '<ellipse cx="60" cy="36" rx="19" ry="22"/>';
  const HAIRP = '<path d="M40 36 Q38 12 60 12 Q82 12 80 36 Q76 24 60 24 Q44 24 40 36Z"/>';
  const eyes = (y, dx, r) => '<circle cx="' + (60 - dx) + '" cy="' + y + '" r="' + r + '" fill="' + HAIR + '"/><circle cx="' + (60 + dx) + '" cy="' + y + '" r="' + r + '" fill="' + HAIR + '"/>';
  const mouth = (y, w) => '<path d="M' + (60 - w) + ' ' + y + ' Q60 ' + (y + 3) + ' ' + (60 + w) + ' ' + y + '" fill="none" stroke="' + LINE + '" stroke-width="1.4" stroke-linecap="round"/>';
  const FRONT = fill(SH, SUIT) + '<path d="M50 60 L60 74 L70 60Z" fill="' + SHIRT + '"/>' + fill(NECK, SKIN_D) + fill(HEAD, SKIN) + fill(HAIRP, HAIR) + eyes(38, 8, 2.2) + mouth(48, 5);
  const sky = id => '<linearGradient id="sk-' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe3f3"/><stop offset="1" stop-color="#eef4f8"/></linearGradient>';
  const bgRect = (c, id) => '<rect width="' + W + '" height="' + H + '" fill="' + (c || 'url(#sk-' + id + ')') + '"/>';

  /* ---------- 카메라 앵글 ---------- */
  const cam = {};
  cam.eye = svg(bgRect(null, 'eye') + FRONT, sky('eye'));
  cam.high = svg(bgRect(null, 'high') +
    '<path d="M14 90 Q16 66 42 63 L78 63 Q104 66 106 90Z" fill="' + SUIT + '"/>' +
    '<ellipse cx="60" cy="41" rx="21" ry="19" fill="' + SKIN + '"/>' +
    '<path d="M39 41 Q37 14 60 13 Q83 14 81 41 Q78 33 70 31 Q60 35 50 31 Q42 33 39 41Z" fill="' + HAIR + '"/>' +
    eyes(44, 8, 2) + mouth(53, 4) +
    '<path d="M50 63 L60 72 L70 63Z" fill="' + SHIRT + '"/>', sky('high'));
  cam.low = svg(bgRect(null, 'low') +
    '<path d="M16 90 Q18 68 42 66 L78 66 Q102 68 104 90Z" fill="' + SUIT + '"/>' +
    '<rect x="50" y="56" width="20" height="12" rx="3" fill="' + SKIN_D + '"/>' +
    '<path d="M41 36 Q43 60 60 62 Q77 60 79 36 Q71 49 60 49 Q49 49 41 36Z" fill="#e8c0a2"/>' +
    '<ellipse cx="60" cy="32" rx="19" ry="18" fill="' + SKIN + '"/>' +
    '<path d="M41 30 Q40 13 60 13 Q80 13 79 30 Q72 22 60 22 Q48 22 41 30Z" fill="' + HAIR + '"/>' +
    eyes(30, 8, 2.2) + '<ellipse cx="57" cy="40" rx="1.3" ry="1.7" fill="#7a4a3a"/><ellipse cx="63" cy="40" rx="1.3" ry="1.7" fill="#7a4a3a"/>' + mouth(45, 5), sky('low'));
  cam.bird = svg(bgRect(null, 'bird') +
    '<ellipse cx="60" cy="70" rx="46" ry="18" fill="' + SUIT + '"/>' +
    '<ellipse cx="38.5" cy="48" rx="3" ry="4.5" fill="' + SKIN + '"/><ellipse cx="81.5" cy="48" rx="3" ry="4.5" fill="' + SKIN + '"/>' +
    '<circle cx="60" cy="44" r="21" fill="' + HAIR + '"/>' +
    '<path d="M60 44 m-2 0 a2 2 0 1 1 4 0 a6 6 0 1 1 -12 0 a10 10 0 1 1 20 0 a14 14 0 1 1 -28 0" fill="none" stroke="#4a5b8e" stroke-width="1.3" stroke-linecap="round"/>', sky('bird'));
  /* 웜아이: 바닥에서 올려다본 전신 — 발·다리는 크고 위로 갈수록 좁아져 머리는 작게 보인다 */
  cam.worm = svg('<rect width="' + W + '" height="' + H + '" fill="#bfdcf2"/><path d="M0 14 Q30 4 60 10 Q90 4 120 14 L120 0 L0 0Z" fill="#e6f1f9" opacity=".7"/>' +
    '<polygon points="14,90 42,90 60,42 52,42" fill="' + SUIT + '"/><polygon points="106,90 78,90 60,42 68,42" fill="' + SUIT + '"/>' +
    '<ellipse cx="27" cy="87" rx="15" ry="4.6" fill="#1b1f2a"/><ellipse cx="93" cy="87" rx="15" ry="4.6" fill="#1b1f2a"/>' +
    '<path d="M50 44 L70 44 L67 26 L53 26Z" fill="' + SUIT + '"/><path d="M57 26 L60 33 L63 26Z" fill="' + SHIRT + '"/>' +
    '<circle cx="60" cy="18" r="6.4" fill="' + SKIN + '"/><path d="M53.6 18 Q53.4 11.6 60 11.4 Q66.6 11.6 66.4 18 Q63.4 14.6 60 14.8 Q56.6 14.6 53.6 18Z" fill="' + HAIR + '"/>');
  cam.dutch = svg('<g transform="rotate(-16 60 45)"><rect x="-40" y="-40" width="200" height="170" fill="url(#sk-dutch)"/>' +
    '<rect x="-40" y="68" width="200" height="70" fill="#c9d3d9"/><line x1="-40" y1="68" x2="160" y2="68" stroke="#7a8a96" stroke-width="1.4"/>' + FRONT + '</g>', sky('dutch'));
  cam.close = svg(bgRect(null, 'close') +
    '<ellipse cx="60" cy="54" rx="40" ry="46" fill="' + SKIN + '"/>' +
    '<path d="M20 52 Q18 -2 60 2 Q102 -2 100 52 Q92 24 60 26 Q28 24 20 52Z" fill="' + HAIR + '"/>' +
    '<path d="M36 41 L52 40 M68 40 L84 41" stroke="' + HAIR + '" stroke-width="2" stroke-linecap="round"/>' +
    '<circle cx="44" cy="51" r="4.4" fill="' + HAIR + '"/><circle cx="76" cy="51" r="4.4" fill="' + HAIR + '"/>' +
    '<circle cx="45.4" cy="49.6" r="1.3" fill="#fff"/><circle cx="77.4" cy="49.6" r="1.3" fill="#fff"/>' +
    '<path d="M60 56 L57.5 67 L62.5 67" fill="none" stroke="' + LINE + '" stroke-width="1.2" stroke-linejoin="round"/>' +
    '<path d="M49 78 Q60 85 71 78" fill="none" stroke="' + LINE + '" stroke-width="1.8" stroke-linecap="round"/>', sky('close'));
  cam.wide = svg(bgRect(null, 'wide') + '<circle cx="96" cy="20" r="7" fill="#ffe08a"/>' +
    '<path d="M0 66 L22 44 L40 62 L62 40 L90 64 L108 50 L120 58 L120 90 L0 90Z" fill="#a9bdb1"/>' +
    '<rect y="70" width="120" height="20" fill="#cdbd94"/>' +
    '<ellipse cx="60" cy="79" rx="7" ry="1.8" fill="#000" opacity=".18"/>' +
    '<circle cx="60" cy="57" r="3.2" fill="' + SKIN + '"/><path d="M56.8 57 Q57 53.4 60 53.4 Q63 53.4 63.2 57 Q61.5 55.4 60 55.4 Q58.5 55.4 56.8 57Z" fill="' + HAIR + '"/>' +
    '<path d="M56 60.5 h8 l1 10 h-10z" fill="' + SUIT + '"/><path d="M57.5 70.5 v8 M62.5 70.5 v8" stroke="' + SUIT + '" stroke-width="2" stroke-linecap="round"/>', sky('wide'));
  cam.side = svg(bgRect(null, 'side') +
    '<path d="M24 90 Q26 64 52 62 L80 62 Q98 64 100 90Z" fill="' + SUIT + '"/>' +
    '<path d="M52 50 h15 v14 h-15z" fill="' + SKIN_D + '"/>' +
    '<path d="M46 44 Q44 18 64 14 Q82 14 82 34 L91 40 L82 44 L83 50 Q80 56 72 56 Q60 58 52 54 Q46 52 46 44Z" fill="' + SKIN + '"/>' +
    '<path d="M46 40 Q42 14 66 12 Q85 12 83 30 Q72 22 58 26 Q50 30 46 40Z" fill="' + HAIR + '"/>' +
    '<ellipse cx="58" cy="40" rx="3" ry="5" fill="' + SKIN_D + '"/><circle cx="75" cy="36" r="2" fill="' + HAIR + '"/>' +
    '<path d="M77 49 L84 49" stroke="' + LINE + '" stroke-width="1.4" stroke-linecap="round"/>', sky('side'));

  /* ---------- 조명 방향 ---------- */
  const sun = (x, y, r) => {
    r = r || 4; let rays = '';
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; rays += '<line x1="' + f1(x + Math.cos(a) * (r + 1.4)) + '" y1="' + f1(y + Math.sin(a) * (r + 1.4)) + '" x2="' + f1(x + Math.cos(a) * (r + 3.6)) + '" y2="' + f1(y + Math.sin(a) * (r + 3.6)) + '" stroke="#f5b400" stroke-width="1.2" stroke-linecap="round"/>'; }
    return '<g>' + rays + '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="#ffd23f" stroke="#d99a00" stroke-width="1"/></g>';
  };
  const arrow = (x1, y1, x2, y2) => {
    const a = Math.atan2(y2 - y1, x2 - x1), h = 3.6, p = s => (f1(x2 - Math.cos(a + s) * h) + ',' + f1(y2 - Math.sin(a + s) * h));
    return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#f5b400" stroke-width="1.6" stroke-dasharray="3 2" stroke-linecap="round"/><polygon points="' + x2 + ',' + y2 + ' ' + p(-0.45) + ' ' + p(0.45) + '" fill="#f5b400"/>';
  };
  const clip = k => '<clipPath id="lc-' + k + '">' + SH + NECK + HEAD + HAIRP + '</clipPath>';
  const shade = (k, grad, extra) => '<g clip-path="url(#lc-' + k + ')"><rect width="' + W + '" height="' + H + '" fill="url(#lg-' + k + ')"/>' + (extra || '') + '</g>';
  const lin = (k, x1, y1, x2, y2, a) => '<linearGradient id="lg-' + k + '" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"><stop offset="0" stop-color="#05070d" stop-opacity="0"/><stop offset="1" stop-color="#05070d" stop-opacity="' + a + '"/></linearGradient>';
  const lit = {};
  const BG = '#dde4e9';
  lit.front = svg(bgRect(BG) + FRONT +
    '<g clip-path="url(#lc-front)"><rect width="120" height="90" fill="url(#lg-front)"/><ellipse cx="60" cy="59" rx="12" ry="3.2" fill="#05070d" opacity=".07"/></g>' +
    '<g transform="translate(60 83)"><rect x="-8" y="-4.6" width="16" height="9.2" rx="2" fill="#fff" stroke="#5a554a" stroke-width="1"/><circle r="3" fill="#7d8a99" stroke="#5a554a" stroke-width="1"/></g>' +
    '<path d="M50 77 L47 72 M60 76 L60 70 M70 77 L73 72" stroke="#f5b400" stroke-width="1.5" stroke-linecap="round"/>',
    clip('front') + '<radialGradient id="lg-front" cx="60" cy="34" r="34" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".3"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>');
  lit.left = svg(bgRect(BG) + FRONT + shade('left') + sun(10, 40) + arrow(19, 40, 40, 40), clip('left') + lin('left', 0.25, 0, 0.75, 0, 0.7));
  lit.right = svg(bgRect(BG) + FRONT + shade('right') + sun(110, 40) + arrow(101, 40, 80, 40), clip('right') + lin('right', 0.75, 0, 0.25, 0, 0.7));
  lit.back = svg(bgRect('#242838') + '<circle cx="60" cy="30" r="40" fill="url(#rg-back)"/>' +
    '<g filter="url(#gl-back)" fill="#fff3c4" stroke="#fff3c4" stroke-width="3.4" stroke-linejoin="round">' + SH + NECK + HEAD + HAIRP + '</g>' +
    FRONT + shade('back') + sun(60, 6, 3.4),
    clip('back') + lin('back', 0, 0, 0, 0, 0) .replace('stop-opacity="0"/><stop offset="1" stop-color="#05070d" stop-opacity="0"', 'stop-opacity=".72"/><stop offset="1" stop-color="#05070d" stop-opacity=".72"') +
    '<radialGradient id="rg-back"><stop offset="0" stop-color="#ffe9a3" stop-opacity=".9"/><stop offset="1" stop-color="#ffe9a3" stop-opacity="0"/></radialGradient>' +
    '<filter id="gl-back" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation=".9"/></filter>');
  lit.top = svg(bgRect(BG) + FRONT + shade('top', null,
    '<ellipse cx="52" cy="39" rx="6" ry="3.6" fill="#05070d" opacity=".32"/><ellipse cx="68" cy="39" rx="6" ry="3.6" fill="#05070d" opacity=".32"/><ellipse cx="60" cy="47" rx="4" ry="2.4" fill="#05070d" opacity=".28"/><ellipse cx="60" cy="60" rx="13" ry="4.6" fill="#05070d" opacity=".2"/>') +
    sun(60, 6, 3.4) + arrow(60, 11, 60, 17), clip('top') + lin('top', 0, 0.15, 0, 0.85, 0.6));
  lit.under = svg(bgRect('#c9d1d8') + FRONT + shade('under', null,
    '<ellipse cx="52" cy="33" rx="6" ry="3.2" fill="#05070d" opacity=".3"/><ellipse cx="68" cy="33" rx="6" ry="3.2" fill="#05070d" opacity=".3"/>') +
    sun(60, 84, 4) + arrow(60, 77, 60, 66), clip('under') + lin('under', 0, 0.85, 0, 0.15, 0.68));
  lit.keyL = svg(bgRect(BG) + FRONT + shade('keyL') + sun(12, 12) + arrow(19, 18, 36, 30), clip('keyL') + lin('keyL', 0.22, 0.1, 0.8, 0.9, 0.55));
  lit.keyR = svg(bgRect(BG) + FRONT + shade('keyR') + sun(108, 12) + arrow(101, 18, 84, 30), clip('keyR') + lin('keyR', 0.78, 0.1, 0.2, 0.9, 0.55));
  lit.dim = svg(bgRect('#0e1117') + FRONT +
    '<g clip-path="url(#lc-dim)"><rect width="120" height="90" fill="#05070d" opacity=".82"/><ellipse cx="49" cy="38" rx="17" ry="19" fill="url(#lg-dim)"/></g>' + sun(12, 22, 2.8),
    clip('dim') + '<radialGradient id="lg-dim"><stop offset="0" stop-color="#ffe7b0" stop-opacity=".55"/><stop offset="1" stop-color="#ffe7b0" stop-opacity="0"/></radialGradient>');

  window.PRESET_ART = { cam: cam, lit: lit };
})();
