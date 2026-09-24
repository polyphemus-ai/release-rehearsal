import { writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Polyphemus, plaidApp, savePlaidApp } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// Finance (Plaid): your own Plaid app, banks linked on Plaid's own hosted page, and reading — never
// moving — money. It runs inside polyphemus, so no access token is ever handed to a server or a model.

function fakePlaid() {
  const seen = { paths: [] as string[], secrets: [] as string[], removed: [] as string[], linkBodies: [] as Record<string, any>[] };
  // What the bank is consented for, as Plaid would report it: widened by an update-mode link.
  let consented = ['transactions'];
  // What this Plaid app is allowed to ask for at all — Production approval, per product.
  let approved: string[] = [];
  let base = '';
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
    const path = new URL(req.url ?? '/', base).pathname;
    seen.paths.push(path);
    seen.secrets.push(String(body.secret ?? ''));
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (!path.startsWith('/simplefin') && body.secret !== 'sandbox-secret-0123456789') return json(400, { error_code: 'INVALID_API_KEYS', error_message: 'invalid keys' });
    if (path === '/link/token/create') {
      seen.linkBodies.push(body);
      const extra = (body.additional_consented_products ?? []) as string[];
      // A Plaid app is approved for a product before it may consent to it, in Production and here.
      if (extra.some((p) => !approved.includes(p))) return json(400, { error_code: 'INVALID_PRODUCT', error_message: `${extra.join(', ')} not enabled for this client` });
      // Update mode (an access token, no new item): approving it widens what this bank answers for.
      if (body.access_token) {
        consented = [...new Set([...consented, ...extra])];
        return json(200, { link_token: 'link-update', hosted_link_url: `${base}/hosted/link-update` });
      }
      consented = [...new Set(['transactions', ...extra])];
      return json(200, { link_token: 'link-1', hosted_link_url: `${base}/hosted/link-1` });
    }
    if (path === '/link/token/get') {
      return json(200, { link_sessions: [{ results: { item_add_results: [{ public_token: 'public-1' }] } }] });
    }
    if (path === '/item/public_token/exchange') return json(200, { access_token: 'access-bank-1', item_id: 'item-1' });
    if (path === '/item/get') return json(200, { item: { institution_id: 'ins_1', consented_products: consented } });
    if (path === '/institutions/get_by_id') return json(200, { institution: { name: 'First Sandbox Bank' } });
    if (path === '/accounts/get') {
      if (body.access_token === 'access-relogin') return json(400, { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed' });
      return json(200, { accounts: [
        { account_id: 'acc-1', name: 'Checking', mask: '1234', type: 'depository', subtype: 'checking', balances: { current: 1234.56, available: 1200, iso_currency_code: 'USD' } },
        { account_id: 'acc-2', name: 'Rewards Card', mask: '9876', type: 'credit', subtype: 'credit card', balances: { current: 310.2, available: null, iso_currency_code: 'USD' } },
      ] });
    }
    if (path === '/accounts/balance/get') {
      return json(200, { accounts: [{ account_id: 'acc-1', name: 'Checking', mask: '1234', type: 'depository', subtype: 'checking', balances: { current: 1234.56, available: 1200, iso_currency_code: 'USD' } }] });
    }
    if (path === '/transactions/get') {
      // An account this bank doesn't have: Plaid refuses the call.
      if ((body.options?.account_ids ?? []).some((id: string) => !['acc-1', 'acc-2'].includes(id))) return json(400, { error_code: 'INVALID_ACCOUNT_ID', error_message: 'one or more of the account IDs is invalid' });
      return json(200, {
        accounts: [{ account_id: 'acc-1', name: 'Checking', mask: '1234' }],
        transactions: [
          { date: '2026-09-15', name: 'COFFEE', merchant_name: 'Coffee Bar', amount: 4.5, iso_currency_code: 'USD', account_id: 'acc-1', personal_finance_category: { primary: 'FOOD_AND_DRINK' } },
          { date: '2026-09-10', name: 'RENT', amount: 1500, iso_currency_code: 'USD', account_id: 'acc-1', pending: false },
        ],
      });
    }
    if (path === '/investments/holdings/get') {
      // Plaid answers only for what the item is consented for.
      if (!consented.includes('investments')) return json(400, { error_code: 'ADDITIONAL_CONSENT_REQUIRED', error_message: 'consent required' });
      return json(200, {
        accounts: [{ account_id: 'acc-2', name: 'Brokerage', mask: '9876' }],
        securities: [{ security_id: 'sec-1', name: 'Index Fund', ticker_symbol: 'IDX' }],
        holdings: [{ account_id: 'acc-2', security_id: 'sec-1', quantity: 12, institution_value: 4200, iso_currency_code: 'USD' }],
      });
    }
    if (path === '/liabilities/get') {
      if (!consented.includes('liabilities')) return json(400, { error_code: 'ADDITIONAL_CONSENT_REQUIRED', error_message: 'consent required' });
      return json(200, { accounts: [{ account_id: 'acc-3', name: 'Mortgage' }], liabilities: { mortgage: [{ account_id: 'acc-3', loan_type_description: 'mortgage', next_monthly_payment: 1800, next_payment_due_date: '2026-10-01', interest_rate: { percentage: 6.25 } }] } });
    }
    if (path === '/simplefin/claim') {
      if (req.method !== 'POST') return json(405, {});
      if (seen.paths.filter((p) => p === '/simplefin/claim').length > 1) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('Token already claimed');
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`${base.replace('http://', 'http://simplefin-user:simplefin-pass@')}/simplefin`);
    }
    if (path === '/simplefin/accounts') {
      const auth = Buffer.from((req.headers.authorization ?? '').replace('Basic ', ''), 'base64').toString('utf8');
      if (auth !== 'simplefin-user:simplefin-pass') return json(403, { errors: ['bad credentials'] });
      return json(200, {
        errors: [],
        accounts: [
          {
            id: 'sf-1',
            name: 'Everyday',
            currency: 'USD',
            balance: '482.19',
            'available-balance': '470.00',
            'balance-date': Math.floor(Date.now() / 1000),
            org: { name: 'Sandbox Credit Union' },
            transactions: [
              { id: 't1', posted: Math.floor(Date.now() / 1000) - 86_400, amount: '-54.20', description: 'GROCER 123', payee: 'Grocer' },
              { id: 't2', posted: Math.floor(Date.now() / 1000) - 172_800, amount: '1200.00', description: 'PAYROLL' },
            ],
          },
        ],
      });
    }
    if (path === '/item/remove') {
      seen.removed.push(String(body.access_token));
      return json(200, { removed: true });
    }
    json(404, { error_message: 'no such path' });
  });
  return {
    seen,
    approve: (...products: string[]) => approved.push(...products),
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve((base = `http://127.0.0.1:${(server.address() as { port: number }).port}`)))),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;
let plaid: ReturnType<typeof fakePlaid>;
const savedEnv = { ...process.env };

