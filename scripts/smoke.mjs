// Loads every screen of the app in a real browser and fails on any uncaught error or CSP block.
//
// The app is plain JavaScript with no build step, so a deleted function or a rule the
// Content-Security-Policy drops is invisible until someone opens that screen. `node --check` sees
// neither. This does, in a few seconds, against a fixture so it never touches real data.
//
//   node scripts/smoke.mjs                          # all screens
//   node scripts/smoke.mjs '#/models'                # one
//   node scripts/smoke.mjs --shots <folder> ['#/…']  # and a screenshot of each at 400px and 1200px,
//                                                    # light and dark, to look at before calling UI done
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'daemon', 'web');
// The daemon's own headers, CSP included: a fixture without them can't see what production blocks.
const HEADERS = JSON.parse(readFileSync(join(WEB, '..', 'security-headers.json'), 'utf8'));
const PORT = 3917;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const mark = { shape: 'hex', color: 'amber' };
const model = (label, provider, how, id, extra = {}) => ({ label, target: label, chosen: true, connection: label.split(':')[0], provider, vendor: provider.toLowerCase(), how, billedAs: 'billed per token', modelId: id, lastReplyModel: null, ready: true, note: '', out: false, unavailable: null, metered: true, testCost: 'a few dozen tokens', result: null, usedBy: { agents: [], threads: 0, backup: null }, ...extra });

