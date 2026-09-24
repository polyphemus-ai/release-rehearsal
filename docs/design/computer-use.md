# Computer use

**Goal:** a bot can operate any app you can, including ones with no API: a browser first,
then a full desktop, each in its own sandboxed computer. Every model works with it, and the
bot never sees your passwords.

## What the providers offer (Sep 2026)

| | Anthropic | OpenAI | xAI |
|---|---|---|---|
| Native tool | `computer_toolset_20260801` (GA), plus `browser_toolset_20260801` | `{type: "computer"}` in the Responses API | **None in the API.** Grok Bot's computer is a product feature only |
| Models | Fable 5/5.1, Opus 5, Sonnet 5, Opus 4.8 | GPT-5.4 and later (`gpt-5.6-sol`, `gpt-6-astra`) | — |
| Call shape | One `tool_use` per action, run in order, stop at the first failure | One `computer_call` carrying `actions[]`, plus `pending_safety_checks` | Our generic tools |
| Who runs the actions | **The Polyphemus, in every case** | | |

## Architecture

```
 model ──native tool or generic tools──▶ adapter ──canonical actions──▶ executor ──▶ sandbox
                                                                         ├ browser (Playwright + a11y tree)
                                                                         └ desktop (Xvfb/VNC + xdotool)
```

### Canonical action schema

One discriminated union that both adapters map into and out of:

- **Observe:** `screenshot`, `zoom{region}`
- **Pointer:** `click{target, button, count 1–3, modifiers}`, `drag{path}`, `move`,
  `mouseDown` / `mouseUp`, `scroll{target, dx, dy}`
- **Keyboard:** `type{text}`, `key{chord[], repeat}`, `holdKey`, `wait{ms}`
- **Browser only:** `navigate`, `readPage`, `find{query}`, `formInput{ref, value}`,
  `tabs.*`, `fillSecret{ref, secretId}`

A `target` is either `{coord: {x, y, frameId}}` or `{ref}`. `frameId` ties a coordinate to
the screenshot it came from, so scaling is always right. Actions run in order and stop at the
first failure.

### Mapping each provider

- **Anthropic:** dispatch on `(toolset_name, name)`. Return one `tool_result` per call and
  attach the screenshot to the last one. Screenshots are pre-scaled to about 1080p (the API
  rejects oversized images).
- **OpenAI:** expand `actions[]` into canonical actions, then return one
  `computer_call_output` with the final screenshot. `pending_safety_checks` go to the
  approval gate and are acknowledged only after you approve. Zoom is emulated by cropping.
- **Grok and anything without a native tool:** the canonical schema is exposed as strict
  function tools. Screenshots travel as images in the next user message. In the browser,
  text tools (`readPage`, `find`, click by ref) let even text-only models work.

This requires one core change: canonical messages gain an **`image` block**, so tool results
can carry screenshots. It's also useful for reading image files.

## Executors

**Browser first.** The leaders default to the accessibility tree or DOM, and use pixels only
as a fallback:

- Anthropic's browser tool uses accessibility-tree refs that "survive layout shifts".
- Playwright MCP uses the tree by default.
- Screenshots cost about 1–1.8k tokens each.

| Phase | Executor |
|---|---|
| 4 | **Browser:** Playwright from TypeScript, Chromium in a container, a persistent context per bot identity (`storageState`), refs from the accessibility snapshot. Risky abilities are off by default: running JavaScript, file upload, console and network reads. This also gives the workflow Verify step real UI checks, replacing your `ui-screenshot-verify` skill |
| 6 | **Linux desktop:** Anthropic's reference container: Ubuntu, Xvfb, x11vnc/noVNC, xdotool, mutter at 1280×800. X11, not Wayland |
| 6 | Hosted option: E2B Desktop or Browserbase, for always-on bots that don't run on your machine |
| later | Windows (UI Automation via Windows-MCP), macOS (accessibility API, cua-driver), Android (adb + uiautomator2 on an emulator). iOS is realistically limited to the Simulator |

## Which way out (banked 2026-09-16)

Where a browser or a sandbox appears to connect from. Not a question yet — Polyphemus runs on your own
computer, so everything already goes out through your own address — but three things make it one:

- **A company server** ([hosting.md](hosting.md)): traffic leaves from the company's address. Sometimes
  that's wanted, sometimes a site blocks it, sometimes a service only admits one particular network.
- **Worker isolation**: once agents run in containers, "which way out" becomes a setting — through this
  computer, through a company proxy, or nowhere.
- **Hosted sandboxes**: a datacenter address is the one sites block. Grok Bot added routing its VM's
  traffic out through your own desktop for exactly this (seen 2026-09-14), with a count of open
  connections shown in its settings; the same screen lists several computers per account, each with its
  own rule for running things — closer to worker isolation and multiplayer than to browsing.

If Polyphemus ever routes an agent's traffic through a person's machine, the browser's rule holds: public
addresses only, nothing on that machine or its networks, and it says how many connections are open.

## Safety defaults

