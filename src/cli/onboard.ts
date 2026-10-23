import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import type { Config, PoiConfig } from "../core/types.js";
import {
  DEFAULT_VAULT,
  configPath,
  defaultSources,
  exists,
  newConfig,
  saveConfig,
  ensureDirs,
} from "../core/config.js";
import { PROVIDERS, TRANSCRIPTION_PROVIDERS, providerById, transcriptionProviderById } from "../providers/catalog.js";
import { listModels } from "../core/llm.js";
import { scaffoldVault } from "../vault/vault.js";
import { installService } from "../core/service.js";
import { runCycle } from "../core/agent.js";
import { SOURCES } from "../sources/index.js";
import { resolveYouTubeChannelId } from "../sources/youtube.js";

export type OnboardFlags = {
  yes?: boolean;
  force?: boolean;
  vault?: string;
  name?: string;
  role?: string;
  jurisdiction?: string;
  party?: string;
  x?: string;
  truth?: string;
  bluesky?: string;
  youtube?: string;
  bioguide?: string;
  fec?: string;
  congress?: number;
  senateSession?: number;
  state?: string;
  rss?: string[];
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  transcription?: string;
  transcriptionKey?: string;
  transcriptionModel?: string;
  noTranscription?: boolean;
  autostart?: boolean;
};

function value(input: string | symbol, message?: string): string;
function value(input: boolean | symbol, message?: string): boolean;
function value<T>(input: T | symbol, message = "Cancelled."): T {
  if (typeof input === "symbol" || p.isCancel(input)) {
    p.cancel(message);
    process.exit(0);
  }
  return input as T;
}

function providerKindForTranscription(id: string): string {
  if (id === "google" || id === "gemini") return "gemini-audio";
  if (id === "deepgram") return "deepgram";
  return "openai-audio";
}

function defaultTranscriptionModel(providerId: string): string {
  if (providerId === "openai") return "whisper-1";
  if (providerId === "groq") return "whisper-large-v3";
  if (providerId === "deepinfra") return "openai/whisper-large-v3";
  if (providerId === "mistral") return "voxtral-mini-latest";
  if (providerId === "google" || providerId === "gemini") return "gemini-2.5-flash";
  if (providerId === "deepgram") return "nova-3";
  return "whisper-1";
}

