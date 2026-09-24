# Hosting: Polyphemus somewhere other than your own computer

Two different questions wear the same clothes, and conflating them wastes work. Written
2026-09-13 for the company case; rewritten 2026-09-17 after working through the personal one and
checking it against the code.

- **A shared install** — you, a couple of collaborators, one machine that is always on, reached
  without asking anyone to install Tailscale. Needs almost nothing new.
- **A company server** — colleagues at work, IT policy, single sign-on, budgets. Needs real work,
  and lands with multiplayer at 1.0.

| | Shared install | Company server |
|---|---|---|
| Who uses it | You plus a few people you already trust | Colleagues, joining and leaving over time |
| Where it runs | A VM you own (EC2 or anything) | A Linux VM IT hosts, backed up |
| The address | `https://team.<your domain>` through a proxy on the same box | `https://polyphemus.<company domain>` with a real certificate |
| How people get in | Pairing codes, behind an identity-aware proxy | Single sign-on with their work account |
| Whose models | Your API keys; your subscriptions stay yours alone | Company API accounts with spending limits |
| Isolation | Required in practice | Required, and IT will ask first |
| What Polyphemus needs | Nothing in the code | Server mode, SSO, invitations, budgets, audit |

## Shape one: a shared install

The goal is a Polyphemus that is always on and reachable from phones and laptops without Tailscale on
each of them.

### It works without server mode

The trick is that the proxy runs on the same machine and talks to loopback, so Polyphemus never has to
listen anywhere new. Checked 2026-09-17:

- **The daemon listens on 127.0.0.1 and the Tailscale address, never `0.0.0.0`**
  (`packages/daemon/src/server.ts:181`). A proxy on the same box reaching `127.0.0.1:3900` leaves
  that rule untouched.
- **It already expects to sit behind TLS termination:** `x-forwarded-proto: https` is honoured
  (`server.ts:2489`).
- **The same-origin check compares the `Origin` header host with the `Host` header**
  (`server.ts:2755`), so a proxied request where both are `team.<your domain>` passes. Nothing
  requires a tailnet address.
- **Permissions are already central and already multi-person.** `packages/daemon/src/access.ts` is
  asked by every route, the event stream and push, so a permission is never enforced in one path and
  forgotten in another. The install owner sees everything; everyone else is a member or a viewer of
  particular projects, and membership of one grants nothing anywhere else.

Prefer an outbound tunnel (Cloudflare Tunnel, or equivalent) over opening a port: no inbound firewall
hole, and no public listener on the box.

### What to set up

1. A VM you own, always on. `poly service install` so the daemon starts at boot.
2. A tunnel or reverse proxy on that same VM, pointing at `127.0.0.1:3900`.
3. **An identity-aware proxy in front** — Cloudflare Access or similar, with Google, GitHub or email
   one-time codes. Without it, pairing is the only gate and the pairing route is reachable from the
   internet. This is what replaces "install Tailscale everywhere".
4. `isolation.level = "isolated"`. Several people's agents otherwise share one Unix user on a
   reachable machine.
5. Pair each person's devices; `poly devices` lists them and `poly devices revoke <id>` cuts
   one off.

Tailscale's own HTTPS issues certificates for `*.ts.net` names, so a custom domain does not come
from it. Terminating TLS yourself — which the tunnel does — is the whole difference.

### What is not proven yet

- **Streaming through a proxy.** The app streams over HTTP and SSE, and proxies sometimes buffer it.
  Untested as of 2026-09-17, and the most likely thing to bite. Test it first.
- **Permissions under adversarial use.** The enforcement is written and central; nobody has
  demonstrated that a person cannot read, answer or run what they should not — including over a
  connection left open after their access was revoked. That release test is part of multiplayer at
  1.0. For people you already trust, this is a judgement call rather than a blocker.

### Subscriptions: the line that does not move

