// Retrying fetch for calls that are safe to repeat: the AI endpoint (nothing
// is charged or changed until a reply is produced) and Google's read-only
// purchase lookup.

// Worth another try: the service is waking, overloaded or briefly broken.
// 4xx other than these mean the request itself is wrong; repeating won't help.
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

const defaultSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Seconds from a Retry-After header (number or HTTP date), or null. */
function retryAfterMs(response, now) {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Like fetch, but tries again on network errors and retryable statuses.
 *
 * - `attempts`: total tries, including the first.
 * - `baseDelayMs`: first wait; doubles each time, with jitter.
 * - `maxDelayMs`: longest single wait. A `Retry-After` longer than this is
 *   not waited out: that response is returned so the caller can pass it on.
 * - `attemptTimeoutMs`: how long one try may take to produce response
 *   headers (not the whole body, which may stream for minutes).
 * - `deadlineMs`: how long all tries and waits together may take. When it
 *   runs out, the latest result is returned (or its error thrown).
 * - `signal`: the caller giving up; stops waiting and retrying at once.
 *
 * Returns the last response when every try ends in a retryable status, and
 * throws the last error when every try fails to connect.
 */
export async function fetchWithRetry(
  fetchImpl,
  url,
  init = {},
  {
    attempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    attemptTimeoutMs = 0,
    deadlineMs = 0,
    signal,
    sleep = defaultSleep,
    now = () => Date.now(),
    random = Math.random,
    onRetry,
  } = {},
) {
  let lastError;
  const deadline = deadlineMs ? now() + deadlineMs : Infinity;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    let last = attempt >= attempts;
    // This try gets its own limit, or whatever is left of the overall one.
    const left = deadline - now();
    const tryMs = Math.max(1, Math.min(attemptTimeoutMs || Infinity, left));

    // One controller per try: aborted by the caller, or by this try's timer.
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = Number.isFinite(tryMs)
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new Error('upstream timed out'));
        }, tryMs)
      : null;

    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = timedOut ? new Error('upstream timed out') : e;
    } finally {
      if (timer) clearTimeout(timer);
      // The body may still be streaming, so keep following the caller's
      // abort; only stop listening when this try produced no response.
      if (!response) signal?.removeEventListener('abort', onAbort);
    }

    let wait = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    wait = wait / 2 + (wait / 2) * random();
    // No time left for a wait and another try: this result is final.
    if (now() + wait >= deadline) last = true;

    if (response) {
      if (!RETRYABLE.has(response.status) || last) return response;
      const asked = retryAfterMs(response, now());
      // Told to wait longer than we are willing to: let the caller see it.
      if (asked !== null && asked > maxDelayMs) return response;
      if (asked !== null) wait = Math.max(wait, asked);
      onRetry?.({ attempt, status: response.status, waitMs: wait });
      // Free the connection before trying again.
      await response.body?.cancel().catch(() => {});
      signal?.removeEventListener('abort', onAbort);
    } else {
      if (last) throw lastError;
      onRetry?.({ attempt, error: lastError, waitMs: wait });
    }

    await sleep(wait, signal);
  }
}
