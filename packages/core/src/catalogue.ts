import type { Adapter } from './config.js';

// Providers polyphemus knows how to connect to, so adding one is a screen rather than hand-editing
// config.toml (docs/design/roadmap.md, "the place you work" #1). Polyphemus ships six connections;
// this is everything else it can set up for you.
//
// Two things are deliberate here:
//  - **A base URL is a suggestion, never a fact.** OpenAI-compatible endpoints move, and a wrong
//    one that looks authoritative is worse than an empty box. Every connect screen shows the URL,
//    prefilled where we're confident, and lets you correct it before anything is written.
//  - **`more` is a stash, not a catalogue.** Names from OpenClaw's provider directory (seen
//    2026-09-12) that we haven't set up properly. They're listed so the work is scoped, and so
//    nobody has to go re-derive the list; they aren't offered as if they were ready.

export type ConnectWith = 'key' | 'cli' | 'local';

export interface CatalogueEntry {
  /** What the connection is called in config.toml. */
  id: string;
  /** The company whose models it reaches. Connections group under this. */
  vendor: string;
  name: string;
  /** One line: what you'd use it for. */
  about: string;
  /** Frontier labs first, then what people actually reach for. */
  tier: 'frontier' | 'popular' | 'gateway' | 'local';
  connect: ConnectWith;
  adapter: Adapter;
  /** Suggested, and editable before it's written. Omitted where we'd only be guessing. */
  baseUrl?: string;
  /** The variable polyphemus reads if you'd rather keep the key in your environment. */
  env?: string;
  /** Where to get a key, or read about it. */
  docs?: string;
  /** Already in the config polyphemus ships, so it's set up rather than added. */
  shipped?: boolean;
}

