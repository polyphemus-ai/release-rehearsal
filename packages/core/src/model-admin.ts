import { editConfig, ConfigHistory } from './config-edit.js';
import { isMetered, resolveModel, type Config, type ResolvedModel } from './config.js';
import { classifyError } from './errors.js';
import type { Polyphemus } from './polyphemus.js';
import { homedir } from 'node:os';
import { FOLLOW_DEFAULT, loadAgents, updateAgent, type Agent } from './roster.js';
import { emptyUsage, PolyphemusError, ProviderError, type Usage } from './types.js';

// Looking after the models you've chosen: testing one when you ask, moving it to another way in,
// and taking it away. The Models & providers screen is built on these (docs/design/routing.md).

/**
 * What a test will cost, said before it runs. On a vendor CLI there is no small prompt: its own
 * system prompt, skills and AGENTS.md are the floor, measured at 17–38k tokens for one codex turn
 * (capacity.md). On an API key the question itself is the whole cost.
 */
export function testCost(config: Config, provider: string): { billing: 'plan' | 'metered' | 'free'; said: string } {
  const auth = config.providers[provider]?.auth.type;
  if (auth === 'cli') return { billing: 'plan', said: 'about 20–40k tokens of your plan’s allowance (a CLI sends its own setup with every request)' };
  if (auth === 'api_key') return { billing: 'metered', said: 'a few dozen tokens, billed per token (a fraction of a cent)' };
  return { billing: 'free', said: 'nothing billed: it runs on your own server' };
}

export interface ModelTest {
  ok: boolean;
  /** What it answered, trimmed, or the error. */
  said: string;
  usage: Usage;
  costUsd?: number;
  ms: number;
  errorClass?: string;
}

const TEST_PROMPT = 'This is a connection test from polyphemus. Reply with the single word OK and nothing else. Do not use any tools.';

/**
 * Sends one short question to a model and records how it went, like a real turn would. Only ever
 * run because someone pressed Test: polyphemus never probes on its own (capacity.md).
 */
export async function testModel(polyphemus: Polyphemus, model: ResolvedModel, signal?: AbortSignal): Promise<ModelTest> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(180_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let text = '';
  let usage = emptyUsage();
  let costUsd: number | undefined;
  try {
    const provider = polyphemus.registry.get(model.provider);
    if (provider.kind === 'model') {
      for await (const event of provider.stream({ model: model.model, system: 'You are being tested for availability. Answer briefly.', messages: [{ role: 'user', content: [{ type: 'text', text: TEST_PROMPT }] }], tools: [], signal: combined })) {
        if (event.type === 'text_delta') text += event.text;
        if (event.type === 'message_done') {
          usage = event.usage;
          // Not every provider streams: some hand over the whole reply at the end.
          if (!text) text = event.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        }
      }
    } else {
      // A vendor CLI runs its own loop, so it's pinned read-only in a folder it has no reason to touch.
      for await (const event of provider.run({ prompt: TEST_PROMPT, model: model.model, cwd: polyphemus.home, autoApprove: false, readOnly: true, signal: combined })) {
        if (event.type === 'text_delta') text += event.text;
        if (event.type === 'capacity') polyphemus.recordUsage(event.provider, event.readings);
        if (event.type === 'turn_done') {
          usage = event.usage;
          costUsd = event.costUsd;
        }
      }
    }
    if (combined.aborted) throw new ProviderError('It didn’t answer within three minutes.', 'overloaded', model.provider);
    polyphemus.store.recordModelOk(model.provider, model.model);
    polyphemus.breakers.succeeded(model.provider);
    return { ok: true, said: text.trim().slice(0, 200) || '(an empty reply)', usage, ...(costUsd !== undefined && { costUsd }), ms: Date.now() - started };
  } catch (err) {
    const message = (err as Error).message;
    const errorClass = err instanceof ProviderError ? err.errorClass : classifyError(message);
    polyphemus.store.recordModelError(model.provider, model.model, message, errorClass);
    return { ok: false, said: message, usage, ms: Date.now() - started, errorClass };
  }
}

/** Every agent polyphemus knows about: your library, and each project's own. */
export function everyAgent(polyphemus: Polyphemus): Agent[] {
  const agents = loadAgents(polyphemus.home).agents;
  for (const project of polyphemus.store.projects()) {
    agents.push(...loadAgents(polyphemus.home, project.path, project.slug).agents.filter((agent) => agent.scope === 'project'));
  }
  return agents;
}

/** Agents that name `ref` as their model or in their fallback list. */
export function agentsUsing(polyphemus: Polyphemus, ref: string): Agent[] {
  return everyAgent(polyphemus).filter((agent) => agent.model === ref || agent.fallback?.includes(ref));
}

/**
 * Moves a chosen model to another way in — claude-opus-5 through Claude Code becomes claude-opus-5
 * through the Anthropic API key — everywhere it's named: the chosen list, the default, the backup
 * list, and any agent that runs on it or falls back to it. One config revision, so one undo.
 * Threads already running keep the connection they started on until you switch their model.
 */
