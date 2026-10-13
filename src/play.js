'use strict';
// Google Play subscription check (subscriptionsv2). Adapted from the reference
// validator: same entitled states, same "temporary vs definitive" split.
const { GoogleAuth } = require('google-auth-library');

const GRANTING_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_CANCELED', // cancelled but paid until expiry
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
]);

function isEntitled(state, expiryMs, nowMs) {
  return GRANTING_STATES.has(state) && Number.isFinite(expiryMs) && expiryMs > nowMs;
}

/**
 * Pure interpretation of a subscriptionsv2 response.
 * Returns { valid, accountId, expiresAt }.
 */
function interpret(data, nowMs = Date.now()) {
  const expiries = (data.lineItems || []).map((li) => Date.parse(li.expiryTime)).filter(Number.isFinite);
  const expiryMs = expiries.length ? Math.max(...expiries) : 0;
  return {
    valid: isEntitled(data.subscriptionState, expiryMs, nowMs),
    accountId: data.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
    expiresAt: expiryMs || null,
  };
}

function createPlayClient({ packageName, credentials, fetchImpl = fetch, retries = 2, delayMs = 800 }) {
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });

  /** Resolves { valid, temporary, accountId, expiresAt, message }. Never throws. */
  return async function checkSubscription(purchaseToken) {
    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const headers = await (await auth.getClient()).getRequestHeaders();
        const res = await fetchImpl(url, { headers });
        if (res.ok) return { ...interpret(await res.json()), temporary: false, message: 'ok' };
        // 401/403 = our own credentials/permissions: never punish the user for it.
        if (res.status === 401 || res.status === 403) {
          console.error('Play auth/permission error', res.status);
          return { valid: false, temporary: true, message: 'verification_unavailable' };
        }
        // Other 4xx = Play definitively rejects this token.
        if (res.status >= 400 && res.status < 500) {
          return { valid: false, temporary: false, message: `rejected_${res.status}` };
        }
      } catch (e) {
        console.warn('Play check failed', e?.message);
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
    return { valid: false, temporary: true, message: 'verification_unavailable' };
  };
}

module.exports = { createPlayClient, interpret, isEntitled };
