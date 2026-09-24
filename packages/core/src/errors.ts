import type { ErrorClass } from './types.js';

/**
 * Classifies a provider failure from its message and HTTP status. Routing
 * decides retry and fallback from the class, never from the raw text (see
 * docs/design/routing.md).
 */
export function classifyError(message: string, status?: number): ErrorClass {
  const code = status ?? statusIn(message);
  if (code === 402 || /balance exhausted|insufficient[_ ]quota|usage limit|spend(ing)? limit|out of credits|credits? required/i.test(message)) {
    return 'quota_exhausted';
  }
  if (code === 429 || /rate.?limit/i.test(message)) return 'rate_limited';
  if (code === 401 || code === 403 || /authenticat|unauthori[sz]ed|not logged in|please log ?in|invalid api key/i.test(message)) {
    return 'auth';
  }
  if (/context (window|length)|prompt is too long|maximum context/i.test(message)) return 'context_exceeded';
  if (code === 529 || (code !== undefined && code >= 500 && code < 600) || /overloaded|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message)) {
    return 'overloaded';
  }
  if (code === 400 || code === 404) return 'invalid_request';
  return 'unknown';
}

/** Finds an HTTP status mentioned in an error message ("status 402", "http_status": 429, "429 Too Many"). */
export function statusIn(message: string): number | undefined {
  const match = /(?:status[":\s]+|http_status[":\s]+|^)([45]\d\d)\b/im.exec(message);
  return match?.[1] ? Number(match[1]) : undefined;
}
