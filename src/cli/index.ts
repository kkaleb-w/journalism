#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import type { Config, PrimaryEvent } from "../core/types.js";
import {
  APP_VERSION,
  configPath,
  dataDir,
  ensureDirs,
  exists,
  loadConfig,
  loadState,
  saveConfig,
  tryLoadConfig,
} from "../core/config.js";
import { loadEvents, ingestEvents, newEvent, invalidateCache } from "../core/store.js";
import { ask, digest, synthesize } from "../core/memory.js";
import { runCycle, runForeground, agentRunning, logLine } from "../core/agent.js";
import { installService, uninstallService, serviceStatus } from "../core/service.js";
import { enabledSources, sourceById, sourceSummary, SOURCES } from "../sources/index.js";
import { onboard } from "./onboard.js";
import { doctor } from "./doctor.js";
import { scaffoldVault, ensureVaultDirs } from "../vault/vault.js";
import { fetchYouTubeTranscript, resolveYouTubeChannelId, transcribeUrl, downloadYouTubeAudio } from "../sources/youtube.js";
import { downloadToTmp, transcribeAudioLong, transcribeFile } from "../core/transcribe.js";
import { isOfficialDomain, truncate } from "../core/util.js";
import { exportSite } from "../core/site.js";

const program = new Command();

program
  .name("journalism")
  .description("Primary-source agent for one political person of interest")
  .version(APP_VERSION)
  .showHelpAfterError();

program
  .command("onboard")
  .description("set up the vault, model provider, transcription and person of interest")
  .option("--yes", "non-interactive with flags")
  .option("--force", "overwrite an existing config")
  .option("--vault <dir>", "notes directory")
  .option("--name <name>", "person of interest")
  .option("--role <role>", "role or office")
  .option("--jurisdiction <place>", "jurisdiction")
  .option("--party <party>", "party")
  .option("--x <handle>", "X handle")
  .option("--truth <handle>", "Truth Social handle")
  .option("--bluesky <handle>", "Bluesky handle")
  .option("--youtube <url|handle|id>", "YouTube channel")
  .option("--bioguide <id>", "Bioguide ID")
  .option("--chamber <chamber>", "house or senate")
  .option("--fec <id>", "FEC candidate ID")
  .option("--congress <n>", "Congress number", (v) => Number(v), 119)
  .option("--senate-session <n>", "Senate session", (v) => Number(v), 2)
  .option("--state <code>", "state code for vote matching")
  .option("--rss <url>", "official RSS feed (repeatable)", (v, prev: string[]) => [...prev, v], [])
  .option("--provider <id>", "provider id (openai, anthropic, google, deepseek, ...)")
  .option("--api-key <key>", "provider API key")
  .option("--model <model>", "default model")
  .option("--base-url <url>", "custom endpoint")
  .option("--transcription <id>", "transcription provider id")
  .option("--transcription-key <key>", "transcription API key")
  .option("--transcription-model <model>", "transcription model")
  .option("--no-transcription", "disable speech transcription")
  .option("--autostart", "install auto-start (default)")
  .option("--no-autostart", "do not install auto-start")
  .action(async (opts) => {
    await onboard({
      yes: opts.yes,
      force: opts.force,
      vault: opts.vault,
      name: opts.name,
      role: opts.role,
      jurisdiction: opts.jurisdiction,
      party: opts.party,
      x: opts.x,
      truth: opts.truth,
      bluesky: opts.bluesky,
      youtube: opts.youtube,
      bioguide: opts.bioguide,
      chamber: opts.chamber,
      fec: opts.fec,
      congress: opts.congress,
      senateSession: opts.senateSession,
      state: opts.state,
      rss: opts.rss,
      provider: opts.provider,
      apiKey: opts.apiKey,
      model: opts.model,
      baseUrl: opts.baseUrl,
      transcription: typeof opts.transcription === "string" ? opts.transcription : undefined,
      transcriptionKey: opts.transcriptionKey,
      transcriptionModel: opts.transcriptionModel,
      noTranscription: opts.transcription === false,
      autostart: opts.autostart,
    });
  });

