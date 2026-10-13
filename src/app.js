'use strict';
const express = require('express');
const { Readable } = require('node:stream');
const pass = require('./pass');
const { createLimiter } = require('./ratelimit');

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

const bearer = (req) => (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1] ?? null;

/**
 * deps:
 *  verifyFirebaseToken(idToken) -> { uid }   (throws if invalid)
 *  checkSubscription(purchaseToken) -> { valid, temporary, accountId, expiresAt }
 *  fetchImpl                         upstream HTTP client
 *  config: { passSecret, passTtlSeconds, upstreamBase, upstreamKey,
 *            requireAccountBinding, rateLimitPerMin }
 */
function createApp({ verifyFirebaseToken, checkSubscription, fetchImpl = fetch, config, now = Date.now }) {
  const app = express();
  const allow = createLimiter({ max: config.rateLimitPerMin, now });
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Trade (Firebase login + Play purchase token) for a short-lived pass.
  app.post('/auth', async (req, res) => {
    try {
      const idToken = bearer(req);
      if (!idToken) throw new HttpError(401, 'missing_login');
      let uid;
      try {
        ({ uid } = await verifyFirebaseToken(idToken));
      } catch {
        throw new HttpError(401, 'invalid_login');
      }
      const purchaseToken = req.body?.purchaseToken;
      if (typeof purchaseToken !== 'string' || !purchaseToken.trim()) {
        throw new HttpError(400, 'purchase_token_required');
      }
      const result = await checkSubscription(purchaseToken.trim());
      if (result.temporary) throw new HttpError(503, 'verification_unavailable');
      if (!result.valid) throw new HttpError(403, 'subscription_inactive');
      // The purchase must have been made by this signed-in user, so one
      // subscription can't be shared across accounts.
      if (config.requireAccountBinding && result.accountId !== uid) {
        throw new HttpError(403, 'purchase_not_yours');
      }
      return res.json(pass.issue(uid, config.passTtlSeconds, config.passSecret, now()));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('auth failed', e?.message);
      return res.status(status).json({ error: e instanceof HttpError ? e.message : 'server_error' });
    }
  });

  // OpenAI-compatible proxy. The real key never leaves this process.
  app.use('/v1', async (req, res) => {
    const claims = pass.verify(bearer(req), config.passSecret, now());
    if (!claims) return res.status(401).json({ error: 'invalid_pass' });
    if (!allow(claims.sub)) return res.status(429).json({ error: 'rate_limited' });
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
    const path = req.url.replace(/^\/+/, '');
    if (path !== 'chat/completions' && path !== 'models') return res.status(404).end();

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const upstream = await fetchImpl(`${config.upstreamBase}/${path}`, {
        method: req.method,
        headers: {
          authorization: `Bearer ${config.upstreamKey}`,
          ...(req.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        body: req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
        signal: controller.signal,
      });
      res.status(upstream.status);
      const type = upstream.headers.get('content-type');
      if (type) res.set('content-type', type);
      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
    } catch (e) {
      if (!controller.signal.aborted) {
        console.error('upstream failed', e?.message);
        if (!res.headersSent) res.status(502).json({ error: 'upstream_unavailable' });
      }
    }
  });

  return app;
}

module.exports = { createApp };
