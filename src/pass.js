'use strict';
// Signed, short-lived pass (HS256 JWT) handed to a verified subscriber.
const crypto = require('node:crypto');

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload, secret) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${mac}`;
}

/** Returns the payload, or null if the pass is forged, malformed or expired. */
function verify(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, mac] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

function issue(uid, ttlSeconds, secret, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  return { pass: sign({ sub: uid, iat, exp: iat + ttlSeconds }, secret), expiresAt: (iat + ttlSeconds) * 1000 };
}

module.exports = { issue, verify };