const STATE = {
  archivedCount: 2,
  update: { current: '0.1.0', channel: 'stable', installedFrom: 'npm', latest: '0.1.0', newer: false, checkedAt: Date.now() - 3600000, checking: true },
  sessions: [{ id: 'aaaa1111', title: 'A thread', work: { outcome: 'Fix the CRM data import', status: 'waiting', reason: 'Step 3: Write to HubSpot', run: 2, step: 3, steps: 4, gate: true, evidence: 2, receipts: 1 }, provider: 'anthropic', model: 'x', modelLabel: 'claude', cwd: '/tmp', createdAt: ago(60), updatedAt: ago(1), running: false, waiting: false, project: 'demo', preview: 'Fine.', agent: 'bd' }],
  models: [
    model('anthropic:claude-opus-5', 'Anthropic', 'API key', 'claude-opus-5', { result: { lastOkAt: Date.now() - 7200000 }, usedBy: { agents: ['BD'], threads: 3, backup: null } }),
    model('xai:grok-4.6', 'xAI', 'API key', 'grok-4.6', { result: { lastErrorAt: Date.now() - 60000, lastError: '403 model_not_available', errorClass: 'auth' }, usedBy: { agents: [], threads: 0, backup: 1 } }),
    model('fast', 'xAI', 'API key', 'grok-4.6-mini', { chosen: false, ready: false, note: 'no key' }),
    // Out after a quota error that gave no reset time: tried again an hour later (core/src/quota.ts).
    model('grok-build:default', 'xAI', 'Grok Build CLI', null, { billedAs: 'counts against your plan', connection: 'grok-build', metered: false, out: true, unavailable: 'said it was out of quota at 12:40 PM; polyphemus tries it again after 1:40 PM', notIsolated: 'Grok Build isn’t offered where agents are isolated: it read a file outside the worker.' }),
  ],
  selected: ['anthropic:claude-opus-5', 'xai:grok-4.6'],
  agents: [{ id: 'bd', name: 'bd', title: 'BD', description: 'the pipeline', scope: 'library', project: null, model: null, fallback: [], mark }],
  agentTemplates: [{ name: 'builder', title: 'Builder', description: 'end to end' }],
  routing: { fallback: ['xai:grok-4.6'], onFallback: 'continue', allowMetered: false },
  defaultModel: 'anthropic:claude-opus-5',
  usage: {},
  projects: [{ slug: 'demo', name: 'Demo', path: '/tmp/demo', description: 'A project', status: 'active', createdAt: ago(900), needsOrientation: false, inbox: 1, isolation: { own: 'isolated', applies: 'isolated' }, network: { presets: ['packages'], hosts: ['api.example.com'], refused: [{ host: 'registry.example.org', at: Date.now() - 120000 }] } }],
  projectsRoot: '/tmp',
  questions: [
    { id: 'rt1', sessionId: 'aaaa1111', kind: 'routine', askedAt: Date.now() - 50000, name: 'model-headroom', project: '', projectName: '', schedule: 'cron "15 7,19 * * *" (America/Chicago)', mode: 'ask', prompt: 'Check usage, and only speak up when one runs out before its reset.', description: 'Twice a day.', agentTitle: 'BD', replaces: true, canAnswer: ['p1'] },
    { id: 'rt2', sessionId: 'aaaa1111', kind: 'routine', askedAt: Date.now() - 40000, name: 'x-replies', project: 'demo', projectName: 'Demo', stop: true, description: 'Replaced by the daily post.', agentTitle: 'BD', canAnswer: ['p1'] },
    { id: 'g1', sessionId: 'aaaa1111', kind: 'gate', askedAt: Date.now() - 720000, asks: 'Write 412 records to HubSpot', outcome: 'Fix the CRM data import', run: 2, step: 3, of: 4, canAnswer: ['p1'] },
    { id: 'o1', sessionId: 'aaaa1111', kind: 'outcome', askedAt: Date.now() - 60000, text: 'Weekly outreach list', why: 'It runs every Monday and needs checking.', agentTitle: 'BD', canAnswer: ['p1'] },
    { id: 'sec1', sessionId: 'aaaa1111', kind: 'secret', askedAt: Date.now() - 30000, name: 'aws/site', purpose: 'Deploy the site', agent: 'bd', agentTitle: 'BD', project: 'demo', projectName: 'Demo', exists: false, scopes: ['agent', 'project'], line: 'BD asks for a secret: aws/site', canAnswer: ['p1'] },
    { id: 'si1', sessionId: 'aaaa1111', kind: 'signin', askedAt: Date.now() - 20000, how: 'oauth', where: 'Gmail', purpose: 'Read the inbox', connection: 'gmail', agentTitle: 'BD', line: 'BD asks you to sign in to Gmail', canAnswer: ['p1'] },
  ],
  push: { publicKey: null, httpsUrl: null, kinds: null },
  capacity: [{ provider: 'anthropic', readings: [{ window: '7d', usedPct: 20, resetsAt: null, label: '20% used', forecast: null }] }, { provider: 'grok-build', readings: [{ window: 'quota', usedPct: 100, resetsAt: null, label: 'out of quota (tries again after 1:40 PM)', forecast: null }] }],
  devices: [{ id: 'd1', name: 'This computer', createdAt: ago(90), lastSeenAt: ago(1), current: true }],
  routines: [{ id: '~/snowball-checkin', name: 'snowball-checkin', project: '', agent: 'bd', schedule: 'cron "0 7 * * 1,4" (America/Chicago)', next: Date.now() + 43200000, paused: false, pausedReason: null, enabled: true, last: null }, { id: 'demo/new-sync', name: 'new-sync', project: 'demo', agent: null, schedule: 'every 1h', next: null, paused: false, pausedReason: null, waiting: true, enabled: true, last: null }, { id: 'demo/daily-post', name: 'daily-post', project: 'demo', agent: 'bd', schedule: 'cron "17 9,14,19 * * *" (America/Chicago)', next: Date.now() + 3600000, paused: false, pausedReason: null, enabled: true, last: { status: 'started', outcome: 'succeeded', createdAt: Date.now() - 7200000, finishedAt: Date.now() - 7100000 } }],
  me: { id: 'p1', name: 'Alex', owner: true },
  people: [{ id: 'p1', name: 'Alex', owner: true }, { id: 'p2', name: 'Sam', owner: false }],
  isolation: { level: 'host', runtime: { name: 'Docker', version: '29.1.3', rootless: false }, levels: [
    { id: 'isolated', title: 'Isolated', says: 'Commands and file changes run in a container with only this project’s folder and its memory. No network except hosts you grant, no home folder, no credentials, nothing that controls polyphemus.' },
    { id: 'isolated-open', title: 'Isolated, open network', says: 'The same container, with network to any public host: for installing packages and fetching from the web. Never this computer or your local network.' },
    { id: 'host', title: 'On this computer', says: 'Commands and file changes run as you, on this computer: anything you can reach, they can. Polyphemus’s guards keep credential files out of reach, but they aren’t a boundary.' },
  ], presets: [{ id: 'packages', title: 'Package registries', says: 'Installing packages: npm, PyPI, crates.io, Go modules and RubyGems.', hosts: [] }, { id: 'github', title: 'GitHub', says: 'Reading from GitHub.', hosts: [] }] },
  connectionCount: 1,
  connectionIssues: [{ id: 'contacts', name: 'Contacts', error: '401 Unauthorized: the token has expired', errorKind: 'auth', at: Date.now() - 60000, session: { id: 'aaaa1111', title: 'A thread' } }],
};
const CONNECTION = {
  id: 'contacts', name: 'Contacts', owner: { id: 'p2', name: 'Sam', you: false }, kind: 'stdio', where: 'npx -y contacts-mcp', secrets: ['CONTACTS_TOKEN'],
  tools: [{ name: 'read_contacts', description: 'List contacts', reads: true }, { name: 'write_contacts', description: 'Update contacts', reads: false }],
  toolsListedAt: Date.now() - 3600000,
  ceiling: { provenance: 'declared', tools: ['read_contacts'], by: 'Sam', at: Date.now() - 86400000, scopes: null, says: 'Read-only, declared by Sam · 11 Sep. Nobody checked with Contacts; polyphemus holds itself to it.' },
  health: 'failing', healthAt: Date.now() - 60000, error: '401 Unauthorized: the token has expired', errorKind: 'auth', errorSession: { id: 'aaaa1111', title: 'A thread' },
  grants: [{ project: 'demo', projectName: 'Demo', agent: null, agentTitle: null, tools: ['read_contacts'], by: 'Alex', at: Date.now() - 7200000 }, { project: 'demo', projectName: 'Demo', agent: 'bd', agentTitle: 'BD', tools: ['read_contacts'], by: 'Alex', at: Date.now() - 3600000 }],
  canManage: true, canGrant: true,
};
const BROWSER_CONNECTION = {
  id: 'browser', name: 'Browser', owner: { id: 'p1', name: 'Alex', you: true }, kind: 'builtin', where: 'Built into polyphemus: Chrome on this computer, headless', secrets: [], auth: 'none', signedIn: null, github: null,
  tools: [{ name: 'open_page', description: 'Open a public web page', reads: true }, { name: 'click', description: 'Click by ref', reads: false }],
  toolsListedAt: Date.now() - 3600000,
  ceiling: { provenance: 'checked', tools: ['open_page', 'click'], by: null, at: Date.now() - 86400000, scopes: ['Public web pages only'], says: 'Checked with Browser when it was signed in to · 15 Sep: Public web pages only' },
  health: 'ok', healthAt: Date.now() - 60000, error: null, errorKind: null, errorSession: null,
  grants: [{ project: 'demo', projectName: 'Demo', agent: null, agentTitle: null, tools: ['open_page', 'click'], by: 'Alex', at: Date.now() - 7200000 }],
  signIns: [
    { id: 's1', site: 'github.com', owner: { name: 'Alex', you: true }, projects: [{ slug: 'demo', name: 'Demo', heldBack: null }], updatedAt: Date.now() - 3600000, usedAt: Date.now() - 600000 },
    { id: 's2', site: 'dashboard.example.com', owner: { name: 'Alex', you: true }, projects: [{ slug: 'demo', name: 'Demo', heldBack: 'other people in demo could see what it reaches (1 person besides Alex), so it’s used only where it’s Alex’s alone' }], updatedAt: Date.now() - 86400000, usedAt: null },
  ],
  signInProjects: [{ slug: 'demo', name: 'Demo' }],
  canManage: true, canGrant: true,
};
const REACH = { connection: 'contacts', name: 'Contacts', health: 'failing', tools: [{ name: 'read_contacts', reads: true }], inherited: false, why: 'Granted to BD in Demo by Alex · 12 Sep, narrowing the project’s grant', ceiling: { provenance: 'declared', says: CONNECTION.ceiling.says } };
// What discover says about Codex on a Linux where its sandbox can't start (core/src/agents/codex-sandbox.ts).
const SANDBOX_BLOCKED = {"ok":false,"cause":"apparmor","output":"bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted","checkedAt":0,"explanation":{"problem":"Codex can’t run commands on this computer: its sandbox (bubblewrap) can’t start, so every command Codex runs fails before it starts, including the ones it reads files with.","why":"This Linux restricts unprivileged user namespaces through AppArmor (kernel.apparmor_restrict_unprivileged_userns = 1, on by default since Ubuntu 24.04), and Codex’s sandbox needs them.","fixes":[{"title":"Allow namespaces for bubblewrap only (recommended)","steps":["sudo tee /etc/apparmor.d/bwrap <<'EOF'\nabi <abi/4.0>,\ninclude <tunables/global>\n\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n  include if exists <local/bwrap>\n}\nEOF","sudo apparmor_parser -r /etc/apparmor.d/bwrap"],"tradeoff":"Only bubblewrap gets the exception, but any program on this computer can use bubblewrap to get a namespace, which is part of what the restriction was closing."},{"title":"Or turn the restriction off for every program","steps":["sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0","echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-userns.conf   # keeps it after a restart"],"tradeoff":"Simplest, but it reopens, for every program, the kernel attack surface Ubuntu closed on purpose."}]}};
const VENDORS = [
  { id: 'openai', name: 'OpenAI', ready: true, connections: [{ id: 'codex', label: 'Codex CLI', how: 'your ChatGPT plan', signIn: 'cli', ready: true, note: 'your subscription, via `codex`', hasKey: false, command: 'codex login', models: [], chosen: ['codex:default'], metered: false, installed: true, signedIn: true, account: 'ChatGPT', sandbox: SANDBOX_BLOCKED, sandboxOff: false }] },
  { id: 'anthropic', name: 'Anthropic', ready: true, connections: [{ id: 'claude-code', label: 'Claude Code CLI', how: 'your Claude subscription', signIn: 'cli', ready: false, note: 'not signed in', hasKey: false, command: 'claude', models: [], chosen: [], metered: false, installed: true, signedIn: false, account: null }, { id: 'anthropic', label: 'API key', how: 'billed per token', signIn: 'key', ready: true, note: 'key saved', hasKey: true, command: null, models: [], chosen: ['anthropic:claude-opus-5'], metered: true, installed: true, signedIn: true, account: 'you@example.com' }] },
  // Shipped with polyphemus but not accepted yet: offered, not used.
  { id: 'google', name: 'Google', ready: false, connections: [{ id: 'gemini-cli', label: 'Gemini CLI', how: 'your Google AI plan', signIn: 'cli', ready: false, offered: true, note: 'offered, not in use: accept it to use it', hasKey: false, command: null, models: [], chosen: [], metered: false, installed: true, signedIn: true, account: 'you@example.com' }, { id: 'gemini', label: 'API key', how: 'billed per token', signIn: 'key', ready: false, offered: true, note: 'offered, not in use: accept it to use it', hasKey: false, command: null, models: [], chosen: [], metered: true }] },
  { id: 'xai', name: 'xAI', ready: true, connections: [{ id: 'xai', label: 'API key', how: 'billed per token', signIn: 'key', ready: true, note: 'key saved', hasKey: true, command: null, models: [] }, { id: 'grok-build', label: 'Grok Build CLI', how: 'your SuperGrok plan', signIn: 'cli', ready: true, note: 'your subscription, via `grok`', hasKey: false, command: 'grok login', models: [], chosen: ['grok-build:default'], metered: false, installed: true, signedIn: true, account: null, sandboxOff: null, usageFrom: { source: 'xAI’s billing endpoint, with the Grok CLI’s sign-in, every 5 minutes. It isn’t a documented API, so it can stop working.', unknown: null } }] },
];

