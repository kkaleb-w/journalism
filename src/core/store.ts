import fs from "node:fs";
import path from "node:path";
import { dataDir, eventsPath, rawDir } from "./config.js";
import type { PrimaryEvent } from "./types.js";
import { safeFilePart, sha256 } from "./util.js";

export type EventIndex = {
  byId: Map<string, PrimaryEvent>;
  all: PrimaryEvent[];
};

let cached: EventIndex | null = null;

export function loadEvents(force = false): EventIndex {
  if (cached && !force) return cached;
  const byId = new Map<string, PrimaryEvent>();
  const all: PrimaryEvent[] = [];
  if (fs.existsSync(eventsPath())) {
    const lines = fs.readFileSync(eventsPath(), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as PrimaryEvent;
        if (!ev.id) continue;
        byId.set(ev.id, ev);
        all.push(ev);
      } catch {
        /* skip bad line */
      }
    }
  }
  all.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  cached = { byId, all };
  return cached;
}

export function invalidateCache(): void {
  cached = null;
}

export function eventId(source: string, externalId: string): string {
  return `${source}:${externalId}`;
}

export function contentHash(...parts: string[]): string {
  return sha256(parts.join("\u0000")).slice(0, 32);
}

export type IngestResult = { added: PrimaryEvent[]; skipped: number };

export function ingestEvents(events: PrimaryEvent[]): IngestResult {
  const idx = loadEvents();
  const added: PrimaryEvent[] = [];
  let skipped = 0;
  fs.mkdirSync(dataDir(), { recursive: true });
  const stream = fs.createWriteStream(eventsPath(), { flags: "a" });
  for (const ev of events) {
    if (!ev.id || !ev.url) {
      skipped++;
      continue;
    }
    const duplicate = idx.byId.get(ev.id) ?? (ev.hash ? idx.all.find((e) => e.hash === ev.hash) : undefined);
    if (duplicate) {
      skipped++;
      continue;
    }
    idx.byId.set(ev.id, ev);
    idx.all.unshift(ev);
    added.push(ev);
    stream.write(JSON.stringify(ev) + "\n");
    saveRaw(ev);
  }
  stream.end();
  return { added, skipped };
}

export function saveRaw(ev: PrimaryEvent): void {
  const dir = path.join(rawDir(), safeFilePart(ev.source));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeFilePart(ev.id.split(":").slice(1).join(":"))}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(ev, null, 2) + "\n");
  } catch {
    /* raw storage is best effort */
  }
}

export function newEvent(input: Omit<PrimaryEvent, "retrievedAt" | "hash" | "trust"> & { hash?: string }): PrimaryEvent {
  const retrievedAt = new Date().toISOString();
  return {
    ...input,
    trust: "primary",
    retrievedAt,
    hash: input.hash ?? contentHash(input.source, input.title, input.text.slice(0, 2000), input.publishedAt),
  };
}

export function eventsSince(isoDate: string): PrimaryEvent[] {
  return loadEvents().all.filter((e) => e.publishedAt >= isoDate);
}
