import { createConnection } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import * as readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT, detectHttps, detectTailscale, enableHttps, httpsRootPort, startDaemon, tailscaleOnWindows, webPushSender } from '@polyphemus/daemon';
import QRCode from 'qrcode';
import { homedir } from 'node:os';
import { existsSync as folderExists, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  addProject,
  envSetting,
  PROJECT_ROLES,
  type ProjectRole,
  ago,
  classifyError,
  ConfigHistory,
  createProject,
  describeForecast,
  expandHome,
  inboxItems,
  needsOrientation,
  orientationPrompt,
  resolveInboxItem,
  type ProjectMeta,
  type ProjectSetup,
  configFile,
  createProvider,
  describeModel,
  EFFORTS,
  formatUsage,
  Polyphemus,
  polyphemusHome,
  PolyphemusError,
  offList,
  agentModel,
  attachImageFile,
  type ImageBlock,
  resolveModel,
  type ApprovalAnswer,
  type Asker,
  type Effort,
  type ResolvedModel,
  type RuntimeEvent,
  type SessionMeta,
  type SessionRuntime,
  assetPath,
  checkForUpdate,
  compareVersions,
  knownUpdate,
  ensureWorkerImage,
} from '@polyphemus/core';
import { choiceItems, modelChoices, printModels, targetOf } from './models.js';
import { pick, readHidden } from './picker.js';
import { bold, cyan, dim, green, oneLine, red, Renderer, yellow } from './render.js';
import { service, unhealthy, waitForIdle } from './service.js';
import { installPlace, rollback, sayResult, selfCheck, upgrade, type Place } from './upgrade.js';
import { inWsl, serviceManager } from './service-manager.js';
import { doctorCommand } from './doctor.js';
import { COMMANDS as COMMAND_SPECS, findCommand, usageText } from './commands.js';
import { errorEnvelope, exitCodeFor, iso, printJson, wantsJson } from './output.js';
import { transcriptView } from './transcript.js';
import { DaemonClient, RemoteSession, type ReplSession } from './daemon-client.js';
import { routineCommand } from './routines.js';
import { callerName, configCommand } from './config-cmd.js';
import { mcpServe } from './mcp.js';
import { imagePathArg, pickOutImages } from './attachments.js';
import { secretsCommand } from './secrets-cmd.js';
import { skillsCommand } from './skills-cmd.js';
import { agentsCommand, resolveAgent } from './agents-cmd.js';

const USAGE = usageText();
const VERSION = (JSON.parse(readFileSync(assetPath('cli', 'package.json'), 'utf8')) as { version: string }).version;
/** Whether this command answers in JSON, errors included (set once the command is known). */
let jsonOutput = false;

const COMMANDS = `Commands:
  /status            what's running: model, provider, how it's billed, tools, usage
  /model [name]      pick a model from a list, or switch straight to one (remembered for next time)
  /default [name]    set the model new sessions start with, without switching this one
  /models [provider] list the model ids a provider offers
  /login <provider>  add an API key for a pay-as-you-go provider (anthropic, openai, xai)
  /yolo              stop (or start again) asking before commands that change things, this session only
  /effort [level]    ${EFFORTS.join(' | ')} | default
  /new               start a new session
  /sessions          list recent sessions
  /resume <id>       switch to another session
  /title <text>      rename this session
  /image <path>      attach an image to your next message (or paste or drag its path into a message)
  /exit              quit (also /quit, Ctrl+D, or Ctrl+C twice)

Anything else you type goes to the model. help, sessions, models, and exit work without the slash.
End a line with \\ to keep typing on the next line. Ctrl+C interrupts a running turn.`;

const COMMAND_NAMES: readonly string[] = ['help', 'status', 'model', 'default', 'models', 'login', 'yolo', 'effort', 'new', 'sessions', 'resume', 'title', 'image', 'exit', 'quit'];
/** Single words that are almost never meant for the model. */
const BARE_COMMANDS = new Set(['help', 'status', 'sessions', 'models', 'exit', 'quit']);

/** The terminal's view of polyphemus: the shared Polyphemus and the session it's showing. */
interface Cli {
  polyphemus: Polyphemus;
  session: ReplSession;
  cwd: string;
  /** Set when sessions run in the daemon (so the phone sees them); unset when they run here. */
  daemon?: DaemonClient;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: 'string', short: 'm' },
      // talk with an agent in this session (poly agents)
      agent: { type: 'string', short: 'a' },
      resume: { type: 'string', short: 'r' },
      continue: { type: 'boolean', short: 'c' },
      print: { type: 'string', short: 'p' },
      yes: { type: 'boolean', short: 'y' },
      yolo: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      // JSON output for agents and scripts (on by default when stdout isn't a terminal)
      json: { type: 'boolean' },
      // run the session in this terminal, not the daemon
      local: { type: 'boolean' },
      // poly config set/unset: show the change without making it
      'dry-run': { type: 'boolean' },
      // poly secrets
      note: { type: 'string' },
      kind: { type: 'string' },
      reveal: { type: 'boolean' },
      machine: { type: 'boolean' },
      // poly sessions show: only the most recent messages
      last: { type: 'string' },
      // poly sessions: the archived ones
      archived: { type: 'boolean' },
      // poly routine next: how many times to list
      count: { type: 'string' },
      digest: { type: 'string' },
      // poly service update/restart: don't wait for running sessions
      now: { type: 'boolean' },
      // poly models: everything each provider offers, and the effort for a model you add
      all: { type: 'boolean' },
      effort: { type: 'string' },
      // poly skills new: put it in this project instead of your library
      project: { type: 'boolean' },
      // poly projects new/add
      from: { type: 'string' },
      // poly projects new: start it as a git repo (not assumed: a project isn't only code)
      git: { type: 'boolean' },
      // poly agents new: its mark ("hex/violet"), and skip writing its persona from your sentence
      mark: { type: 'string' },
      blank: { type: 'boolean' },
      // poly skills install: swap a library skill already there for this one
      replace: { type: 'boolean' },
      // poly agents edit: what to change
      title: { type: 'string' },
      description: { type: 'string' },
      fallback: { type: 'string' },
      persona: { type: 'string' },
      instructions: { type: 'string' },
      about: { type: 'string' },
      name: { type: 'string' },
      // poly pair --person, poly projects share --role
      person: { type: 'string' },
      role: { type: 'string' },
      // poly loop "<goal>" --until "<command>" --max N
      until: { type: 'string' },
      // poly update --check
      check: { type: 'boolean' },
      // poly rollback --restore
      restore: { type: 'boolean' },
      channel: { type: 'string' },
      max: { type: 'string' },
    },
  });
  if (values.version) return console.log(jsonOutput ? JSON.stringify({ version: VERSION }) : VERSION);
  if (values.help) return console.log(USAGE);
  // The MCP server's stdout is the protocol: nothing else may print there.
  if (positionals[0] === 'mcp') {
    if (positionals[1] !== 'serve') throw new PolyphemusError('Usage: poly mcp serve', 'USAGE', 'poly help mcp serve');
    return mcpServe();
  }

  // Before anything opens this computer's data: run by an update with the version it's about to
  // switch to, and that version mustn't change the real data before it has checked a copy.
  if (positionals[0] === 'self-check') {
    jsonOutput = wantsJson(values.json);
    return selfCheckCommand();
  }

  const polyphemus = await Polyphemus.open();
  const cwd = process.cwd();
  const [command, ...rest] = positionals;
  const spec = command ? (findCommand(`${command} ${rest[0] ?? ''}`) ?? findCommand(command)) : undefined;
  jsonOutput = (spec?.json ?? false) && wantsJson(values.json);
  // An edit made to config.toml outside polyphemus is pointed out (config commands handle it themselves).
  if (command !== 'config') {
    const drift = new ConfigHistory(polyphemus.home, polyphemus.store, 'polyphemus').drift();
    if (drift) console.error(yellow(`! config.toml was changed outside polyphemus since revision ${drift.rev}. See: poly config diff · keep it: poly config adopt · go back: poly config undo`));
  }
  if (command === 'config') return configCommand(polyphemus, rest, { dryRun: values['dry-run'] === true }, jsonOutput);
  if (command === 'secrets') return secretsCommand(polyphemus, rest, { note: values.note, kind: values.kind, reveal: values.reveal === true, last: values.last, machine: values.machine === true }, jsonOutput, readSecret);
  if (command === 'help') return help(rest);
  if (command === 'capabilities') return capabilities(polyphemus);
  if (command === 'login') {
    await login(polyphemus, rest[0], readSecret);
    return;
  }
  if (command === 'sessions') return sessionsCommand(polyphemus, rest, values);
  if (command === 'models') return modelsCommand(polyphemus, rest, { all: values.all === true, effort: values.effort });
  if (command === 'skills') return skillsCommand(polyphemus, rest, { project: values.project === true, from: values.from, agent: typeof values.agent === 'string' ? values.agent : undefined, replace: values.replace === true }, jsonOutput, cwd);
  if (command === 'agents') {
    return agentsCommand(polyphemus, rest, { project: values.project === true, model: values.model, from: values.from, mark: values.mark, blank: values.blank === true, title: values.title, description: values.description, fallback: values.fallback, persona: values.persona, instructions: values.instructions, dryRun: values['dry-run'] === true }, jsonOutput, cwd);
  }
  if (command === 'usage') return usageCommand(polyphemus);
  if (command === 'projects') return projectsCommand(polyphemus, rest, values, cwd);
  if (command === 'routine' || command === 'routines') return routineCommand(polyphemus, rest, values, daemonPort(), jsonOutput);
  if (command === 'serve') return serve(polyphemus, cwd);
  if (command === 'service') return service(rest[0], cwd, daemonPort(), { now: values.now === true });
  if (command === 'pair') return pairDevice(polyphemus, values.person);
  if (command === 'start') return startHere(polyphemus, cwd);
  if (command === 'doctor') return doctorCommand(polyphemus, { port: daemonPort(), version: VERSION, json: jsonOutput, answers, printJson });
  if (command === 'people') return peopleCommand(polyphemus, rest);
  if (command === 'devices') return devices(polyphemus, rest);
  if (command === 'loop') return loopCommand(polyphemus, rest, values, cwd);
  if (command === 'update') return updateCommand(polyphemus, values);
  if (command === 'rollback') return rollbackCommand(polyphemus, { restore: values.restore === true, now: values.now === true });
  if (command === 'intake') return intakeCommand(polyphemus, rest, values, cwd);
  if (command) {
    const words = [...new Set(COMMAND_SPECS.map((c) => c.usage.split(' ')[1] ?? '').filter((w) => /^[a-z]/.test(w)))];
    const guess = closest(command, words);
    jsonOutput = wantsJson(values.json); // an agent that mistyped a command still gets a JSON answer
    throw new PolyphemusError(`Unknown command "${command}".${guess ? ` Did you mean "${guess}"?` : ''}`, 'USAGE', 'poly help');
  }

  const toResume = values.resume ? polyphemus.store.resolve(values.resume) : values.continue ? polyphemus.store.latest(cwd) : undefined;
  if (values.resume && !toResume) throw new PolyphemusError(`No session matches "${values.resume}".`, 'NOT_FOUND', 'poly sessions');

  const printMode = values.print !== undefined;
  // -a puts an agent on the other side of this session: its persona and instructions, its skills,
  // and its model route. (The session records which agent it ran as; that's bookkeeping, not the
  // words we show people.)
  const agent = values.agent ? resolveAgent(polyphemus, values.agent, cwd) : undefined;
  const options = { cwd, agent, autoApprove: values.yes === true || values.yolo === true, alwaysAllow: polyphemus.config.permissions.allow };
  // -m wins; a resumed session keeps its model; otherwise the default, which is asked for once.
  const picked = values.model ? resolveModel(polyphemus.config, values.model) : undefined;
  // -m is held to your list like everything else; the turn would refuse it anyway, this says so first.
  const offTheList = picked && offList(polyphemus.config, picked);
  if (offTheList) throw new PolyphemusError(offTheList, 'USAGE');
  const modelForNew = async () => {
    const base = picked ?? (polyphemus.config.defaultModel ? resolveModel(polyphemus.config, polyphemus.config.defaultModel) : await chooseDefaultModel(polyphemus, printMode));
    return agent && !picked ? agentModel(polyphemus.config, agent, base) : base;
  };

  // With the daemon running, the terminal is one of its clients: the session runs there, and your
  // phone sees it live. -p and --local keep it in this process.
  const daemon = printMode || values.local ? undefined : await DaemonClient.connect(polyphemus.home, daemonPort());
  if (daemon) {
    const remote = toResume
      ? await RemoteSession.open(daemon, toResume, cwd)
      : new RemoteSession(daemon, cwd, { model: await modelForNew(), autoApprove: options.autoApprove, agent: agent?.name });
    if (toResume) {
      if (picked) await remote.switchModel(picked);
      if (options.autoApprove) remote.autoApprove = true;
      printResumed(remote);
    }
    return repl({ polyphemus, session: remote, cwd, daemon }, toResume !== undefined);
  }

  const session = toResume ? polyphemus.openSession(toResume, { ...options, model: picked }) : polyphemus.newSession({ ...options, model: await modelForNew() });

  if (printMode) {
    // stdout is just the reply, so scripts can use it; everything else goes to stderr.
    const renderer = new Renderer();
    session.on((event) => {
      if (event.type === 'notice') process.stderr.write(`${yellow(`! ${event.text}`)}\n`);
      else if (event.type === 'info') process.stderr.write(`${dim(event.text)}\n`);
      else if (event.type === 'artifact') process.stderr.write(`${dim(`Shown: ${event.artifact.title} (open the thread in the app to see it)`)}\n`);
      else if (event.type !== 'model' && event.type !== 'session') renderer.render(event);
    });
    const { text, images } = pickOutImages(values.print!, polyphemus.home);
    try {
      const stop = await session.send(text, undefined, images);
      process.exitCode = stop === 'end_turn' ? 0 : 1;
    } finally {
      // The session's gateway socket would keep this process running after the reply, and its worker
      // would outlive it: close both, so -p exits when the turn does.
      session.close();
      polyphemus.close();
    }
    return;
  }
  if (toResume) printResumed(session);
  await repl({ polyphemus, session, cwd }, toResume !== undefined);
}