const json = (res, body) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const server = createServer((req, res) => {
  for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value);
  const path = req.url.split('?')[0];
  if (path === '/api/state') return json(res, STATE);
  if (path === '/api/providers') return json(res, { providers: VENDORS });
  if (path === '/api/catalogue') return json(res, { catalogue: [{ id: 'anthropic', vendor: 'Anthropic', name: 'Anthropic API', about: 'Claude', tier: 'frontier', connect: 'key', adapter: 'anthropic', configured: true }, { id: 'claude-code', vendor: 'Anthropic', name: 'Claude Code CLI', about: 'Claude on your subscription', tier: 'frontier', connect: 'cli', adapter: 'claude-cli', configured: false, installed: true, signedIn: true, account: 'you@example.com' }, { id: 'codex', vendor: 'OpenAI', name: 'Codex CLI', about: 'GPT on your ChatGPT plan', tier: 'frontier', connect: 'cli', adapter: 'codex-cli', configured: false, installed: true, signedIn: true, account: 'ChatGPT', sandbox: SANDBOX_BLOCKED }, { id: 'grok-build', vendor: 'xAI', name: 'Grok CLI', about: 'Grok on your SuperGrok plan', tier: 'frontier', connect: 'cli', adapter: 'grok-cli', configured: true, installed: false, onWindows: true, install: 'curl -fsSL https://x.ai/cli/install.sh | bash' }], more: ['Someone Else'] });
  if (path.endsWith('/models')) return json(res, { models: [{ id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1000000, maxOutput: 128000 }] });
  if (path === '/artifacts/a000000000000001/file') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="80" height="20" fill="#3e7bfa"/><rect y="30" width="50" height="20" fill="#3e7bfa"/></svg>');
  }
  if (path === '/artifacts/a000000000000002/file') {
    res.writeHead(200, { 'Content-Type': 'text/csv' });
    return res.end('game,plays\nStardrift,48\n"FreeCell, classic",38\n');
  }
  if (path === '/artifacts/a000000000000003/frame') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'", 'X-Frame-Options': 'SAMEORIGIN' });
    return res.end('<!doctype html><style>body{font:14px sans-serif}</style><div id="c">chart</div><script>document.getElementById("c").textContent = "drawn"</script>');
  }
  if (path === '/api/workflows') return json(res, { workflows: [{ id: 'loop', name: 'Loop until it passes', about: 'Work toward a goal a round at a time until a command passes.', input: { type: 'object', properties: { goal: { type: 'string', description: 'What it’s working toward' }, until: { type: 'string', description: 'A command that exits 0 when it’s done' }, max: { type: 'number', description: 'The most rounds' } }, required: ['goal', 'until'] } }] });
  if (path === '/api/connections/catalogue') return json(res, { catalogue: [
    { id: 'notion', name: 'Notion', about: 'Search, read and write pages and databases in your workspace.', url: 'https://mcp.notion.com/mcp', signIn: 'oauth', color: '#191919', checked: '2026-09-12', connected: [] },
    { id: 'google-drive', name: 'Google Drive', about: 'Search and read your Drive.', signIn: 'google', google: 'drive', color: '#1a73e8', checked: '2026-09-12', connected: [] },
    { id: 'github', name: 'GitHub', about: 'Repositories, issues, pull requests and CI, as your account.', url: 'https://api.githubcopilot.com/mcp/', signIn: 'token', token: { where: 'https://github.com/settings/personal-access-tokens/new', steps: ['Open the page.', 'Pick repositories.', 'Give Read access.', 'Paste it here.'], placeholder: 'github_pat_…' }, color: '#24292f', checked: '2026-09-12', connected: ['github'] },
    { id: 'browser', name: 'Browser', about: 'Open public web pages, read them, click and type: a fresh headless browser for each thread, signed in only where you kept a sign-in.', signIn: 'none', builtin: 'browser', color: '#0f766e', checked: '2026-09-14', connected: [] },
    { id: 'finance', name: 'Finance', about: 'Balances, transactions, investments and bills from your banks, through Plaid. Read-only.', signIn: 'plaid', builtin: 'finance', color: '#0f5132', checked: '2026-09-17', connected: [] },
    { id: 'x', name: 'X', about: 'Post, reply and delete posts as your account, and read your own posts and mentions.', signIn: 'x', color: '#000000', checked: '2026-09-16', connected: [] },
  ], google: { client: false, callback: 'https://example.ts.net/oauth/callback' }, x: { client: false, callback: 'https://example.ts.net/oauth/callback' }, plaid: { client: false, environment: null, banks: [] }, simplefin: { linked: false } });
  if (path === '/api/skills') return json(res, { library: [{ name: 'frontend-design', description: 'Distinctive visual design for new UI.', from: { id: 'anthropic/frontend-design', license: 'Apache-2.0' } }, { name: 'our-deploy', description: 'Shipping this project.', from: null }], agents: [{ id: 'bd', title: 'BD', mark: { shape: 'hex', color: 'amber' }, skills: [{ name: 'brainstorming', description: 'Before any creative work, explore intent and design.', from: { id: 'superpowers/brainstorming', license: 'MIT' } }] }], projects: [] });
  if (path === '/api/skills/library') return json(res, { builtAt: Date.now() - 3600000, building: null, total: 831, withheld: 14, problems: [], sources: [{ id: 'anthropic', name: 'Anthropic', repo: 'anthropics/skills', count: 14 }, { id: 'superpowers', name: 'Superpowers (obra)', repo: 'obra/superpowers', count: 14 }, { id: 'github', name: 'GitHub (awesome-copilot)', repo: 'github/awesome-copilot', count: 436 }], skills: [{ id: 'superpowers/brainstorming', name: 'brainstorming', description: 'You MUST use this before any creative work — explores intent, requirements and design before implementation.', source: 'superpowers', sourceName: 'Superpowers (obra)', repo: 'obra/superpowers', path: 'skills/brainstorming', license: 'MIT' }, { id: 'anthropic/frontend-design', name: 'frontend-design', description: 'Guidance for distinctive, intentional visual design when building new UI.', source: 'anthropic', sourceName: 'Anthropic', repo: 'anthropics/skills', path: 'skills/frontend-design', license: 'Apache-2.0' }], more: 829 });
  if (path === '/api/connections') return json(res, { connections: [CONNECTION], people: STATE.people, canAdd: true });
  if (path === '/api/connections/browser') return json(res, { connection: BROWSER_CONNECTION, activity: [] });
  // A live view of a sign-in: any picture will do, with where the page is.
  if (path === '/api/connections/browser/live/l1') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Page': encodeURIComponent(JSON.stringify({ url: 'https://github.com/login', title: 'Sign in to GitHub', secret: true })) });
    return res.end(readFileSync(join(WEB, 'icon-512.png')));
  }
  if (path === '/api/connections/contacts') return json(res, { connection: CONNECTION, activity: [{ at: Date.now() - 60000, tool: 'read_contacts', outcome: 'failed', detail: '401 Unauthorized', session: { id: 'aaaa1111', title: 'A thread' }, agent: 'BD', by: 'Alex' }, { at: Date.now() - 120000, tool: 'write_contacts', outcome: 'refused', detail: 'write_contacts isn’t granted to bd in demo', session: null, agent: 'BD', by: 'Alex' }] });
  if (path.endsWith('/reach') && path.startsWith('/api/projects/')) return json(res, { project: 'demo', reach: [{ ...REACH, inherited: false, why: 'Granted to Demo by Alex · 12 Sep' }], agents: [{ id: 'bd', title: 'BD', reach: [REACH] }] });
  if (path.endsWith('/reach') && path.startsWith('/api/agents/')) return json(res, { agent: 'bd', projects: [{ project: 'demo', name: 'Demo', reach: [REACH] }] });
  if (path.startsWith('/api/agents/')) return json(res, { agent: { ...STATE.agents[0], persona: 'You chase things.', instructions: 'Own the pipeline.', file: '/tmp/bd/agent.toml' } });
  if (path === '/api/sessions') return json(res, { sessions: STATE.sessions.map((x) => ({ ...x, snippet: 'the words around it', archivedAt: ago(10) })) });
  // How a thread flowed: two agents and a person, with a hand-off, a wait and a stopped turn.
  if (/^\/api\/sessions\/\w+\/flow$/.test(path)) {
    const t0 = Date.now() - 16 * 60000;
    return json(res, {
      startedAt: t0,
      actors: [
        { id: 'person:p1', kind: 'person', name: 'Alex', mark: null },
        { id: 'agent:bd', kind: 'agent', name: 'BD', mark },
        { id: 'agent:critic', kind: 'agent', name: 'Critic', mark: { shape: 'circle', color: 'teal' } },
      ],
      says: [
        { seq: 0, at: t0, actor: 'person:p1', role: 'user', preview: 'Look at the pricing page on a phone.' },
        { seq: 3, at: t0 + 5 * 60000, actor: 'agent:bd', role: 'assistant', preview: 'The compare table runs off the edge. @Critic can you check the copy?' },
        { seq: 6, at: t0 + 9 * 60000, actor: 'agent:critic', role: 'assistant', preview: 'Two headings say the same thing.' },
        { seq: 7, at: t0 + 11 * 60000, actor: 'person:p1', role: 'user', preview: 'Fix the table first.' },
      ],
      turns: [
        { at: t0 + 10000, until: t0 + 5 * 60000, speaker: 'bd', sender: 'person:p1', model: 'anthropic:claude-opus-5', stopReason: 'end_turn', tokens: 24000, costUsd: 0.21, billing: 'metered', endSeq: 4 },
        { at: t0 + 5 * 60000 + 4000, until: t0 + 9 * 60000, speaker: 'critic', sender: 'agent:bd', model: 'openai:gpt-5.6-sol', stopReason: 'end_turn', tokens: 12000, costUsd: 0.08, billing: 'metered', endSeq: 7 },
        { at: t0 + 11 * 60000, until: t0 + 14 * 60000, speaker: 'bd', sender: 'person:p1', model: 'anthropic:claude-opus-5', stopReason: 'aborted', tokens: 9000, costUsd: 0.05, billing: 'metered', endSeq: 9 },
      ],
      waits: [{ at: t0 + 7 * 60000, kind: 'approval', summary: 'run: pnpm build', answer: 'allow', by: 'person:p1' }],
      comings: [{ at: t0 + 4 * 60000 + 30000, who: 'agent:critic', change: 'joined', by: 'person:p1' }],
    });
  }
  if (path.startsWith('/api/sessions/')) {
    const msg = (role, text) => ({ role, content: [{ type: 'text', text }] });
    const now = Date.now();
    const step = (n, title, kind, status, extra = {}) => ({ id: `s${n}`, runId: 'r2', n, title, kind, status, startedAt: now - 600000, endedAt: status === 'done' ? now - 500000 : undefined, evidence: [], ...extra });
    const work = {
      outcome: { id: 'o1', sessionId: 'aaaa1111', text: 'Fix the CRM data import', setBy: 'agent:bd', acceptedBy: 'person:p1', setAt: now - 86400000, setByName: 'Alex', proposedBy: 'agent:bd' },
      active: 'r2',
      runs: [
        { id: 'r2', n: 2, status: 'waiting', startedAt: now - 2400000, startedByName: 'Alex', steps: [
          step(1, 'Pull the export', 'work', 'done', { seqStart: 2, evidence: [{ id: 'e1', kind: 'call', label: 'HubSpot read_contacts', ok: true, receipt: 'HubSpot answered', at: now }, { id: 'e2', kind: 'file', label: 'contacts-export.csv', detail: '84 KB', ok: true, at: now }] }),
          step(2, 'Dry run', 'think', 'done', { reason: 'It answered; there was nothing else to check.' }),
          step(3, 'Write to HubSpot', 'gate', 'waiting', { asks: 'Write 412 records to HubSpot' }),
          step(4, 'Read them back', 'verify', 'queued', { verifies: 1 }),
        ] },
        { id: 'r1', n: 1, status: 'failed', reason: 'Step 1, Pull the export: HubSpot read_contacts: 401 Unauthorized', startedAt: now - 18000000, startedByName: 'Alex', steps: [step(1, 'Pull the export', 'work', 'failed', { reason: 'HubSpot read_contacts: 401 Unauthorized', evidence: [{ id: 'e0', kind: 'call', label: 'HubSpot read_contacts', ok: false, detail: '401 Unauthorized', at: now }] })] },
      ],
    };
    const artifact = (id, kind, title, name) => ({ id, sessionId: 'aaaa1111', seq: 2, title, kind, mediaType: '', name, bytes: 2048, createdAt: now, by: 'agent:bd' });
    const artifacts = [artifact('a000000000000001', 'svg', 'Plays per game', 'plays.svg'), artifact('a000000000000002', 'csv', 'The numbers', 'plays.csv'), artifact('a000000000000003', 'html', 'Plays, interactive', 'plays.html')];
    // A thread whose queue stopped behind a run that was sent back.
    // A group chat where people and agents came and went.
    if (path.startsWith('/api/sessions/ffff6666')) {
      const attendance = [
        { at: now - 270000, subject: 'agent:helm', change: 'joined', by: 'person:p1', who: 'Helm', kind: 'agent', byName: 'Alex' },
        { at: now - 250000, subject: 'person:p2', change: 'joined', role: 'member', by: 'person:p1', who: 'Sam', kind: 'person', byName: 'Alex' },
        { at: now - 30000, subject: 'agent:helm', change: 'left', by: 'person:p1', who: 'Helm', kind: 'agent', byName: 'Alex' },
      ];
      return json(res, { meta: { ...STATE.sessions[0], id: 'ffff6666', title: 'Crank, get oriented', work: null, createdAt: now - 400000 }, running: false, questions: [], mode: 'ask', turns: [], notes: [], model: { label: 'claude' }, times: [now - 300000, now - 290000, now - 200000, now - 190000], actors: ['person:p1', 'agent:bd', 'person:p1', 'agent:bd'], messages: [msg('user', '@BD can you get oriented?'), msg('assistant', 'Reading the handoff now.'), msg('user', '@BD what did you find?'), msg('assistant', 'Three open issues.')], members: [STATE.agents[0]], roster: STATE.agents, work: null, artifacts: [], attendance, people: STATE.people });
    }
    if (path.startsWith('/api/sessions/bbbb2222')) {
      const stopped = { id: 'r9', n: 1, status: 'failed', reason: 'Sent back by Alex: not this week.', workflow: 'ship-issue', startedAt: now - 3600000, startedByName: 'Alex', steps: [step(1, 'Merge?', 'gate', 'failed', { reason: 'Sent back by Alex: not this week.' })], upNext: { workflow: 'ship-issue', input: { issue: 13, then: '14, 15' } } };
      return json(res, { meta: { ...STATE.sessions[0], id: 'bbbb2222', title: 'Ship issue #12' }, running: false, questions: [], mode: 'ask', turns: [], notes: [], model: { label: 'claude' }, times: [], messages: [], members: [], roster: STATE.agents, work: { outcome: { id: 'o9', sessionId: 'bbbb2222', text: 'Ship issue #12', setBy: 'person:p1', setAt: now - 3600000, setByName: 'Alex' }, active: null, runs: [stopped] }, artifacts: [] });
    }
    // An agent that looked at a page: the picture it was handed shows with the result (one call failed, so the steps are open).
    if (path.startsWith('/api/sessions/eeee5555')) {
      const shot = { type: 'image', mediaType: 'image/png', path: '/uploads/0123456789abcdef0123456789abcdef.png' };
      const messages = [
        msg('user', 'Does the pricing page look right on a phone?'),
        { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'browser__open_page', input: { url: 'https://example.com/pricing' } }, { type: 'tool_call', id: 't2', name: 'browser__take_screenshot', input: {} }, { type: 'tool_call', id: 't3', name: 'browser__click', input: { ref: 12 } }] },
        { role: 'user', content: [{ type: 'tool_result', callId: 't1', content: 'Address: https://example.com/pricing\nTitle: Pricing' }, { type: 'tool_result', callId: 't2', content: 'Here’s the page as it fits the window.', images: [shot] }, { type: 'tool_result', callId: 't3', content: 'Polyphemus refused this call: click on Browser isn’t granted to this thread in demo', isError: true }] },
        msg('assistant', 'The plans stack neatly, but the “Compare” table runs off the right edge.'),
      ];
      return json(res, { meta: { ...STATE.sessions[0], id: 'eeee5555', title: 'Pricing on a phone' }, project: 'demo', running: true, workingSince: Date.now() - 95000, working: [{ agent: null, title: null, since: Date.now() - 95000, alongside: false }, { agent: 'bd', title: 'BD', since: Date.now() - 40000, alongside: true }], queued: [{ id: 'q1', by: 'Alex', mine: true, text: 'Also check the pricing page on a phone.', attachments: 0, at: Date.now() - 20000 }, { id: 'q2', by: 'Sam', mine: false, text: 'And the footer links.', attachments: 0, at: Date.now() - 10000 }], questions: [], mode: 'ask', turns: [], notes: [], model: { label: 'claude' }, times: messages.map((_, i) => ago(10 - i)), messages, members: [], roster: STATE.agents, work: null, artifacts: [] });
    }
    // A ship run at its merge, with the pictures its last look took.
    if (path.startsWith('/api/sessions/dddd4444')) {
      const looked = step(3, 'Round 2 · Look at the pages', 'check', 'done', { reason: 'Passed at 3f9a1c2.', evidence: [{ id: 'l1', kind: 'check', label: 'Open / at 400px', detail: 'Loaded: “Ledger”. · at 3f9a1c2', ok: true, at: now }, { id: 'l2', kind: 'check', label: 'Open / at 1280px', detail: 'Loaded: “Ledger”. · at 3f9a1c2', ok: true, at: now }], pictures: [{ id: 'a000000000000011', title: '/ at 400px' }, { id: 'a000000000000012', title: '/ at 1280px' }, { id: 'a000000000000013', title: '/pricing at 400px' }, { id: 'a000000000000014', title: '/pricing at 1280px' }] });
      const failedLook = step(1, 'Round 1 · Look at the pages', 'check', 'failed', { reason: '/pricing at 400px: Uncaught: TypeError: plans is undefined', evidence: [{ id: 'l0', kind: 'check', label: 'Open /pricing at 400px', detail: 'Uncaught: TypeError: plans is undefined · at 1b2c3d4', ok: false, at: now }] });
      const merging = { id: 'r7', n: 1, status: 'waiting', workflow: 'ship-issue', startedAt: now - 3600000, startedByName: 'Alex', steps: [failedLook, step(2, 'Round 2 · Build', 'work', 'done'), looked, step(4, 'Merge?', 'gate', 'waiting', { asks: 'Merge pull request #31? 4 pictures of its pages, at that commit, are on the last “Look at the pages” step.' })] };
      return json(res, { meta: { ...STATE.sessions[0], id: 'dddd4444', title: 'Ship issue #12' }, project: 'demo', running: false, questions: [], mode: 'ask', turns: [], notes: [], model: { label: 'claude' }, times: [], messages: [], members: [], roster: STATE.agents, work: { outcome: { id: 'o8', sessionId: 'dddd4444', text: 'Ship issue #12', setBy: 'person:p1', setAt: now - 3600000, setByName: 'Alex' }, active: 'r7', runs: [merging] }, artifacts: [] });
    }
    // An intake that filed issues: each can be shipped, or all of them in order.
    if (path.startsWith('/api/sessions/cccc3333')) {
      const filed = { id: 'r8', n: 1, status: 'waiting', workflow: 'intake', startedAt: now - 3600000, startedByName: 'Alex', steps: [step(1, 'File the issues', 'action', 'done', { reason: 'Filed #13, #14 and #15.', filedIssues: { repo: 'acme/site', numbers: [13, 14, 15] } }), step(2, 'Anything else?', 'gate', 'waiting', { asks: 'Anything else to file?' })] };
      return json(res, { meta: { ...STATE.sessions[0], id: 'cccc3333', title: 'Make work of a request' }, project: 'demo', running: false, questions: [], mode: 'ask', turns: [], notes: [], model: { label: 'claude' }, times: [], messages: [], members: [], roster: STATE.agents, work: { outcome: null, active: null, runs: [filed] }, artifacts: [] });
    }
    // Who came and went: an agent added and removed, and Sam given the project.
    const attendance = [
      { at: now - 270000, subject: 'agent:helm', change: 'joined', by: 'person:p1', who: 'Helm', kind: 'agent', byName: 'Alex' },
      { at: now - 250000, subject: 'person:p2', change: 'joined', role: 'member', by: 'person:p1', who: 'Sam', kind: 'person', byName: 'Alex' },
      { at: now - 30000, subject: 'agent:helm', change: 'left', by: 'person:p1', who: 'Helm', kind: 'agent', byName: 'Alex' },
    ];
    // Two messages held while it worked: one of yours, one of Sam's.
    const queued = [{ id: 'q1', by: 'Alex', mine: true, text: 'Also check the pricing page on a phone.', attachments: 0, at: now - 20000 }, { id: 'q2', by: 'Sam', mine: false, text: 'And the footer links.', attachments: 0, at: now - 10000 }];
    return json(res, { meta: STATE.sessions[0], queued, running: false, questions: [], mode: 'ask', turns: [], notes: [], model: { label: 'anthropic:claude-opus-5' }, isolation: 'isolated', times: [ago(5), ago(4)], messages: [msg('user', 'Hello'), msg('assistant', 'Hi.')], members: [STATE.agents[0]], roster: STATE.agents, work, artifacts, attendance });
  }
  // A step's pictures, and a tool result's: any PNG will do.
  if (/^\/artifacts\/[0-9a-f]{16}\/file$/.test(path) || path.startsWith('/api/images/')) {
    res.writeHead(200, { 'Content-Type': 'image/png', ...HEADERS });
    return res.end(readFileSync(join(WEB, 'icon-512.png')));
  }
  // One routine's own page: what it asks before doing, and whether a clean run says so.
  if (path.startsWith('/api/routines/') && !path.endsWith('/run'))
    return json(res, { routine: { id: 'demo/daily-post', name: 'daily-post', project: 'demo', mode: 'ask', notify: ['failure'], prompt: 'Draft today’s post and log it.', file: '/tmp/demo/.polyphemus/routines/daily-post.md', text: '---\nmode: ask\n---\nDraft today’s post.\n', digest: 'abc', waiting: false, asks: true, canChange: true } });
  if (path.includes('/inbox')) return json(res, { items: [{ name: 'AGENTS.md', kind: 'rules', content: '# Demo\n\nRules.' }] });
  // What's been made here, across the project's threads.
  if (path.endsWith('/artifacts') && path.startsWith('/api/projects/'))
    return json(res, {
      artifacts: [
        { id: 'a000000000000021', sessionId: 'aaaa1111', seq: 4, title: 'Pricing page', kind: 'html', mediaType: 'text/html', name: 'pricing.html', bytes: 14320, createdAt: Date.now() - 5400000, by: 'agent:bd', in: 'A thread' },
        { id: 'a000000000000022', sessionId: 'bbbb2222', seq: 2, title: 'Outreach list', kind: 'csv', mediaType: 'text/csv', name: 'outreach.csv', bytes: 2210, createdAt: Date.now() - 86400000, by: 'agent:bd', in: 'Ship the rest: #13, #14, #15' },
      ],
    });
  // Where the project stands, as an agent last left it: the top of Work.
  if (path.endsWith('/handoff'))
    return json(res, {
      text: '# Handoff: Demo\n\nThe pricing page is rebuilt and merged (#31). Its checks pass and the pictures are on the run.\n\nNext: the footer links Sam asked about, then the 404 page.\n\nBlocked: nobody has said which plan is the default, so the table still shows three.',
      at: Date.now() - 900000,
    });
  if (path.startsWith('/api/')) return json(res, {});
  const file = join(WEB, path === '/' ? 'index.html' : path);
  if (!file.startsWith(WEB) || !existsSync(file)) {
    res.writeHead(404);
    return res.end('no');
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'text/plain' });
  res.end(readFileSync(file));
});

