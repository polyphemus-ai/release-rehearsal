import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { publisherOf, registryServers, searchRegistry } from '../src/connections/registry.js';

// The open MCP Registry, as polyphemus offers it: servers it can reach, said to be by whoever proved
// the domain in their name, found by what someone types.
describe('the MCP Registry', () => {
  it('says who published a server from the domain its name proves', () => {
    expect(publisherOf('com.notion/mcp')).toBe('notion.com');
    expect(publisherOf('io.github.alex/tasks')).toBe('github.com/alex');
    expect(publisherOf('ai.example.api/x')).toBe('api.example.ai');
  });

  it('offers only servers reachable over streamable HTTP at a plain https address, with the keys they need', () => {
    const servers = registryServers([
      { server: { name: 'com.example/tasks', title: 'Tasks', description: 'Tasks for teams.', remotes: [{ type: 'sse', url: 'https://example.com/sse' }, { type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: [{ name: 'X-API-Key', description: 'Your key', isSecret: true, isRequired: true }, { name: 'X-Client', value: 'fixed' }] }], websiteUrl: 'https://example.com' } },
      { server: { name: 'com.oldstyle/x', remotes: [{ type: 'sse', url: 'https://oldstyle.com/sse' }] } },
      { server: { name: 'com.local/x', packages: [{ registryType: 'npm' }] } },
      { server: { name: 'com.plain/x', remotes: [{ type: 'streamable-http', url: 'http://plain.com/mcp' }] } },
      { server: { name: 'com.templated/x', remotes: [{ type: 'streamable-http', url: 'https://{workspace}.templated.com/mcp' }] } },
      { nothing: true },
    ]);
    expect(servers).toEqual([
      { name: 'com.example/tasks', title: 'Tasks', description: 'Tasks for teams.', url: 'https://mcp.example.com/mcp', publisher: 'example.com', keys: [{ name: 'X-API-Key', description: 'Your key', secret: true, required: true }], website: 'https://example.com' },
    ]);
  });

  it('finds the closest first, and leaves out what the catalogue already has', () => {
    const index = {
      builtAt: 0,
      servers: registryServers(['Linear Clone', 'Task Linear', 'Linear', 'Other'].map((title, i) => ({ server: { name: `com.s${i}/x`, title, description: 'x', remotes: [{ type: 'streamable-http', url: `https://s${i}.example.com/mcp` }] } }))),
    };
    expect(searchRegistry(index, 'linear').map((s) => s.title)).toEqual(['Linear', 'Linear Clone', 'Task Linear']);
    expect(searchRegistry(index, 'linear', (s) => s.title === 'Linear').map((s) => s.title)).toEqual(['Linear Clone', 'Task Linear']);
  });

  it('puts a publisher with a domain of its own before a GitHub account’s', () => {
    const index = { builtAt: 0, servers: registryServers(['io.github.sam/jira', 'com.atlassian/jira'].map((name, i) => ({ server: { name, title: 'Jira', remotes: [{ type: 'streamable-http', url: `https://s${i}.example.com/mcp` }] } }))) };
    expect(searchRegistry(index, 'jira').map((s) => s.publisher)).toEqual(['atlassian.com', 'github.com/sam']);
  });

  it('asks again for a page that failed once, and keeps what it read when one fails twice', async () => {
    let asked = 0;
    const server = createServer((req, res) => {
      asked++;
      const cursor = new URL(req.url!, 'http://x').searchParams.get('cursor');
      // The first page fails once; the second always fails.
      if ((!cursor && asked === 1) || cursor === 'two') return res.writeHead(500).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ servers: [{ server: { name: 'com.example/one', remotes: [{ type: 'streamable-http', url: 'https://one.example.com/mcp' }] } }], metadata: { nextCursor: 'two' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    vi.stubEnv('POLYPHEMUS_MCP_REGISTRY', `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    vi.resetModules();
    try {
      const { buildRegistryIndex } = await import('../src/connections/registry.js');
      const index = await buildRegistryIndex();
      expect(index.servers.map((s) => s.name)).toEqual(['com.example/one']);
      expect(index.partial).toMatch(/stopped after 1 pages: the registry answered 500/);
      expect(asked).toBe(4);
    } finally {
      vi.unstubAllEnvs();
      server.close();
    }
  });
});
