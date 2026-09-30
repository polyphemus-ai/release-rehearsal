import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverOAuth } from '../src/connections/oauth.js';

// Finding how a remote MCP server signs in, from its published metadata — as real servers publish it,
// not only as the spec says to label it.
describe('discovering a server’s sign-in', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  const serve = (asType: string, asBody?: string) =>
    new Promise<string>((resolve) => {
      server = createServer((req, res) => {
        const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
        if (req.url === '/mcp') {
          res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
          return res.end();
        }
        if (req.url === '/.well-known/oauth-protected-resource/mcp') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [`${base}/auth`] }));
        }
        if (req.url === '/.well-known/oauth-authorization-server/auth') {
          res.writeHead(200, { 'content-type': asType });
          return res.end(asBody ?? JSON.stringify({ issuer: `${base}/auth`, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['plain', 'S256'] }));
        }
        res.writeHead(404);
        res.end();
      }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`));
    });

  it('reads an authorization server’s metadata even when it’s labelled as a download', async () => {
    // Semrush's is application/octet-stream (2026-09-29): JSON all the same.
    const base = await serve('application/octet-stream');
    expect(await discoverOAuth(`${base}/mcp`)).toMatchObject({ resource: `${base}/mcp`, issuer: `${base}/auth`, registrationEndpoint: `${base}/register` });
  });

  it('isn’t fooled by a page that isn’t metadata at all', async () => {
    const base = await serve('text/html', '<html><body>Sign in</body></html>');
    expect(await discoverOAuth(`${base}/mcp`)).toBeUndefined();
  });
});
