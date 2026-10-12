// The HTTP surface:
//   POST /auth                   purchase token -> pass
//   POST /v1/chat/completions    pass -> the AI endpoint, key added here
//   GET  /v1/models              pass -> the one model the plan offers
//   GET  /health

import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { createPassIssuer, subscriberId } from './pass.js';
import { fetchWithRetry } from './retry.js';


/** OpenAI-style error body, which the app's client already understands. */
function fail(res, status, code, message, extra = {}) {
  res.status(status).json({ error: { code, message, type: code }, ...extra });
}

function bearer(req) {
  const header = req.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/**
 * Passes bytes through and calls `onIdle` if none arrive for `ms`: an
 * upstream that goes silent mid-reply would otherwise hold the connection,
 * and the subscriber's slot, forever.
 */
function idleGuard(ms, onIdle) {
  if (!ms) return new Transform({ transform: (chunk, _enc, cb) => cb(null, chunk) });
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      onIdle();
      // Breaks the pipeline here, whether or not the upstream connection
      // reacts to being cancelled.
      guard.destroy(new Error('upstream went silent'));
    }, ms);
  };
  const guard = new Transform({
    transform(chunk, _enc, cb) {
      arm();
      cb(null, chunk);
    },
    destroy(err, cb) {
      clearTimeout(timer);
      cb(err);
    },
    flush(cb) {
      clearTimeout(timer);
      cb();
    },
  });
  arm();
  return guard;
}

/**
 * @param {object} deps
 * @param {object} deps.config            see config.js
 * @param {(token: string) => Promise<{active: boolean, expiresAt?: number, reason?: string}>} deps.verifyPurchase
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]  wait between retries
 * @param {(message: string, detail?: unknown) => void} [deps.log]
 */