const argv = process.argv.slice(2);
const SHOTS = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : undefined;
const ONLY = argv.find((a, i) => a.startsWith('#') && argv[i - 1] !== '--shots');
const ROUTES = ONLY
  ? [ONLY]
  : ['#/', '#/direct', '#/projects', '#/p/demo', '#/team', '#/a/bd', '#/new-agent', '#/you', '#/models', '#/models/anthropic:claude-opus-5', '#/choose', '#/providers', '#/providers/anthropic', '#/add-provider', '#/new', '#/s/aaaa1111', '#/s/aaaa1111?at=1', '#/flow/aaaa1111', '#/flow/aaaa1111?as=timeline', '#/review/demo', '#/threads', '#/threads?q=thread', '#/threads?archived=1', '#/threads?project=demo', '#/threads?agent=bd', '#/models?tab=providers', '#/models?tab=connections', '#/models?tab=defaults', '#/models/xai:grok-4.6', '#/models/fast', '#/setup', '#/connections', '#/connections/contacts', '#/connections/new', '#/connections/new?service=notion', '#/connections/new?service=github', '#/connections/new?service=other', '#/connections/new?service=google-drive', '#/connections/new?service=github&with=token', '#/connections/new?service=browser', '#/connections/new?service=x', '#/connections/new?service=finance', '#/connections/browser', '#/connections/browser/live/l1?site=github.com', '#/p/demo?tab=setup', '#/p/demo?tab=work', '#/s/bbbb2222', '#/s/cccc3333', '#/s/dddd4444', '#/s/eeee5555', '#/s/ffff6666', '#/skills', '#/skills/browse?to=library', '#/skills/browse?to=agent%3Abd', '#/u/p2'];

