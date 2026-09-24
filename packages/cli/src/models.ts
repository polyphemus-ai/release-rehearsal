import {
  providerStatus,
  resolveModel,
  type CapacityReading,
  type Config,
  type Credentials,
  type ModelInfo,
  type ProviderRegistry,
  type ResolvedModel,
} from '@polyphemus/core';
import type { PickItem } from './picker.js';
import { dim, green, yellow } from './render.js';

/** How long to wait for a CLI to list its models before showing the list without them. */
const LIST_TIMEOUT_MS = 5000;

export interface ModelChoice {
  model: ResolvedModel;
  ready: boolean;
  note: string;
}

export const targetOf = (model: ResolvedModel): string => `${model.provider}:${model.model}`;

/**
 * Every model you can pick: the configured aliases, plus whatever each installed subscription CLI
 * offers. With `apis`, also everything each ready API provider lists — that's how you see what a
 * local server or a gateway actually has, without naming models in the config first.
 */
export async function modelChoices(
  config: Config,
  registry: ProviderRegistry,
  credentials: Credentials,
  opts: { apis?: boolean } = {},
): Promise<ModelChoice[]> {
  const status = (provider: string) => {
    const providerConfig = config.providers[provider];
    return providerConfig ? providerStatus(provider, providerConfig, credentials) : { ready: false, note: 'unknown provider' };
  };
  const choices: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const name of Object.keys(config.models)) {
    const model = resolveModel(config, name);
    seen.add(targetOf(model));
    choices.push({ model, ...status(model.provider) });
  }

  const listable = Object.entries(config.providers).filter(
    ([id, providerConfig]) => (providerConfig.auth.type === 'cli' || opts.apis === true) && status(id).ready,
  );
  const listed = await Promise.all(
    listable.map(async ([id]) => ({ id, models: await withTimeout(registry.get(id).listModels(), LIST_TIMEOUT_MS).catch(() => [] as ModelInfo[]) })),
  );
  for (const { id, models } of listed) {
    for (const { id: modelId } of models) {
      const model: ResolvedModel = { label: `${id}:${modelId}`, provider: id, model: modelId };
      if (modelId === 'default' || seen.has(targetOf(model))) continue;
      seen.add(targetOf(model));
      choices.push({ model, ...status(id) });
    }
  }
  return choices;
}

/** Picker rows: name, what it runs on, whether it's ready, and usage if a turn has reported it. */
export function choiceItems(choices: ModelChoice[], capacity: Map<string, CapacityReading[]>, current?: ResolvedModel): PickItem<ResolvedModel>[] {
  const labelWidth = Math.max(0, ...choices.map((c) => c.model.label.length));
  const targetWidth = Math.max(0, ...choices.filter((c) => c.model.label !== targetOf(c.model)).map((c) => targetOf(c.model).length));
  return choices.map((choice) => {
    const target = targetOf(choice.model);
    const usage = (capacity.get(choice.model.provider) ?? [])
      .filter((r) => r.usedPct !== undefined)
      .map((r) => `${r.window} ${r.usedPct}%`)
      .join(' · ');
    const status = `${choice.ready ? '✓' : '✗'} ${choice.note}${usage ? ` · ${usage}` : ''}`;
    const isCurrent = current !== undefined && targetOf(current) === target;
    return {
      label: choice.model.label.padEnd(labelWidth),
      detail: `${(choice.model.label === target ? '' : target).padEnd(targetWidth)}  ${status}${isCurrent ? '  (current)' : ''}`,
      ready: choice.ready,
      value: choice.model,
    };
  });
}

/** The same list as plain lines, for `poly models` and non-interactive use. */
export function printModels(choices: ModelChoice[], capacity: Map<string, CapacityReading[]>, current?: ResolvedModel): void {
  for (const item of choiceItems(choices, capacity, current)) {
    const detail = item.detail ?? '';
    const marked = item.ready ? detail.replace('✓', green('✓')) : detail.replace('✗', yellow('✗'));
    console.log(`  ${item.label}  ${item.ready ? marked : dim(marked)}`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
