import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentState, Config } from "./types.js";

export const APP_VERSION = "0.1.0";

export function homeDir(): string {
  return process.env.JOURNALISM_HOME || path.join(os.homedir(), ".journalism");
}

export function configPath(): string {
  return path.join(homeDir(), "config.json");
}

export function dataDir(): string {
  return path.join(homeDir(), "data");
}

export function statePath(): string {
  return path.join(dataDir(), "state.json");
}

export function eventsPath(): string {
  return path.join(dataDir(), "events.jsonl");
}

export function rawDir(): string {
  return path.join(dataDir(), "raw");
}

export function logPath(): string {
  return path.join(homeDir(), "logs", "agent.log");
}

export function pidPath(): string {
  return path.join(homeDir(), "agent.pid");
}

export const DEFAULT_VAULT = path.join(os.homedir(), "JournalismVault");

export const DEFAULT_INTERVALS: Record<string, number> = {
  x: 30,
  truthsocial: 30,
  bluesky: 30,
  youtube: 120,
  congress: 720,
  "senate-votes": 360,
  "house-votes": 360,
  fec: 1440,
  rss: 60,
};

const ConfigSchema = z.object({
  version: z.literal(1),
  vault: z.string().min(1),
  poi: z.object({
    name: z.string().min(1),
    role: z.string().optional(),
    jurisdiction: z.string().optional(),
    party: z.string().optional(),
    handles: z.object({
      x: z.string().optional(),
      truth: z.string().optional(),
      bluesky: z.string().optional(),
      youtubeChannelId: z.string().optional(),
      youtubeHandle: z.string().optional(),
      website: z.string().optional(),
      rss: z.array(z.string()).optional(),
    }),
    ids: z.object({
      bioguide: z.string().optional(),
      fecCandidateId: z.string().optional(),
      congress: z.number().optional(),
      senateSession: z.number().optional(),
      state: z.string().optional(),
      chamber: z.enum(["house", "senate"]).optional(),
    }),
  }),
  provider: z.object({
    id: z.string(),
    kind: z.enum(["openai", "anthropic", "gemini", "cohere"]),
    baseUrl: z.string(),
    apiKey: z.string(),
    model: z.string(),
    maxTokens: z.number().optional(),
  }),
  transcription: z.union([
    z.object({
      enabled: z.literal(true),
      providerId: z.string(),
      kind: z.string(),
      baseUrl: z.string(),
      apiKey: z.string(),
      model: z.string(),
    }),
    z.object({ enabled: z.literal(false) }),
  ]),
  sources: z.record(
    z.string(),
    z.object({
      enabled: z.boolean(),
      intervalMinutes: z.number().min(5),
      options: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  agent: z.object({
    autoStart: z.boolean(),
    pollJitterSeconds: z.number().min(0),
    digestHour: z.number().min(0).max(23),
    quietHours: z
      .object({ start: z.number().min(0).max(23), end: z.number().min(0).max(23) })
      .nullable(),
    dailyTokenBudget: z.number().min(0),
    maxItemsPerCycle: z.number().min(1),
    backfillDays: z.number().min(1),
    synthesizeEveryNewItems: z.number().min(1),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function exists(): boolean {
  return fs.existsSync(configPath());
}

export function ensureDirs(): void {
  for (const dir of [homeDir(), dataDir(), rawDir(), path.join(homeDir(), "logs")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): Config {
  const raw = fs.readFileSync(configPath(), "utf8");
  return ConfigSchema.parse(JSON.parse(raw)) as Config;
}

export function tryLoadConfig(): Config | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

export function saveConfig(config: Config): void {
  ensureDirs();
  config.updatedAt = new Date().toISOString();
  const tmp = `${configPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, configPath());
  try {
    fs.chmodSync(configPath(), 0o600);
  } catch {
    /* windows */
  }
}

export function defaultState(): AgentState {
  return {
    nextRun: {},
    seen: {},
    tokensUsedToday: 0,
    tokenDay: new Date().toISOString().slice(0, 10),
    cycles: 0,
    itemsCollected: 0,
    pending: [],
  };
}

export function loadState(): AgentState {
  ensureDirs();
  try {
    return { ...defaultState(), ...(JSON.parse(fs.readFileSync(statePath(), "utf8")) as AgentState) };
  } catch {
    return defaultState();
  }
}

export function saveState(state: AgentState): void {
  ensureDirs();
  const tmp = `${statePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, statePath());
}

export function defaultSources(poi: Config["poi"]): Config["sources"] {
  return {
    x: { enabled: Boolean(poi.handles.x), intervalMinutes: 30 },
    truthsocial: { enabled: Boolean(poi.handles.truth), intervalMinutes: 30 },
    bluesky: { enabled: Boolean(poi.handles.bluesky), intervalMinutes: 30 },
    youtube: { enabled: Boolean(poi.handles.youtubeChannelId), intervalMinutes: 120 },
    congress: { enabled: Boolean(poi.ids.bioguide), intervalMinutes: 720 },
    "senate-votes": {
      enabled: Boolean(poi.ids.bioguide && poi.ids.congress && poi.ids.chamber === "senate"),
      intervalMinutes: 360,
    },
    "house-votes": {
      enabled: Boolean(poi.ids.bioguide && poi.ids.congress && poi.ids.chamber !== "senate"),
      intervalMinutes: 360,
    },
    fec: { enabled: Boolean(poi.ids.fecCandidateId), intervalMinutes: 1440 },
    rss: { enabled: Boolean(poi.handles.rss?.length), intervalMinutes: 60 },
  };
}

export function newConfig(input: {
  vault: string;
  poi: Config["poi"];
  provider: Config["provider"];
  transcription: Config["transcription"];
  autoStart: boolean;
}): Config {
  const now = new Date().toISOString();
  return {
    version: 1,
    vault: path.resolve(input.vault.replace(/^~(?=$|\/)/, os.homedir())),
    poi: input.poi,
    provider: input.provider,
    transcription: input.transcription,
    sources: defaultSources(input.poi),
    agent: {
      autoStart: input.autoStart,
      pollJitterSeconds: 90,
      digestHour: 8,
      quietHours: null,
      dailyTokenBudget: 250_000,
      maxItemsPerCycle: 40,
      backfillDays: 30,
      synthesizeEveryNewItems: 1,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function requireConfig(): Config {
  if (!exists()) {
    throw new Error("No config found. Run `journalism onboard` first.");
  }
  return loadConfig();
}
