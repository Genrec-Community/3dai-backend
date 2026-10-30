'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pass = require('../src/pass');
const { interpret } = require('../src/play');
const { createLimiter } = require('../src/ratelimit');
const { createApp } = require('../src/app');

const SECRET = 's'.repeat(40);
const config = {
  passSecret: SECRET,
  passTtlSeconds: 3600,
  upstreamBase: 'http://upstream.test/v1',
  upstreamKey: 'REAL-KEY',
  upstreamModel: 'real-model-x',
  requireAccountBinding: true,
  rateLimitPerMin: 2,
};

async function start(overrides = {}) {
  const calls = [];
  const app = createApp({
    config,
    verifyFirebaseToken: async (t) => {
      if (t !== 'good-login') throw new Error('bad');
      return { uid: 'u1' };
    },
    checkSubscription: async () => ({ valid: true, temporary: false, accountId: 'u1' }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response('data: hi\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    ...overrides,
  });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, close: () => server.close() };
}

const post = (base, path, token, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });

test('pass: round-trips, rejects tampering and expiry', () => {
  const { pass: p } = pass.issue('u1', 60, SECRET, 1_000_000);
  assert.equal(pass.verify(p, SECRET, 1_000_000).sub, 'u1');
  assert.equal(pass.verify(p, 'other-secret', 1_000_000), null);
  assert.equal(pass.verify(p + 'x', SECRET, 1_000_000), null);
  assert.equal(pass.verify(p, SECRET, 1_000_000 + 61_000), null);
  assert.equal(pass.verify('a.b.c', SECRET), null);
});

test('play: entitled states and expiry', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const mk = (state, t) => ({ subscriptionState: state, lineItems: [{ expiryTime: t }] });
  assert.equal(interpret(mk('SUBSCRIPTION_STATE_ACTIVE', future)).valid, true);
  assert.equal(interpret(mk('SUBSCRIPTION_STATE_CANCELED', future)).valid, true);
  assert.equal(interpret(mk('SUBSCRIPTION_STATE_IN_GRACE_PERIOD', future)).valid, true);
  assert.equal(interpret(mk('SUBSCRIPTION_STATE_ACTIVE', past)).valid, false);
  assert.equal(interpret(mk('SUBSCRIPTION_STATE_EXPIRED', future)).valid, false);
  assert.equal(interpret({ subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' }).valid, false);
  const bound = interpret({ ...mk('SUBSCRIPTION_STATE_ACTIVE', future), externalAccountIdentifiers: { obfuscatedExternalAccountId: 'u1' } });
  assert.equal(bound.accountId, 'u1');
});

test('limiter: blocks past max, resets next window', () => {
  let t = 0;
  const allow = createLimiter({ max: 2, windowMs: 1000, now: () => t });
  assert.deepEqual([allow('a'), allow('a'), allow('a'), allow('b')], [true, true, false, true]);
  t = 1000;
  assert.equal(allow('a'), true);
});

test('/auth: issues a pass for a valid subscriber', async () => {
  const s = await start();
  const res = await post(s.base, '/auth', 'good-login', { purchaseToken: 'tok' });
  assert.equal(res.status, 200);
  assert.equal(pass.verify((await res.json()).pass, SECRET).sub, 'u1');
  s.close();
});

test('/auth: rejections', async () => {
  const cases = [
    [{ }, null, { purchaseToken: 't' }, 401],
    [{ }, 'bad-login', { purchaseToken: 't' }, 401],
    [{ }, 'good-login', {}, 400],
    [{ checkSubscription: async () => ({ valid: false, temporary: false }) }, 'good-login', { purchaseToken: 't' }, 403],
    [{ checkSubscription: async () => ({ valid: false, temporary: true }) }, 'good-login', { purchaseToken: 't' }, 503],
    [{ checkSubscription: async () => ({ valid: true, temporary: false, accountId: 'someone-else' }) }, 'good-login', { purchaseToken: 't' }, 403],
    [{ checkSubscription: async () => ({ valid: true, temporary: false, accountId: null }) }, 'good-login', { purchaseToken: 't' }, 403],
  ];
  for (const [over, login, body, want] of cases) {
    const s = await start(over);
    assert.equal((await post(s.base, '/auth', login, body)).status, want);
    s.close();
  }
});

test('/v1: needs a valid pass, swaps in the real key, streams back', async () => {
  const s = await start();
  assert.equal((await post(s.base, '/v1/chat/completions', 'nope', {})).status, 401);
  assert.equal(s.calls.length, 0);
  const { pass: p } = pass.issue('u1', 60, SECRET);
  const res = await post(s.base, '/v1/chat/completions', p, { model: 'auto' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'data: hi\n\n');
  assert.equal(s.calls[0].url, 'http://upstream.test/v1/chat/completions');
  assert.equal(s.calls[0].init.headers.authorization, 'Bearer REAL-KEY');
  s.close();
});

test('/v1: rate limit, unknown paths', async () => {
  const s = await start();
  const { pass: p } = pass.issue('u1', 60, SECRET);
  assert.equal((await post(s.base, '/v1/chat/completions', p, {})).status, 200);
  assert.equal((await post(s.base, '/v1/chat/completions', p, {})).status, 200);
  assert.equal((await post(s.base, '/v1/chat/completions', p, {})).status, 429);
  s.close();
  const s2 = await start();
  assert.equal((await post(s2.base, '/v1/admin/keys', p, {})).status, 404);
  s2.close();
});

test('/v1: client never learns the real key on upstream failure', async () => {
  const s = await start({ fetchImpl: async () => { throw new Error('boom REAL-KEY'); } });
  const { pass: p } = pass.issue('u1', 60, SECRET);
  const res = await post(s.base, '/v1/chat/completions', p, {});
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes('REAL-KEY'));
  s.close();
});

test('/v1: client cannot choose the model; token limits are left alone', async () => {
  const s = await start();
  const { pass: p } = pass.issue('u1', 60, SECRET);
  await post(s.base, '/v1/chat/completions', p, { model: 'gpt-expensive', max_tokens: 64000, user: 'x', messages: [] });
  const sent = JSON.parse(s.calls[0].init.body);
  assert.equal(sent.model, 'real-model-x');
  assert.equal(sent.max_tokens, 64000);
  assert.equal('user' in sent, false);
  assert.deepEqual(sent.messages, []);
  s.close();
});

test('/v1/models: one public entry, answered without calling upstream', async () => {
  const s = await start();
  const { pass: p } = pass.issue('u1', 60, SECRET);
  const res = await fetch(s.base + '/v1/models', { headers: { authorization: `Bearer ${p}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, 1);
  assert.ok(!JSON.stringify(body).includes('real-model-x'));
  assert.equal(s.calls.length, 0);
  assert.equal((await fetch(s.base + '/v1/models')).status, 401);
  s.close();
});

test('/v1: upstream auth/billing errors are hidden from the client', async () => {
  for (const status of [401, 402, 403]) {
    const s = await start({
      fetchImpl: async () => new Response('{"error":"bad key REAL-KEY"}', { status }),
    });
    const { pass: p } = pass.issue('u1', 60, SECRET);
    const res = await post(s.base, '/v1/chat/completions', p, {});
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes('REAL-KEY'));
    s.close();
  }
});

test('/auth: rate limited per client', async () => {
  const s = await start({ config: { ...config, authLimitPerMin: 2 } });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await post(s.base, '/auth', 'good-login', { purchaseToken: 't' })).status);
  assert.deepEqual(codes, [200, 200, 429]);
  s.close();
});
