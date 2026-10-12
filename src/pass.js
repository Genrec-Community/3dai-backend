// The pass: a short-lived signed token the app sends with each AI request.
// It proves this server recently saw an active subscription, so the proxy
// never has to call Google on the hot path.

import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'threedollarai';
const AUDIENCE = 'plan';

/** A stable id for a subscriber that doesn't reveal the purchase token. */
export function subscriberId(purchaseToken) {
  return createHash('sha256').update(purchaseToken).digest('hex').slice(0, 32);
}

export function createPassIssuer({ secret, ttlSeconds, now = () => Date.now() }) {
  const key = new TextEncoder().encode(secret);

  return {
    /**
     * Signs a pass for `subscriber`. It never outlives the subscription:
     * `subscriptionExpiresAt` (ms) caps the lifetime.
     */
    async issue(subscriber, subscriptionExpiresAt) {
      const issuedAt = Math.floor(now() / 1000);
      let expiresAt = issuedAt + ttlSeconds;
      if (subscriptionExpiresAt) {
        expiresAt = Math.min(expiresAt, Math.floor(subscriptionExpiresAt / 1000));
      }
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(subscriber)
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAt)
        .sign(key);
      return { token, expiresAt: expiresAt * 1000 };
    },

    /** The subscriber id, or null when the pass is missing, forged or expired. */
    async verify(token) {
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: ISSUER,
          audience: AUDIENCE,
          algorithms: ['HS256'],
          currentDate: new Date(now()),
        });
        return typeof payload.sub === 'string' ? payload.sub : null;
      } catch {
        return null;
      }
    },
  };
}
