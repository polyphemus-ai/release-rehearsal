import { PolyphemusError } from '../types.js';
import type { Vault } from '../secrets/vault.js';
import type { McpClient, McpTool } from './mcp-client.js';

// Your banks, read-only, through Plaid. Unlike the other connections this one runs inside polyphemus
// rather than as a server of its own: Plaid's access tokens don't expire, so there's no short-lived
// token to hand out — keeping them in the daemon means no model, agent or subprocess ever sees one.
//
// What's kept: your Plaid app's client id and secret, and one access token per bank you link ("item").
// What polyphemus asks for: balances, transactions, investments and bills. Nothing that moves money —
// Plaid's payment products aren't enabled here, and these endpoints can't.

export type PlaidEnvironment = 'sandbox' | 'production';
export const PLAID_SECRET = 'plaid/app';
const BASES: Record<PlaidEnvironment, string> = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };

export interface PlaidItem {
  itemId: string;
  accessToken: string;
  institution: string;
  addedAt: number;
  /** What this bank was linked for, as Plaid reports it: transactions, investments, liabilities. */
  products?: string[];
  /** Where /transactions/sync got to, so each look asks only for what's new. */
  cursor?: string;
}

/** What polyphemus asks for at Plaid: transactions outright, the read-only rest consented for later. */
export const PLAID_PRODUCTS = ['transactions'];
export const PLAID_ALSO = ['investments', 'liabilities'];
const PRODUCT_WORDS: Record<string, string> = { transactions: 'transactions', investments: 'investments', liabilities: 'cards, loans and mortgages' };
export const productWords = (products: readonly string[]) => products.map((p) => PRODUCT_WORDS[p] ?? p).join(', ');

/** Did Plaid refuse because of a product, rather than because something was wrong with the request? */
const aboutProducts = (message: string) => /INVALID_PRODUCT|PRODUCTS_NOT_SUPPORTED|PRODUCT_NOT_ENABLED|ADDITIONAL_CONSENT_REQUIRED|not enabled|invalid product/i.test(message);

export interface PlaidApp {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
  items: PlaidItem[];
}

export const plaidBase = (environment: PlaidEnvironment) => process.env.POLYPHEMUS_PLAID_API ?? BASES[environment];

export function plaidApp(vault: Vault): PlaidApp | undefined {
  const raw = vault.get(PLAID_SECRET, 'plaid');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<PlaidApp>;
    if (!parsed.clientId || !parsed.secret) return undefined;
    return { clientId: parsed.clientId, secret: parsed.secret, environment: parsed.environment === 'production' ? 'production' : 'sandbox', items: parsed.items ?? [] };
  } catch {
    return undefined;
  }
}

export function savePlaidApp(vault: Vault, app: PlaidApp): void {
  vault.set(PLAID_SECRET, JSON.stringify(app), { kind: 'token', note: 'Your Plaid app, and one access token per bank you’ve linked' });
}

export function setPlaidApp(vault: Vault, clientId: string, secret: string, environment: PlaidEnvironment): void {
  const id = clientId.trim();
  const key = secret.trim();
  if (!/^[a-f0-9]{20,40}$/i.test(id)) throw new PolyphemusError('That isn’t a Plaid client ID: copy it from the Plaid dashboard, under Keys.', 'USAGE');
  if (key.length < 20) throw new PolyphemusError('Paste the secret for the environment you picked — Plaid has one for Sandbox and one for Production.', 'USAGE');
  const existing = plaidApp(vault);
  savePlaidApp(vault, { clientId: id, secret: key, environment, items: existing?.items ?? [] });
}

