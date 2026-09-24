// What an isolated project's agents may reach on the network (docs/design/isolation.md, network grants):
// nothing, unless a person grants it — a preset, or hosts by name. Enforced by polyphemus's proxy.

export interface ProjectNetwork {
  presets: string[];
  hosts: string[];
}

export const NETWORK_PRESETS: Record<string, { title: string; says: string; hosts: string[] }> = {
  packages: {
    title: 'Package registries',
    says: 'Installing packages: npm, PyPI, crates.io, Go modules and RubyGems.',
    hosts: ['registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org', 'crates.io', 'index.crates.io', 'static.crates.io', 'proxy.golang.org', 'sum.golang.org', 'rubygems.org', 'index.rubygems.org'],
  },
  github: {
    title: 'GitHub',
    says: 'Reading from GitHub: cloning, releases, raw files and its API. Pushing stays polyphemus’s, as your GitHub identities.',
    hosts: ['github.com', 'api.github.com', 'codeload.github.com', '*.githubusercontent.com'],
  },
};

export const isNetworkPreset = (id: unknown): id is string => typeof id === 'string' && Object.hasOwn(NETWORK_PRESETS, id);

/**
 * A host as a person might type it — a URL, a name, `*.example.com`, `example.com:8443` — made into the
 * rule the proxy checks, or why it can't be one.
 */
export function normalizeHost(input: string): { host: string } | { error: string } {
  let text = input.trim().toLowerCase();
  if (!text) return { error: 'Type a host, like registry.npmjs.org.' };
  if (text === '*' || text === '*.*') return { error: 'Every host is the “Isolated, open network” level, not a grant.' };
  // A pasted URL keeps its host and any port it names.
  const url = /^[a-z][a-z0-9+.-]*:\/\//.exec(text) ? safeUrl(text) : undefined;
  if (url) text = `${url.hostname}${url.port ? `:${url.port}` : ''}`;
  text = text.replace(/\/.*$/, '').replace(/\.(?=:|$)/, '');
  if (/^\d+(\.\d+){3}(:\d+)?$/.test(text) || /^\[?[0-9a-f]*:[0-9a-f:.]*\]?(:\d+)?$/.test(text)) return { error: 'Grant hosts by name: addresses on this computer or a private network are always refused, and public ones change.' };
  const match = /^(\*\.)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]|[a-z0-9-]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))) return { error: `“${input.trim()}” isn’t a host polyphemus can grant: use a name like example.com or *.example.com.` };
  if (!match[2]!.includes('.')) return { error: `“${match[2]}” is a name on your own network, and agents can never reach those.` };
  return { host: text };
}

function safeUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/** Every host a project's grant allows: its presets' and its own. */
export function grantedHosts(network: ProjectNetwork | undefined): string[] {
  if (!network) return [];
  return [...new Set([...network.presets.filter(isNetworkPreset).flatMap((id) => NETWORK_PRESETS[id]!.hosts), ...network.hosts])].sort();
}

export function parseNetwork(text: string | null | undefined): ProjectNetwork | undefined {
  if (!text) return undefined;
  try {
    const raw = JSON.parse(text) as Partial<ProjectNetwork>;
    const presets = Array.isArray(raw.presets) ? raw.presets.filter(isNetworkPreset) : [];
    const hosts = Array.isArray(raw.hosts) ? raw.hosts.filter((h): h is string => typeof h === 'string' && 'host' in normalizeHost(h)) : [];
    return presets.length || hosts.length ? { presets, hosts } : undefined;
  } catch {
    return undefined;
  }
}
