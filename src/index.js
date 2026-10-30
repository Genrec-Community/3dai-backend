'use strict';
const admin = require('firebase-admin');
const { createApp } = require('./app');
const { createPlayClient } = require('./play');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const passSecret = required('PASS_SECRET');
if (passSecret.length < 32) throw new Error('PASS_SECRET must be at least 32 characters');

const config = {
  passSecret,
  // Short, so a cancelled or refunded subscription loses access quickly.
  passTtlSeconds: Number(process.env.PASS_TTL_SECONDS || 3600),
  // Any OpenAI-compatible provider, e.g. https://api.openai.com/v1
  upstreamBase: required('UPSTREAM_BASE_URL').replace(/\/+$/, ''),
  upstreamKey: required('UPSTREAM_API_KEY'),
  // The single model every 3Dollar subscriber gets.
  upstreamModel: required('UPSTREAM_MODEL'),
  trustProxy: Number(process.env.TRUST_PROXY_HOPS ?? 1),
  requireAccountBinding: process.env.REQUIRE_ACCOUNT_BINDING !== 'false',
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN || 30),
};

// Verifying a Firebase login only needs the project id (public signing keys).
admin.initializeApp({ projectId: required('FIREBASE_PROJECT_ID') });

const app = createApp({
  config,
  verifyFirebaseToken: (t) => admin.auth().verifyIdToken(t),
  checkSubscription: createPlayClient({
    packageName: required('PLAY_PACKAGE_NAME'),
    credentials: JSON.parse(required('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON')),
  }),
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`gateway listening on ${port}`));
