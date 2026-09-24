import { PolyphemusError } from '../types.js';
import type { Vault } from '../secrets/vault.js';
import type { McpClient, McpTool } from './mcp-client.js';

// The other way into Finance: SimpleFIN. Plaid is a developer product — an app of your own, keys, and
// approval before real banks. SimpleFIN is a consumer one: you link your banks at SimpleFIN Bridge, it
// gives you one setup token, and pasting it here is the whole setup. Read-only by design: the protocol
// has no way to move money.
//
// A setup token is base64 of a claim URL, and it works once: POSTing to it returns an access URL with
// the credentials in it, which is what polyphemus keeps (in the vault, like everything else).

export const SIMPLEFIN_SECRET = 'simplefin/access';

export const SIMPLEFIN_SCOPES = [
  'Reads only: accounts, balances and transactions at the banks you linked at SimpleFIN',
  'The protocol has no way to move money',
  'The access URL stays in polyphemus’s vault: no model, agent or server is handed it',
];

/** Trades a setup token for the access URL it claims. The token works once — SimpleFIN says so, not polyphemus. */
export async function claimSimplefin(setupToken: string): Promise<string> {
  const token = setupToken.trim();
  if (!token) throw new PolyphemusError('Paste the setup token from SimpleFIN.', 'USAGE');
  let claimUrl: string;
  try {
    claimUrl = Buffer.from(token, 'base64').toString('utf8').trim();
  } catch {
    throw new PolyphemusError('That isn’t a SimpleFIN setup token: it’s one long base64 string.', 'USAGE');
  }
  if (!reachable(claimUrl)) throw new PolyphemusError('That isn’t a SimpleFIN setup token: it should decode to an https address.', 'USAGE');
  const res = await fetch(claimUrl, { method: 'POST', headers: { 'content-length': '0' }, signal: AbortSignal.timeout(30_000) });
  const body = (await res.text()).trim();
  if (res.status === 403) throw new PolyphemusError('SimpleFIN says that token is used or invalid. Make a new one at SimpleFIN Bridge.', 'USAGE');
  if (!res.ok || !reachable(body)) throw new PolyphemusError(`SimpleFIN wouldn’t take that token: ${body.slice(0, 200) || res.status}`, 'FAILED');
  return body;
}

/** https anywhere real; a test's own server on this computer may be plain http. */
function reachable(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

export const simplefinAccess = (vault: Vault) => vault.get(SIMPLEFIN_SECRET, 'simplefin') ?? undefined;

export function saveSimplefinAccess(vault: Vault, accessUrl: string): void {
  vault.set(SIMPLEFIN_SECRET, accessUrl, { kind: 'token', note: 'Your SimpleFIN access URL: the banks you linked there, read-only' });
}

/** One read from SimpleFIN. The credentials live in the URL, so they never reach a header a log might keep. */
async function simplefin(accessUrl: string, query: Record<string, string>): Promise<Record<string, any>> {
  const url = new URL(`${accessUrl.replace(/\/$/, '')}/accounts`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const auth = `${url.username}:${url.password}`;
  url.username = '';
  url.password = '';
  const res = await fetch(url, { headers: { authorization: `Basic ${Buffer.from(auth).toString('base64')}`, accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
  if (res.status === 401 || res.status === 403) throw new PolyphemusError('SimpleFIN refused the saved access URL. Make a new setup token at SimpleFIN Bridge and paste it again.', 'USAGE');
  if (!res.ok) throw new PolyphemusError(`SimpleFIN answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`, 'FAILED');
  return (await res.json()) as Record<string, any>;
}

const money = (amount: unknown, currency: unknown) => {
  const value = typeof amount === 'string' ? Number(amount) : typeof amount === 'number' ? amount : NaN;
  return Number.isFinite(value) ? `${value.toFixed(2)} ${String(currency ?? 'USD')}` : 'unknown';
};

const TOOLS: McpTool[] = [
  { name: 'list_accounts', annotations: { readOnlyHint: true }, description: 'Every account at the banks you linked at SimpleFIN, with its bank and current balance.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'transactions',
    annotations: { readOnlyHint: true },
    description: 'Transactions from those accounts, newest first: date, description, amount and which account. `days` looks that far back (30 by default, 730 at most); `account` narrows it to one account id.',
    inputSchema: { type: 'object', properties: { days: { type: 'number' }, account: { type: 'string' }, max: { type: 'number' } } },
  },
];

/** Finance through SimpleFIN, run inside polyphemus: reads, and nothing else. */
export function simplefinClient(read: () => string | undefined): McpClient {
  const accessOrFail = () => {
    const access = read();
    if (!access) throw new PolyphemusError('No SimpleFIN token yet: open Finance under Connections and paste one.', 'USAGE');
    return access;
  };
  const say = (errors: unknown) => (Array.isArray(errors) && errors.length ? { problems: errors.map((e) => (typeof e === 'string' ? e : (e as { msg?: string }).msg ?? 'something went wrong')) } : {});

  const run: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    async list_accounts() {
      const data = await simplefin(accessOrFail(), { 'balances-only': '1' });
      const accounts = (data.accounts ?? []).map((a: Record<string, any>) => ({
        bank: a.org?.name ?? a.org?.domain ?? 'A bank',
        id: a.id,
        name: a.name,
        balance: money(a.balance, a.currency),
        available: a['available-balance'] === undefined ? undefined : money(a['available-balance'], a.currency),
        asOf: a['balance-date'] ? new Date(Number(a['balance-date']) * 1000).toISOString().slice(0, 10) : undefined,
      }));
      return JSON.stringify({ accounts, ...say(data.errors ?? data.errlist) }, null, 2);
    },
    async transactions(args) {
      const days = Math.min(Math.max(Number(args.days) || 30, 1), 730);
      const max = Math.min(Math.max(Number(args.max) || 50, 1), 250);
      const since = Math.floor((Date.now() - days * 86_400_000) / 1000);
      const query: Record<string, string> = { 'start-date': String(since), pending: '1' };
      if (typeof args.account === 'string' && args.account) query.account = args.account;
      const data = await simplefin(accessOrFail(), query);
      const rows: Array<Record<string, unknown>> = [];
      for (const account of data.accounts ?? []) {
        for (const t of account.transactions ?? []) {
          rows.push({
            date: new Date(Number(t.posted) * 1000).toISOString().slice(0, 10),
            name: t.payee || t.description,
            amount: money(t.amount, account.currency),
            account: account.name,
            bank: account.org?.name ?? undefined,
            memo: t.memo || undefined,
            pending: t.pending === true ? true : undefined,
          });
        }
      }
      rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return JSON.stringify({ since: new Date(since * 1000).toISOString().slice(0, 10), transactions: rows.slice(0, max), more: rows.length > max ? rows.length - max : undefined, ...say(data.errors ?? data.errlist) }, null, 2);
    },
  };

  return {
    async listTools() {
      return TOOLS;
    },
    async callTool(name, args) {
      const tool = run[name];
      if (!tool) return { isError: true, text: `No tool called ${name}.` };
      try {
        return { isError: false, text: await tool(args ?? {}) };
      } catch (err) {
        // A token that stopped working is the connection's problem, not the model's.
        if (/refused the saved access URL/.test((err as Error).message)) throw err;
        return { isError: true, text: (err as Error).message };
      }
    },
    close() {
      // Each call is one request; nothing is held open.
    },
  };
}