Personal subscriptions (Claude Max, ChatGPT, SuperGrok) are tied to one person by their terms.
Running your own turns through your own subscription on your own VM is a grey area you can decide
about. Running *other people's* turns through it is not: a shared install serves collaborators from
API keys, and the subscriptions stay yours. This is a licensing constraint, not an engineering one —
there is nothing to build that changes it.

## Shape two: a company server

The question it answers: a team wants to run Polyphemus at work, colleagues join projects, and IT policy
rules out Tailscale. What does Polyphemus need, and what does IT configure once, so everyone after the
first person just signs in?

### Why today's shape doesn't fit

- **Where it listens:** 127.0.0.1 and the Tailscale address only — a deliberate rule (AGENTS.md).
- **How people get in:** pairing codes made in a terminal, one device at a time.
- **Where it runs:** one person's computer, which sleeps, travels, and isn't IT-managed.

A proxy on the box answers the first two for a handful of people who trust each other (shape one). It
does not answer joining, leaving, budgets or audit, which is what makes this a different shape rather
than a bigger version of the same one.

### The shape that fits

**Polyphemus on a company server, behind the company's own sign-in, reached however IT already publishes
internal apps.**

| Piece | At a company |
|---|---|
| Where it runs | A Linux VM IT hosts (on premises or a cloud tenant), always on, backed up |
| The address | `https://polyphemus.<company domain>` with a real certificate |
| How people reach it | The office network or VPN; for phones away from the office, an identity-aware proxy such as **Microsoft Entra Application Proxy** or **Cloudflare Access** — no inbound firewall hole, the usual answer to "no Tailscale" |
| How people sign in | **Single sign-on with their work account** (OpenID Connect; Microsoft Entra ID first) instead of pairing codes. IT assigns a group; leavers lose access with their account |
| Whose model accounts | **Company API accounts** with spending limits. Personal subscriptions (Claude, ChatGPT) are tied to one person by their terms and shouldn't power a shared server |
| GitHub | Polyphemus's GitHub identities already belong to an organisation, so they fit as they are |

### What IT configures, once

1. A Linux VM (4–8 vCPU, 16 GB to start), with backups.
2. A DNS name and a TLS certificate.
3. A single sign-on app registration, assigned to a group.
4. A way in: office network or VPN, or an identity-aware proxy for phones.
5. An outbound allowlist: the model APIs, `github.com` and `api.github.com`, and connected services.
6. Company API keys (or approval to use them), with budgets.

After that, a colleague opens the address, signs in with their work account, and is added to projects
from the app. Nothing to install.

### What Polyphemus needs first

1. **Server mode:** listen on a configured address behind a trusted proxy, keeping the same-origin
   check. This deliberately replaces "never beyond the tailnet" for this mode, with its own safeguards.
   Shape one sidesteps this by keeping the proxy on the same machine; a company deployment will not
   always be able to.
2. **Single sign-on (OpenID Connect)** alongside pairing codes.
3. **Invitations and roles in the app** (on the roadmap as multiplayer basics).
4. **Model accounts per company, per person, or both**, with spending limits and who spent what.
5. **Worker isolation — required, not optional, on a shared server.** Today an agent's shell runs as
   Polyphemus's user; on a server that's every colleague's agents in one account. Containers per project
   or per run. IT will ask about this first.
6. **An audit log IT can read:** who did what, through which connection, when.

## Which way out

A browser on a company server leaves from the company's address, which some services block and others
require. Worker isolation makes this a setting per project or run — out through the server, out through
a company proxy, or nowhere. Banked with the rest in [computer-use.md](computer-use.md#which-way-out-banked-2026-09-16).

## Open, to answer with a real deployment

- Whether SSE survives the tunnel in practice (shape one), and what to change if it doesn't.
- Which identity provider (Microsoft Entra ID is the likely first), and whether there's a VPN.
- On-premises VM or a cloud tenant.
- Whether people bring their own model accounts as well as the company's.