export const CATALOGUE: readonly CatalogueEntry[] = [
  // ── The frontier labs ───────────────────────────────────────────────────
  { id: 'anthropic', vendor: 'Anthropic', name: 'Anthropic API', about: 'Claude, billed per token', tier: 'frontier', connect: 'key', adapter: 'anthropic', env: 'ANTHROPIC_API_KEY', docs: 'https://console.anthropic.com/settings/keys', shipped: true },
  { id: 'claude-code', vendor: 'Anthropic', name: 'Claude Code CLI', about: 'Claude on your Pro or Max subscription', tier: 'frontier', connect: 'cli', adapter: 'claude-cli', shipped: true },
  { id: 'openai', vendor: 'OpenAI', name: 'OpenAI API', about: 'GPT, billed per token', tier: 'frontier', connect: 'key', adapter: 'openai-responses', env: 'OPENAI_API_KEY', docs: 'https://platform.openai.com/api-keys', shipped: true },
  { id: 'codex', vendor: 'OpenAI', name: 'Codex CLI', about: 'GPT on your ChatGPT plan', tier: 'frontier', connect: 'cli', adapter: 'codex-cli', shipped: true },
  { id: 'xai', vendor: 'xAI', name: 'xAI API', about: 'Grok, billed per token', tier: 'frontier', connect: 'key', adapter: 'openai-responses', baseUrl: 'https://api.x.ai/v1', env: 'XAI_API_KEY', docs: 'https://console.x.ai', shipped: true },
  { id: 'grok-build', vendor: 'xAI', name: 'Grok CLI', about: 'Grok on your SuperGrok plan', tier: 'frontier', connect: 'cli', adapter: 'grok-cli', shipped: true },
  { id: 'google', vendor: 'Google', name: 'Gemini API', about: 'Gemini, through its OpenAI-compatible endpoint', tier: 'frontier', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', env: 'GEMINI_API_KEY', docs: 'https://aistudio.google.com/apikey' },
  { id: 'mistral', vendor: 'Mistral', name: 'Mistral API', about: 'Mistral and Codestral', tier: 'frontier', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY', docs: 'https://console.mistral.ai/api-keys' },
  { id: 'deepseek', vendor: 'DeepSeek', name: 'DeepSeek API', about: 'Strong reasoning, very cheap', tier: 'frontier', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.deepseek.com', env: 'DEEPSEEK_API_KEY', docs: 'https://platform.deepseek.com/api_keys' },

  // ── Popular ─────────────────────────────────────────────────────────────
  { id: 'groq', vendor: 'Groq', name: 'Groq', about: 'Open models, very fast', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY', docs: 'https://console.groq.com/keys' },
  { id: 'cerebras', vendor: 'Cerebras', name: 'Cerebras', about: 'Open models at very high throughput', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.cerebras.ai/v1', env: 'CEREBRAS_API_KEY', docs: 'https://cloud.cerebras.ai' },
  { id: 'together', vendor: 'Together AI', name: 'Together AI', about: 'A wide range of open models', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.together.xyz/v1', env: 'TOGETHER_API_KEY', docs: 'https://api.together.ai/settings/api-keys' },
  { id: 'fireworks', vendor: 'Fireworks', name: 'Fireworks', about: 'Open models, tuned for serving', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.fireworks.ai/inference/v1', env: 'FIREWORKS_API_KEY', docs: 'https://fireworks.ai/account/api-keys' },
  { id: 'perplexity', vendor: 'Perplexity', name: 'Perplexity', about: 'Answers with live web search', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.perplexity.ai', env: 'PERPLEXITY_API_KEY', docs: 'https://www.perplexity.ai/settings/api' },
  { id: 'moonshot', vendor: 'Moonshot AI', name: 'Moonshot (Kimi)', about: 'Kimi, including its coding models', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.moonshot.ai/v1', env: 'MOONSHOT_API_KEY', docs: 'https://platform.moonshot.ai' },
  { id: 'zai', vendor: 'Z.AI', name: 'Z.AI (GLM)', about: 'The GLM family', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.z.ai/api/paas/v4', env: 'ZAI_API_KEY', docs: 'https://z.ai' },
  { id: 'qwen', vendor: 'Alibaba', name: 'Qwen', about: 'Qwen, through Alibaba Model Studio', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', env: 'DASHSCOPE_API_KEY', docs: 'https://bailian.console.aliyun.com' },
  { id: 'cohere', vendor: 'Cohere', name: 'Cohere', about: 'Command models, strong at RAG', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.cohere.ai/compatibility/v1', env: 'COHERE_API_KEY', docs: 'https://dashboard.cohere.com/api-keys' },
  { id: 'nvidia', vendor: 'NVIDIA', name: 'NVIDIA NIM', about: 'Hosted open models on NVIDIA infrastructure', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://integrate.api.nvidia.com/v1', env: 'NVIDIA_API_KEY', docs: 'https://build.nvidia.com' },
  { id: 'huggingface', vendor: 'Hugging Face', name: 'Hugging Face', about: 'Inference across many open models', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://router.huggingface.co/v1', env: 'HF_TOKEN', docs: 'https://huggingface.co/settings/tokens' },
  { id: 'bedrock', vendor: 'Amazon', name: 'Amazon Bedrock', about: 'Claude and others inside your AWS account', tier: 'popular', connect: 'key', adapter: 'openai-chat', docs: 'https://docs.aws.amazon.com/bedrock/' },
  // From OpenClaw's provider directory, each endpoint checked against its source (2026-09-18).
  { id: 'zai-coding', vendor: 'Z.AI', name: 'Z.AI Coding Plan', about: 'GLM on your Z.AI coding subscription', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.z.ai/api/coding/paas/v4', env: 'ZAI_API_KEY', docs: 'https://z.ai/subscribe' },
  { id: 'kimi-coding', vendor: 'Moonshot AI', name: 'Kimi Coding', about: 'Kimi on your Kimi Code subscription', tier: 'popular', connect: 'key', adapter: 'anthropic', baseUrl: 'https://api.kimi.com/coding/', env: 'KIMI_API_KEY', docs: 'https://www.kimi.com/code' },
  { id: 'minimax', vendor: 'MiniMax', name: 'MiniMax', about: 'MiniMax models, strong at agentic coding', tier: 'popular', connect: 'key', adapter: 'anthropic', baseUrl: 'https://api.minimax.io/anthropic', env: 'MINIMAX_API_KEY', docs: 'https://platform.minimax.io' },
  { id: 'venice', vendor: 'Venice AI', name: 'Venice', about: 'Private, uncensored open models', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.venice.ai/api/v1', env: 'VENICE_API_KEY', docs: 'https://venice.ai/settings/api' },
  { id: 'deepinfra', vendor: 'DeepInfra', name: 'DeepInfra', about: 'Cheap hosted open models', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.deepinfra.com/v1/openai', env: 'DEEPINFRA_API_KEY', docs: 'https://deepinfra.com/dash/api_keys' },
  { id: 'novita', vendor: 'NovitaAI', name: 'Novita AI', about: 'Hosted open models, pay as you go', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.novita.ai/openai/v1', env: 'NOVITA_API_KEY', docs: 'https://novita.ai/settings/key-management' },
  { id: 'chutes', vendor: 'Chutes', name: 'Chutes', about: 'Open models on decentralized compute', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://llm.chutes.ai/v1', env: 'CHUTES_API_KEY', docs: 'https://chutes.ai' },
  { id: 'featherless', vendor: 'Featherless AI', name: 'Featherless', about: 'Thousands of open models, flat monthly price', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.featherless.ai/v1', env: 'FEATHERLESS_API_KEY', docs: 'https://featherless.ai/account/api-keys' },
  { id: 'baseten', vendor: 'Baseten', name: 'Baseten', about: 'Fast hosted open models', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://inference.baseten.co/v1', env: 'BASETEN_API_KEY', docs: 'https://app.baseten.co/settings/api_keys' },
  { id: 'gmi', vendor: 'GMI Cloud', name: 'GMI Cloud', about: 'Hosted open models on GMI’s GPUs', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.gmi-serving.com/v1', env: 'GMI_API_KEY', docs: 'https://console.gmicloud.ai' },
  { id: 'arcee', vendor: 'Arcee AI', name: 'Arcee AI', about: 'Small models tuned for business tasks', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.arcee.ai/api/v1', env: 'ARCEEAI_API_KEY', docs: 'https://models.arcee.ai' },
  { id: 'synthetic', vendor: 'Synthetic', name: 'Synthetic', about: 'Open models on a flat subscription', tier: 'popular', connect: 'key', adapter: 'anthropic', baseUrl: 'https://api.synthetic.new/anthropic', env: 'SYNTHETIC_API_KEY', docs: 'https://synthetic.new' },
  { id: 'stepfun', vendor: 'StepFun', name: 'StepFun', about: 'Step models, strong at reasoning', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.stepfun.ai/v1', env: 'STEPFUN_API_KEY', docs: 'https://platform.stepfun.ai' },
  { id: 'xiaomi', vendor: 'Xiaomi', name: 'Xiaomi MiMo', about: 'Xiaomi’s MiMo models', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.xiaomimimo.com/v1', env: 'XIAOMI_API_KEY', docs: 'https://platform.xiaomimimo.com' },
  { id: 'longcat', vendor: 'Meituan', name: 'LongCat', about: 'Meituan’s LongCat models', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.longcat.chat/openai', env: 'LONGCAT_API_KEY', docs: 'https://longcat.chat/platform' },
  { id: 'qianfan', vendor: 'Baidu', name: 'Baidu Qianfan', about: 'ERNIE and hosted models from Baidu', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://qianfan.baidubce.com/v2', env: 'QIANFAN_API_KEY', docs: 'https://console.bce.baidu.com/qianfan' },
  { id: 'tencent', vendor: 'Tencent Cloud', name: 'Tencent TokenHub', about: 'Hunyuan and hosted models from Tencent', tier: 'popular', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://tokenhub.tencentmaas.com/v1', env: 'TOKENHUB_API_KEY', docs: 'https://cloud.tencent.com/product/hunyuan' },
  { id: 'copilot', vendor: 'GitHub', name: 'GitHub Copilot', about: 'Models on your Copilot subscription', tier: 'popular', connect: 'key', adapter: 'openai-chat', docs: 'https://github.com/settings/copilot' },

  // ── Gateways: one key, many models ──────────────────────────────────────
  { id: 'openrouter', vendor: 'OpenRouter', name: 'OpenRouter', about: 'Hundreds of models behind one key', tier: 'gateway', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', docs: 'https://openrouter.ai/keys' },
  { id: 'litellm', vendor: 'LiteLLM', name: 'LiteLLM', about: 'Your own gateway in front of everything else', tier: 'gateway', connect: 'key', adapter: 'openai-chat', env: 'LITELLM_API_KEY', docs: 'https://docs.litellm.ai' },
  { id: 'vercel', vendor: 'Vercel', name: 'Vercel AI Gateway', about: 'Routing and spend limits across providers', tier: 'gateway', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://ai-gateway.vercel.sh/v1', env: 'AI_GATEWAY_API_KEY', docs: 'https://vercel.com/docs/ai-gateway' },
  { id: 'opencode', vendor: 'OpenCode', name: 'OpenCode Zen', about: 'Coding models picked and tested by OpenCode', tier: 'gateway', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://opencode.ai/zen/v1', env: 'OPENCODE_API_KEY', docs: 'https://opencode.ai/zen' },
  { id: 'kilocode', vendor: 'Kilo', name: 'Kilo Gateway', about: 'Many models behind one Kilo key', tier: 'gateway', connect: 'key', adapter: 'openai-chat', baseUrl: 'https://api.kilo.ai/api/gateway/', env: 'KILOCODE_API_KEY', docs: 'https://kilo.ai' },
  { id: 'cloudflare', vendor: 'Cloudflare', name: 'Cloudflare AI Gateway', about: 'Caching and analytics in front of providers', tier: 'gateway', connect: 'key', adapter: 'openai-chat', env: 'CLOUDFLARE_API_KEY', docs: 'https://developers.cloudflare.com/ai-gateway/' },

  // ── On your own machine ─────────────────────────────────────────────────
  { id: 'ollama', vendor: 'Ollama', name: 'Ollama', about: 'Models running on this computer', tier: 'local', connect: 'local', adapter: 'openai-chat', baseUrl: 'http://localhost:11434/v1' },
  { id: 'lmstudio', vendor: 'LM Studio', name: 'LM Studio', about: "LM Studio's local server", tier: 'local', connect: 'local', adapter: 'openai-chat', baseUrl: 'http://localhost:1234/v1' },
  { id: 'llamacpp', vendor: 'llama.cpp', name: 'llama.cpp', about: 'A llama-server you run yourself', tier: 'local', connect: 'local', adapter: 'openai-chat', baseUrl: 'http://localhost:8080/v1' },
  { id: 'sglang', vendor: 'SGLang', name: 'SGLang', about: 'An SGLang server you run yourself', tier: 'local', connect: 'local', adapter: 'openai-chat', baseUrl: 'http://127.0.0.1:30000/v1' },
  { id: 'vllm', vendor: 'vLLM', name: 'vLLM', about: 'A vLLM server, local or on your own box', tier: 'local', connect: 'local', adapter: 'openai-chat', baseUrl: 'http://localhost:8000/v1' },
];

/**
 * The rest of OpenClaw's provider directory (seen 2026-09-12), kept so the remaining work is a
 * known list rather than a research task. Nothing here is offered in the app: an entry graduates
 * into CATALOGUE once someone has checked its endpoint and how it authenticates.
 */
export const MORE_PROVIDERS: readonly string[] = [
  // Chat models still to check: an endpoint we couldn't confirm, or auth that isn't a plain key
  // (Azure's per-resource URL and api-key header, AWS signing, Google Cloud credentials).
  'Azure OpenAI / AI Foundry', 'Amazon Bedrock Mantle', 'Anthropic on Vertex', 'Gemini on Vertex',
  'Meta Llama API', 'Ollama Cloud', 'OpenCode Go', 'Volcengine (Doubao)', 'BytePlus', 'llmman', 'ds4',
  // Sign-ins rather than keys, for providers already here: ChatGPT and SuperGrok OAuth without their
  // CLIs, GitHub Copilot's device code, OpenRouter's OAuth.
  'OpenAI (ChatGPT sign-in)', 'xAI (SuperGrok sign-in)', 'GitHub Copilot (device sign-in)', 'OpenRouter (OAuth)',
];
// Not listed: OpenClaw's speech, image and video services (Azure Speech, ComfyUI, Deepgram,
// ElevenLabs, fal, Gradium, Runway, SenseAudio, Vydra) — not models polyphemus talks to — and its own
// ClawRouter and the community Claude-subscription proxy.

/** The TOML block that adds a connection, ready to be merged into config.toml. */
export function providerBlock(entry: CatalogueEntry, opts: { baseUrl?: string } = {}): Record<string, unknown> {
  const baseUrl = opts.baseUrl?.trim() || entry.baseUrl;
  return {
    adapter: entry.adapter,
    // base_url, not baseUrl: that's the key config.toml uses, and an unknown one is ignored.
    ...(baseUrl ? { base_url: baseUrl } : {}),
    auth:
      entry.connect === 'cli'
        ? { type: 'cli' }
        : entry.connect === 'local'
          ? { type: 'none' }
          : { type: 'api_key', ...(entry.env ? { env: entry.env } : {}) },
  };
}

export const catalogueEntry = (id: string): CatalogueEntry | undefined => CATALOGUE.find((entry) => entry.id === id);