/** One call to Plaid, with your app's credentials. Never called with anything a model wrote. */
export async function plaid(app: PlaidApp, path: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await fetch(`${plaidBase(app.environment)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: app.clientId, secret: app.secret, ...body }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    const why = [data.error_message, data.error_code].filter(Boolean).join(' — ') || `${res.status}`;
    throw new PolyphemusError(`Plaid refused ${path}: ${why}`, res.status === 400 && data.error_code === 'ITEM_LOGIN_REQUIRED' ? 'USAGE' : 'FAILED');
  }
  return data;
}

/**
 * Where to send someone to link a bank: Plaid's own hosted page, so no bank credential passes through
 * polyphemus. Transactions are asked for outright; investments and liabilities are *consented* at the
 * same time (Plaid bills for them only when they're used), because a consent not asked for here can
 * only be added by sending the person back to Plaid. An app not approved for those in Plaid's
 * dashboard would have the whole link refused, so that case falls back to transactions alone.
 */
export async function startPlaidLink(app: PlaidApp, opts: { person: string; back?: string }): Promise<{ linkToken: string; url: string; consented: string[] }> {
  const ask = (also: string[]) =>
    plaid(app, '/link/token/create', {
      user: { client_user_id: opts.person },
      client_name: 'polyphemus',
      products: PLAID_PRODUCTS,
      ...(also.length && { additional_consented_products: also }),
      country_codes: ['US'],
      language: 'en',
      hosted_link: opts.back ? { completion_redirect_uri: opts.back } : {},
    });
  let consented = [...PLAID_PRODUCTS, ...PLAID_ALSO];
  let created: Record<string, any>;
  try {
    created = await ask(PLAID_ALSO);
  } catch (err) {
    if (!aboutProducts((err as Error).message)) throw err;
    // Your Plaid app isn't approved for those yet: link for what it can do rather than not at all.
    consented = [...PLAID_PRODUCTS];
    created = await ask([]);
  }
  if (!created.hosted_link_url) throw new PolyphemusError('Plaid didn’t give a link to send you to. Check the app’s products in the Plaid dashboard.', 'FAILED');
  return { linkToken: String(created.link_token), url: String(created.hosted_link_url), consented };
}

/**
 * Where to send someone to widen what a bank already linked is consented for. Plaid's update mode:
 * the same item, re-approved by the person at Plaid, with the extra products consented. Nothing is
 * exchanged afterwards — the access token polyphemus holds simply covers more once they're through.
 */
export async function startPlaidConsent(app: PlaidApp, item: PlaidItem, opts: { person: string; back?: string }): Promise<{ linkToken: string; url: string }> {
  let created: Record<string, any>;
  try {
    created = await plaid(app, '/link/token/create', {
      user: { client_user_id: opts.person },
      client_name: 'polyphemus',
      access_token: item.accessToken,
      additional_consented_products: PLAID_ALSO,
      country_codes: ['US'],
      language: 'en',
      hosted_link: opts.back ? { completion_redirect_uri: opts.back } : {},
    });
  } catch (err) {
    const message = (err as Error).message;
    if (aboutProducts(message)) {
      throw new PolyphemusError(
        `Plaid won’t consent ${productWords(PLAID_ALSO)} for this app: it’s approved for transactions only. Ask for Investments and Liabilities in the Plaid dashboard under Products, then try again. (${message})`,
        'USAGE',
      );
    }
    throw err;
  }
  if (!created.hosted_link_url) throw new PolyphemusError('Plaid didn’t give a link to send you to.', 'FAILED');
  return { linkToken: String(created.link_token), url: String(created.hosted_link_url) };
}

/** What Plaid says this bank is consented for now — the truth, rather than what polyphemus asked for. */
export async function plaidItemProducts(app: PlaidApp, item: PlaidItem): Promise<string[]> {
  const data = await plaid(app, '/item/get', { access_token: item.accessToken });
  const one = data.item ?? {};
  const products = one.consented_products ?? [...(one.billed_products ?? []), ...(one.products ?? [])];
  return [...new Set((products as unknown[]).map(String))];
}

/** After the person finishes at Plaid: the banks they linked, ready to keep. */
export async function finishPlaidLink(app: PlaidApp, linkToken: string): Promise<PlaidItem[]> {
  const session = await plaid(app, '/link/token/get', { link_token: linkToken });
  // Plaid reports a session's results in a few shapes, and someone may link more than one bank in one
  // sitting: take every public token in any of them.
  const sessions: Array<Record<string, any>> = session.link_sessions?.length ? session.link_sessions : [session];
  const publicTokens: string[] = sessions.flatMap((one) => [
    ...((one.results ?? {}).item_add_results ?? []).map((r: { public_token?: string }) => r.public_token),
    ...(one.on_success?.public_token ? [one.on_success.public_token] : []),
    ...(one.public_token ? [one.public_token] : []),
  ]).filter((token): token is string => typeof token === 'string' && token.length > 0);
  const items: PlaidItem[] = [];
  for (const publicToken of [...new Set(publicTokens)]) {
    const exchanged = await plaid(app, '/item/public_token/exchange', { public_token: publicToken });
    const accessToken = String(exchanged.access_token);
    const itemId = String(exchanged.item_id);
    let institution = 'A bank';
    let products: string[] = [];
    try {
      const item = await plaid(app, '/item/get', { access_token: accessToken });
      const one = item.item ?? {};
      products = [...new Set(((one.consented_products ?? [...(one.billed_products ?? []), ...(one.products ?? [])]) as unknown[]).map(String))];
      const id = one.institution_id;
      if (id) institution = String((await plaid(app, '/institutions/get_by_id', { institution_id: id, country_codes: ['US'] })).institution?.name ?? institution);
    } catch {
      // Naming it is a nicety; the link itself worked.
    }
    items.push({ itemId, accessToken, institution, addedAt: Date.now(), ...(products.length && { products }) });
  }
  return items;
}

/** One account at a linked bank, as the Finance page lists it under the bank. */
export interface PlaidAccount {
  id: string;
  name: string;
  mask?: string;
  type: string;
  subtype?: string;
  /** For a card or a loan this is what's owed, not what's there. */
  current: number | null;
  available: number | null;
  currency: string;
}

/**
 * The accounts at one bank, with the balances Plaid last fetched. /accounts/get rather than
 * /accounts/balance/get: opening a bank on the page shouldn't bill a live balance check each time.
 */
export async function plaidAccounts(app: PlaidApp, item: PlaidItem): Promise<PlaidAccount[]> {
  const data = await plaid(app, '/accounts/get', { access_token: item.accessToken });
  return ((data.accounts ?? []) as Array<Record<string, any>>).map((a) => ({
    id: String(a.account_id),
    name: String(a.name ?? a.official_name ?? 'Account'),
    ...(a.mask ? { mask: String(a.mask) } : {}),
    type: String(a.type ?? ''),
    ...(a.subtype ? { subtype: String(a.subtype) } : {}),
    current: typeof a.balances?.current === 'number' ? a.balances.current : null,
    available: typeof a.balances?.available === 'number' ? a.balances.available : null,
    currency: String(a.balances?.iso_currency_code ?? a.balances?.unofficial_currency_code ?? 'USD'),
  }));
}

/** Ends the link at Plaid's end as well as polyphemus's. */
export async function plaidRemoveItem(app: PlaidApp, accessToken: string): Promise<void> {
  await plaid(app, '/item/remove', { access_token: accessToken });
}

const money = (amount: unknown, currency: unknown) => (typeof amount === 'number' ? `${amount.toFixed(2)} ${String(currency ?? 'USD')}` : 'unknown');
const clipList = <T>(list: T[], max: number) => (list.length > max ? list.slice(0, max) : list);

/** What this connection can do at all, whatever anyone grants: read, and only these. */
export const PLAID_SCOPES = [
  'Reads only: balances, transactions, investments and bills at the banks you link',
  'Nothing that moves money — no payments, no transfers',
  'Your Plaid app and each bank’s token stay in polyphemus’s vault: no model, agent or server is handed one',
];

const TOOLS: McpTool[] = [
  { name: 'list_accounts', annotations: { readOnlyHint: true }, description: 'Every account at the banks you’ve linked, with its type and current balance.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'transactions',
    annotations: { readOnlyHint: true },
    description: 'Transactions from the linked accounts, newest first: date, name, amount, category and which account. `days` looks that far back (30 by default, 730 at most); `account` narrows it to one account id.',
    inputSchema: { type: 'object', properties: { days: { type: 'number' }, account: { type: 'string' }, max: { type: 'number' } } },
  },
  { name: 'investments', annotations: { readOnlyHint: true }, description: 'Holdings in any linked investment accounts: what’s held, how much, and what it’s worth.', inputSchema: { type: 'object', properties: {} } },
  { name: 'bills', annotations: { readOnlyHint: true }, description: 'Credit cards, loans and mortgages at the linked banks: balances, rates, minimum payments and due dates.', inputSchema: { type: 'object', properties: {} } },
];

/**
 * The Finance connection, run inside polyphemus. Every tool reads; nothing here can move money, and the
 * access tokens stay in this process — they're never put in a server's environment or a prompt.
 */
export function plaidClient(read: () => PlaidApp | undefined, write: (app: PlaidApp) => void): McpClient {
  const appOrFail = () => {
    const app = read();
    if (!app) throw new PolyphemusError('Set up your Plaid app first: Setup → Connections → Finance.', 'USAGE');
    if (!app.items.length) throw new PolyphemusError('No bank is linked yet: open Finance under Connections and link one.', 'USAGE');
    return app;
  };
  const named = (app: PlaidApp, accounts: Array<Record<string, any>>) =>
    new Map(accounts.map((a) => [String(a.account_id), `${a.name}${a.mask ? ` ••${a.mask}` : ''}`] as const));

  const ADD_IT = 'The person can add it at Setup → Finance → the bank → “Add investments and bills”, which sends them back to Plaid. Nobody but them can.';

  /**
   * Why a bank couldn't be asked. A bank linked before this product was consented isn't a bank with
   * no holdings, and reporting it as one would have an agent tell someone they have no 401k. Told
   * apart: not consented (the person can fix it), the bank doesn't offer it through Plaid, and Plaid
   * still fetching. Genuinely having no such accounts stays silent — the summary line says that.
   */
  const cantAsk = (item: PlaidItem, product: string, message: string): Record<string, string> | undefined => {
    if (/ADDITIONAL_CONSENT_REQUIRED|NOT_CONSENTED|INVALID_PRODUCT|PRODUCT_NOT_ENABLED/i.test(message)) {
      return { bank: item.institution, problem: `${item.institution} isn’t consented for ${productWords([product])}.`, fix: ADD_IT };
    }
    if (/PRODUCTS_NOT_SUPPORTED/i.test(message)) return { bank: item.institution, problem: `${item.institution} doesn’t offer ${productWords([product])} through Plaid.` };
    if (/PRODUCT_NOT_READY/i.test(message)) return { bank: item.institution, problem: `Plaid is still fetching ${productWords([product])} from ${item.institution}. Ask again in a few minutes.` };
    if (/NO_INVESTMENT_ACCOUNTS|NO_LIABILITY_ACCOUNTS/i.test(message)) return undefined;
    if (item.products && !item.products.includes(product)) {
      return { bank: item.institution, problem: `${item.institution} was linked for ${productWords(item.products)} only.`, fix: ADD_IT };
    }
    return undefined;
  };

  /** What came back, and what couldn't be asked — never one presented as the other. */
  const answer = (rows: Array<Record<string, unknown>>, problems: Array<Record<string, string>>, empty: string): string => {
    if (!problems.length) return rows.length ? JSON.stringify(rows, null, 2) : empty;
    return JSON.stringify({ found: rows, couldNotAsk: problems, note: `${empty} — at the banks that could be asked. Don’t report this as nothing held: say which banks couldn’t be asked and why.` }, null, 2);
  };

  const run: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    async list_accounts() {
      const app = appOrFail();
      const out: Array<Record<string, unknown>> = [];
      for (const item of app.items) {
        const data = await plaid(app, '/accounts/balance/get', { access_token: item.accessToken });
        for (const account of data.accounts ?? []) {
          out.push({
            bank: item.institution,
            id: account.account_id,
            name: `${account.name}${account.mask ? ` ••${account.mask}` : ''}`,
            type: [account.type, account.subtype].filter(Boolean).join('/'),
            balance: money(account.balances?.current, account.balances?.iso_currency_code),
            available: account.balances?.available === null ? undefined : money(account.balances?.available, account.balances?.iso_currency_code),
          });
        }
      }
      return JSON.stringify(out, null, 2);
    },
    async transactions(args) {
      const app = appOrFail();
      const days = Math.min(Math.max(Number(args.days) || 30, 1), 730);
      const max = Math.min(Math.max(Number(args.max) || 50, 1), 250);
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const until = new Date().toISOString().slice(0, 10);
      const rows: Array<Record<string, unknown>> = [];
      const account = typeof args.account === 'string' && args.account ? args.account : undefined;
      let held = false;
      for (const item of app.items) {
        // An account is at one bank: asked of the others, Plaid refuses the whole call with
        // INVALID_ACCOUNT_ID, and filtering by account never worked with two banks linked (2026-09-19).
        const data = await plaid(app, '/transactions/get', { access_token: item.accessToken, start_date: since, end_date: until, options: { count: 500, ...(account && { account_ids: [account] }) } }).catch((err: Error) => {
          if (account && /INVALID_ACCOUNT_ID/.test(err.message)) return undefined;
          throw err;
        });
        if (!data) continue;
        held = true;
        const names = named(app, data.accounts ?? []);
        for (const t of data.transactions ?? []) {
          rows.push({
            date: t.date,
            name: t.merchant_name ?? t.name,
            amount: money(t.amount, t.iso_currency_code),
            category: t.personal_finance_category?.primary ?? (t.category ?? []).join(' / ') ?? undefined,
            account: names.get(String(t.account_id)) ?? t.account_id,
            bank: item.institution,
            pending: t.pending === true ? true : undefined,
          });
        }
      }
      if (account && !held) throw new Error(`No linked bank has an account with the id ${account}. list_accounts gives each account's id.`);
      rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return JSON.stringify({ since, until, transactions: clipList(rows, max), more: rows.length > max ? rows.length - max : undefined }, null, 2);
    },
    async investments() {
      const app = appOrFail();
      const out: Array<Record<string, unknown>> = [];
      const problems: Array<Record<string, string>> = [];
      for (const item of app.items) {
        const data = await plaid(app, '/investments/holdings/get', { access_token: item.accessToken }).catch((err: Error) => {
          const why = cantAsk(item, 'investments', err.message);
          if (why) problems.push(why);
          else if (!/PRODUCT_NOT_READY|NO_INVESTMENT_ACCOUNTS/i.test(err.message)) throw err;
          return undefined;
        });
        if (!data) continue;
        const securities = new Map<string, Record<string, any>>((data.securities ?? []).map((s: Record<string, any>) => [String(s.security_id), s] as [string, Record<string, any>]));
        const names = named(app, data.accounts ?? []);
        for (const holding of data.holdings ?? []) {
          const security = securities.get(String(holding.security_id));
          out.push({
            bank: item.institution,
            account: names.get(String(holding.account_id)) ?? holding.account_id,
            security: security?.name ?? security?.ticker_symbol ?? holding.security_id,
            ticker: security?.ticker_symbol ?? undefined,
            quantity: holding.quantity,
            value: money(holding.institution_value, holding.iso_currency_code),
          });
        }
      }
      return answer(out, problems, 'No investment accounts at the linked banks.');
    },
    async bills() {
      const app = appOrFail();
      const out: Array<Record<string, unknown>> = [];
      const problems: Array<Record<string, string>> = [];
      for (const item of app.items) {
        const data = await plaid(app, '/liabilities/get', { access_token: item.accessToken }).catch((err: Error) => {
          const why = cantAsk(item, 'liabilities', err.message);
          if (why) problems.push(why);
          else if (!/PRODUCT_NOT_READY|NO_LIABILITY_ACCOUNTS/i.test(err.message)) throw err;
          return undefined;
        });
        if (!data) continue;
        const names = named(app, data.accounts ?? []);
        const liabilities = data.liabilities ?? {};
        for (const card of liabilities.credit ?? []) {
          out.push({ bank: item.institution, kind: 'credit card', account: names.get(String(card.account_id)) ?? card.account_id, lastPayment: card.last_payment_amount, minimum: card.minimum_payment_amount, due: card.next_payment_due_date, apr: (card.aprs ?? []).map((a: Record<string, any>) => `${a.apr_percentage}% ${a.apr_type}`).join(', ') || undefined });
        }
        for (const loan of [...(liabilities.student ?? []), ...(liabilities.mortgage ?? [])]) {
          out.push({ bank: item.institution, kind: loan.loan_type_description ?? 'loan', account: names.get(String(loan.account_id)) ?? loan.account_id, minimum: loan.minimum_payment_amount ?? loan.next_monthly_payment, due: loan.next_payment_due_date, rate: loan.interest_rate_percentage ?? loan.interest_rate?.percentage });
        }
      }
      return answer(out, problems, 'No credit cards or loans at the linked banks.');
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
        const message = (err as Error).message;
        // A bank that needs signing in again is the connection's problem, not the model's.
        if (/ITEM_LOGIN_REQUIRED/i.test(message)) throw err;
        return { isError: true, text: message };
      }
    },
    close() {
      // Nothing is held open: each call is one request to Plaid.
      void write;
    },
  };
}
