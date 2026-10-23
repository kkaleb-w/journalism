export type ProviderKind = "openai" | "anthropic" | "gemini" | "cohere";

export type Provider = {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** true when the user must supply their own endpoint (Azure, Vertex, Bedrock, Cloudflare) */
  customBase?: boolean;
  keyUrl: string;
  defaultModel: string;
  suggestedModels: string[];
  notes?: string;
  supportsTranscription?: boolean;
};

export type TranscriptionProvider = {
  id: string;
  name: string;
  kind: "openai-audio" | "deepgram" | "gemini-audio";
  baseUrl: string;
  keyUrl: string;
  defaultModel: string;
  models: string[];
};

export type SourceType =
  | "post"
  | "statement"
  | "speech"
  | "vote"
  | "bill"
  | "money"
  | "action";

export type PrimaryEvent = {
  id: string;
  source: string;
  sourceType: SourceType;
  /** short human label: "Truth Social post", "Senate roll call 312" */
  sourceLabel: string;
  /** primary = the person or an official record of the person. Nothing else is accepted. */
  trust: "primary";
  title: string;
  text: string;
  url: string;
  publishedAt: string;
  retrievedAt: string;
  meta: Record<string, unknown>;
  hash: string;
};

export type PoiConfig = {
  name: string;
  role?: string;
  jurisdiction?: string;
  party?: string;
  handles: {
    x?: string;
    truth?: string;
    bluesky?: string;
    youtubeChannelId?: string;
    youtubeHandle?: string;
    website?: string;
    rss?: string[];
  };
  ids: {
    bioguide?: string;
    fecCandidateId?: string;
    congress?: number;
    senateSession?: number;
    state?: string;
  };
};

export type SourceConfig = {
  enabled: boolean;
  intervalMinutes: number;
  options?: Record<string, unknown>;
};

export type Config = {
  version: 1;
  vault: string;
  poi: PoiConfig;
  provider: {
    id: string;
    kind: ProviderKind;
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens?: number;
  };
  transcription:
    | { enabled: true; providerId: string; kind: string; baseUrl: string; apiKey: string; model: string }
    | { enabled: false };
  sources: Record<string, SourceConfig>;
  agent: {
    autoStart: boolean;
    pollJitterSeconds: number;
    digestHour: number;
    quietHours: { start: number; end: number } | null;
    dailyTokenBudget: number;
    maxItemsPerCycle: number;
    backfillDays: number;
    synthesizeEveryNewItems: number;
  };
  createdAt: string;
  updatedAt: string;
};

export type SourceContext = {
  config: Config;
  state: AgentState;
  log: (msg: string) => void;
};

export type SourceAdapter = {
  id: string;
  label: string;
  description: string;
  /** why this source is allowed under the primary-source rule */
  primaryReason: string;
  requires: string[];
  defaultIntervalMinutes: number;
  poll: (ctx: SourceContext) => Promise<PrimaryEvent[]>;
};

export type AgentState = {
  lastRunAt?: string;
  nextRun: Record<string, string>;
  seen: Record<string, string>;
  lastSynthesisAt?: string;
  tokensUsedToday: number;
  tokenDay: string;
  lastError?: string;
  cycles: number;
  itemsCollected: number;
  pending?: string[];
  pid?: number;
};
