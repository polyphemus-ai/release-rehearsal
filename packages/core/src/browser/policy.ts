import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Where an agent's browser may go: public web pages. Not this computer, not your home or office
// network, not your tailnet — an agent reading a page mustn't be able to reach a router's admin page,
// a dev database's console or polyphemus itself. Checked for every request the page makes, not only the
// address typed, so a public page can't pull something private in either.
//
// It's a check, not a boundary: Chrome resolves names itself, so a name that resolves differently a
// moment later (DNS rebinding) could slip through. Worker isolation's network rules are the boundary.

/** Why an address is refused, in words; undefined if it may be opened. */
export async function refusedAddress(raw: string): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'that isn’t a web address';
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || raw === 'about:blank') return undefined;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `only http and https pages can be opened, not ${url.protocol.replace(':', '')}`;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return 'it has no host';
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa|ts\.net)$/.test(host)) return `${host} is on this computer or a private network`;
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses === undefined) return undefined; // Chrome will say it couldn't find it
  const inside = addresses.find(privateAddress);
  return inside ? `${host === inside ? host : `${host} (${inside})`} is on this computer or a private network` : undefined;
}

const cache = new Map<string, { addresses: string[] | undefined; at: number }>();

async function resolve(host: string): Promise<string[] | undefined> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.addresses;
  const addresses = await lookup(host, { all: true }).then(
    (found) => found.map((a) => a.address),
    () => undefined,
  );
  cache.set(host, { addresses, at: Date.now() });
  return addresses;
}

/** Loopback, private, link-local, carrier-grade NAT (tailnets live there), multicast, unspecified. */
export function privateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return privateAddress(mapped);
  // The same, as a URL writes it: [::ffff:127.0.0.1] becomes [::ffff:7f00:1] (independent review,
  // 2026-09-19). And NAT64's 64:ff9b::/96, which carries an IPv4 address the same way.
  const bare = address.replace(/^\[|\]$/g, '').toLowerCase();
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const nat64 = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(bare)?.[1];
  if (nat64) return privateAddress(nat64);
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
  }
  return true;
}