beforeEach(async () => {
  plaid = fakePlaid();
  Object.assign(process.env, { POLYPHEMUS_PLAID_API: await plaid.start(), CODEX_HOME: '/nonexistent' });
  home = await mkdtemp(join(tmpdir(), 'polyphemus-plaid-'));
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  polyphemus = await Polyphemus.open(home);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
});
afterEach(async () => {
  await daemon.close();
  polyphemus.close();
  await plaid.stop();
  process.env = { ...savedEnv };
});

describe('Finance through SimpleFIN', () => {
  it('claims a setup token once and reads accounts and transactions with it', async () => {
    const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const raw = await res.text();
      return { status: res.status, raw, data: JSON.parse(raw || '{}') as Record<string, any> };
    };
    const token = Buffer.from(`${process.env.POLYPHEMUS_PLAID_API}/simplefin/claim`).toString('base64');

    expect((await call('/api/connections/catalogue')).data.simplefin).toEqual({ linked: false });
    expect((await call('/api/connections/simplefin', { token: 'not base64 at all' })).status).toBe(400);
    expect((await call('/api/connections/simplefin', { token })).data).toEqual({ linked: true });
    // It works once: SimpleFIN says so, and polyphemus passes that on rather than pretending.
    expect((await call('/api/connections/simplefin', { token })).status).toBe(400);

    const added = (await call('/api/connections', { catalogue: 'finance' })).data;
    expect(added.connection).toMatchObject({ where: expect.stringContaining('asks SimpleFIN itself') });
    expect(added.connection.tools.map((t: { name: string }) => t.name)).toEqual(['list_accounts', 'transactions']);

    const project = (await call('/api/projects', { name: 'Money' })).data.project;
    await call('/api/connections/finance/grant', { project: project.slug, tools: ['list_accounts', 'transactions'] });
    const accounts = await polyphemus.connections.call('finance', 'list_accounts', {}, { project: project.slug });
    expect(JSON.parse(accounts.content).accounts).toEqual([expect.objectContaining({ bank: 'Sandbox Credit Union', name: 'Everyday', balance: '482.19 USD' })]);
    const spending = await polyphemus.connections.call('finance', 'transactions', { days: 30 }, { project: project.slug });
    expect(JSON.parse(spending.content).transactions[0]).toMatchObject({ name: 'Grocer', amount: '-54.20 USD', account: 'Everyday' });
    // The access URL has the credentials in it, so nothing anyone can read may show it.
    for (const secret of ['simplefin-user', 'simplefin-pass']) expect((await call('/api/connections/finance')).raw).not.toContain(secret);
  });
});

