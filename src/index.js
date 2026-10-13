'use strict';
const admin = require('firebase-admin');
const { createApp } = require('./app');
const { createPlayClient } = require('./play');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const config = {
  passSecret: required('PASS_SECRET'),
  passTtlSeconds: Number(process.env.PASS_TTL_SECONDS || 24 * 3600),
  upstreamBase: required('UPSTREAM_BASE_URL').replace(/\/+$/, ''),
  upstreamKey: required('UPSTREAM_API_KEY'),
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