export async function onboard(flags: OnboardFlags): Promise<void> {
  if (exists() && !flags.force) {
    p.intro(chalk.bold("journalism"));
    p.log.warn(`Config already exists at ${configPath()}. Use --force to redo onboarding.`);
    p.outro("Nothing changed.");
    return;
  }

  ensureDirs();
  p.intro(chalk.bold("journalism") + chalk.dim(" — a primary-source agent for one political person"));

  if (!flags.yes) {
    p.note(
      "This tool records only what the person says and does:\n" +
        "their own posts, their own speeches, their votes, their money.\n" +
        "No news. No aggregators. Every line in the vault is cited.",
      "The rule",
    );
    p.note(
      "You will need an API key from one of 30+ model providers.\n" +
        "The agent runs 24/7 and only calls the model when new records arrive.",
      "Before you start",
    );
  }

  // 1. vault
  let vault = flags.vault;
  if (!vault) {
    if (flags.yes) vault = DEFAULT_VAULT;
    else {
      vault = value(
        await p.text({
          message: "Where should the notes and transcripts live?",
          placeholder: DEFAULT_VAULT,
          defaultValue: DEFAULT_VAULT,
          initialValue: DEFAULT_VAULT,
        }),
      );
    }
  }
  vault = String(vault).replace(/^~(?=$|\/)/, process.env.HOME ?? "");
  fs.mkdirSync(vault, { recursive: true });

  // 2. provider
  let providerId = flags.provider;
  let provider = providerId ? providerById(providerId) : undefined;
  if (!provider) {
    if (flags.yes) {
      p.cancel("--provider is required with --yes (for example: --provider openai)");
      process.exit(1);
    }
    providerId = value(
      await p.autocomplete({
        message: "Which model provider?",
        maxItems: 12,
        options: PROVIDERS.map((pr) => ({
          value: pr.id,
          label: pr.name,
          hint: pr.kind === "openai" ? pr.baseUrl : pr.kind,
        })),
      }),
    );
    provider = providerById(providerId)!;
  }
  provider = provider!;
  providerId = providerId!;

  let baseUrl: string = flags.baseUrl || provider.baseUrl;
  if (provider.customBase && !flags.baseUrl && !flags.yes) {
    baseUrl = value(
      await p.text({
        message: "Endpoint base URL",
        placeholder: provider.baseUrl || "https://.../v1",
        defaultValue: provider.baseUrl,
        validate: (v) => (v && v.startsWith("http") ? undefined : "Must start with http"),
      }),
    );
  }

  let apiKey: string = flags.apiKey ?? "";
  if (!apiKey) {
    if (provider.id === "ollama" || provider.id === "lmstudio" || provider.id === "vllm") {
      apiKey = "local";
    } else if (flags.yes) {
      p.cancel("--api-key is required with --yes");
      process.exit(1);
    } else {
      apiKey = value(
        await p.password({
          message: `Paste your ${provider.name} API key`,
          validate: (v) => (v && v.length > 7 ? undefined : "That looks too short"),
        }),
      );
    }
  }

  let models: string[] = [];
  const spin = p.spinner();
  spin.start(`Checking ${provider.name}`);
  models = await listModels({ kind: provider.kind, baseUrl, apiKey });
  spin.stop(models.length ? `Connected. ${models.length} models available.` : "Could not list models. You can still type a model name.");

  let model: string = flags.model ?? "";
  if (!model) {
    if (flags.yes) {
      model = provider.defaultModel;
    } else if (models.length) {
      const sorted = [...new Set([...provider.suggestedModels.filter((m) => models.includes(m)), ...models])].slice(0, 80);
      const pick = value(
        await p.autocomplete({
          message: "Default model",
          maxItems: 12,
          options: sorted.map((m) => ({ value: m, label: m })),
        }),
      );
      model = pick as string;
    } else {
      model = value(
        await p.text({
          message: "Model name",
          placeholder: provider.defaultModel || "model-id",
          defaultValue: provider.defaultModel,
          initialValue: provider.defaultModel,
        }),
      );
    }
  }

  // 3. transcription
  let transcription: Config["transcription"] = { enabled: false };
  const supports = provider.supportsTranscription && ["openai", "groq", "deepinfra", "mistral", "google"].includes(provider.id);
  if (!flags.noTranscription) {
    if (flags.transcription) {
      const tp = transcriptionProviderById(flags.transcription)!;
      transcription = {
        enabled: true,
        providerId: tp.id,
        kind: tp.kind,
        baseUrl: tp.baseUrl,
        apiKey: flags.transcriptionKey || apiKey,
        model: flags.transcriptionModel || tp.defaultModel,
      };
    } else if (flags.yes) {
      transcription = supports
        ? {
            enabled: true,
            providerId: provider.id,
            kind: providerKindForTranscription(provider.id),
            baseUrl,
            apiKey,
            model: defaultTranscriptionModel(provider.id),
          }
        : { enabled: false };
    } else {
      if (supports) {
        const use = value(
          await p.confirm({
            message: `${provider.name} can transcribe audio. Use it to turn speeches into text?`,
            initialValue: true,
          }),
        );
        if (use) {
          transcription = {
            enabled: true,
            providerId: provider.id,
            kind: providerKindForTranscription(provider.id),
            baseUrl,
            apiKey,
            model: defaultTranscriptionModel(provider.id),
          };
        }
      }
      if (!transcription.enabled) {
        const want = value(
          await p.confirm({
            message: "Use a separate transcription API? (Deepgram, Groq, OpenAI, Gemini, Mistral)",
            initialValue: false,
          }),
        );
        if (want) {
          const tpId = value(
            await p.select({
              message: "Transcription provider",
              options: TRANSCRIPTION_PROVIDERS.map((tp) => ({ value: tp.id, label: tp.name })),
            }),
          );
          const tp = transcriptionProviderById(tpId)!;
          const key = value(
            await p.password({
              message: `Paste your ${tp.name} API key`,
              validate: (v) => (v && v.length > 7 ? undefined : "Too short"),
            }),
          );
          transcription = {
            enabled: true,
            providerId: tp.id,
            kind: tp.kind,
            baseUrl: tp.baseUrl,
            apiKey: key,
            model: tp.defaultModel,
          };
        }
      }
    }
  }

  // 4. person of interest
  let name = flags.name;
  if (!name) {
    if (flags.yes) {
      p.cancel("--name is required with --yes");
      process.exit(1);
    }
    name = value(await p.text({ message: "Who is the person of interest?", placeholder: "e.g. Alexandria Ocasio-Cortez" }));
  }

  let role = flags.role;
  let jurisdiction = flags.jurisdiction;
  let party = flags.party;
  let x = flags.x;
  let truth = flags.truth;
  let bluesky = flags.bluesky;
  let youtube = flags.youtube;
  let bioguide = flags.bioguide;
  let fec = flags.fec;
  let congress = flags.congress;
  let senateSession = flags.senateSession;
  let state = flags.state;
  let rss = flags.rss ?? [];

  if (!flags.yes) {
    role = role || value(await p.text({ message: "Role or office (optional)", placeholder: "U.S. Senator, Governor, candidate" }));
    jurisdiction = jurisdiction || value(await p.text({ message: "Jurisdiction (optional)", placeholder: "Arizona, US Senate, federal" }));
    party = party || value(await p.text({ message: "Party (optional)", placeholder: "Independent" }));
    p.note("Leave any account blank if it does not apply.", "Accounts");
    x = x || value(await p.text({ message: "X / Twitter handle", placeholder: "@handle" }));
    truth = truth || value(await p.text({ message: "Truth Social handle", placeholder: "@handle" }));
    bluesky = bluesky || value(await p.text({ message: "Bluesky handle", placeholder: "name.bsky.social" }));
    youtube = youtube || value(await p.text({ message: "YouTube channel URL, @handle or channel ID", placeholder: "https://youtube.com/@handle" }));
  }

  if (youtube && !youtube.startsWith("UC") && youtube.length !== 24) {
    const spin2 = p.spinner();
    spin2.start("Resolving YouTube channel");
    const resolved = await resolveYouTubeChannelId(youtube);
    spin2.stop(resolved ? `Channel ${resolved}` : "Could not resolve the channel. Paste the UC… channel ID later.");
    if (resolved) youtube = resolved;
  }

  if (!flags.yes) {
    p.note(
      "Congress.gov and FEC keys are free. They unlock the voting and money records.\n" +
        "Bioguide ID looks like A000370. FEC candidate ID looks like H8NY15148.",
      "Official record IDs (optional)",
    );
    bioguide = bioguide || value(await p.text({ message: "Bioguide ID", placeholder: "A000370" }));
    fec = fec || value(await p.text({ message: "FEC candidate ID", placeholder: "H8NY15148" }));
    const c = value(await p.text({ message: "Congress number", placeholder: "119", defaultValue: "119", initialValue: "119" }));
    congress = congress ?? (Number(c) || 119);
    const s = value(await p.text({ message: "Senate session (1 or 2)", placeholder: "2", defaultValue: "2", initialValue: "2" }));
    senateSession = senateSession ?? (Number(s) || 2);
    state = state || value(await p.text({ message: "State code for vote matching", placeholder: "AZ" }));
    const feeds = value(await p.text({ message: "Official RSS feeds, comma separated (optional)", placeholder: "" }));
    rss = rss.concat(
      String(feeds)
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean),
    );
  } else {
    congress = congress ?? 119;
    senateSession = senateSession ?? 2;
  }

  const poi: PoiConfig = {
    name,
    role: role || undefined,
    jurisdiction: jurisdiction || undefined,
    party: party || undefined,
    handles: {
      x: x?.replace(/^@/, "") || undefined,
      truth: truth?.replace(/^@/, "") || undefined,
      bluesky: bluesky?.replace(/^@/, "") || undefined,
      youtubeChannelId: youtube || undefined,
      rss: rss.length ? rss : undefined,
    },
    ids: {
      bioguide: bioguide || undefined,
      fecCandidateId: fec || undefined,
      congress: bioguide ? congress : undefined,
      senateSession: bioguide ? senateSession : undefined,
      state: state?.toUpperCase() || undefined,
    },
  };

  // 5. source keys
  const sourceOptions: Record<string, Record<string, unknown>> = {};
  if (!flags.yes) {
    if (poi.handles.x) {
      const token = value(await p.password({ message: "X API bearer token (required for X posts)", validate: (v) => (v ? undefined : "Required for X") }));
      sourceOptions.x = { token };
    }
    if (poi.ids.bioguide) {
      const key = value(await p.text({ message: "Congress.gov API key", placeholder: "free from api.congress.gov" }));
      if (key) sourceOptions.congress = { apiKey: key };
    }
    if (poi.ids.fecCandidateId) {
      const key = value(await p.text({ message: "FEC API key", placeholder: "free from api.open.fec.gov" }));
      if (key) sourceOptions.fec = { apiKey: key };
    }
  } else {
    if (process.env.X_BEARER_TOKEN) sourceOptions.x = { token: process.env.X_BEARER_TOKEN };
    if (process.env.CONGRESS_API_KEY) sourceOptions.congress = { apiKey: process.env.CONGRESS_API_KEY };
    if (process.env.FEC_API_KEY) sourceOptions.fec = { apiKey: process.env.FEC_API_KEY };
  }

  const sources = defaultSources(poi);
  for (const [id, opts] of Object.entries(sourceOptions)) {
    if (sources[id]) sources[id].options = opts;
  }

  // 6. autostart
  let autoStart = flags.autostart ?? true;
  if (flags.autostart === undefined && !flags.yes) {
    autoStart = value(
      await p.confirm({
        message: "Start the agent automatically when this computer boots?",
        initialValue: true,
      }),
    );
  }

  const draft = newConfig({ vault, poi, provider: { id: provider.id, kind: provider.kind, baseUrl, apiKey, model }, transcription, autoStart });
  draft.sources = sources;

  if (!flags.yes) {
    const enabled = SOURCES.filter((s) => sources[s.id]?.enabled).map((s) => s.label);
    const lines = [
      `Person: ${poi.name}${poi.role ? ` — ${poi.role}` : ""}`,
      `Vault: ${draft.vault}`,
      `Model: ${provider.name} / ${model}`,
      `Transcription: ${transcription.enabled ? transcription.model : "off"}`,
      `Auto-start: ${autoStart ? "yes" : "no"}`,
      `Sources: ${enabled.length ? enabled.join(", ") : "none yet"}`,
    ];
    p.note(lines.join("\n"), "Ready");
    const ok = value(await p.confirm({ message: "Write this config and build the vault?", initialValue: true }));
    if (!ok) {
      p.outro("Nothing written.");
      return;
    }
  }

  saveConfig(draft);
  const created = scaffoldVault(draft);
  p.log.success(`Config: ${configPath()}`);
  p.log.success(`Vault: ${draft.vault} (${created.length} files created)`);

  if (autoStart) {
    const svc = installService(draft);
    if (svc.ok) p.log.success(svc.message);
    else p.log.warn(svc.message);
  }

  if (!flags.yes) {
    const runNow = value(await p.confirm({ message: "Collect the first batch of records now?", initialValue: true }));
    if (runNow) {
      const spin3 = p.spinner();
      spin3.start("Collecting primary records");
      const result = await runCycle(draft, { force: true });
      spin3.stop(`Collected ${result.added.length} new records, wrote ${result.synthesized} notes.`);
      if (result.errors.length) {
        for (const e of result.errors) p.log.warn(`${e.source}: ${e.message}`);
      }
    }
  }

  p.outro(
    chalk.bold("Done.") +
      `\n\n  ${chalk.cyan("journalism status")}     see what the agent is doing` +
      `\n  ${chalk.cyan("journalism ask \"...\"")}  question the record` +
      `\n  ${chalk.cyan("journalism digest")}     today's briefing` +
      `\n  Open ${draft.vault} in Obsidian.\n`,
  );
}