- **One sandbox per bot identity,** never shared. Grok Bot shares one computer across all
  your bots, and its own docs say not to rely on separate bots as a security boundary. Its
  settings confirm it: **Bot Computer**, auto-review and the time zone are one set for the
  account, not one per bot (x.ai/bot settings, seen 2026-09-11). The machine itself is the same
  shape as ours — a container with a virtual framebuffer streamed into the app, showing Chrome,
  a file manager and a terminal on a window-manager dock, not a VM per bot. What differs is the
  boundary, and that's the part not to copy.
- **Egress allowlist** per bot. Private and loopback ranges are blocked. Navigation is
  limited to `http` and `https`.
- **Everything on screen is untrusted input.** Operator instructions never come from page
  content. Anthropic's injection classifiers stay on, and OpenAI safety checks go to you.
- **Confirmation gates:** purchases, sends and posts, deletes, permission changes, and
  accepting terms.
- **Credentials:**
  - The model never sees passwords. You log in once through a takeover (noVNC or the app's
    live view) and the session is saved. Or cookies are injected. (Built for the browser, 2026-09-16:
    the app's live view, cookies kept per site.)
  - `fillSecret` fills fields from the vault through the broker and is redacted from
    transcripts.
  - No credentials in prompts, ever.
- **Audit:** every action is logged with before and after screenshots, plus an optional
  video recording. Hard caps on steps, time, and cost.

## Learn once, replay

This follows Grok Bot's routines. You show a bot a task once (live or in a recording) and
it drafts a **procedure** ([memory.md](memory.md)) plus a recording of canonical actions with
element fingerprints.

- **Replay is deterministic when possible.** When a step no longer matches the screen, that
  step goes back to the model to re-plan.
- **Your corrections update the procedure.**
- **Routines** put a procedure on a schedule or a trigger.

## Build order

| Phase | Work |
|---|---|
| 2 | `image` block in canonical types and in both adapters |
| 4 (first slice, 2026-09-14) | **Shipping looks at what it built:** `browser/chrome.ts` drives the machine's own headless Chrome over its DevTools pipe (no Playwright, a throwaway profile); `ship-issue` serves the worktree and opens the plan's pages at phone and desktop widths every round. Only Polyphemus drives it — no model has the browser yet |
| 4 (second slice, 2026-09-14) | **Agents drive a browser:** the **Browser** connection (built in, granted like any other). Tools: open_page, read_page (the accessibility tree as text, with refs), click, type_text, press_key, scroll_page, go_back, take_screenshot (a PNG file). A browser context per thread with no logins; every request checked against public addresses only; downloads refused; dialogs dismissed; popups closed. Text first, so every model can use it; no native computer-use tool mapping yet |
| 4 (third slice, 2026-09-14) | **Models see pictures in tool results:** a `tool_result` carries image blocks (kept in uploads like attached images). Anthropic gets them inside the result, OpenAI Responses as `input_image` output, OpenAI-compatible servers as a user message right after. Pictures from any MCP server, `take_screenshot`, and `read_file` on an image all reach the model; agent CLIs get them as MCP image content through the gateway |
| 4 (fourth slice, 2026-09-16) | **Sign-ins an agent keeps:** on the Browser connection, a person signs in to a site by hand in a live view — a JPEG of a tab of its own, polled, with taps, typing, keys and scrolling sent back (`TabHands`); a password field's focus switches the app's box to a password box. Keeping it saves the cookies for that site and its subdomains in the vault (`connection/<id>/sign-in/<id>`), and what the page holds in `localStorage` for sites that keep their session there rather than in cookies; the owner picks projects the browser is granted to. A thread's browser starts with the sign-ins its project has, the model is told which (and which were held back, and why), cookie and stored-session values are masked in anything a tool returns, and what a site refreshes is saved back. Held back wherever anyone besides the owner has a role in the project. Not kept: `sessionStorage` — it dies with the tab even for a person at their own computer, so a site that signs in that way asks to be signed in again however the session is kept |
| 4 | Canonical action schema, browser executor, Anthropic and OpenAI native mappings, generic tools for Grok, UI checks in Verify |
| 6 | Desktop sandbox, takeover login, recording and replay routines, hosted sandboxes |
| later | Windows, macOS, and Android executors |

## Key sources

Anthropic: [computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool),
[browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool),
[reference container](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo).
OpenAI [computer use](https://developers.openai.com/api/docs/guides/tools-computer-use).
xAI: [API tools](https://docs.x.ai/developers/tools/overview),
[Grok Bot computer](https://docs.x.ai/grok-bot/computer-and-apps).
Browser tooling: [Playwright MCP](https://github.com/microsoft/playwright-mcp),
[Stagehand caching](https://docs.stagehand.dev/v3/best-practices/caching).
Desktop and mobile: [E2B Desktop](https://github.com/e2b-dev/desktop),
[Windows-MCP](https://github.com/CursorTouch/Windows-MCP),
[Cua](https://github.com/trycua/cua),
[mobile-mcp](https://github.com/mobile-next/mobile-mcp).