describe('Finance', () => {
  it('links a bank through Plaid’s own page, reads what it offers, and keeps the tokens to itself', async () => {
    const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const raw = await res.text();
      return { status: res.status, raw, data: JSON.parse(raw || '{}') as Record<string, any> };
    };

    expect((await call('/api/connections/catalogue')).data.plaid).toEqual({ client: false, environment: null, banks: [] });
    expect((await call('/api/connections', { catalogue: 'finance' })).status).toBe(400);
    expect((await call('/api/connections/plaid-app', { clientId: 'nope', secret: 'sandbox-secret-0123456789', environment: 'sandbox' })).status).toBe(400);
    expect((await call('/api/connections/plaid-app', { clientId: 'a'.repeat(24), secret: 'sandbox-secret-0123456789', environment: 'sandbox' })).data).toEqual({ client: true, environment: 'sandbox' });

    const added = (await call('/api/connections', { catalogue: 'finance' })).data;
    expect(added.connection).toMatchObject({ id: 'finance', where: expect.stringContaining('asks Plaid itself (sandbox)') });
    expect(added.connection.tools.map((t: { name: string; reads: boolean }) => [t.name, t.reads])).toEqual([
      ['list_accounts', true],
      ['transactions', true],
      ['investments', true],
      ['bills', true],
    ]);

    // Linking: polyphemus sends you to Plaid, then asks Plaid what came back.
    const started = (await call('/api/connections/finance/plaid/link', {})).data;
    expect(started.url).toContain('/hosted/link-1');
    const finished = (await call('/api/connections/finance/plaid/finish', { linkToken: started.linkToken })).data;
    expect(finished.linked).toEqual([{ id: 'item-1', name: 'First Sandbox Bank' }]);
    // The app isn't approved for investments or liabilities yet, so linking falls back to transactions
    // rather than failing — and the bank says what it covers.
    expect(plaid.seen.linkBodies[0]).toMatchObject({ products: ['transactions'], additional_consented_products: ['investments', 'liabilities'] });
    expect(plaid.seen.linkBodies[1]).toMatchObject({ products: ['transactions'] });
    expect(plaid.seen.linkBodies[1]!.additional_consented_products).toBeUndefined();
    expect((await call('/api/connections/finance')).data.connection.banks).toEqual([
      { id: 'item-1', name: 'First Sandbox Bank', at: expect.any(Number), products: ['transactions'], missing: ['investments', 'liabilities'], unknown: false },
    ]);
    // Linking the same bank again doesn't double it.
    await call('/api/connections/finance/plaid/finish', { linkToken: started.linkToken });
    expect((await call('/api/connections/finance')).data.connection.banks).toHaveLength(1);

    // Reading, through a grant, the way any connection is used.
    const project = (await call('/api/projects', { name: 'Money' })).data.project;
    await call('/api/connections/finance/grant', { project: project.slug, tools: ['list_accounts', 'transactions'] });
    const accounts = await polyphemus.connections.call('finance', 'list_accounts', {}, { project: project.slug });
    expect(JSON.parse(accounts.content)).toEqual([expect.objectContaining({ bank: 'First Sandbox Bank', name: 'Checking ••1234', balance: '1234.56 USD' })]);
    const spending = await polyphemus.connections.call('finance', 'transactions', { days: 30 }, { project: project.slug });
    expect(JSON.parse(spending.content).transactions[0]).toMatchObject({ name: 'Coffee Bar', amount: '4.50 USD', account: 'Checking ••1234' });
    // One account, by the id list_accounts gives: a bank without it is skipped, not the whole call
    // refused; an id no bank has is said plainly (INVALID_ACCOUNT_ID sent agents to 90-day pulls).
    const oneAccount = await polyphemus.connections.call('finance', 'transactions', { days: 30, account: 'acc-1' }, { project: project.slug });
    expect(oneAccount.isError).toBe(false);
    expect(JSON.parse(oneAccount.content).transactions).toHaveLength(2);
    const nowhere = await polyphemus.connections.call('finance', 'transactions', { days: 30, account: 'acc-9' }, { project: project.slug });
    expect(nowhere).toMatchObject({ isError: true, content: expect.stringContaining('No linked bank has an account with the id acc-9') });
    // A bank linked without that consent is not a bank with nothing in it: the agent is told which
    // bank couldn't be asked and who can fix it, rather than "no investment accounts".
    await call('/api/connections/finance/grant', { project: project.slug, tools: ['list_accounts', 'transactions', 'investments', 'bills'] });
    const beforeConsent = JSON.parse((await polyphemus.connections.call('finance', 'investments', {}, { project: project.slug })).content);
    expect(beforeConsent).toMatchObject({
      found: [],
      couldNotAsk: [{ bank: 'First Sandbox Bank', problem: expect.stringContaining('isn’t consented for investments'), fix: expect.stringContaining('Add investments and bills') }],
    });
    expect(polyphemus.connections.get('finance')).toMatchObject({ health: 'ok' });

    // Widening it: Plaid has to approve the app for the product first, and says so plainly.
    expect((await call('/api/connections/finance/plaid/consent', { bank: 'item-1' })).data.error).toContain('approved for transactions only');
    plaid.approve('investments', 'liabilities');
    expect((await call('/api/connections/finance/plaid/consent', { bank: 'item-1' })).data.url).toContain('/hosted/link-update');
    // Polyphemus asks Plaid what the bank covers now, rather than waiting to be told.
    for (let tries = 0; tries < 40; tries++) {
      if ((await call('/api/connections/finance')).data.connection.banks[0].missing.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await call('/api/connections/finance')).data.connection.banks[0]).toMatchObject({ products: ['transactions', 'investments', 'liabilities'], missing: [] });
    expect(JSON.parse((await polyphemus.connections.call('finance', 'investments', {}, { project: project.slug })).content)).toEqual([
      expect.objectContaining({ bank: 'First Sandbox Bank', security: 'Index Fund', ticker: 'IDX', value: '4200.00 USD' }),
    ]);
    expect(JSON.parse((await polyphemus.connections.call('finance', 'bills', {}, { project: project.slug })).content)).toEqual([
      expect.objectContaining({ bank: 'First Sandbox Bank', kind: 'mortgage', minimum: 1800, rate: 6.25 }),
    ]);

    // A bank linked by an older polyphemus has nothing recorded: looking at Finance asks Plaid once.
    const app = plaidApp(polyphemus.vault)!;
    savePlaidApp(polyphemus.vault, { ...app, items: app.items.map(({ products: _products, ...item }) => item) });
    expect((await call('/api/connections/finance')).data.connection.banks[0]).toMatchObject({ unknown: true });
    for (let tries = 0; tries < 40; tries++) {
      if (!(await call('/api/connections/finance')).data.connection.banks[0].unknown) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await call('/api/connections/finance')).data.connection.banks[0]).toMatchObject({ unknown: false, products: ['transactions', 'investments', 'liabilities'] });

    const balanceChecks = plaid.seen.paths.filter((p) => p === '/accounts/balance/get').length;
    // Nothing anyone can read gives up a token, and the secret only ever goes to Plaid.
    const shown = (await call('/api/connections/finance')).raw;
    for (const secret of ['access-bank-1', 'sandbox-secret-0123456789', 'public-1']) expect(shown).not.toContain(secret);
    expect(plaid.seen.secrets.every((s) => s === 'sandbox-secret-0123456789')).toBe(true);

    // Disconnecting takes the lot: the app, the banks (ended at Plaid), and any SimpleFIN address.
    expect((await call('/api/connections/finance')).data.connection.alsoForgets).toEqual(['your Plaid app and 1 linked bank, which are unlinked at Plaid too']);

    // Opening a bank on the page lists its accounts, from Plaid's last fetch rather than a billed live check.
    expect((await call('/api/connections/finance/plaid/accounts', { bank: 'item-1' })).data.accounts).toEqual([
      { id: 'acc-1', name: 'Checking', mask: '1234', type: 'depository', subtype: 'checking', current: 1234.56, available: 1200, currency: 'USD' },
      { id: 'acc-2', name: 'Rewards Card', mask: '9876', type: 'credit', subtype: 'credit card', current: 310.2, available: null, currency: 'USD' },
    ]);
    expect(plaid.seen.paths.filter((p) => p === '/accounts/balance/get').length).toBe(balanceChecks);
    // A bank that wants signing in again says so in words, rather than failing the page.
    const now = plaidApp(polyphemus.vault)!;
    savePlaidApp(polyphemus.vault, { ...now, items: now.items.map((item) => ({ ...item, accessToken: 'access-relogin' })) });
    expect((await call('/api/connections/finance/plaid/accounts', { bank: 'item-1' })).data).toEqual({ accounts: [], problem: 'First Sandbox Bank wants you to sign in again at Plaid before it answers.' });
    savePlaidApp(polyphemus.vault, now);
    expect((await call('/api/connections/finance/plaid/accounts', { bank: 'nope' })).status).toBe(404);

    // Unlinking ends it at Plaid too.
    expect((await call('/api/connections/finance/plaid/remove', { bank: 'item-1' })).data.banks).toEqual([]);
    expect(plaid.seen.removed).toEqual(['access-bank-1']);
    expect((await polyphemus.connections.call('finance', 'list_accounts', {}, { project: project.slug })).content).toContain('No bank is linked yet');
  });

  it('forgets the Plaid app and its banks when Finance is disconnected', async () => {
    const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    await call('/api/connections/plaid-app', { clientId: 'a'.repeat(24), secret: 'sandbox-secret-0123456789', environment: 'sandbox' });
    await call('/api/connections', { catalogue: 'finance' });
    const started = (await call('/api/connections/finance/plaid/link', {})).data;
    await call('/api/connections/finance/plaid/finish', { linkToken: started.linkToken });
    expect(polyphemus.vault.has('plaid/app')).toBe(true);

    expect((await call('/api/connections/finance/disconnect', {})).data.alsoForgot).toEqual(['your Plaid app and 1 linked bank (ended at Plaid too)']);
    expect(polyphemus.vault.has('plaid/app')).toBe(false);
    expect(plaid.seen.removed).toEqual(['access-bank-1']);
    // Connecting again starts from nothing: no app, no banks.
    expect((await call('/api/connections', { catalogue: 'finance' })).status).toBe(400);
  });
});