/** `initial`, if given, is sent as the first message (e.g. an orientation prompt). */
async function repl(cli: Cli, resumed: boolean, initial?: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 500 });
  const renderer = new Renderer();
  let active: AbortController | null = null;

  let lastIdleInterrupt = 0;
  rl.on('SIGINT', () => {
    if (active) {
      active.abort();
      return;
    }
    // Like most REPLs: one Ctrl+C while idle clears the line, a second within 2s quits.
    if (Date.now() - lastIdleInterrupt < 2000) return rl.close();
    lastIdleInterrupt = Date.now();
    rl.write(null, { ctrl: true, name: 'e' });
    rl.write(null, { ctrl: true, name: 'u' });
    process.stdout.write(dim('\n(press Ctrl+C again to exit)\n'));
    rl.prompt();
  });
  rl.on('close', () => {
    cli.session.close();
    cli.daemon?.close();
    process.stdout.write('\n');
    process.exit(0);
  });

  const where = cli.daemon ? ' · in the daemon: your phone sees this session' : '';
  if (!resumed) console.log(`${bold('polyphemus')} ${dim(`· ${cli.session.model.label}${where} · /help for commands`)}`);
  // What the daemon last heard from npm, without asking again here.
  const update = knownUpdate(cli.polyphemus.home, { channel: cli.polyphemus.config.updates.channel });
  if (update.newer) console.log(yellow(`polyphemus ${update.latest} is out (you have ${update.current}): poly update`));

  // Questions a session needs a person for, answered here with prompts.
  const asker: Asker = {
    approve: async ({ tool, summary }, signal): Promise<ApprovalAnswer> => {
      renderer.endLine();
      const question = `${yellow('?')} Allow ${bold(tool)} ${oneLine(summary, 200)}  ${dim('[y]es / [n]o / [a]lways this exact one · /yolo stops asking')} `;
      const answer = (await rl.question(question, { signal })).trim().toLowerCase();
      return answer === 'a' || answer === 'always' ? 'always' : answer === 'y' || answer === 'yes' ? 'allow' : 'deny';
    },
    chooseFallback: async ({ candidates, retry }, signal) => {
      const [first] = candidates;
      if (!first) return undefined;
      renderer.endLine();
      const usage = (cli.polyphemus.capacity.get(first.provider) ?? []).map(formatUsage).join(', ');
      const options = candidates.length > 1 ? '[Y]es / [n]o / [p]ick another' : '[Y]es / [n]o';
      const question = `${yellow('?')} Switch to ${bold(describeModel(first))}${usage ? dim(` (${usage})`) : ''} and ${retry ? 'retry' : 'send'}? ${dim(options)} `;
      const answer = (await rl.question(question, { signal })).trim().toLowerCase();
      if (answer === '' || answer === 'y' || answer === 'yes') return first;
      if (answer === 'p' && candidates.length > 1) {
        return pick('Switch to', choiceItems(candidates.map((model) => ({ model, ready: true, note: 'ready' })), cli.polyphemus.capacity), 0);
      }
      return undefined;
    },
  };

  let detach = () => {};
  const attach = (session: ReplSession) => {
    detach();
    session.asker = asker;
    detach = session.on((event: RuntimeEvent) => {
      if (event.type === 'info') {
        renderer.endLine();
        renderer.write(`${dim(event.text)}\n`);
      } else if (event.type === 'artifact') {
        // The terminal can't draw a chart; the app can. Say where it is.
        renderer.endLine();
        renderer.write(`${dim(`Shown: ${event.artifact.title} — open this thread in the app to see it (${event.artifact.name})`)}\n`);
      } else if (event.type !== 'model' && event.type !== 'session') {
        renderer.render(event);
      }
    });
    cli.session = session;
  };
  attach(cli.session);

  let queued = initial;
  /** Images waiting for the next message (from /image). */
  let attachments: ImageBlock[] = [];
  for (;;) {
    let input = queued ?? '';
    queued = undefined;
    let images: ImageBlock[] = [];
    if (!input) {
      let line = await rl.question(`${cyan(cli.session.model.label)}${cli.session.autoApprove ? ` ${red('yolo')}` : ''} ${dim('›')} `);
      while (line.endsWith('\\')) line = `${line.slice(0, -1)}\n${await rl.question(dim('… '))}`;
      input = line.trim();
      if (!input) continue;
      if (BARE_COMMANDS.has(input.toLowerCase())) input = `/${input.toLowerCase()}`;

      if (input === '/image' || input.startsWith('/image ')) {
        try {
          const path = imagePathArg(input.slice('/image'.length));
          if (!path) throw new PolyphemusError('Usage: /image <path>');
          const image = attachImageFile(cli.polyphemus.home, path);
          attachments.push(image);
          console.log(dim(`Attached ${image.name}. It goes with your next message.`));
        } catch (err) {
          printError(err);
        }
        continue;
      }

      if (input.startsWith('/')) {
        try {
          await handleCommand(cli, input, rl, attach);
        } catch (err) {
          printError(err);
        }
        continue;
      }

      // An image path pasted or dragged into the message is attached rather than sent as text.
      try {
        const picked = pickOutImages(input, cli.polyphemus.home);
        if (picked.images.length > 0) console.log(dim(`Attached ${picked.images.map((image) => image.name).join(', ')}.`));
        input = picked.text;
        images = [...attachments, ...picked.images];
        attachments = [];
      } catch (err) {
        printError(err);
        continue;
      }
    }

    active = new AbortController();
    try {
      await cli.session.send(input, active.signal, images);
    } catch (err) {
      renderer.endLine();
      printError(err);
    } finally {
      active = null;
      // If anything reset the terminal's mode during the turn, take it back so keys keep working.
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
    }
  }
}

