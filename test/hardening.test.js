// Protections that never turn a paying subscriber away.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

function config(overrides = {}) {
  return {
    upstreamBaseUrl: 'https://upstream.test/v1',
    upstreamApiKey: 'upstream-secret-key',
    upstreamModel: 'auto',
    passSecret: 'x'.repeat(40),
    passTtlSeconds: 86400,
    streamIdleMs: 0,
    maxBodyBytes: 1024 * 1024,
    upstreamAttempts: 1,
    upstreamTimeoutMs: 5000,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 10,
    ...overrides,
  };
}

async function start({ overrides, upstream } = {}) {
  const calls = [];
  const logs = [];
  const app = createApp({
    config: config(overrides),
    log: (m) => logs.push(m),
    sleep: async () => {},
    verifyPurchase: async (t) =>
      t.startsWith('good')
        ? { active: true, expiresAt: Date.now() + 86400_000 }
        : { active: false, reason: 'unknown_token' },
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return upstream
        ? upstream(init)
        : new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const pass = async (token = 'good-token-1') =>
    (await (await post('/auth', { purchaseToken: token })).json()).pass;
  return {
    base,
    calls,
    logs,
    post,
    pass,
    chat: (body, token) =>
      post('/v1/chat/completions', body, { authorization: `Bearer ${token}` }),
    close: () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  };
}

const MESSAGES = { messages: [{ role: 'user', content: 'hi' }] };

/** An upstream reply that stays open until `end()` is called. */
function held() {
  const ends = [];
  const upstream = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {}\n\n'));
          ends.push(() => {
            try {
              c.close();
            } catch {
              // Already cancelled by the server.
            }
          });
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  return { upstream, endAll: () => ends.splice(0).forEach((e) => e()) };
}

test('asking for several answers at once is ignored', async () => {
  const s = await start();
  try {
    const token = await s.pass();
    await s.chat({ ...MESSAGES, n: 8, temperature: 0.2, model: 'gpt-x' }, token);
    assert.equal(s.calls[0].n, undefined);
    assert.equal(s.calls[0].model, 'auto');
    // Ordinary settings still go through.
    assert.equal(s.calls[0].temperature, 0.2);
  } finally {
    await s.close();
  }
});

test('a reply that goes silent is cut off', async () => {
  const h = held();
  const s = await start({ overrides: { streamIdleMs: 80 }, upstream: h.upstream });
  try {
    const token = await s.pass();
    const res = await s.chat({ ...MESSAGES, stream: true }, token);
    assert.equal(res.status, 200);
    const started = Date.now();
    // The connection is dropped, which the app sees as a failed reply.
    await assert.rejects(res.text());
    assert.ok(Date.now() - started < 3000);
    // The server logs just after dropping the connection.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(s.logs.includes('Upstream went silent mid-reply'));
    // Its slot is free again.
    h.endAll();
    const next = await s.chat(MESSAGES, token);
    assert.equal(next.status, 200);
    h.endAll();
    await next.text();
  } finally {
    h.endAll();
    await s.close();
  }
});

test('responses carry no-store and nosniff', async () => {
  const s = await start();
  try {
    const auth = await s.post('/auth', { purchaseToken: 'good-token-1' });
    assert.equal(auth.headers.get('cache-control'), 'no-store');
    assert.equal(auth.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(auth.headers.get('x-powered-by'), null);
    const { pass } = await auth.json();
    const chat = await s.chat(MESSAGES, pass);
    assert.match(chat.headers.get('cache-control'), /no-store/);
    // No CORS headers: other websites can't use a visitor's pass.
    assert.equal(chat.headers.get('access-control-allow-origin'), null);
  } finally {
    await s.close();
  }
});

test('secrets never appear in what the server sends back', async () => {
  const s = await start({
    upstream: async () =>
      new Response('{"error":"key upstream-secret-key is revoked"}', { status: 401 }),
  });
  try {
    const token = await s.pass();
    const res = await s.chat(MESSAGES, token);
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.ok(!text.includes('upstream-secret-key'));
    assert.ok(!text.includes('x'.repeat(40)));
    assert.ok(!s.logs.join('\n').includes('upstream-secret-key'));
  } finally {
    await s.close();
  }
});
