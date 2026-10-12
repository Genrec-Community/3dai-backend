import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchWithRetry } from '../src/retry.js';

/** A fetch that plays back `steps`: a status, a Response, or an Error. */
function scripted(steps) {
  const calls = [];
  const cancelled = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    if (step instanceof Response) return step;
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`status ${step}`));
        c.close();
      },
      cancel() {
        cancelled.push(step);
      },
    });
    return new Response(body, { status: step });
  };
  return { impl, calls, cancelled };
}

function options(extra = {}) {
  const waits = [];
  return {
    waits,
    opts: {
      attempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      random: () => 1,
      sleep: async (ms) => void waits.push(ms),
      ...extra,
    },
  };
}

test('returns at once when the first try works', async () => {
  const f = scripted([200]);
  const { opts, waits } = options();
  const res = await fetchWithRetry(f.impl, 'u', {}, opts);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(waits, []);
});

test('retries a waking or overloaded service, backing off each time', async () => {
  const f = scripted([503, 502, 200]);
  const { opts, waits } = options();
  const res = await fetchWithRetry(f.impl, 'u', {}, opts);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'status 200');
  assert.equal(f.calls.length, 3);
  assert.deepEqual(waits, [100, 200]);
  // Failed responses are released before the next try.
  assert.deepEqual(f.cancelled, [503, 502]);
});

test('retries network errors, then throws the last one', async () => {
  const recovering = scripted([new TypeError('fetch failed'), 200]);
  const a = options();
  assert.equal((await fetchWithRetry(recovering.impl, 'u', {}, a.opts)).status, 200);
  assert.equal(recovering.calls.length, 2);

  const dead = scripted([new TypeError('fetch failed')]);
  const b = options();
  await assert.rejects(fetchWithRetry(dead.impl, 'u', {}, b.opts), /fetch failed/);
  assert.equal(dead.calls.length, 3);
  assert.equal(b.waits.length, 2);
});

test('gives back the last response when every try is retryable', async () => {
  const f = scripted([503]);
  const { opts } = options();
  const res = await fetchWithRetry(f.impl, 'u', {}, opts);
  assert.equal(res.status, 503);
  assert.equal(await res.text(), 'status 503');
  assert.equal(f.calls.length, 3);
});

test('does not retry requests that are simply wrong', async () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    const f = scripted([status, 200]);
    const { opts, waits } = options();
    const res = await fetchWithRetry(f.impl, 'u', {}, opts);
    assert.equal(res.status, status);
    assert.equal(f.calls.length, 1, String(status));
    assert.deepEqual(waits, []);
  }
});

test('waits as long as Retry-After asks, when that is short', async () => {
  const busy = new Response('busy', { status: 429, headers: { 'retry-after': '1' } });
  const f = scripted([busy, 200]);
  const { opts, waits } = options();
  assert.equal((await fetchWithRetry(f.impl, 'u', {}, opts)).status, 200);
  assert.deepEqual(waits, [1000]);
});

test('passes a long Retry-After on instead of holding the request', async () => {
  const busy = new Response('busy', { status: 429, headers: { 'retry-after': '60' } });
  const f = scripted([busy, 200]);
  const { opts, waits } = options();
  const res = await fetchWithRetry(f.impl, 'u', {}, opts);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '60');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(waits, []);
});

test('a single wait never exceeds the cap', async () => {
  const f = scripted([503, 503, 503, 503, 503, 200]);
  const { opts, waits } = options({ attempts: 6, baseDelayMs: 400, maxDelayMs: 1000 });
  assert.equal((await fetchWithRetry(f.impl, 'u', {}, opts)).status, 200);
  assert.deepEqual(waits, [400, 800, 1000, 1000, 1000]);
});

test('a try that never answers times out and is retried', async () => {
  let n = 0;
  const impl = (_url, init) => {
    n++;
    if (n > 1) return Promise.resolve(new Response('ok'));
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  };
  const { opts } = options({ attemptTimeoutMs: 30 });
  const res = await fetchWithRetry(impl, 'u', {}, opts);
  assert.equal(await res.text(), 'ok');
  assert.equal(n, 2);
});

test('all tries together respect the overall deadline', async () => {
  // Each wait "takes" its length on a fake clock.
  let clock = 0;
  const f = scripted([503]);
  const waits = [];
  const res = await fetchWithRetry(f.impl, 'u', {}, {
    attempts: 10,
    baseDelayMs: 400,
    maxDelayMs: 400,
    deadlineMs: 1000,
    random: () => 1,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  // 400 + 400 fits in 1000 ms; a third wait would not, so it stops there
  // and hands back the last answer instead of trying all ten times.
  assert.equal(res.status, 503);
  assert.deepEqual(waits, [400, 400]);
  assert.equal(f.calls.length, 3);
});

test('a dead upstream fails within the deadline, not after every timeout', async () => {
  const impl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  const started = Date.now();
  await assert.rejects(
    fetchWithRetry(impl, 'u', {}, {
      attempts: 3,
      attemptTimeoutMs: 5000,
      deadlineMs: 150,
      baseDelayMs: 10,
      maxDelayMs: 10,
    }),
    /timed out/,
  );
  // Without the deadline this would take 15 seconds.
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});

test('stops at once when the caller gives up', async () => {
  const caller = new AbortController();
  const f = scripted([503]);
  const { opts } = options({
    signal: caller.signal,
    sleep: async () => caller.abort(new Error('client left')),
  });
  await assert.rejects(fetchWithRetry(f.impl, 'u', {}, opts), /client left/);
  assert.equal(f.calls.length, 1);
});