async function handleCommand(cli: Cli, input: string, rl: readline.Interface, attach: (session: ReplSession) => void): Promise<void> {
  const { polyphemus, session } = cli;
  const [name = '', ...args] = input.slice(1).split(/\s+/);
  const arg = args.join(' ');
  switch (name) {
    case 'help':
      return console.log(COMMANDS);
    case 'status': {
      const rows = await session.statusRows();
      const width = Math.max(...rows.map(([label]) => label.length));
      for (const [label, value] of rows) console.log(`  ${dim(label.padEnd(width))}  ${value}`);
      return;
    }
    case 'exit':
    case 'quit':
      return rl.close();
    case 'model': {
      if (arg) return await session.switchModel(resolveModel(polyphemus.config, arg));
      const choices = await modelChoices(polyphemus.config, polyphemus.registry, polyphemus.credentials);
      if (!process.stdin.isTTY) return printModels(choices, polyphemus.capacity, session.model);
      const current = Math.max(0, choices.findIndex((c) => targetOf(c.model) === targetOf(session.model)));
      const picked = await pick('Switch model', choiceItems(choices, polyphemus.capacity, session.model), current);
      return picked ? await session.switchModel(picked) : undefined;
    }
    case 'default': {
      let model: ResolvedModel | undefined;
      if (arg) model = resolveModel(polyphemus.config, arg);
      else {
        const choices = await modelChoices(polyphemus.config, polyphemus.registry, polyphemus.credentials);
        const current = polyphemus.config.defaultModel ? resolveModel(polyphemus.config, polyphemus.config.defaultModel) : undefined;
        const at = Math.max(0, choices.findIndex((c) => current !== undefined && targetOf(c.model) === targetOf(current)));
        model = await pick('Default model for new sessions', choiceItems(choices, polyphemus.capacity, current), at);
      }
      if (!model) return;
      polyphemus.rememberDefault(model);
      return console.log(dim(`New sessions will start with ${describeModel(model)}.`));
    }
    case 'models': {
      const providerId = arg || session.model.provider;
      const ids = (await polyphemus.registry.get(providerId).listModels()).sort();
      return console.log(ids.map((id) => `  ${providerId}:${id}`).join('\n') || dim('(none)'));
    }
    case 'yolo':
      session.autoApprove = !session.autoApprove;
      return console.log(
        session.autoApprove
          ? yellow('YOLO on: every command runs without asking, for this session only. Type /yolo again to turn it off.')
          : dim('YOLO off: polyphemus asks before commands that change things again. Read-only commands never ask.'),
      );
    case 'login': {
      if (await login(polyphemus, arg || undefined, readHidden)) polyphemus.registry.forget(arg);
      return;
    }
    case 'effort': {
      if (!arg) return console.log(`Effort: ${session.effort ?? 'default'}`);
      if (arg === 'default') session.effort = undefined;
      else if (EFFORTS.includes(arg as Effort)) session.effort = arg as Effort;
      else throw new PolyphemusError(`Effort must be one of: ${EFFORTS.join(', ')}, default`);
      return console.log(dim(`Effort set to ${session.effort ?? 'default'}.`));
    }
    case 'new': {
      const next = cli.daemon
        ? new RemoteSession(cli.daemon, cli.cwd, { model: session.model, autoApprove: session.autoApprove })
        : polyphemus.newSession({ cwd: cli.cwd, model: session.model, autoApprove: session.autoApprove, alwaysAllow: session.alwaysAllow });
      session.close();
      attach(next);
      return console.log(dim('New session.'));
    }
    case 'sessions':
      return printSessions(polyphemus.store.list(20));
    case 'resume': {
      if (!arg) throw new PolyphemusError('Usage: /resume <id>');
      const meta = polyphemus.store.resolve(arg);
      if (!meta) throw new PolyphemusError(`No session matches "${arg}".`);
      const next = cli.daemon
        ? await RemoteSession.open(cli.daemon, meta, cli.cwd)
        : polyphemus.openSession(meta, { cwd: cli.cwd, autoApprove: session.autoApprove, alwaysAllow: session.alwaysAllow });
      session.close();
      attach(next);
      return printResumed(next);
    }
    case 'title':
      if (!session.meta) throw new PolyphemusError('Nothing to rename yet: send a message first.');
      if (!arg) throw new PolyphemusError('Usage: /title <text>');
      await session.rename(arg);
      return console.log(dim('Renamed.'));
    default: {
      const guess = closest(name, COMMAND_NAMES);
      throw new PolyphemusError(`Unknown command /${name}.${guess ? ` Did you mean /${guess}?` : ''} Try /help.`);
    }
  }
}

const daemonPort = () => Number(envSetting('PORT') ?? DEFAULT_PORT);

/** Runs the daemon in the foreground: this computer and your tailnet only, never the open network. */
async function serve(polyphemus: Polyphemus, cwd: string): Promise<void> {
  const port = daemonPort();
  const time = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const log = (line: string) => console.log(dim(`[${time()}] ${line}`));
  // POLYPHEMUS_TAILSCALE=off: this computer only — for a test or throwaway daemon, which must never take
  // over the tailnet address the real one is using.
  const useTailscale = envSetting('TAILSCALE') !== 'off';
  const tailscale = useTailscale ? await detectTailscale() : undefined;
  let httpsUrl = tailscale ? await secureAddress(port, log) : undefined;
  const push = webPushSender(polyphemus.home, () => httpsUrl ?? 'https://localhost');
  // The tailnet address only where it's this machine's: inside WSL it's Windows's, and the way in is
  // Tailscale's HTTPS on Windows, which reaches here through WSL's localhost forwarding.
  const hosts = ['127.0.0.1', ...(tailscale?.local ? [tailscale.ip] : [])];
  const phoneAt = (t: typeof tailscale) => httpsUrl ?? (t?.local ? `http://${t.dnsName ?? t.ip}:${port}` : undefined);
  const daemon = await startDaemon({ polyphemus, hosts, port, cwd, log, push, httpsUrl });
  console.log(`${bold('polyphemus daemon')} ${dim(`listening on ${daemon.urls.join(', ')}`)}`);
  const phone = phoneAt(tailscale);
  if (phone) console.log(`Phone: ${cyan(phone)} ${dim('(reachable only on your tailnet)')}`);
  else if (tailscale) console.log(yellow('Tailscale is on, on Windows, but its HTTPS address couldn’t be pointed here, so phones can’t reach polyphemus yet.'));
  else console.log(yellow('Tailscale isn’t running yet, so only this computer can connect. polyphemus picks it up when it starts.'));
  const paired = polyphemus.store.listDevices().filter((d) => !d.revokedAt).length;
  console.log(dim(paired > 0 ? `${paired} paired device${paired === 1 ? '' : 's'}. Pair another: poly pair` : 'No devices paired yet. In another terminal: poly pair'));
  if (process.stdout.isTTY) console.log(dim('Ctrl+C to stop.'));
  if (polyphemus.keptOnThisComputer) log('Agents keep running on this computer, as before. Isolated is now the default for new installs: choose it in Setup, Where agents run.');
  // The worker image is built now, in the background, rather than during someone's first isolated turn.
  const runtime = polyphemus.runtime();
  if (runtime) void ensureWorkerImage(runtime).catch((err: unknown) => log(`The worker image couldn’t be built yet: ${(err as Error).message}`));

  // Tailscale can come up after polyphemus does (at boot, or after signing in): keep looking, and listen there once it's up.
  let bound = tailscale?.ip;
  let routeLost = false;
  const watch = setInterval(() => {
    void (async () => {
      // Something else (another project's app, say) can take over the HTTPS address. Say so, loudly,
      // but don't take it back: the other route might be intentional.
      if (httpsUrl) {
        const route = await detectHttps(port);
        if (!route && !routeLost) {
          routeLost = true;
          log(`Tailscale's HTTPS route for ${httpsUrl} no longer points at polyphemus. Take it back: poly service restart (or move the other app to another port).`);
          daemon.alert('polyphemus lost its address', `Something replaced the route for ${httpsUrl}, so phones can’t reach polyphemus there. On the computer: poly service restart, or move the other app to another port.`);
        } else if (route && routeLost) {
          routeLost = false;
          log(`The HTTPS route points at polyphemus again: ${route}`);
        }
      }
      const now = useTailscale ? await detectTailscale() : undefined;
      if (!now || now.ip === bound) return;
      if (now.local) await daemon.listen(now.ip);
      bound = now.ip;
      httpsUrl = await secureAddress(port, log);
      daemon.setHttpsUrl(httpsUrl);
      const reach = phoneAt(now);
      log(reach ? `Tailscale is up: phones can reach ${reach}` : 'Tailscale is up on Windows, but its HTTPS address couldn’t be pointed here, so phones can’t reach polyphemus yet.');
    })().catch((err: unknown) => log(`Couldn’t listen on Tailscale: ${(err as Error).message}`));
  }, 30_000);

  await new Promise<void>((resolve) => {
    // A second Ctrl+C while it's closing still ends it at once, as a person pressing it again means.
    process.once('SIGINT', () => resolve());
    // A service manager's stop arrives twice — to every process in the service, then again from the
    // launcher — and the second used to kill the daemon halfway through closing (2026-09-22).
    process.on('SIGTERM', () => resolve());
  });
  clearInterval(watch);
  console.log('\nStopping…');
  await daemon.close();
  polyphemus.close();
  console.log('Stopped.');
}

