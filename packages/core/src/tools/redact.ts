const MASK = '«redacted secret»';

/** Common credential formats. A backstop: the guard and the tool environment keep most secrets out in the first place. */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bxai-[A-Za-z0-9]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
const AWS_SECRET = /(aws_secret_access_key\s*[=:]\s*["']?)[A-Za-z0-9/+]{40}/gi;

/**
 * A field that holds a credential, by what it's called — `accessToken`, `access_token`, `clientSecret`,
 * `cookies` alike, so the name is read a word at a time however it's spelled.
 */
const SECRET_WORD = /^(tokens?|secrets?|passwords?|passphrases?|credentials?|cookies?|apikey|key|keys|authorization|auth|bearer|signature|private|refresh|access)$/i;
const holdsSecret = (key: string): boolean =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .some((word) => SECRET_WORD.test(word));

/**
 * Every secret a stored value holds: the value itself, and — when it's a JSON record, as a sign-in
 * or a linked bank is kept — the fields inside it whose names say they're credentials. Masking only
 * the whole record missed the token on its own, which is what a service hands back (connections
 * review, 2026-09-20). Only those fields: a record also holds the name of the bank and the account
 * it's about, and masking those would leave a model reading «redacted secret» instead of its work.
 */
function inside(value: string, depth = 0): string[] {
  const found = [value];
  const trimmed = value.trim();
  if (depth > 3 || !(trimmed.startsWith('{') || trimmed.startsWith('['))) return found;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return found;
  }
  const take = (node: unknown, at: number) => {
    if (at > 4) return;
    if (typeof node === 'string') found.push(...inside(node, depth + 1));
    else if (Array.isArray(node)) for (const item of node) take(item, at + 1);
    else if (node && typeof node === 'object') for (const item of Object.values(node)) take(item, at + 1);
  };
  const walk = (node: unknown, at: number) => {
    if (at > 4 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((item) => walk(item, at + 1));
    for (const [key, item] of Object.entries(node)) {
      if (holdsSecret(key)) take(item, at + 1);
      else walk(item, at + 1);
    }
  };
  walk(parsed, 0);
  return found;
}

/**
 * Builds a function that masks secrets in text: exact values polyphemus knows
 * about (the keys it holds, and the credentials kept inside one), plus common credential formats.
 */
export function makeRedactor(known: readonly string[] = []): (text: string) => string {
  const values = [...new Set(known.flatMap((value) => inside(value)).filter((value) => value.length >= 12))].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const value of values) out = out.split(value).join(MASK);
    for (const pattern of PATTERNS) out = out.replace(pattern, MASK);
    return out.replace(AWS_SECRET, `$1${MASK}`);
  };
}
