import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlayVerifier } from '../src/play.js';

const NOW = Date.parse('2026-10-12T00:00:00Z');

const ACTIVE = {
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  lineItems: [{ productId: 'pro_monthly', expiryTime: '2026-11-01T00:00:00Z' }],
};

/** A verifier whose Google is `respond(url)`. */
function setup(respond) {
  const clock = { now: NOW };
  const calls = [];
  const verify = createPlayVerifier({
    packageName: 'com.example.app',
    productIds: ['pro_monthly'],
    now: () => clock.now,
    sleep: async () => {},
    getAccessToken: async () => 'google-access-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return respond(url, calls.length);
    },
  });
  return { verify, calls, clock };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('asks Google about the right app and token, as the service account', async () => {
  const s = setup(() => json(ACTIVE));
  const result = await s.verify('tok/en+1');
  assert.deepEqual(result, {
    active: true,
    expiresAt: Date.parse('2026-11-01T00:00:00Z'),
  });
  assert.equal(
    s.calls[0].url,
    'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
      'com.example.app/purchases/subscriptionsv2/tokens/tok%2Fen%2B1',
  );
  assert.equal(s.calls[0].init.headers.authorization, 'Bearer google-access-token');
});

test('an active answer is reused for five minutes', async () => {
  const s = setup(() => json(ACTIVE));
  await s.verify('token-a');
  s.clock.now += 4 * 60 * 1000;
  await s.verify('token-a');
  assert.equal(s.calls.length, 1);
  s.clock.now += 2 * 60 * 1000;
  await s.verify('token-a');
  assert.equal(s.calls.length, 2);
  // Another token is its own lookup.
  await s.verify('token-b');
  assert.equal(s.calls.length, 3);
});

test('a "no" is forgotten quickly, so a new purchase works at once', async () => {
  let paid = false;
  const s = setup(() => (paid ? json(ACTIVE) : json({ error: {} }, 404)));
  assert.deepEqual(await s.verify('token-a'), {
    active: false,
    reason: 'unknown_token',
  });
  // Repeats inside half a minute don't spend Google quota.
  await s.verify('token-a');
  assert.equal(s.calls.length, 1);
  paid = true;
  s.clock.now += 31 * 1000;
  assert.equal((await s.verify('token-a')).active, true);
});

test('a burst for one token asks Google once', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const s = setup(async () => {
    await gate;
    return json(ACTIVE);
  });
  const all = Promise.all([s.verify('t-1234'), s.verify('t-1234'), s.verify('t-1234')]);
  release();
  const results = await all;
  assert.equal(s.calls.length, 1);
  assert.ok(results.every((r) => r.active));
});

test('a permissions problem is an error, never "not subscribed"', async () => {
  const s = setup(() => json({ error: { message: 'insufficient permissions' } }, 403));
  await assert.rejects(s.verify('token-a'), /Play API 403/);
  // And it isn't cached: fixing the setup takes effect immediately.
  await assert.rejects(s.verify('token-a'), /Play API 403/);
  assert.equal(s.calls.length, 2);
});

test('Google hiccups are retried', async () => {
  const s = setup((_url, n) => (n < 3 ? json({}, 503) : json(ACTIVE)));
  assert.equal((await s.verify('token-a')).active, true);
  assert.equal(s.calls.length, 3);
});

test('an expired subscription is refused', async () => {
  const s = setup(() =>
    json({
      subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED',
      lineItems: [{ productId: 'pro_monthly', expiryTime: '2026-10-01T00:00:00Z' }],
    }),
  );
  assert.equal((await s.verify('token-a')).active, false);
});
