import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { interpretSubscription } from '../src/play.js';

const HOUR = 60 * 60 * 1000;
const UPSTREAM_KEY = 'upstream-secret-key';

function baseConfig(overrides = {}) {
  return {
    upstreamBaseUrl: 'https://upstream.test/v1',
    upstreamApiKey: UPSTREAM_KEY,
    upstreamModel: 'auto',
    passSecret: 'x'.repeat(40),
    passTtlSeconds: 24 * 60 * 60,
    streamIdleMs: 0,
    maxBodyBytes: 1024 * 1024,
    upstreamAttempts: 3,
    upstreamTimeoutMs: 5000,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 5000,
    ...overrides,
  };
}

/** Starts the app on a free port with fakes for Google and the AI endpoint. */
async function start({ config = {}, verify, upstream } = {}) {
  const clock = { now: Date.now() };
  const calls = [];
  const waits = [];
  const app = createApp({
    config: baseConfig(config),
    now: () => clock.now,
    log: () => {},
    // Retries don't really wait in tests; the waits are recorded instead.
    sleep: async (ms) => void waits.push(ms),
    verifyPurchase:
      verify ??
      (async (token) =>
        token === 'good-token-1234'
          ? { active: true, expiresAt: clock.now + 30 * 24 * HOUR }
          : { active: false, reason: 'unknown_token' }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return upstream
        ? upstream(url, init)
        : new Response('{"choices":[]}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const pass = async () => {
    const res = await post('/auth', { purchaseToken: 'good-token-1234' });
    return (await res.json()).pass;
  };
  const chat = async (body, token) =>
    post('/v1/chat/completions', body, {
      authorization: `Bearer ${token ?? (await pass())}`,
    });
  return {
    base,
    clock,
    calls,
    waits,
    post,
    pass,
    chat,
    close: () =>
      new Promise((r) => {
        server.close(r);
        // fetch keeps connections alive; don't wait for them to time out.
        server.closeAllConnections();
      }),
  };
}

const MESSAGES = { messages: [{ role: 'user', content: 'hi' }] };

describe('POST /auth', () => {
  let s;
  before(async () => (s = await start()));
  after(() => s.close());

  test('gives a pass for an active subscription', async () => {
    const res = await s.post('/auth', { purchaseToken: 'good-token-1234' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.pass, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    const ttl = Date.parse(body.expiresAt) - s.clock.now;
    assert.ok(ttl > 23 * HOUR && ttl <= 24 * HOUR, `ttl was ${ttl}`);
  });

  test('refuses a token Google does not recognise', async () => {
    const res = await s.post('/auth', { purchaseToken: 'made-up-token' });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, 'plan_inactive');
    assert.equal(body.reason, 'unknown_token');
  });

  test('rejects a missing or malformed token', async () => {
    assert.equal((await s.post('/auth', {})).status, 400);
    assert.equal((await s.post('/auth', { purchaseToken: 5 })).status, 400);
    assert.equal((await s.post('/auth', '{not json')).status, 400);
  });
});

test('a pass never outlives the subscription', async () => {
  const s = await start({
    verify: async () => ({ active: true, expiresAt: Date.now() + 2 * HOUR }),
  });
  try {
    const res = await s.post('/auth', { purchaseToken: 'good-token-1234' });
    const ttl = Date.parse((await res.json()).expiresAt) - s.clock.now;
    assert.ok(ttl <= 2 * HOUR && ttl > HOUR, `ttl was ${ttl}`);
  } finally {
    await s.close();
  }
});

test('a Google outage is a 503, not "subscription ended"', async () => {
  const s = await start({
    verify: async () => {
      throw new Error('Play API 500');
    },
  });
  try {
    const res = await s.post('/auth', { purchaseToken: 'good-token-1234' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'verify_unavailable');
  } finally {
    await s.close();
  }
});

describe('POST /v1/chat/completions', () => {
  let s;
  beforeEach(async () => (s = await start()));

  test('needs a valid pass', async () => {
    try {
      const none = await s.post('/v1/chat/completions', MESSAGES);
      assert.equal(none.status, 401);
      assert.equal((await none.json()).error.code, 'invalid_pass');
      assert.equal((await s.chat(MESSAGES, 'not.a.pass')).status, 401);
      // The upstream key itself is not a pass.
      assert.equal((await s.chat(MESSAGES, UPSTREAM_KEY)).status, 401);
      assert.equal(s.calls.length, 0);
    } finally {
      await s.close();
    }
  });

  test('rejects an expired pass', async () => {
    try {
      const token = await s.pass();
      s.clock.now += 25 * HOUR;
      assert.equal((await s.chat(MESSAGES, token)).status, 401);
    } finally {
      await s.close();
    }
  });

  test('rejects a pass signed with another secret', async () => {
    const other = await start({ config: { passSecret: 'y'.repeat(40) } });
    try {
      const forged = await other.pass();
      assert.equal((await s.chat(MESSAGES, forged)).status, 401);
    } finally {
      await other.close();
      await s.close();
    }
  });

  test('forwards with the real key and the plan model', async () => {
    try {
      const token = await s.pass();
      const res = await s.chat(
        { ...MESSAGES, model: 'expensive-model', stream: true },
        token,
      );
      assert.equal(res.status, 200);
      const call = s.calls[0];
      assert.equal(call.url, 'https://upstream.test/v1/chat/completions');
      assert.equal(call.init.headers.authorization, `Bearer ${UPSTREAM_KEY}`);
      assert.equal(call.body.model, 'auto');
      assert.equal(call.body.stream, true);
      assert.deepEqual(call.body.messages, MESSAGES.messages);
      // The pass never reaches the upstream.
      assert.ok(!JSON.stringify(call.init).includes(token));
    } finally {
      await s.close();
    }
  });

  test('rejects a body without messages', async () => {
    try {
      assert.equal((await s.chat({ model: 'auto' })).status, 400);
      assert.equal(s.calls.length, 0);
    } finally {
      await s.close();
    }
  });
});

test('streams the reply through as it arrives', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const s = await start({
    upstream: async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('data: {"a":1}\n\n'));
            await gate;
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  try {
    const res = await s.chat({ ...MESSAGES, stream: true });
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    // The first event arrives while the upstream is still holding the rest.
    const first = dec.decode((await reader.read()).value);
    assert.equal(first, 'data: {"a":1}\n\n');
    release();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += dec.decode(value);
    }
    assert.equal(rest, 'data: [DONE]\n\n');
  } finally {
    await s.close();
  }
});

test('passes upstream errors on, but hides a rejected key', async () => {
  let status = 429;
  const s = await start({
    upstream: async () =>
      new Response(`{"error":{"message":"upstream said ${status}"}}`, {
        status,
        headers: { 'content-type': 'application/json', 'retry-after': '7' },
      }),
  });
  try {
    const busy = await s.chat(MESSAGES);
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get('retry-after'), '7');

    status = 401;
    const rejected = await s.chat(MESSAGES);
    assert.equal(rejected.status, 502);
    const body = await rejected.text();
    assert.ok(!body.includes('upstream said'));
    assert.equal(JSON.parse(body).error.code, 'upstream_auth');
  } finally {
    await s.close();
  }
});

test('a waking upstream is retried and the app sees one clean reply', async () => {
  let n = 0;
  const s = await start({
    upstream: async () => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      if (n === 2) return new Response('waking up', { status: 503 });
      return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  try {
    const res = await s.chat({ ...MESSAGES, stream: true });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('"ok":true'));
    assert.ok(!text.includes('waking up'));
    assert.equal(s.calls.length, 3);
    // Each try carries the same request.
    assert.deepEqual(s.calls[2].body, s.calls[0].body);
  } finally {
    await s.close();
  }
});

test('a bad request is not retried', async () => {
  const s = await start({
    upstream: async () =>
      new Response('{"error":{"message":"bad"}}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
  });
  try {
    assert.equal((await s.chat(MESSAGES)).status, 400);
    assert.equal(s.calls.length, 1);
  } finally {
    await s.close();
  }
});

test('an unreachable upstream is a 502', async () => {
  const s = await start({
    upstream: async () => {
      throw new TypeError('fetch failed');
    },
  });
  try {
    const res = await s.chat(MESSAGES);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'upstream_unreachable');
    // Tried three times before giving up.
    assert.equal(s.calls.length, 3);
    assert.equal(s.waits.length, 2);
  } finally {
    await s.close();
  }
});

test('oversized requests are refused', async () => {
  const s = await start({ config: { maxBodyBytes: 1000 } });
  try {
    const big = { messages: [{ role: 'user', content: 'x'.repeat(5000) }] };
    assert.equal((await s.chat(big)).status, 413);
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('/v1/models lists the plan model; /health and 404 work', async () => {
  const s = await start();
  try {
    const token = await s.pass();
    const models = await fetch(`${s.base}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.deepEqual((await models.json()).data.map((m) => m.id), ['auto']);
    assert.equal((await fetch(`${s.base}/v1/models`)).status, 401);
    assert.deepEqual(await (await fetch(`${s.base}/health`)).json(), { ok: true });
    assert.equal((await fetch(`${s.base}/nope`)).status, 404);
  } finally {
    await s.close();
  }
});

describe('interpretSubscription', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  const opts = { productIds: ['pro_monthly'], now };
  const item = (expiryTime, productId = 'pro_monthly') => ({ productId, expiryTime });

  test('active, in grace, and cancelled-but-paid-for are entitled', () => {
    for (const state of [
      'SUBSCRIPTION_STATE_ACTIVE',
      'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
      'SUBSCRIPTION_STATE_CANCELED',
    ]) {
      const r = interpretSubscription(
        { subscriptionState: state, lineItems: [item('2026-11-01T00:00:00Z')] },
        opts,
      );
      assert.equal(r.active, true, state);
      assert.equal(r.expiresAt, Date.parse('2026-11-01T00:00:00Z'));
    }
  });

  test('expired, paused, on hold and pending are not', () => {
    for (const state of [
      'SUBSCRIPTION_STATE_EXPIRED',
      'SUBSCRIPTION_STATE_PAUSED',
      'SUBSCRIPTION_STATE_ON_HOLD',
      'SUBSCRIPTION_STATE_PENDING',
      undefined,
    ]) {
      const r = interpretSubscription(
        { subscriptionState: state, lineItems: [item('2026-11-01T00:00:00Z')] },
        opts,
      );
      assert.equal(r.active, false, String(state));
    }
  });

  test('a past expiry or another product is refused', () => {
    assert.equal(
      interpretSubscription(
        {
          subscriptionState: 'SUBSCRIPTION_STATE_CANCELED',
          lineItems: [item('2026-10-01T00:00:00Z')],
        },
        opts,
      ).reason,
      'expired',
    );
    assert.equal(
      interpretSubscription(
        {
          subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
          lineItems: [item('2026-11-01T00:00:00Z', 'other_app_sub')],
        },
        opts,
      ).reason,
      'wrong_product',
    );
    assert.equal(interpretSubscription({}, opts).active, false);
  });
});