program
  .command("start")
  .description("run the tracker (foreground). Use --once for a single cycle")
  .option("--once", "run one cycle and exit")
  .option("--foreground", "accepted for service compatibility")
  .option("--force", "ignore schedules and poll every enabled source now")
  .option("--source <id>", "only this source")
  .action(async (opts) => {
    const config = requireConfigOrExit();
    if (opts.once) {
      const result = await runCycle(config, { force: Boolean(opts.force), only: opts.source ? [opts.source] : undefined });
      printCycle(result);
      return;
    }
    await runForeground(config);
  });

program
  .command("status")
  .description("show tracker, source and memory status")
  .action(async () => {
    const config = requireConfigOrExit();
    renderStatus(config);
  });

program
  .command("digest")
  .description("write today's briefing from the last 24 hours")
  .option("--hours <n>", "lookback window", (v) => Number(v), 24)
  .action(async (opts) => {
    const config = requireConfigOrExit();
    const out = await digest(config, opts.hours);
    console.log(out);
  });

program
  .command("ask")
  .argument("<question...>", "question for the record")
  .description("answer a question using only collected primary records")
  .action(async (parts: string[]) => {
    const config = requireConfigOrExit();
    const out = await ask(config, parts.join(" "));
    console.log(out);
  });

program
  .command("ingest")
  .argument("<urlOrFile>", "official page, audio file, video or transcript")
  .description("add one primary source by hand")
  .option("--title <title>", "title")
  .option("--force", "allow a non-official domain")
  .action(async (target: string, opts) => {
    const config = requireConfigOrExit();
    const ev = await ingestManual(config, target, opts.title, Boolean(opts.force));
    const result = ingestEvents([ev]);
    console.log(chalk.green(`Added ${result.added.length} record${result.added.length === 1 ? "" : "s"}.`));
    if (result.added.length) {
      const spin = chalk.dim("writing memory…");
      process.stdout.write(spin + "\r");
      try {
        const out = await synthesize(config, result.added);
        process.stdout.write(" ".repeat(spin.length) + "\r");
        console.log(chalk.green(`Memory updated (${out.written} notes).`));
      } catch (err) {
        process.stdout.write(" ".repeat(spin.length) + "\r");
        console.log(chalk.yellow(`Memory update failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  });

program
  .command("sources")
  .argument("[action]", "list | enable | disable")
  .argument("[id]", "source id")
  .description("list or toggle sources")
  .action((action = "list", id?: string) => {
    const config = requireConfigOrExit();
    if (action === "list") {
      for (const s of sourceSummary(config)) {
        const mark = s.enabled ? chalk.green("●") : chalk.dim("○");
        console.log(`${mark} ${s.id.padEnd(14)} ${String(s.interval).padStart(4)}m  ${chalk.dim(SOURCES.find((x) => x.id === s.id)?.description ?? "")}`);
      }
      return;
    }
    if (!id) {
      console.log("Usage: journalism sources enable|disable <id>");
      return;
    }
    const adapter = sourceById(id);
    if (!adapter || !config.sources[id]) {
      console.log(chalk.red(`Unknown source: ${id}`));
      process.exitCode = 1;
      return;
    }
    config.sources[id].enabled = action === "enable";
    saveConfig(config);
    console.log(`${id}: ${action === "enable" ? "enabled" : "disabled"}`);
  });

program
  .command("config")
  .argument("[action]", "show | get | set")
  .argument("[key]")
  .argument("[value]")
  .description("inspect or edit config")
  .action((action = "show", key?: string, value?: string) => {
    const config = requireConfigOrExit();
    if (action === "show" || !action) {
      console.log(JSON.stringify(redact(config), null, 2));
      return;
    }
    if (action === "get" && key) {
      console.log(JSON.stringify(getPath(config, key), null, 2));
      return;
    }
    if (action === "set" && key && value !== undefined) {
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {
        /* keep string */
      }
      setPath(config as unknown as Record<string, unknown>, key, parsed);
      saveConfig(config);
      console.log(`${key} = ${JSON.stringify(parsed)}`);
      return;
    }
    console.log("Usage: journalism config show | get <key> | set <key> <value>");
  });

program
  .command("service")
  .argument("[action]", "status | install | uninstall")
  .description("manage auto-start")
  .action((action = "status") => {
    const config = requireConfigOrExit();
    if (action === "install") {
      const r = installService(config);
      console.log(r.ok ? chalk.green(r.message) : chalk.yellow(r.message));
      return;
    }
    if (action === "uninstall") {
      const r = uninstallService();
      console.log(r.ok ? chalk.green(r.message) : chalk.yellow(r.message));
      return;
    }
    const s = serviceStatus();
    console.log(`installed: ${s.installed ? "yes" : "no"}\nrunning:   ${s.running ? "yes" : "no"}\n${chalk.dim(s.detail)}`);
  });

program
  .command("doctor")
  .description("check install, provider, vault and sources")
  .action(async () => {
    process.exitCode = await doctor();
  });

program
  .command("export")
  .description("build a static, readable HTML site from the vault")
  .option("--out <dir>", "output directory", "./journalism-site")
  .action((opts) => {
    const config = requireConfigOrExit();
    const result = exportSite(config, opts.out);
    console.log(chalk.green(`Wrote ${result.file} (${result.records} records)`));
  });

program
  .command("vault")
  .description("print the vault path and open instructions")
  .action(() => {
    const config = requireConfigOrExit();
    ensureVaultDirs(config);
    console.log(config.vault);
  });

program.action(async () => {
  if (!exists()) {
    await onboard({});
    return;
  }
  renderStatus(loadConfig());
});

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});

function requireConfigOrExit(): Config {
  const config = tryLoadConfig();
  if (!config) {
    console.error(chalk.red("No config found. Run `journalism onboard` first."));
    process.exit(1);
  }
  return config;
}

function renderStatus(config: Config): void {
  const state = loadState();
  const idx = loadEvents();
  const counts = new Map<string, number>();
  for (const e of idx.all) counts.set(e.sourceType, (counts.get(e.sourceType) ?? 0) + 1);
  const running = agentRunning();
  const svc = serviceStatus();
  const last = state.lastRunAt ? new Date(state.lastRunAt).toLocaleString() : "never";

  console.log("");
  console.log(chalk.bold(`journalism ${APP_VERSION}`) + chalk.dim(`  ${configPath()}`));
  console.log(`${chalk.dim("person")}   ${chalk.bold(config.poi.name)}${config.poi.role ? chalk.dim(` — ${config.poi.role}`) : ""}`);
  console.log(`${chalk.dim("vault")}    ${config.vault}`);
  console.log(`${chalk.dim("model")}    ${config.provider.model} ${chalk.dim(`(${config.provider.id})`)}`);
  console.log(
    `${chalk.dim("agent")}    ${
      running.running ? chalk.green(`running (pid ${running.pid})`) : svc.running ? chalk.green("running (service)") : chalk.yellow("stopped")
    }  ${chalk.dim(`last cycle ${last}`)}`,
  );
  console.log(
    `${chalk.dim("records")}  ${idx.all.length} total  ${[...counts.entries()].map(([k, v]) => `${v} ${k}`).join(", ") || "none"}`,
  );
  console.log(
    `${chalk.dim("memory")}   ${state.pending?.length ?? 0} pending  ${chalk.dim(`${state.tokensUsedToday.toLocaleString()} / ${config.agent.dailyTokenBudget.toLocaleString()} tokens today`)}`,
  );
  if (state.lastError) console.log(chalk.red(`last error: ${state.lastError}`));
  console.log("");
  for (const s of sourceSummary(config)) {
    if (!s.enabled) continue;
    const next = state.nextRun[s.id];
    const nextLabel = next ? new Date(next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "now";
    console.log(`  ${chalk.green("●")} ${s.id.padEnd(14)} ${String(s.interval).padStart(4)}m  ${chalk.dim(`next ${nextLabel}`)}`);
  }
  console.log("");
}

function printCycle(result: Awaited<ReturnType<typeof runCycle>>): void {
  console.log(chalk.bold(`\n${result.added.length} new records`));
  for (const ev of result.added.slice(0, 20)) {
    console.log(`  ${chalk.dim(ev.publishedAt.slice(0, 10))} ${ev.sourceLabel.padEnd(22)} ${truncate(ev.title, 70)}`);
  }
  if (result.added.length > 20) console.log(chalk.dim(`  … ${result.added.length - 20} more`));
  console.log(chalk.dim(`sources run: ${result.ran.join(", ") || "none"} · synthesized ${result.synthesized} · pending ${result.pending}`));
  for (const e of result.errors) console.log(chalk.red(`  ${e.source}: ${e.message}`));
  console.log("");
}

async function ingestManual(config: Config, target: string, title?: string, force = false): Promise<PrimaryEvent> {
  const isUrl = /^https?:\/\//.test(target);
  if (!isUrl && !fs.existsSync(target)) throw new Error(`File not found: ${target}`);

  if (isUrl && !isOfficialDomain(target) && !force) {
    throw new Error(
      "Refusing a non-official domain. This tool only takes primary records. Use --force only for the person's own campaign site.",
    );
  }

  let text = "";
  let sourceType: PrimaryEvent["sourceType"] = "statement";
  let meta: Record<string, unknown> = {};

  if (isUrl && /(?:youtube\.com|youtu\.be)/.test(target)) {
    const id = target.match(/(?:v=|youtu\.be\/)([\w-]{11})/)?.[1];
    if (!id) throw new Error("Could not read the YouTube video id");
    const transcript = await fetchYouTubeTranscript(id);
    if (transcript) {
      text = transcript;
      sourceType = "speech";
      meta = { videoId: id, transcript: "youtube-captions" };
    } else if (config.transcription.enabled) {
      const audio = (await downloadYouTubeAudio(id)) ?? (await downloadToTmp(target, `yt-${id}`));
      const t = await transcribeAudioLong(config, audio);
      text = t.text;
      sourceType = "speech";
      meta = { videoId: id, transcript: `${t.provider}/${t.model}` };
    } else {
      throw new Error("No captions on that video and transcription is off.");
    }
  } else if (isUrl && /\.(mp3|m4a|wav|ogg|webm|mp4)(\?|$)/i.test(target)) {
    if (!config.transcription.enabled) throw new Error("Transcription is off, cannot process audio.");
    const audio = await downloadToTmp(target, "ingest");
    const t = await transcribeFile(config, audio);
    text = t.text;
    sourceType = "speech";
    meta = { transcript: `${t.provider}/${t.model}` };
  } else if (!isUrl) {
    const ext = path.extname(target).toLowerCase();
    if ([".mp3", ".m4a", ".wav", ".ogg", ".webm", ".mp4"].includes(ext)) {
      if (!config.transcription.enabled) throw new Error("Transcription is off, cannot process audio.");
      const t = await transcribeAudioLong(config, target);
      text = t.text;
      sourceType = "speech";
      meta = { transcript: `${t.provider}/${t.model}`, file: path.basename(target) };
    } else {
      text = fs.readFileSync(target, "utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      meta = { file: path.basename(target) };
    }
  } else {
    const res = await fetch(target, { headers: { "user-agent": "journalism-cli/0.1" }, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const main = html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
    text = main
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    sourceType = "statement";
    meta = { url: target };
  }

  if (!text.trim()) throw new Error("Nothing to store: empty text");
  return newEvent({
    id: `manual:${Date.now()}`,
    source: "manual",
    sourceType,
    sourceLabel: sourceType === "speech" ? "Transcript" : "Official document",
    title: title || (isUrl ? new URL(target).pathname.split("/").filter(Boolean).pop() || target : path.basename(target)),
    text: truncate(text, 120_000),
    url: isUrl ? target : `file://${path.resolve(target)}`,
    publishedAt: new Date().toISOString(),
    meta,
  });
}

function redact(config: Config): unknown {
  const clone = JSON.parse(JSON.stringify(config)) as Config;
  clone.provider.apiKey = mask(clone.provider.apiKey);
  if (clone.transcription.enabled) clone.transcription.apiKey = mask(clone.transcription.apiKey);
  for (const s of Object.values(clone.sources)) {
    if (s.options?.token) s.options.token = mask(String(s.options.token));
    if (s.options?.apiKey) s.options.apiKey = mask(String(s.options.apiKey));
  }
  return clone;
}

function mask(s: string): string {
  if (!s) return "";
  return s.length <= 8 ? "••••" : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function getPath(obj: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], obj);
}

function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (typeof next !== "object" || next === null) cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}
