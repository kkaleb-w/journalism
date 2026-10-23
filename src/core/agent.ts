import fs from "node:fs";
import type { Config, PrimaryEvent, SourceAdapter } from "./types.js";
import { loadState, saveState, logPath, pidPath, ensureDirs } from "./config.js";
import { ingestEvents, loadEvents } from "./store.js";
import { enabledSources, sourceById } from "../sources/index.js";
import { synthesize } from "./memory.js";
import { tokensLeftToday } from "./llm.js";
import { mapLimit, sleep } from "./util.js";

export type CycleResult = {
  ran: string[];
  added: PrimaryEvent[];
  skipped: number;
  errors: { source: string; message: string }[];
  synthesized: number;
  pending: number;
};

export function logLine(msg: string): void {
  ensureDirs();
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(logPath(), line);
  } catch {
    /* ignore */
  }
  if (process.env.JOURNALISM_QUIET !== "1") process.stdout.write(line);
}

function isDue(next: string | undefined, intervalMinutes: number, force: boolean): boolean {
  if (force || !next) return true;
  return Date.now() >= new Date(next).getTime();
}

export async function runCycle(
  config: Config,
  opts: { force?: boolean; only?: string[]; synthesize?: boolean } = {},
): Promise<CycleResult> {
  const state = loadState();
  const sources = enabledSources(config).filter((s) => !opts.only?.length || opts.only.includes(s.id));
  const due = sources.filter((s) => isDue(state.nextRun[s.id], config.sources[s.id].intervalMinutes, Boolean(opts.force)));
  const result: CycleResult = { ran: [], added: [], skipped: 0, errors: [], synthesized: 0, pending: state.pending?.length ?? 0 };

  await mapLimit(due, 2, async (source: SourceAdapter) => {
    const started = Date.now();
    try {
      logLine(`poll ${source.id}`);
      const events = await source.poll({ config, state, log: (m) => logLine(`  ${source.id}: ${m}`) });
      const capped = events.slice(0, config.agent.maxItemsPerCycle);
      const ingest = ingestEvents(capped);
      result.ran.push(source.id);
      result.added.push(...ingest.added);
      result.skipped += ingest.skipped;
      state.pending = [...(state.pending ?? []), ...ingest.added.map((e) => e.id)];
      state.itemsCollected = (state.itemsCollected ?? 0) + ingest.added.length;
      const jitter = Math.floor(Math.random() * config.agent.pollJitterSeconds * 1000);
      state.nextRun[source.id] = new Date(
        Date.now() + config.sources[source.id].intervalMinutes * 60_000 + jitter,
      ).toISOString();
      logLine(`  ${source.id}: ${ingest.added.length} new, ${ingest.skipped} seen (${Date.now() - started}ms)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ source: source.id, message });
      state.lastError = `${source.id}: ${message}`;
      // back off, do not hammer a broken source
      state.nextRun[source.id] = new Date(Date.now() + Math.max(10, config.sources[source.id].intervalMinutes) * 60_000).toISOString();
      logLine(`  ${source.id}: ERROR ${message}`);
    }
    saveState(state);
  });

  if (opts.synthesize !== false && (state.pending?.length ?? 0) >= config.agent.synthesizeEveryNewItems) {
    if (tokensLeftToday(config.agent.dailyTokenBudget) < 8000) {
      logLine("synthesis paused: daily token budget spent");
    } else {
      const idx = loadEvents();
      const batch = (state.pending ?? [])
        .map((id) => idx.byId.get(id))
        .filter((e): e is PrimaryEvent => Boolean(e))
        .sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : 1))
        .slice(0, 24);
      if (batch.length) {
        try {
          const out = await synthesize(config, batch);
          const done = new Set(batch.map((e) => e.id));
          state.pending = (state.pending ?? []).filter((id) => !done.has(id));
          state.lastSynthesisAt = new Date().toISOString();
          result.synthesized = out.written;
          logLine(`memory: wrote ${out.written} notes from ${batch.length} records`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push({ source: "memory", message });
          logLine(`memory: ERROR ${message}`);
        }
      }
    }
  }

  state.cycles = (state.cycles ?? 0) + 1;
  state.lastRunAt = new Date().toISOString();
  result.pending = state.pending?.length ?? 0;
  saveState(state);
  return result;
}

function quietNow(config: Config): boolean {
  const q = config.agent.quietHours;
  if (!q) return false;
  const h = new Date().getHours();
  if (q.start === q.end) return false;
  if (q.start < q.end) return h >= q.start && h < q.end;
  return h >= q.start || h < q.end;
}

export async function runForeground(config: Config): Promise<void> {
  ensureDirs();
  fs.writeFileSync(pidPath(), String(process.pid));
  logLine(`agent started (pid ${process.pid}); ${enabledSources(config).length} sources enabled`);
  const shutdown = () => {
    logLine("agent stopping");
    try {
      fs.unlinkSync(pidPath());
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let first = true;
  while (true) {
    if (!first && quietNow(config)) {
      await sleep(60_000);
      continue;
    }
    first = false;
    try {
      await runCycle(config, { force: false });
    } catch (err) {
      logLine(`cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(30_000);
  }
}

export function agentRunning(): { running: boolean; pid?: number } {
  try {
    const pid = Number(fs.readFileSync(pidPath(), "utf8").trim());
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

export { sourceById };