/**
 * Tailscale's HTTPS address for the daemon (tailnet only, never the internet),
 * turned on if it isn't yet. Phones need HTTPS for notifications.
 */
async function secureAddress(port: number, log: (line: string) => void): Promise<string | undefined> {
  const existing = await detectHttps(port);
  if (existing) return existing;
  // The address already serves something else that's running — another polyphemus, another app: leave it.
  // A route to a port where nothing answers any more is stale, and polyphemus takes it.
  const other = await httpsRootPort();
  if (other !== undefined && other !== port && (await answers(other))) {
    log(`Tailscale’s HTTPS address already serves something on port ${other}, so polyphemus left it alone. Phones can reach this daemon at its tailnet address instead; to move the HTTPS address here, stop that app and restart polyphemus.`);
    return undefined;
  }
  const problem = await enableHttps(port);
  if (problem === 'permission' && tailscaleOnWindows()) log('Phones reach polyphemus through Tailscale’s HTTPS on Windows, and Tailscale wouldn’t let polyphemus set it up. In PowerShell on Windows, run once: tailscale serve --bg --https=443 http://127.0.0.1:' + port);
  else if (problem === 'permission') log('Notifications need HTTPS through Tailscale, and Tailscale won’t let polyphemus set it up. Run once, then restart polyphemus: sudo tailscale set --operator=$USER');
  else if (problem) log(`Couldn’t turn on HTTPS through Tailscale (needed for notifications): ${problem}`);
  return problem ? undefined : detectHttps(port);
}

/** Whether something is listening on a local port. */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1500, () => (socket.destroy(), resolve(false)));
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

/**
 * A fresh install, straight to the setup wizard: the daemon running, this computer paired, and the
 * app open on it. The wizard is where models, an agent and isolation are chosen, and it used to sit
 * behind starting the daemon, pairing by hand and reading a code off the terminal — so nobody new
 * reached it (2026-09-22). Tailscale and a phone are a later step: this is 127.0.0.1 only.
 */