/** Words a screen must show, so a route that quietly falls back to another screen fails. */
const EXPECT = {
  '#/': 'Arrange the list',
  '#/p/demo?tab=setup': 'What it can reach',
  '#/p/demo?tab=work': 'Every thread here',
  '#/s/bbbb2222': 'Ship the rest: #13, #14, #15',
  '#/s/cccc3333': 'Ship all, in order',
  '#/s/dddd4444': '/pricing at 1280px',
  '#/s/aaaa1111': 'You removed Helm',
  '#/you': 'polyphemus.ai',
  '#/direct': 'Direct',
  '#/s/ffff6666': 'You gave Sam access to the project, as a member',
  '#/s/eeee5555': '/api/images/0123456789abcdef0123456789abcdef.png',
  '#/connections/new': 'Something else',
  '#/connections/new?service=github': 'Create it on GitHub',
  '#/connections/new?service=github&with=token': 'Make a token',
  '#/connections/new?service=notion': 'Sign in to Notion',
  '#/connections/new?service=browser': 'Only public web pages',
  '#/connections/browser': 'Sign-ins it keeps',
  '#/connections/browser/live/l1?site=github.com': 'Keep this sign-in',
  '#/connections/new?service=google-drive': 'Authorized redirect URIs',
  '#/connections/new?service=other': 'Its MCP server is',
};

