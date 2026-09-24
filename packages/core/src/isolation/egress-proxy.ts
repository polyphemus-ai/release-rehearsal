// The proxy every worker's network goes through (docs/design/isolation.md, network grants). It runs in
// a container of its own with ordinary network; workers have none at all. Each worker is handed one Unix
// socket — its own folder of a shared volume — so which socket a connection arrives on says which worker
// it is: nothing to steal, and workers can't reach each other. Kept as source text: it's written into
// ~/.polyphemus and run by the worker image's Node, with nothing but Node's standard library.
//
// The policy file says which hosts each worker may reach. A host is checked
// by name against the grant, then every address it resolves to is checked against private, loopback,
// link-local, carrier-grade NAT (tailnets) and metadata ranges, and the connection goes to the address
// that was checked — so a granted name can't be pointed at this computer or the local network.

/** Where a worker's forwarder listens, inside the worker: what HTTP(S)_PROXY points at. */
export const EGRESS_PORT = 3128;
/** Where a worker's own socket folder is mounted. */
export const EGRESS_MOUNT = '/run/polyphemus-egress';

export const EGRESS_PROXY_SOURCE = String.raw`import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs';

// Paths inside its container; a test runs it directly with its own.
const POLICY = process.env.POLYPHEMUS_EGRESS_POLICY || '/egress/policy.json';
let cached = { mtime: '', policy: { workers: {} } };
function policy() {
  try {
    const stat = fs.statSync(POLICY);
    // Replaced by a rename each time, so a new inode means a new policy even within the same millisecond.
    const mark = stat.ino + ':' + stat.mtimeMs;
    if (mark !== cached.mtime) cached = { mtime: mark, policy: JSON.parse(fs.readFileSync(POLICY, 'utf8')) };
  } catch {}
  return cached.policy;
}

// Separate lists: Node's BlockList treats IPv4-mapped IPv6 rules as matching plain IPv4 addresses.
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [addr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked4.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) blocked6.addSubnet(addr, bits, 'ipv6');

function isPublic(address) {
  // An IPv4 address written as IPv6 is judged as the IPv4 address it is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return !blocked4.check(mapped[1], 'ipv4');
  if (/^::ffff:/i.test(address)) return false;
  return net.isIP(address) === 6 ? !blocked6.check(address, 'ipv6') : !blocked4.check(address, 'ipv4');
}

function worker(name) {
  const entry = (policy().workers || {})[name];
  return entry ? { name, ...entry } : null;
}

function granted(entry, host, port) {
  host = host.toLowerCase().replace(/\.$/, '');
  return (entry.hosts || []).some((rule) => {
    const [pattern, only] = rule.split(/:(?=\d+$)/);
    if (only ? Number(only) !== port : port !== 80 && port !== 443) return false;
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
    return host === pattern;
  });
}

function say(line) {
  process.stdout.write(JSON.stringify({ at: Date.now(), ...line }) + '\n');
}

async function decide(name, host, port) {
  const entry = worker(name);
  if (!entry) return { status: 403, why: 'this worker has no network any more' };
  const refuse = (why) => {
    say({ worker: entry.name, project: entry.project || null, host, port, refused: why });
    return { status: 403, why };
  };
  if (!host || !(port > 0 && port < 65536)) return refuse('not a host and port');
  if (!granted(entry, host, port)) return refuse(entry.hosts?.includes('*') ? 'only ports 80 and 443 are open' : 'not granted');
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return refuse('no such host');
  }
  // IPv4 first: a container network often has no IPv6 route out.
  const usable = addresses.filter((a) => isPublic(a.address)).sort((a, b) => net.isIP(a.address) - net.isIP(b.address));
  if (!usable.length) return refuse('it points at this computer or a private network');
  return { entry, address: usable[0].address };
}

function refuseText(host, why) {
  return why === 'not granted'
    ? 'polyphemus: ' + host + ' isn’t granted to agents in this project. A person can grant it on the project’s Setup tab, under Where agents run.\n'
    : 'polyphemus: the connection to ' + host + ' was refused: ' + why + '.\n';
}

function serve(name) {
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end('polyphemus: send requests through the proxy with a full URL.\n');
    return;
  }
  if (url.protocol !== 'http:') {
    res.writeHead(400).end('polyphemus: only http:// is proxied directly; https goes through CONNECT.\n');
    return;
  }
  const port = Number(url.port || 80);
  const decision = await decide(name, url.hostname, port);
  if (!decision.address) {
    res.writeHead(decision.status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(refuseText(url.hostname, decision.why));
    return;
  }
  const headers = { ...req.headers };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  const upstream = http.request({ host: decision.address, port, method: req.method, path: url.pathname + url.search, headers }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => res.headersSent ? res.destroy() : res.writeHead(502).end('polyphemus: ' + url.hostname + ' didn’t answer.\n'));
  req.pipe(upstream);
});

server.on('connect', async (req, client, head) => {
  client.on('error', () => {});
  const [host, portText] = req.url.startsWith('[') ? [req.url.slice(1, req.url.indexOf(']')), req.url.slice(req.url.indexOf(']') + 2)] : req.url.split(/:(?=\d+$)/);
  const port = Number(portText);
  const decision = await decide(name, host, port);
  if (!decision.address) {
    const text = refuseText(host, decision.why);
    client.end('HTTP/1.1 ' + decision.status + ' Forbidden' + '\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ' + Buffer.byteLength(text) + '\r\n\r\n' + text);
    return;
  }
  const upstream = net.connect(port, decision.address, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
});
return server;
}

// A socket for each worker in the policy, and none for a worker that's gone.
const SOCKETS = process.env.POLYPHEMUS_EGRESS_SOCKETS || '/sockets';
const listening = new Map();
function sync() {
  const wanted = new Set(Object.keys(policy().workers || {}).filter((name) => /^[a-z0-9-]+$/.test(name)));
  for (const [name, server] of listening) {
    if (wanted.has(name)) continue;
    server.close();
    listening.delete(name);
    try { fs.rmSync(SOCKETS + '/' + name + '/proxy.sock', { force: true }); } catch {}
  }
  for (const name of wanted) {
    if (listening.has(name)) continue;
    const dir = SOCKETS + '/' + name;
    const file = dir + '/proxy.sock';
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.rmSync(file, { force: true });
    } catch (err) {
      say({ worker: name, error: String(err) });
      continue;
    }
    const server = serve(name);
    server.on('error', (err) => say({ worker: name, error: String(err) }));
    server.listen(file, () => fs.chmodSync(file, 0o600));
    listening.set(name, server);
  }
}
sync();
setInterval(sync, 500);
say({ ready: true });
`;

/** The worker's side: listens where HTTP(S)_PROXY points and hands each connection to its socket. Restarted if it stops. */
export const EGRESS_FORWARDER_SOURCE = String.raw`const net = require('node:net');
net.createServer((client) => {
  const upstream = net.connect('${EGRESS_MOUNT}/proxy.sock');
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.pipe(upstream).pipe(client);
}).listen(${EGRESS_PORT}, '127.0.0.1');
`;
