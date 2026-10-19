const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const source = fs.readFileSync('studio-api.js', 'utf8');
  const api = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const env = { OPEN_ACCESS: 'true', ANTHROPIC_API_KEY: 'test' };
  const request = value => new Request('https://studio.test/api/layout', { method: 'POST', body: typeof value === 'string' ? value : JSON.stringify(value) });
  let checks = 0;
  for (const name of ['handleImage', 'handleKling', 'handleProjects', 'handleUsage', 'handlePolish', 'handlePrompt', 'handleLayout', 'handleTts']) {
    for (const body of ['{', 'null', '[]']) {
      const method = name === 'handleProjects' ? 'PUT' : 'POST';
      const response = await api[name](new Request('https://studio.test/api/test', { method, body }), env);
      assert.equal(response.status, 400, name + ': ' + body); checks++;
    }
  }
  for (const body of [{ prompt: 'test', refs: {} }, { prompt: 'test', refs: [null] }, { prompt: 'test', order: ['unknown'] }]) {
    assert.equal((await api.handleImage(request(body), env)).status, 400); checks++;
  }
  for (const body of ['{', 'null', '[]']) {
    assert.equal((await api.handleKling(request(body), { ...env, KLING_API_KEY: 'test' })).status, 400); checks++;
  }
  const input = { cuts: [{ i: 0, ratio: 1 }, { i: 1, ratio: 1 }] };
  const originalFetch = global.fetch;
  let calls = 0;
  const layout = cells => ({ pages: [{ rows: [{ h: 1, cells }] }] });
  const cell = cut => ({ cut, w: 1 });
  try {
    for (const output of [layout([cell(0)]), layout([cell(0), cell(0)]), layout([cell(1), cell(0)]), layout([cell(0), { cut: 1, w: 0 }]), { pages: [] }, null, layout([cell(0), cell(1)])]) {
      global.fetch = async () => { calls++; return Response.json({ content: [{ type: 'text', text: JSON.stringify(output) }] }); };
      const response = await api.handleLayout(request(input), env);
      assert.equal(response.status, output?.pages?.[0]?.rows?.[0]?.cells?.[1]?.cut === 1 && output.pages[0].rows[0].cells[1].w === 1 ? 200 : 502);
      checks++;
    }
    for (const cuts of [[null], [{ i: 0, ratio: 0 }], [{ i: 0, ratio: 1, texts: {} }], Array.from({ length: 121 }, (_, i) => ({ i, ratio: 1 }))]) {
      const before = calls;
      assert.equal((await api.handleLayout(request({ cuts }), env)).status, 400);
      assert.equal(calls, before); checks++;
    }
  } finally { global.fetch = originalFetch; }
  console.log('PASS: ' + checks + ' API regression checks (mocked external services)');
})().catch(error => { console.error(error); process.exitCode = 1; });