const CHROME = ['google-chrome', 'chromium', 'chromium-browser'];
const BROWSER = CHROME.find((name) => spawnSync('which', [name], { stdio: 'ignore' }).status === 0) ?? CHROME[0];
const look = (route) =>
  new Promise((resolve) => {
    const args = ['--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=4000', '--enable-logging=stderr', '--v=0', '--dump-dom', `http://127.0.0.1:${PORT}/${route}`];
    const child = spawn(BROWSER, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', () => resolve({ route, problems: [`couldn't run ${BROWSER}`] }));
    child.on('close', () => {
      const problems = err
        .split('\n')
        .filter((line) => /Uncaught|violates the following Content Security Policy|ERROR:CONSOLE/i.test(line))
        .map((line) => line.replace(/^.*CONSOLE\(\d+\)]?\s*/, '').trim());
      // A screen that rendered nothing is a failure too, even without an error. A <main> alone isn't
      // enough — every screen has a header bar, or says there's nothing to show — and an error toast
      // means the screen gave up.
      const content = /<div id="content">([\s\S]*?)<\/div>\s*<div id="toast"/.exec(out)?.[1] ?? out;
      if (!/<header class="bar"|class="nothing"|pair-form/.test(content)) problems.push('nothing rendered');
      else if (content.replace(/<[^>]+>/g, '').trim().length < 20) problems.push('the screen is nearly empty');
      const expected = EXPECT[route];
      if (expected && !content.includes(expected)) problems.push(`doesn’t show “${expected}” — it may have fallen back to another screen`);
      if (/class="toast error show"/.test(out)) problems.push(`showed an error: ${/class="toast error show"[^>]*>([^<]*)/.exec(out)?.[1] ?? ''}`);
      resolve({ route, problems: [...new Set(problems)] });
    });
  });

/** One screenshot of a screen, at a width and in a colour scheme. */
const shoot = (route, width, scheme) =>
  new Promise((resolve) => {
    const name = `${route.replace(/^#\/?/, '').replace(/[^\w-]+/g, '_') || 'home'}-${width}-${scheme}.png`;
    const file = join(SHOTS, name);
    const args = ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--virtual-time-budget=4000', `--window-size=${width},${process.env.SMOKE_HEIGHT ?? (width < 600 ? 860 : 900)}`, `--blink-settings=preferredColorScheme=${scheme === 'dark' ? 0 : 1}`, `--screenshot=${file}`, `http://127.0.0.1:${PORT}/${route}`];
    spawn(BROWSER, args, { stdio: 'ignore' }).on('close', () => resolve(file));
  });

server.listen(PORT, '127.0.0.1', async () => {
  let bad = 0;
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    for (const route of ROUTES) for (const width of [400, 1200]) for (const scheme of ['light', 'dark']) await shoot(route, width, scheme);
    console.log(`Screenshots of ${ROUTES.length} screen${ROUTES.length === 1 ? '' : 's'} in ${SHOTS}.`);
  }
  for (const route of ROUTES) {
    const { problems } = await look(route);
    if (problems.length) {
      bad += 1;
      console.log(`✗ ${route}`);
      for (const problem of problems.slice(0, 3)) console.log(`    ${problem.slice(0, 160)}`);
    } else {
      console.log(`✓ ${route}`);
    }
  }
  server.close();
  console.log(bad ? `\n${bad} screen${bad === 1 ? '' : 's'} with problems.` : `\nAll ${ROUTES.length} screens drew cleanly.`);
  process.exit(bad ? 1 : 0);
});
