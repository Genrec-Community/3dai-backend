// Everything the server needs from its environment, read once at start.

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return n;
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/**
 * The service account may be given as raw JSON or base64 (easier to paste
 * into a dashboard without mangling the private key's newlines).
 */
function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  const text = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw, 'base64').toString('utf8');
  const json = JSON.parse(text);
  if (!json.client_email || !json.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not a service account key');
  }
  return json;
}

export function loadConfig() {
  const production = process.env.NODE_ENV === 'production';
  const passSecret = required('PASS_SECRET');
  if (passSecret.length < 32) {
    throw new Error('PASS_SECRET must be at least 32 characters');
  }
  const config = {
    production,
    port: int('PORT', 3000),

    // The AI endpoint this server fronts, and the key that must stay here.
    upstreamBaseUrl: required('UPSTREAM_BASE_URL').replace(/\/+$/, ''),
    upstreamApiKey: required('UPSTREAM_API_KEY'),
    // Every request is sent with this model, whatever the client asked for.
    upstreamModel: process.env.UPSTREAM_MODEL || 'auto',

    passSecret,
    passTtlSeconds: int('PASS_TTL_SECONDS', 24 * 60 * 60),

    packageName: process.env.PLAY_PACKAGE_NAME || 'com.dotwellabs.threedollarai',
    productIds: (process.env.PLAY_PRODUCT_IDS || 'pro_monthly')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    serviceAccount: serviceAccount(),

    // Give up on a reply that sends nothing for this long.
    streamIdleMs: int('STREAM_IDLE_SECONDS', 180) * 1000,
    maxBodyBytes: int('MAX_BODY_MB', 12) * 1024 * 1024,

    // Tries per request to the AI endpoint (first try included), and how
    // long one try may take to start answering. The endpoint can need most
    // of a minute to wake from sleep.
    upstreamAttempts: Math.max(1, int('UPSTREAM_ATTEMPTS', 3)),
    upstreamTimeoutMs: int('UPSTREAM_TIMEOUT_SECONDS', 90) * 1000,
    // All tries together may take this long before the app is told the AI
    // service isn't responding, so a dead endpoint can't pile requests up.
    upstreamDeadlineMs: int('UPSTREAM_DEADLINE_SECONDS', 120) * 1000,
    retryBaseDelayMs: int('RETRY_BASE_DELAY_MS', 500),
    retryMaxDelayMs: int('RETRY_MAX_DELAY_MS', 8000),

    // A fixed purchase token accepted without asking Google, for trying the
    // server before Play is set up. Ignored in production.
    devPurchaseToken: production ? null : process.env.DEV_PURCHASE_TOKEN || null,
  };
  let upstream;
  try {
    upstream = new URL(config.upstreamBaseUrl);
  } catch {
    throw new Error('UPSTREAM_BASE_URL is not a valid URL');
  }
  // The key travels in a header on every request to this address.
  if (production && upstream.protocol !== 'https:') {
    throw new Error('UPSTREAM_BASE_URL must use https in production');
  }
  if (config.passTtlSeconds < 60) {
    throw new Error('PASS_TTL_SECONDS must be at least 60');
  }
  if (!config.serviceAccount && !config.devPurchaseToken) {
    throw new Error(
      'Set GOOGLE_SERVICE_ACCOUNT_JSON (or DEV_PURCHASE_TOKEN outside production)',
    );
  }
  return config;
}
