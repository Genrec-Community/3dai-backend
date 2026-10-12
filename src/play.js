// Asks Google Play whether a purchase token is a live subscription.
// https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get

import { createHash } from 'node:crypto';
import { JWT } from 'google-auth-library';
import { fetchWithRetry } from './retry.js';

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

// The user is entitled in these states. A cancelled subscription stays
// usable until the period they paid for ends.
const ENTITLED = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  'SUBSCRIPTION_STATE_CANCELED',
]);

/**
 * Reads Google's answer for one token.
 * Returns `{ active, expiresAt, reason }`; `expiresAt` is in ms.
 */
export function interpretSubscription(body, { productIds, now }) {
  const state = body?.subscriptionState;
  const items = Array.isArray(body?.lineItems) ? body.lineItems : [];
  const ours = items.filter((i) => productIds.includes(i.productId));
  if (ours.length === 0) return { active: false, reason: 'wrong_product' };
  const expiresAt = Math.max(
    ...ours.map((i) => Date.parse(i.expiryTime ?? '') || 0),
  );
  if (!ENTITLED.has(state)) return { active: false, reason: 'not_active' };
  if (expiresAt <= now) return { active: false, reason: 'expired' };
  return { active: true, expiresAt };
}

/**
 * A verifier backed by the Play Developer API. Answers are cached briefly so
 * an app that re-authenticates often doesn't spend Google quota each time.
 */
export function createPlayVerifier({
  serviceAccount,
  packageName,
  productIds,
  fetchImpl = fetch,
  now = () => Date.now(),
  cacheMs = 5 * 60 * 1000,
  negativeCacheMs = 30 * 1000,
  sleep,
  getAccessToken,
}) {
  if (!getAccessToken) {
    // Caches and refreshes Google's OAuth token by itself.
    const auth = new JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: [SCOPE],
    });
    getAccessToken = async () => (await auth.getAccessToken()).token;
  }
  const cache = new Map();
  /** Lookups in progress, so a burst for one token asks Google once. */
  const pending = new Map();

  // Expired answers are dropped once a minute. Live ones are only thrown
  // away if the cache is enormous (about 20 MB), which costs one extra
  // Google lookup per subscriber rather than any wrong answer.
  let nextSweep = 0;
  function sweep() {
    const t = now();
    if (t >= nextSweep) {
      nextSweep = t + 60 * 1000;
      for (const [k, v] of cache) if (v.until <= t) cache.delete(k);
    }
    if (cache.size > 200_000) cache.clear();
  }

  async function lookup(purchaseToken) {
    const token = await getAccessToken();
    const url =
      `${API}/applications/${encodeURIComponent(packageName)}` +
      `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    // A read-only lookup, so repeating it is harmless. Kept short: the app
    // is waiting, and it keeps its current pass if this fails.
    const res = await fetchWithRetry(
      fetchImpl,
      url,
      { headers: { authorization: `Bearer ${token}` } },
      { attempts: 3, baseDelayMs: 300, maxDelayMs: 2000, attemptTimeoutMs: 8000, sleep },
    );

    let result;
    if (res.status === 400 || res.status === 404 || res.status === 410) {
      // Google doesn't know this token: made up, or long expired.
      result = { active: false, reason: 'unknown_token' };
    } else if (!res.ok) {
      // Our setup is wrong (permissions) or Google is down. Don't cache, and
      // don't tell the app the subscription is gone.
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`Play API ${res.status}: ${detail}`);
    } else {
      result = interpretSubscription(await res.json(), {
        productIds,
        now: now(),
      });
    }

    return result;
  }

  return async function verify(purchaseToken) {
    // Tokens are credentials: keep only their hash in memory.
    const key = createHash('sha256').update(purchaseToken).digest('base64');
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.result;

    let running = pending.get(key);
    if (!running) {
      running = lookup(purchaseToken).finally(() => pending.delete(key));
      pending.set(key, running);
    }
    const result = await running;

    sweep();
    // A "no" is kept only briefly: someone who has just paid, or just
    // renewed, must not be told no for minutes.
    const keep = result.active ? cacheMs : Math.min(cacheMs, negativeCacheMs);
    cache.set(key, { result, until: now() + keep });
    return result;
  };
}

/** Accepts exactly one fixed token. For local use before Play is set up. */
export function createDevVerifier(devToken, now = () => Date.now()) {
  return async (purchaseToken) =>
    purchaseToken === devToken
      ? { active: true, expiresAt: now() + 30 * 24 * 60 * 60 * 1000 }
      : { active: false, reason: 'unknown_token' };
}
