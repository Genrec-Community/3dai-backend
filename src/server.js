import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDevVerifier, createPlayVerifier } from './play.js';

const config = loadConfig();

const verifyPurchase = config.serviceAccount
  ? createPlayVerifier({
      serviceAccount: config.serviceAccount,
      packageName: config.packageName,
      productIds: config.productIds,
    })
  : createDevVerifier(config.devPurchaseToken);

if (!config.serviceAccount) {
  console.warn('DEV MODE: purchases are not checked with Google Play.');
}

const app = createApp({ config, verifyPurchase });

const server = app.listen(config.port, () => {
  console.log(`3Dollar AI backend listening on :${config.port}`);
});

// These bound how long a client may take to SEND a request, which stops slow
// uploads from pinning connections. They don't limit how long a reply may
// stream.
server.headersTimeout = 30_000;
server.requestTimeout = 120_000;
// Longer than the proxy's idle timeout, so it never reuses a socket we closed.
server.keepAliveTimeout = 65_000;

// Render sends SIGTERM on deploy: finish in-flight replies, then exit.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 25_000).unref();
});
