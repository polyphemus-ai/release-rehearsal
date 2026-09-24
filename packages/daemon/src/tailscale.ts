import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import { findOnPath, inWsl } from '@polyphemus/core';

export interface TailscaleInfo {
  /** This machine's Tailscale IPv4 address (100.x.y.z). */
  ip: string;
  /** Its MagicDNS name, e.g. laptop.tail1234.ts.net. */
  dnsName?: string;
  /**
   * The address is on this machine, so the daemon can listen there. Inside WSL it's Windows's, and
   * Tailscale's HTTPS on Windows, forwarding to Windows's own localhost and so into WSL, is the way in.
   */
  local: boolean;
}

const WINDOWS_TAILSCALE = '/mnt/c/Program Files/Tailscale/tailscale.exe';

/**
 * The Tailscale command to ask: Linux's own, or, inside WSL without one, the one on Windows — where
 * Tailscale runs for a Windows computer, and where a phone's connection arrives (2026-09-23).
 */
export function tailscaleCommand(): string {
  if (findOnPath('tailscale')) return 'tailscale';
  if (inWsl()) return findOnPath('tailscale.exe', { windows: true }) ?? (existsSync(WINDOWS_TAILSCALE) ? WINDOWS_TAILSCALE : 'tailscale');
  return 'tailscale';
}

/** Whether Tailscale here is Windows's, reached from WSL. */
export const tailscaleOnWindows = (): boolean => tailscaleCommand().endsWith('.exe');

const tailscale = (args: string[], timeout: number) => promisify(execFile)(tailscaleCommand(), args, { timeout });

/**
 * The HTTPS address Tailscale serves for the daemon on `port` (`poly serve` sets it up
 * with enableHttps), if any, e.g. https://laptop.tail1234.ts.net.
 */
export async function detectHttps(port: number): Promise<string | undefined> {
  try {
    const { stdout } = await tailscale(['serve', 'status', '--json'], 5000);
    const status = JSON.parse(stdout) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
      const proxies = Object.values(web.Handlers ?? {}).map((handler) => handler.Proxy ?? '');
      if (proxies.some((proxy) => new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`).test(proxy))) {
        return `https://${hostPort.replace(/:443$/, '')}`;
      }
    }
  } catch {
    // Tailscale isn't installed, or serve isn't set up.
  }
  return undefined;
}

/** The local port Tailscale's HTTPS address (port 443, path /) proxies to now, if it proxies anywhere. */
export async function httpsRootPort(): Promise<number | undefined> {
  try {
    const { stdout } = await tailscale(['serve', 'status', '--json'], 5000);
    const status = JSON.parse(stdout) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
      if (!hostPort.endsWith(':443')) continue;
      const proxy = web.Handlers?.['/']?.Proxy ?? '';
      const port = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)\/?$/.exec(proxy)?.[1];
      if (port) return Number(port);
    }
  } catch {
    // Tailscale isn't installed, or serve isn't set up.
  }
  return undefined;
}

/** Points Tailscale's HTTPS (tailnet only) at the daemon. Resolves to an error message if Tailscale refuses. */
export async function enableHttps(port: number): Promise<string | undefined> {
  try {
    await tailscale(['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`], 30_000);
    return undefined;
  } catch (err) {
    const output = `${(err as { stderr?: string }).stderr ?? ''}${(err as Error).message}`;
    return /access denied/i.test(output) ? 'permission' : output.trim().split('\n')[0];
  }
}

/** This machine's Tailscale address, if Tailscale is installed and connected. */
export async function detectTailscale(): Promise<TailscaleInfo | undefined> {
  try {
    const { stdout } = await tailscale(['status', '--json'], 5000);
    const status = JSON.parse(stdout) as { BackendState?: string; Self?: { TailscaleIPs?: string[]; DNSName?: string } };
    const ip = status.Self?.TailscaleIPs?.find((address) => address.includes('.'));
    if (status.BackendState !== 'Running' || !ip) return undefined;
    const local = Object.values(networkInterfaces()).some((addresses) => addresses?.some((a) => a.address === ip));
    return { ip, dnsName: status.Self?.DNSName?.replace(/\.$/, '') || undefined, local };
  } catch {
    return undefined;
  }
}