export function createApp({
  config,
  verifyPurchase,
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep,
  log = (message, detail) => console.error(message, detail ?? ''),
}) {
  const passes = createPassIssuer({
    secret: config.passSecret,
    ttlSeconds: config.passTtlSeconds,
    now,
  });
  const app = express();
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ------------------------------------------------------------ /auth
  app.post(
    '/auth',
    express.json({ limit: '16kb' }),
    async (req, res) => {
      // The reply carries a credential.
      res.set('Cache-Control', 'no-store');
      const purchaseToken = req.body?.purchaseToken;
      if (
        typeof purchaseToken !== 'string' ||
        purchaseToken.length < 8 ||
        purchaseToken.length > 4096
      ) {
        return fail(res, 400, 'bad_request', 'purchaseToken is required.');
      }

      let result;
      try {
        result = await verifyPurchase(purchaseToken);
      } catch (e) {
        // Not the user's fault, and not proof the subscription ended: the
        // app should keep its current pass and try again later.
        log('Purchase check failed', e);
        return fail(
          res,
          503,
          'verify_unavailable',
          'Could not check the subscription right now.',
        );
      }
      if (!result.active) {
        return fail(res, 403, 'plan_inactive', 'No active subscription.', {
          reason: result.reason,
        });
      }
      const pass = await passes.issue(subscriberId(purchaseToken), result.expiresAt);
      res.json({
        pass: pass.token,
        expiresAt: new Date(pass.expiresAt).toISOString(),
        subscriptionExpiresAt: result.expiresAt
          ? new Date(result.expiresAt).toISOString()
          : null,
      });
    },
  );

  // ------------------------------------------------- everything under /v1
  const v1 = express.Router();

  v1.use(async (req, res, next) => {
    const subscriber = await passes.verify(bearer(req));
    if (!subscriber) {
      return fail(res, 401, 'invalid_pass', 'Sign in to the plan again.');
    }
    req.subscriber = subscriber;
    next();
  });

  v1.get('/models', (_req, res) => {
    res.json({
      object: 'list',
      data: [{ id: config.upstreamModel, object: 'model', owned_by: 'threedollarai' }],
    });
  });

  v1.post(
    '/chat/completions',
    express.json({ limit: config.maxBodyBytes }),
    async (req, res) => {
      let body = req.body;
      if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
        return fail(res, 400, 'bad_request', 'messages is required.');
      }
      // The plan is one model. Pinning it here means a leaked pass can't be
      // used to reach anything more expensive on the upstream account.
      body.model = config.upstreamModel;
      // One answer per request; `n` would multiply the cost of each one.
      delete body.n;
      // Lets the upstream attribute abuse without learning who the user is.
      body.user = req.subscriber;

      // Stop paying for a reply nobody is waiting for.
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abort.abort();
      });

      // Retries happen here, before any of the reply has been sent, so the
      // app sees one clean response however many tries it took.
      let upstream;
      try {
        upstream = await fetchWithRetry(
          fetchImpl,
          `${config.upstreamBaseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: req.get('accept') ?? 'application/json',
              authorization: `Bearer ${config.upstreamApiKey}`,
            },
            body: JSON.stringify(body),
          },
          {
            attempts: config.upstreamAttempts,
            baseDelayMs: config.retryBaseDelayMs,
            maxDelayMs: config.retryMaxDelayMs,
            attemptTimeoutMs: config.upstreamTimeoutMs,
            deadlineMs: config.upstreamDeadlineMs,
            signal: abort.signal,
            sleep,
            now,
            onRetry: ({ attempt, status, error, waitMs }) =>
              log(
                `Upstream try ${attempt} failed (${status ?? error?.message}); ` +
                  `retrying in ${Math.round(waitMs)} ms`,
              ),
          },
        );
      } catch (e) {
        if (abort.signal.aborted) return;
        log('Upstream unreachable', e);
        return fail(res, 502, 'upstream_unreachable', 'The AI service is not responding.');
      }

      // The request has been delivered; a long reply shouldn't keep
      // megabytes of it alive while it streams.
      req.body = undefined;
      body = undefined;

      // A rejected key is our problem, never the user's: don't let the app
      // think its own sign-in failed, and don't echo upstream auth errors.
      if (upstream.status === 401 || upstream.status === 403) {
        log(`Upstream rejected our key (${upstream.status})`);
        await upstream.body?.cancel().catch(() => {});
        return fail(res, 502, 'upstream_auth', 'The AI service is misconfigured.');
      }

      res.status(upstream.status);
      for (const name of ['content-type', 'retry-after']) {
        const value = upstream.headers.get(name);
        if (value) res.set(name, value);
      }
      // Server-sent events must reach the app as they are produced, and a
      // reply is for one person: nothing in between may store it.
      res.set('Cache-Control', 'no-store, no-transform');
      res.set('X-Accel-Buffering', 'no');
      res.flushHeaders();

      if (!upstream.body) return res.end();
      let stalled = false;
      try {
        await pipeline(
          Readable.fromWeb(upstream.body),
          idleGuard(config.streamIdleMs, () => {
            stalled = true;
            abort.abort(new Error('upstream went silent'));
          }),
          res,
        );
      } catch (e) {
        // The client went away, or the upstream cut or stalled the stream.
        // Either way the response can't be repaired now.
        if (stalled) log('Upstream went silent mid-reply');
        else if (!abort.signal.aborted) log('Stream ended early', e);
        res.destroy();
      }
    },
  );

  app.use('/v1', v1);

  app.use((_req, res) => fail(res, 404, 'not_found', 'Not found.'));

  // Body-parser and other thrown errors.
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return res.destroy();
    if (err?.type === 'entity.too.large') {
      return fail(res, 413, 'too_large', 'That request is too large.');
    }
    if (err?.type === 'entity.parse.failed') {
      return fail(res, 400, 'bad_request', 'The request body is not valid JSON.');
    }
    if (err?.status >= 400 && err?.status < 500) {
      return fail(res, err.status, 'bad_request', 'The request could not be read.');
    }
    log('Unhandled error', err);
    fail(res, 500, 'server_error', 'Something went wrong.');
  });

  return app;
}