export function moveModel(polyphemus: Polyphemus, from: string, connection: string, caller: string): { to: string; changed: string[] } {
  const at = from.indexOf(':');
  if (at <= 0) throw new PolyphemusError(`"${from}" isn’t provider:model-id.`, 'USAGE');
  const modelId = from.slice(at + 1);
  if (!polyphemus.config.selected.includes(from)) throw new PolyphemusError(`${from} isn’t one of your models.`, 'NOT_FOUND');
  if (!polyphemus.config.providers[connection]) throw new PolyphemusError(`No provider called "${connection}".`, 'NOT_FOUND');
  const to = `${connection}:${modelId}`;
  if (to === from) return { to, changed: [] };

  const history = new ConfigHistory(polyphemus.home, polyphemus.store, caller);
  const config = polyphemus.config;
  const changed: string[] = [];
  let text = history.read();
  const swap = (list: readonly string[]) => [...new Set(list.map((ref) => (ref === from ? to : ref)))];
  text = editConfig(text, 'selected', swap(config.selected));
  changed.push('your models');
  if (config.defaultModel === from) {
    text = editConfig(text, 'default_model', to);
    changed.push('the default');
  }
  if (config.routing.fallback.includes(from)) {
    text = editConfig(text, 'routing.fallback', swap(config.routing.fallback));
    changed.push('the backup list');
  }
  history.apply(text, `moved ${from} to ${to}`);
  polyphemus.reloadConfig();

  for (const agent of agentsUsing(polyphemus, from)) {
    updateAgent(agent, {
      ...(agent.model === from && { model: to }),
      ...(agent.fallback?.includes(from) && { fallback: swap(agent.fallback) }),
    });
    changed.push(agent.title);
  }
  return { to, changed };
}

/**
 * Takes a model off your list, and out of the backup list with it — a backup you can't choose is a
 * backup that silently never runs. Refuses the default: something has to be. Signs nothing out.
 */
export function removeModel(polyphemus: Polyphemus, ref: string, caller: string): { agents: string[] } {
  const config = polyphemus.config;
  if (!config.selected.includes(ref)) throw new PolyphemusError(`${ref} isn’t one of your models.`, 'NOT_FOUND');
  if (config.defaultModel === ref) throw new PolyphemusError(`${ref.slice(ref.indexOf(':') + 1)} is the default. Make another model the default first.`, 'CONFLICT');
  const history = new ConfigHistory(polyphemus.home, polyphemus.store, caller);
  let text = editConfig(history.read(), 'selected', config.selected.filter((r) => r !== ref));
  if (config.routing.fallback.includes(ref)) text = editConfig(text, 'routing.fallback', config.routing.fallback.filter((r) => r !== ref));
  history.apply(text, `removed model ${ref}`);
  polyphemus.reloadConfig();
  // Agents are files you own: they're told about, not edited behind your back.
  return { agents: agentsUsing(polyphemus, ref).map((agent) => agent.title) };
}

/**
 * Agents used to follow the default model when they named none: bump the default, and every one
 * of them moved. Now an agent keeps the model it was made with, so the ones that had none are
 * pinned — once — to the model they were actually following. That's a silent change for anyone who
 * relied on the old behaviour, so the config history note names every agent, its file, and the
 * model, and says how to get following back (`model = "default"`).
 *
 * Runs when there is a default to pin to and config.toml has no unrecorded edit (a note recorded
 * then would quietly adopt that edit). Until both hold, it waits and agents keep following.
 */
export function pinAgentsToTheirModel(polyphemus: Polyphemus): { model: string; agents: Agent[] } | undefined {
  const MIGRATION = 'agents-keep-their-model';
  if (polyphemus.store.migrated(MIGRATION)) return undefined;
  const model = polyphemus.config.defaultModel;
  if (!model) return undefined;
  const history = new ConfigHistory(polyphemus.home, polyphemus.store, 'polyphemus');
  if (history.drift()) return undefined;
  // The default agent follows each thread's model on purpose: it isn't pinned.
  const pinned = everyAgent(polyphemus).filter((agent) => agent.model === undefined && agent.name !== polyphemus.config.defaultAgent);
  for (const agent of pinned) updateAgent(agent, { model });
  if (pinned.length > 0) {
    const home = homedir();
    const where = (file: string) => (file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file);
    history.recordCurrent(
      `pinned ${pinned.length} agent${pinned.length === 1 ? '' : 's'} to ${model}, the default they were following — agents now keep the model they were made with: ` +
        `${pinned.map((agent) => `${agent.name} (${where(agent.file)})`).join(', ')}. ` +
        `To have one follow the default again, set model = "${FOLLOW_DEFAULT}" in its agent.toml.`,
    );
  }
  polyphemus.store.markMigrated(MIGRATION);
  return { model, agents: pinned };
}

/** Resolves a ref, or says plainly that it isn't one. */
export function modelRef(config: Config, ref: string): ResolvedModel {
  try {
    return resolveModel(config, ref);
  } catch (err) {
    throw new PolyphemusError((err as Error).message, 'NOT_FOUND');
  }
}

export { isMetered };