async function startHere(polyphemus: Polyphemus, cwd: string): Promise<void> {
  const port = daemonPort();
  if (!(await answers(port))) {
    console.log('Starting polyphemus in the background…');
    await service('install', cwd, port, {});
    for (let i = 0; i < 100 && !(await answers(port)); i++) await new Promise((r) => setTimeout(r, 100));
  }
  if (!(await answers(port))) throw new PolyphemusError(`polyphemus isn’t answering on port ${port}. Start it with \`poly serve\` and run this again.`, 'FAILED', 'poly service logs');
  const url = `http://127.0.0.1:${port}/pair?code=${polyphemus.store.createPairingCode()}`;
  console.log(`${bold('Open polyphemus:')} ${url}`);
  console.log(dim('This computer only, and the link works once. Add your phone later with: poly pair'));
  // Best effort: a machine with no desktop (a server over ssh) still has the address above.
  if (inWsl()) {
    // Windows's own browser, which reaches 127.0.0.1 here through WSL's localhost forwarding. Asked
    // through PowerShell's Start-Process, the way the widely used `open` package does it from WSL:
    // explorer.exe, tried first, opened nothing on the first Windows computer (2026-09-23). Started
    // from a Windows folder, since Windows programs balk at a Linux one as where they start.
    console.log(dim('Opening it in Windows’s browser…'));
    const windowsFolder = folderExists('/mnt/c') ? '/mnt/c' : undefined;
    const opened = (await openWith('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`], windowsFolder)) || (await openWith('explorer.exe', [url], windowsFolder));
    if (!opened) console.log(yellow('Couldn’t open Windows’s browser from here. Open the link above in it yourself.'));
  } else if (process.platform === 'darwin' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    await openWith(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  }
}

/** Runs an opener and waits for it, briefly: whether it started and exited cleanly. */
function openWith(command: string, args: string[], cwd?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', ...(cwd && { cwd }) });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 10_000).unref();
  });
}

async function pairDevice(polyphemus: Polyphemus, personRef?: string): Promise<void> {
  const person = personRef ? polyphemus.store.resolvePerson(personRef) : undefined;
  if (personRef && !person) throw new PolyphemusError(`No one here matches "${personRef}".`, 'NOT_FOUND', 'poly people');
  // The same switch serve obeys: a throwaway install mustn't hand out the tailnet address another daemon owns.
  const tailscale = envSetting('TAILSCALE') !== 'off' ? await detectTailscale() : undefined;
  const host = tailscale?.dnsName ?? tailscale?.ip ?? '127.0.0.1';
  const base = (tailscale && (await detectHttps(daemonPort()))) || `http://${host}:${daemonPort()}`;
  const code = polyphemus.store.createPairingCode(undefined, person?.id);
  if (person && !person.owner) console.log(`This pairs a device as ${bold(person.name)}. It sees only the projects ${person.name} belongs to.`);
  const url = `${base}/pair?code=${code}`;
  console.log(`In the polyphemus app, type this code: ${bold(code)}`);
  console.log(dim(`Or scan the QR code with your phone's camera. Either works once, for the next 10 minutes.\n`));
  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  console.log(`${dim('Or open:')} ${url}`);
  console.log(dim('Your phone needs Tailscale on, and the daemon must be running (poly serve).'));
  if (!tailscale) console.log(yellow(envSetting('TAILSCALE') === 'off' ? 'Tailscale is off for this install (POLYPHEMUS_TAILSCALE=off), so this link only works on this computer.' : 'Tailscale isn’t running here, so this link only works on this computer.'));
}

async function projectsCommand(
  polyphemus: Polyphemus,
  args: string[],
  flags: { from?: string; about?: string; name?: string; model?: string; git?: boolean; role?: string },
  cwd: string,
): Promise<void> {
  const [action, target] = args;
  switch (action) {
    case undefined:
    case 'list':
      return printProjects(polyphemus);
    case 'rename': {
      const name = args.slice(2).join(' ').trim();
      if (!target || !name) throw new PolyphemusError('Usage: poly projects rename <project> <name>', 'USAGE');
      if (name.length > 80) throw new PolyphemusError('Keep the name under 80 characters.', 'USAGE');
      const renamed = polyphemus.store.renameProject(target, name);
      if (!renamed) throw new PolyphemusError(`No project called "${target}".`, 'NOT_FOUND', 'poly projects');
      return jsonOutput ? printJson({ slug: renamed.slug, name: renamed.name }) : console.log(`${green('✓')} ${renamed.slug} is now called ${renamed.name}.`);
    }
    case 'move': {
      // You move the files yourself (they're yours); this tells polyphemus where they went.
      const folder = args[2];
      if (!target || !folder) throw new PolyphemusError('Usage: poly projects move <project> <folder>', 'USAGE');
      const to = resolvePath(expandHome(folder));
      if (!folderExists(to)) throw new PolyphemusError(`There's no folder at ${to}. Move the files first, then tell polyphemus where they went.`, 'NOT_FOUND');
      const moved = polyphemus.store.moveProject(target, to);
      if (!moved) throw new PolyphemusError(`No project called "${target}".`, 'NOT_FOUND', 'poly projects');
      if (jsonOutput) return printJson({ slug: target, from: moved.from, to, sessions: moved.sessions });
      console.log(`${green('✓')} ${target} is now at ${to}.${moved.sessions > 0 ? ` ${moved.sessions} past ${moved.sessions === 1 ? 'session' : 'sessions'} updated.` : ''}`);
      if (to !== moved.from) console.log(dim('If this is the polyphemus checkout itself, run poly service install from the new folder so the service follows it.'));
      return;
    }
    case 'orient': {
      const project = findProject(polyphemus, target ?? cwd);
      const model = flags.model
        ? resolveModel(polyphemus.config, flags.model)
        : polyphemus.config.defaultModel
          ? resolveModel(polyphemus.config, polyphemus.config.defaultModel)
          : await chooseDefaultModel(polyphemus, false);
      const session = polyphemus.newSession({ cwd: project.path, model, alwaysAllow: polyphemus.config.permissions.allow });
      console.log(dim(`Orienting ${project.name}: the agent reads what's there and drafts AGENTS.md and notes for you to review (poly projects review). Nothing in the project folder changes.`));
      return repl({ polyphemus, session, cwd: project.path }, false, orientationPrompt(polyphemus.home, project));
    }
    case 'review':
      return reviewInbox(polyphemus, findProject(polyphemus, target ?? cwd));
    case 'new': {
      if (!target) throw new PolyphemusError('Usage: poly projects new <name> [--about "…"] [--from <git-url>] [--git]');
      const setup = await createProject(polyphemus.store, polyphemus.home, polyphemus.config.projectsRoot, { name: target, about: flags.about, from: flags.from, git: flags.git });
      return printSetup(setup, flags.from ? 'Cloned' : 'Created');
    }
    case 'add':
      return printSetup(addProject(polyphemus.store, polyphemus.home, target ?? cwd, { name: flags.name, about: flags.about }), 'Added');
    case 'park':
    case 'archive':
    case 'activate': {
      if (!target) throw new PolyphemusError(`Usage: poly projects ${action} <project>`, 'USAGE');
      const status = action === 'activate' ? 'active' : action === 'park' ? 'parked' : 'archived';
      if (!polyphemus.store.setProjectStatus(target, status)) throw new PolyphemusError(`No project called "${target}".`, 'NOT_FOUND', 'poly projects');
      return jsonOutput ? printJson({ project: target, status }) : console.log(`${target} is now ${status}.`);
    }
    case 'share':
    case 'unshare': {
      const who = args[2];
      if (!target || !who) throw new PolyphemusError(`Usage: poly projects ${action} <project> <person>${action === 'share' ? ' [--role member|viewer]' : ''}`, 'USAGE');
      const project = polyphemus.store.project(target);
      if (!project) throw new PolyphemusError(`No project called "${target}".`, 'NOT_FOUND', 'poly projects');
      const person = polyphemus.store.resolvePerson(who);
      if (!person) throw new PolyphemusError(`No one here matches "${who}".`, 'NOT_FOUND', 'poly people');
      if (person.owner) throw new PolyphemusError(`${person.name} owns this install and already sees every project.`, 'USAGE');
      const role = action === 'unshare' ? null : ((flags.role ?? 'member') as ProjectRole);
      if (role !== null && !PROJECT_ROLES.includes(role)) throw new PolyphemusError('A role is member or viewer.', 'USAGE');
      polyphemus.store.setProjectRole(project.slug, person.id, role, Date.now(), `person:${polyphemus.store.installOwner().id}`);
      if (jsonOutput) return printJson({ project: project.slug, person: person.id, role });
      return console.log(
        role === null ? `${green('✓')} ${person.name} no longer belongs to ${project.name}.`
        : `${green('✓')} ${person.name} is a ${role} of ${project.name}${role === 'viewer' ? ': they can read, but can’t send, start or approve anything' : ': they can work, message and approve here'}.`,
      );
    }
    default:
      throw new PolyphemusError(`Unknown projects command "${action}". Try: new, add, rename, move, park, archive, activate, share, unshare.`);
  }
}

function printProjects(polyphemus: Polyphemus): void {
  const all = polyphemus.store.projects();
  if (jsonOutput) {
    return printJson({
      projects: all.map((p) => ({
        slug: p.slug,
        name: p.name,
        path: p.path,
        status: p.status,
        description: p.description,
        needsOrientation: needsOrientation(p),
        inbox: inboxItems(polyphemus.home, p).length,
        createdAt: iso(p.createdAt),
      })),
    });
  }
  if (all.length === 0) return console.log(dim('No projects yet. Start one: poly projects new <name>. Or add a folder: poly projects add <folder>'));
  for (const p of all) {
    const status = p.status === 'active' ? '' : `${yellow(p.status)} `;
    const waiting = inboxItems(polyphemus.home, p).length;
    const todo = [needsOrientation(p) ? 'needs setup (poly projects orient)' : '', waiting ? `${waiting} to review` : ''].filter(Boolean).join(', ');
    console.log(`${cyan(p.slug.padEnd(18))} ${status}${tildify(p.path)}${p.description ? dim(` · ${oneLine(p.description, 60)}`) : ''}${todo ? ` ${yellow(todo)}` : ''}`);
  }
}

/** A project by slug, or the one containing a folder. */
function findProject(polyphemus: Polyphemus, ref: string): ProjectMeta {
  const project = polyphemus.store.project(ref) ?? polyphemus.store.projectFor(resolvePath(expandHome(ref)));
  if (!project) throw new PolyphemusError(`No project matches "${ref}".`, 'NOT_FOUND', 'poly projects');
  return project;
}

/** Goes through what agents proposed: keep it (it takes effect) or discard it. */
async function reviewInbox(polyphemus: Polyphemus, project: ProjectMeta): Promise<void> {
  const items = inboxItems(polyphemus.home, project);
  if (items.length === 0) return console.log(dim(`Nothing waiting for ${project.name}.`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const item of items) {
      console.log(`\n${bold(item.kind === 'rules' ? 'AGENTS.md: replaces the project’s rules' : `Note: ${item.name}`)}\n`);
      console.log(item.content.trimEnd());
      const answer = (await rl.question(`\n${yellow('?')} ${item.kind === 'rules' ? 'Use it' : 'Keep it'}? ${dim('[y]es / [n]o, discard / [s]kip')} `)).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') console.log(green(`✓ Saved to ${tildify(resolveInboxItem(polyphemus.home, project, item.name, 'accept')!)}`));
      else if (answer === 'n' || answer === 'no') {
        resolveInboxItem(polyphemus.home, project, item.name, 'discard');
        console.log(dim('Discarded.'));
      } else console.log(dim('Skipped: it stays for later.'));
    }
  } finally {
    rl.close();
  }
}

function printSetup({ project, created }: ProjectSetup, verb: string): void {
  if (jsonOutput) return printJson({ project: { ...project, createdAt: iso(project.createdAt) }, created });
  console.log(`${green('✓')} ${verb} ${bold(project.name)} ${dim(`(${project.slug})`)} at ${tildify(project.path)}`);
  for (const file of created) console.log(dim(`  + ${tildify(file)}`));
  console.log(dim(`Work in it: cd ${tildify(project.path)} && polyphemus, or pick it in the app.`));
}

const tildify = (path: string) => (path === homedir() || path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

/** Who uses this install: the owner, and anyone given a role in a project. */
function peopleCommand(polyphemus: Polyphemus, args: string[]): void {
  const [action, ...rest] = args;
  if (action === 'add') {
    const name = rest.join(' ').trim();
    if (!name) throw new PolyphemusError('Usage: poly people add <name>', 'USAGE');
    const person = polyphemus.store.addPerson(name);
    if (jsonOutput) return printJson({ person });
    console.log(`${green('✓')} Added ${bold(name)} (${cyan(person.id)}). They can’t see anything until they belong to a project:`);
    console.log(dim(`  poly projects share <project> ${person.id} --role member   (or viewer)`));
    console.log(dim(`  poly pair --person ${person.id}                              (pair their phone)`));
    return;
  }
  if (action === 'remove') {
    const person = rest[0] ? polyphemus.store.resolvePerson(rest[0]) : undefined;
    if (!person) throw new PolyphemusError(rest[0] ? `No one here matches "${rest[0]}".` : 'Usage: poly people remove <person>', rest[0] ? 'NOT_FOUND' : 'USAGE', 'poly people');
    if (person.owner) throw new PolyphemusError('The install owner can’t be removed: it’s whose computer this is.', 'USAGE');
    polyphemus.store.removePerson(person.id);
    return jsonOutput ? printJson({ removed: person.id }) : console.log(`${green('✓')} ${person.name} is removed: their devices are cut off and their project roles are gone. What they did stays attributed to them.`);
  }
  if (action === 'rename') {
    const [ref, ...name] = rest;
    const person = ref ? polyphemus.store.resolvePerson(ref) : undefined;
    if (!person || !name.join(' ').trim()) throw new PolyphemusError('Usage: poly people rename <person> <name>', person || !ref ? 'USAGE' : 'NOT_FOUND', 'poly people');
    polyphemus.store.renamePerson(person.id, name.join(' ').trim());
    return jsonOutput ? printJson({ id: person.id, name: name.join(' ').trim() }) : console.log(`${green('✓')} ${person.name} is now ${name.join(' ').trim()}.`);
  }
  if (action) throw new PolyphemusError(`Unknown people command "${action}". Try: add, rename, remove.`, 'USAGE', 'poly help people');
  const people = polyphemus.store.people();
  const devicesByPerson = (id: string) => polyphemus.store.listDevices().filter((d) => !d.revokedAt && (d.personId ?? polyphemus.store.installOwner().id) === id).length;
  if (jsonOutput) {
    return printJson({
      people: people.map((p) => ({ id: p.id, name: p.name, owner: p.owner, devices: devicesByPerson(p.id), projects: Object.fromEntries(polyphemus.store.projectRoles(p.id)) })),
    });
  }
  for (const p of people) {
    const roles = [...polyphemus.store.projectRoles(p.id)].map(([slug, role]) => `${slug} (${role})`).join(', ');
    const where = p.owner ? 'owns this install · sees every project' : roles || 'no projects yet';
    console.log(`${cyan(p.id)}  ${p.name.padEnd(16)} ${dim(where)}  ${dim(`${devicesByPerson(p.id)} device${devicesByPerson(p.id) === 1 ? '' : 's'}`)}`);
  }
  if (people.length === 1) console.log(dim('\nJust you. Add someone: poly people add <name>'));
}

function devices(polyphemus: Polyphemus, args: string[]): void {
  if (args[0] === 'revoke') {
    if (!args[1]) throw new PolyphemusError('Usage: poly devices revoke <id>', 'USAGE');
    if (!polyphemus.store.revokeDevice(args[1])) throw new PolyphemusError(`No active device matches "${args[1]}".`, 'NOT_FOUND', 'poly devices');
    return jsonOutput ? printJson({ revoked: args[1] }) : console.log('Revoked. That device can’t connect anymore.');
  }
  const all = polyphemus.store.listDevices();
  if (jsonOutput) {
    return printJson({
      devices: all.map((d) => ({ id: d.id, name: d.name, createdAt: iso(d.createdAt), lastSeenAt: iso(d.lastSeenAt), revokedAt: iso(d.revokedAt) })),
    });
  }
  if (all.length === 0) return console.log(dim('No paired devices. Pair one with: poly pair'));
  for (const d of all) {
    const status = d.revokedAt ? red('revoked') : d.lastSeenAt ? `last seen ${ago(d.lastSeenAt)}` : 'never connected';
    console.log(`${cyan(d.id)}  ${d.name.padEnd(16)} ${dim(`paired ${ago(d.createdAt)}`)}  ${status}`);
  }
}

/** First run: nothing is assumed. Ask which model new sessions should use, and save the answer. */
async function chooseDefaultModel(polyphemus: Polyphemus, printMode: boolean): Promise<ResolvedModel> {
  if (printMode || !process.stdin.isTTY) {
    throw new PolyphemusError('No default model yet. Pass -m <model> (see `poly models`), or run `polyphemus` in a terminal once to pick one.');
  }
  console.log(`${bold('Welcome to polyphemus.')} Pick the model new sessions start with. Change it any time with /default, or per session with -m.`);
  const choices = await modelChoices(polyphemus.config, polyphemus.registry, polyphemus.credentials);
  const model = await pick('Default model', choiceItems(choices, new Map()), Math.max(0, choices.findIndex((c) => c.ready)));
  if (!model) throw new PolyphemusError('No model picked. Run `polyphemus` again to choose, or pass -m <model>.');
  polyphemus.rememberDefault(model);
  console.log(dim(`Saved ${describeModel(model)} as your default (${configFile(polyphemus.home)}).`));
  return model;
}

/** The option within two edits of `word`, if any ("sessoins" → "sessions"). */
function closest(word: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const option of options) {
    const distance = editDistance(word.toLowerCase(), option);
    if (distance < bestDistance) {
      best = option;
      bestDistance = distance;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

function printResumed(session: ReplSession): void {
  if (!session.meta) return;
  console.log(`${bold('Resumed')} ${session.meta.title || '(untitled)'} ${dim(`· ${session.meta.id} · ${session.history.length} messages · ${session.model.label}`)}`);
  const lastReply = session.history.findLast((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text'));
  const text = lastReply?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  if (text) console.log(dim(`  last reply: ${oneLine(text, 160)}`));
}

// ── Commands that answer agents too (JSON with --json or when piped) ─────

function help(args: string[]): void {
  if (args.length === 0) return jsonOutput ? printJson({ commands: COMMAND_SPECS }) : console.log(USAGE);
  const command = findCommand(args.join(' '));
  if (!command) {
    // A group (config, routine…): its commands, rather than "no command" for a word every one starts with.
    const group = args.join('.').replace(/\s+/g, '.');
    const members = COMMAND_SPECS.filter((c) => c.id.startsWith(`${group}.`));
    if (!members.length) throw new PolyphemusError(`No command "${args.join(' ')}".`, 'NOT_FOUND', 'poly help');
    if (jsonOutput) return printJson({ commands: members });
    return console.log(members.map((c) => `${c.usage}\n  ${c.summary}`).join('\n\n'));
  }
  if (jsonOutput) return printJson(command);
  const examples = command.examples.map((example) => `  ${example}`).join('\n');
  console.log(`${command.usage}\n  ${command.summary}\n\nExamples:\n${examples}${command.json ? '\n\nPrints JSON with --json (and when piped).' : ''}`);
}

/** Everything an agent needs to use polyphemus correctly, in one call. Always JSON. */
async function capabilities(polyphemus: Polyphemus): Promise<void> {
  const choices = await modelChoices(polyphemus.config, polyphemus.registry, polyphemus.credentials);
  printJson({
    name: 'polyphemus',
    version: VERSION,
    about: 'A multi-provider agent harness: one agent loop over Claude, OpenAI, and Grok (their APIs, and the vendors’ own CLIs on your subscriptions), with sessions, projects, and a phone app.',
    output:
      'Commands with json: true print {ok, schemaVersion, data, warnings, error?} with --json, or when stdout is not a terminal. Exit codes: 0 ok, 1 failed, 2 usage, 3 not found, 6 conflict. Commands with effects "interactive" need a person at a terminal: don’t run them from an agent.',
    commands: COMMAND_SPECS.map(({ id, usage, summary, effects, json }) => ({ id, usage, summary, effects, json })),
    defaultModel: polyphemus.config.defaultModel ?? null,
    models: choices.map(({ model, ready, note }) => ({ label: model.label, target: `${model.provider}:${model.model}`, ready, note })),
    projects: polyphemus.store.projects().map(({ slug, name, path, status }) => ({ slug, name, path, status })),
    paths: { home: polyphemus.home, config: configFile(polyphemus.home), sessions: join(polyphemus.home, 'sessions.db'), memory: join(polyphemus.home, 'memory') },
  });
}

async function sessionsCommand(polyphemus: Polyphemus, args: string[], flags: { last?: string; archived?: boolean }): Promise<void> {
  if (args[0] === 'show') {
    if (!args[1]) throw new PolyphemusError('Which session? poly sessions show <id>', 'USAGE', 'poly sessions');
    const meta = polyphemus.store.resolve(args[1]);
    if (!meta) throw new PolyphemusError(`No session matches "${args[1]}".`, 'NOT_FOUND', 'poly sessions');
    const last = flags.last === undefined ? undefined : Number(flags.last);
    if (last !== undefined && !(Number.isInteger(last) && last > 0)) throw new PolyphemusError('--last takes a positive whole number, like --last 10.', 'USAGE');
    const view = transcriptView(meta, polyphemus.store.messages(meta.id), polyphemus.store.projectFor(meta.cwd), last);
    return jsonOutput ? printJson(view.json) : console.log(view.text);
  }
  if (args[0] === 'search') {
    const words = args.slice(1).join(' ').trim();
    if (!words) throw new PolyphemusError('Search for what? poly sessions search <words>', 'USAGE');
    const matches = polyphemus.store.search(words, 30);
    if (jsonOutput) {
      return printJson({
        sessions: matches.map(({ meta: s, snippet }) => ({ id: s.id, title: s.title, snippet: snippet ?? null, archived: s.archivedAt !== undefined, project: polyphemus.store.projectFor(s.cwd)?.slug ?? null, updatedAt: iso(s.updatedAt) })),
      });
    }
    if (matches.length === 0) return console.log(dim(`Nothing mentions “${words}”.`));
    for (const { meta, snippet } of matches) {
      printSessions([meta]);
      if (snippet) console.log(`          ${dim(oneLine(snippet, 110))}`);
    }
    return;
  }
  if (args[0] === 'rename' || args[0] === 'archive' || args[0] === 'unarchive' || args[0] === 'delete') {
    return changeSession(polyphemus, args[0], args[1], args.slice(2).join(' ').trim());
  }
  if (args[0]) throw new PolyphemusError(`Unknown sessions command "${args[0]}".`, 'USAGE', 'poly help sessions show');
  const sessions = polyphemus.store.list(30, { archived: flags.archived === true });
  if (!jsonOutput) return sessions.length === 0 && flags.archived ? console.log(dim('Nothing archived.')) : printSessions(sessions);
  printJson({
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      provider: s.provider,
      model: s.model,
      cwd: s.cwd,
      project: polyphemus.store.projectFor(s.cwd)?.slug ?? null,
      createdAt: iso(s.createdAt),
      updatedAt: iso(s.updatedAt),
    })),
  });
}

/**
 * Rename, archive, or delete a session. With the daemon up, the change goes through it: it may be
 * holding that session open, and deleting one underneath it would leave it writing to nothing.
 */
async function changeSession(polyphemus: Polyphemus, action: 'rename' | 'archive' | 'unarchive' | 'delete', ref: string | undefined, title: string): Promise<void> {
  if (!ref) throw new PolyphemusError(`Which session? poly sessions ${action} <id>`, 'USAGE', 'poly sessions');
  const meta = polyphemus.store.resolve(ref);
  if (!meta) throw new PolyphemusError(`No session matches "${ref}".`, 'NOT_FOUND', 'poly sessions');
  if (action === 'rename' && !title) throw new PolyphemusError('Rename it to what? poly sessions rename <id> <title>', 'USAGE');
  const name = `“${oneLine(action === 'rename' ? meta.title || '(untitled)' : meta.title || meta.id, 60)}”`;
  const daemon = await DaemonClient.connect(polyphemus.home, daemonPort());
  try {
    if (daemon) {
      const path = `/api/sessions/${meta.id}`;
      if (action === 'rename') await daemon.request('POST', `${path}/title`, { text: title });
      else if (action === 'delete') await daemon.request('POST', `${path}/delete`);
      else await daemon.request('POST', `${path}/archive`, { on: action === 'archive' });
    } else if (action === 'rename') polyphemus.store.setTitle(meta.id, title);
    else if (action === 'delete') polyphemus.store.delete(meta.id);
    else polyphemus.store.setArchived(meta.id, action === 'archive');
  } finally {
    daemon?.close();
  }
  if (jsonOutput) return printJson({ id: meta.id, action, ...(action === 'rename' && { title }) });
  const said = {
    rename: `Renamed ${name} to “${title}”.`,
    archive: `Archived ${name}. It’s off the lists, still in search, and back as soon as you send it something.`,
    unarchive: `${name} is back on the lists.`,
    delete: `Deleted ${name} and its conversation.`,
  }[action];
  console.log(green(`✓ ${said}`));
}

/**
 * `poly loop "<goal>" --until "<command>"`: the loop workflow, started in this folder's project. It
 * runs in the daemon — a fresh session each round, the command deciding when it's done — so it keeps
 * going after this terminal closes, and the app shows every round.
 */
async function loopCommand(polyphemus: Polyphemus, words: string[], values: { until?: string; max?: string; agent?: string; yes?: boolean; yolo?: boolean }, cwd: string): Promise<void> {
  const goal = words.join(' ').trim();
  if (!goal || !values.until) throw new PolyphemusError('Say the goal and the command that proves it: poly loop "make the e2e suite pass" --until "pnpm e2e"', 'USAGE', 'poly help loop');
  const project = polyphemus.store.projectFor(cwd);
  if (!project) throw new PolyphemusError('Run it from inside a project folder: loops run in a project.', 'USAGE', 'poly projects add');
  const max = values.max === undefined ? undefined : Number(values.max);
  if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new PolyphemusError('--max is a whole number of rounds.', 'USAGE');
  const daemon = await DaemonClient.connect(polyphemus.home, daemonPort());
  if (!daemon) throw new PolyphemusError('A loop runs in the daemon, and it isn’t running.', 'FAILED', 'poly service start');
  try {
    const { id } = (await daemon.request('POST', '/api/workflows/loop/start', {
      project: project.slug,
      input: { goal, until: values.until, ...(max !== undefined && { max }) },
      ...(values.agent && { agent: values.agent }),
      yolo: values.yes === true || values.yolo === true,
    })) as { id: string };
    if (jsonOutput) return printJson({ id, project: project.slug });
    console.log(green(`✓ Looping on “${oneLine(goal, 60)}” in ${project.name}: thread ${id}. It stops when \`${values.until}\` passes${max ? `, or after ${max} rounds` : ''}.`));
    console.log(dim(`  Watch it in the app, or: polyphemus -r ${id}`));
  } finally {
    daemon.close();
  }
}

/** `poly intake "<text>"`: something came in for this folder's project; it waits on Home for a person. */
async function intakeCommand(polyphemus: Polyphemus, words: string[], values: { kind?: string }, cwd: string): Promise<void> {
  const text = words.join(' ').trim();
  if (!text) throw new PolyphemusError('Say what came in: poly intake "exports drop rows with commas" --kind finding', 'USAGE', 'poly help intake');
  const kind = values.kind ?? 'feedback';
  if (!['feedback', 'idea', 'finding'].includes(kind)) throw new PolyphemusError('--kind is feedback, idea or finding.', 'USAGE');
  const project = polyphemus.store.projectFor(cwd);
  if (!project) throw new PolyphemusError('Run it from inside a project folder: it goes to that project.', 'USAGE', 'poly projects add');
  const daemon = await DaemonClient.connect(polyphemus.home, daemonPort());
  if (!daemon) throw new PolyphemusError('Intake goes through the daemon, and it isn’t running.', 'FAILED', 'poly service start');
  try {
    const { id } = (await daemon.request('POST', `/api/projects/${encodeURIComponent(project.slug)}/incoming`, { kind, text })) as { id: string };
    if (jsonOutput) return printJson({ id, project: project.slug, kind });
    console.log(green(`✓ Added to ${project.name}: it’s waiting on Home for someone to make work of it or dismiss it. Thread ${id}.`));
  } finally {
    daemon.close();
  }
}

/**
 * `poly update`: the newest polyphemus from npm, then the service restarted onto it. From a checkout
 * of the repository it says how to update that instead: git, then poly service update.
 */
async function updateCommand(polyphemus: Polyphemus, values: { check?: boolean; channel?: string; now?: boolean }): Promise<void> {
  let channel = polyphemus.config.updates.channel;
  if (values.channel !== undefined) {
    if (values.channel !== 'stable' && values.channel !== 'beta') throw new PolyphemusError('The channel is stable or beta.', 'USAGE', 'poly update --channel beta');
    // Kept like any other setting: a revision `poly config history` lists and `poly config undo` reverses.
    if (values.channel !== channel) {
      const history = new ConfigHistory(polyphemus.home, polyphemus.store, callerName());
      const rev = history.apply(history.plan('updates.channel', values.channel).after, 'set updates.channel');
      if (!jsonOutput) console.log(dim(`Following ${values.channel} releases now (revision ${rev}; undo: poly config undo).`));
    }
    channel = values.channel;
  }
  const status = await checkForUpdate(polyphemus.home, { enabled: true, force: true, channel });
  if (jsonOutput && values.check) return printJson(status);
  if (status.installedFrom === 'checkout') {
    return console.log(`polyphemus ${status.current}, run from a checkout of its repository. Update it with git, then: poly service update`);
  }
  if (!status.latest) throw new PolyphemusError(`Couldn’t find out the newest version: ${status.why ?? 'npm didn’t answer'}.`, 'FAILED');
  // Back on stable from a beta: nothing goes backwards, so the beta stays until stable passes it.
  if (!status.newer && compareVersions(status.current, status.latest) > 0) {
    return console.log(green(`✓ polyphemus ${status.current} is newer than the newest ${status.channel} release (${status.latest}). It moves to ${status.channel} with the next one that’s newer.`));
  }
  if (!status.newer) return console.log(green(`✓ polyphemus ${status.current} is the newest.`));
  if (values.check) return console.log(`polyphemus ${status.latest} is out (you have ${status.current}). Install it: poly update`);
  const place = installPlace();
  if (!place) {
    return console.log(`polyphemus ${status.latest} is out. This copy wasn’t installed with the installer or npm install -g, so update it the way you installed it.`);
  }
  const result = await upgrade(status.latest, upgradeDeps(polyphemus, place, values.now === true));
  sayResult(result, (line) => console.log(line));
  if (!result.ok) process.exitCode = 1;
  else if (!serviceRunning() && daemonAnswering()) console.log(yellow('polyphemus is running in a terminal (poly serve): stop it and start it again to use the new version.'));
}

/** What an update or a rollback needs from this computer: the service, its health, and waiting for work. */
function upgradeDeps(polyphemus: Polyphemus, place: Place, now: boolean) {
  const manager = (() => {
    try {
      const m = serviceManager();
      return m.isActive() ? m : undefined;
    } catch {
      return undefined; // no service manager here (Windows): nothing in the background to restart
    }
  })();
  return {
    home: polyphemus.home,
    place,
    service: manager,
    unhealthy: () => unhealthy(daemonPort()),
    waitForIdle: () => waitForIdle(now),
    log: (line: string) => console.log(line),
  };
}

const serviceRunning = (): boolean => {
  try {
    return serviceManager().isActive();
  } catch {
    return false;
  }
};

const daemonAnswering = (): boolean => {
  try {
    const status = JSON.parse(readFileSync(join(polyphemusHome(), 'daemon.json'), 'utf8')) as { pid: number };
    process.kill(status.pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** `poly rollback`: back to the version before the last update. */
async function rollbackCommand(polyphemus: Polyphemus, opts: { restore: boolean; now: boolean }): Promise<void> {
  const place = installPlace();
  if (!place) throw new PolyphemusError('This copy runs from a checkout of the repository: go back with git, or poly service rollback for the service.', 'USAGE');
  const result = await rollback({ ...upgradeDeps(polyphemus, place, opts.now), restoreData: opts.restore });
  console.log(result.ok ? green(`✓ ${result.why}`) : yellow(`✗ ${result.why}`));
  if (!result.ok) process.exitCode = 1;
}

/** `poly self-check`: this version against a copy of this computer's data, changing nothing. */
async function selfCheckCommand(): Promise<void> {
  const results = await selfCheck(polyphemusHome());
  const ok = results.every((r) => r.ok);
  if (jsonOutput) printJson({ version: VERSION, ok, checks: results });
  else {
    for (const r of results) console.log(r.ok ? `${green('✓')} ${r.name}` : `${yellow('✗')} ${r.name}: ${r.why}`);
    console.log(ok ? green(`polyphemus ${VERSION} works with this computer’s data.`) : yellow(`polyphemus ${VERSION} can’t work with this computer’s data yet: nothing was changed.`));
  }
  if (!ok) process.exitCode = 1;
}

/** Usage meters with forecasts: will each window last until it resets? */
function usageCommand(polyphemus: Polyphemus): void {
  const forecasts = polyphemus.forecasts();
  const capacity = [...polyphemus.store.capacity().entries()];
  if (jsonOutput) {
    return printJson({
      providers: capacity.map(([provider, readings]) => ({
        provider,
        windows: readings.map((r) => {
          const f = forecasts.find((x) => x.provider === provider && x.window === r.window);
          return {
            window: r.window,
            usedPct: r.usedPct ?? null,
            resetsAt: iso(r.resetsAt?.getTime()),
            observedAt: iso(r.observedAt?.getTime()),
            forecast: f ? { status: f.status, text: describeForecast(f), runsOutAt: iso(f.runsOutAt), pace: f.pace ?? null, ratePerHour: f.ratePerHour ?? null, basis: f.basis ?? null } : null,
          };
        }),
      })),
    });
  }
  if (capacity.length === 0) return console.log(dim('No usage reported yet. It shows up after a turn on a subscription.'));
  for (const [provider, readings] of capacity) {
    console.log(bold(provider));
    for (const r of readings) {
      const pct = Math.round(r.usedPct ?? 0);
      const filled = Math.round(Math.min(100, pct) / 5);
      const bar = `${'█'.repeat(filled)}${'░'.repeat(20 - filled)}`;
      const f = forecasts.find((x) => x.provider === provider && x.window === r.window);
      const line = f ? describeForecast(f) : '';
      console.log(`  ${r.window.padEnd(6)} ${pct >= 90 ? yellow(bar) : bar} ${String(pct).padStart(3)}%  ${dim(formatUsage(r).replace(/^\S+ \d+%\s*/, ''))}`);
      if (line) console.log(`         ${f?.status === 'short' ? yellow(line) : dim(line)}`);
    }
  }
}

async function modelsCommand(polyphemus: Polyphemus, args: string[], flags: { all?: boolean; effort?: string }): Promise<void> {
  const [action, label, target] = args;
  // Naming a model is a config change like any other: validated, recorded, and undoable.
  if (action === 'add' || action === 'rm') {
    const history = new ConfigHistory(polyphemus.home, polyphemus.store, callerName());
    if (!label) throw new PolyphemusError(`Usage: poly models ${action} <name>${action === 'add' ? ' <provider>:<model-id>' : ''}`, 'USAGE');
    if (action === 'rm') {
      if (!polyphemus.config.models[label]) throw new PolyphemusError(`There's no model called "${label}".`, 'NOT_FOUND', 'poly models');
      const rev = history.apply(history.plan(`models.${label}`, undefined).after, `removed model ${label}`);
      return jsonOutput ? printJson({ removed: label, revision: rev }) : console.log(`${green('✓')} Removed ${label}. (Undo: poly config undo)`);
    }
    if (!target) throw new PolyphemusError(`Which model? poly models add ${label} <provider>:<model-id>`, 'USAGE', 'poly models --all');
    const at = target.indexOf(':');
    if (at <= 0) throw new PolyphemusError(`Give it as provider:model-id, like ollama:llama3.1 (you gave "${target}").`, 'USAGE');
    const provider = target.slice(0, at);
    const model = target.slice(at + 1);
    if (!polyphemus.config.providers[provider]) {
      throw new PolyphemusError(`There's no provider called "${provider}" in your config.`, 'NOT_FOUND', `Add one under [providers.${provider}] — see the presets in ${configFile(polyphemus.home)}`);
    }
    if (flags.effort && !EFFORTS.includes(flags.effort as Effort)) throw new PolyphemusError(`Effort must be one of: ${EFFORTS.join(', ')}.`, 'USAGE');
    const value = { provider, model, ...(flags.effort && { effort: flags.effort }) };
    const rev = history.apply(history.plan(`models.${label}`, value).after, `added model ${label} = ${target}`);
    if (jsonOutput) return printJson({ label, provider, model, revision: rev });
    console.log(`${green('✓')} ${label} → ${target}. Use it with: polyphemus -m ${label}${polyphemus.config.defaultModel ? '' : `, or make it the default with /default`}`);
    return;
  }
  if (action !== undefined) throw new PolyphemusError(`Unknown models command "${action}". Try: poly models [--all], models add, models rm.`, 'USAGE', 'poly help models add');

  const choices = await modelChoices(polyphemus.config, polyphemus.registry, polyphemus.credentials, { apis: flags.all });
  if (!jsonOutput) {
    printModels(choices, new Map());
    if (!flags.all) console.log(dim('\nEverything a provider offers (including local servers): poly models --all'));
    return;
  }
  printJson({
    defaultModel: polyphemus.config.defaultModel ?? null,
    models: choices.map(({ model, ready, note }) => ({
      label: model.label,
      provider: model.provider,
      model: model.model,
      ready,
      note,
      out: polyphemus.unavailable(model.provider) !== undefined,
      unavailable: polyphemus.unavailable(model.provider) ?? null,
    })),
  });
}

function printSessions(sessions: SessionMeta[]): void {
  if (sessions.length === 0) return console.log(dim('No sessions yet.'));
  for (const s of sessions) {
    const title = oneLine(s.title || '(untitled)', 50).padEnd(50);
    console.log(`${cyan(s.id)}  ${dim(ago(s.updatedAt).padEnd(9))} ${title}  ${dim(`${s.provider}:${s.model}${s.archivedAt === undefined ? '' : ' · archived'}`)}`);
  }
}

/** Saves and tests an API key. Returns true if a key was saved. */
async function login(polyphemus: Polyphemus, providerId: string | undefined, readKey: (prompt: string) => Promise<string | undefined>): Promise<boolean> {
  const { config, credentials } = polyphemus;
  const apiProviders = Object.entries(config.providers)
    .filter(([, p]) => p.auth.type === 'api_key')
    .map(([id]) => id)
    .join(', ');
  const providers = Object.keys(config.providers).join(', ');
  if (!providerId) throw new PolyphemusError(`Which provider? login <provider>   (API providers: ${apiProviders})`);
  const providerConfig = config.providers[providerId];
  if (!providerConfig) throw new PolyphemusError(`Unknown provider "${providerId}". Configured: ${providers}`);
  if (providerConfig.auth.type === 'cli') {
    const how: Record<string, string> = {
      'claude-cli': 'run `claude` once and sign in',
      'codex-cli': 'run `codex login`',
      'grok-cli': 'run `grok login`',
    };
    console.log(`${providerId} uses its own CLI's login, so there's no key to save here: ${how[providerConfig.adapter] ?? 'sign in with its CLI'}.`);
    return false;
  }

  const key = await readKey(`API key for ${providerId} (input hidden, Esc to cancel): `);
  if (!key) {
    console.log(dim('No key saved.'));
    return false;
  }
  const envOverride =
    providerConfig.auth.type === 'api_key' && providerConfig.auth.env && process.env[providerConfig.auth.env] ? providerConfig.auth.env : undefined;
  credentials.setApiKey(providerId, key);
  try {
    const count = (await createProvider(providerId, providerConfig, credentials).listModels()).length;
    console.log(green(`✓ Key works: ${count} models available. Saved in the vault as provider/${providerId}.`));
    if (polyphemus.accept(providerId, 'cli')) console.log(dim(`${providerId} is now in use.`));
  } catch (err) {
    const message = (err as Error).message;
    // A rejected key is worse than none: it would make the provider look ready. Only keep the key
    // when the test failed for another reason, like being offline.
    if (!envOverride && classifyError(message) === 'auth') {
      credentials.deleteApiKey(providerId);
      console.log(red(`✗ ${providerId} rejected that key, so it wasn't saved: ${message}`));
      return false;
    }
    console.log(yellow(`! Saved, but the test request failed: ${message}`));
  }
  if (envOverride) console.log(yellow(`Note: ${envOverride} is set in this shell and takes precedence over the saved key.`));
  return true;
}

/** Reads a line without echoing it (for `poly login`, before any readline is running). */
function readSecret(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  return new Promise((resolve) => {
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '') {
          stdout.write('\n');
          process.exit(130);
        }
        value = ch === '' || ch === '\b' ? value.slice(0, -1) : value + ch;
      }
    };
    stdout.write(prompt);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function printError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(red(`✗ ${message}`));
  if (err instanceof PolyphemusError && err.fix) console.error(dim(`  Try: ${err.fix}`));
  if (envSetting('DEBUG') && err instanceof Error && !(err instanceof PolyphemusError)) console.error(dim(err.stack ?? ''));
}

main().catch((caught: unknown) => {
  let err = caught;
  // Node's argument parser throws plain errors for unknown flags; those are usage errors (exit 2).
  const code = (caught as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) {
    err = new PolyphemusError(`${(caught as Error).message.split('. ')[0]}.`, 'USAGE', 'poly help');
    jsonOutput ||= wantsJson(process.argv.includes('--json'));
  }
  if (jsonOutput) process.stdout.write(`${JSON.stringify(errorEnvelope(err))}\n`);
  printError(err);
  process.exit(exitCodeFor(err));
});
