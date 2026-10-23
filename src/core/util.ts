import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function iso(d: Date | string | number = new Date()): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString();
}

export function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeEntities(s: string): string {
  return stripHtml(s);
}

export function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

const STOP = new Set(
  "the and for with that this from have has had was were are is be been being about into over under after before they them their there here what when where who whom which why how did does do you your our we us it its of on in to a an as at by or not no yes".split(
    " ",
  ),
);

export function safeSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function safeFilePart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

export function extractJson<T = unknown>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    const start = t.search(/[[{]/);
    if (start === -1) throw new Error("Model returned no JSON");
    const open = t[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return JSON.parse(t.slice(start, i + 1)) as T;
      }
    }
    throw new Error("Could not parse JSON from model output");
  }
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function parseDate(value?: string | null): string {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export function xmlText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  return stripHtml(
    m[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

export function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => m[1]);
}

export function pickLink(block: string): string {
  const m = block.match(/<link[^>]*href="([^"]+)"/i);
  if (m) return m[1];
  const t = block.match(/<link[^>]*>([^<]+)<\/link>/i);
  return t ? t[1].trim() : "";
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Official domains only. Campaign sites must be explicitly listed by the user. */
export function isOfficialDomain(url: string, extra: string[] = []): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (extra.some((h) => host === h || host.endsWith("." + h))) return true;
  return (
    host.endsWith(".gov") ||
    host.endsWith(".mil") ||
    host === "senate.gov" ||
    host === "house.gov" ||
    host.endsWith(".senate.gov") ||
    host.endsWith(".house.gov") ||
    host === "whitehouse.gov" ||
    host.endsWith(".whitehouse.gov")
  );
}

const CACHE_FILE = path.join(dataDir(), "http-cache.json");
type CacheEntry = { etag?: string; lastModified?: string; body?: string; fetchedAt: string };

let cache: Record<string, CacheEntry> | null = null;

function loadCache(): Record<string, CacheEntry> {
  if (cache) return cache;
  cache = readJsonFile<Record<string, CacheEntry>>(CACHE_FILE) ?? {};
  return cache;
}

function saveCache(): void {
  if (!cache) return;
  const entries = Object.entries(cache).sort((a, b) => (a[1].fetchedAt < b[1].fetchedAt ? 1 : -1));
  cache = Object.fromEntries(entries.slice(0, 400));
  writeJsonFile(CACHE_FILE, cache);
}

export type FetchOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  cache?: boolean;
  method?: string;
  body?: string;
};

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<{ text: string; status: number; headers: Headers }> {
  const useCache = opts.cache !== false;
  const c = loadCache();
  const hit = c[url];
  const headers: Record<string, string> = {
    "user-agent": "journalism-cli/0.1 (+primary-source research; https://github.com/kkaleb-w/journalism)",
    accept: "application/json, text/xml, application/xml, text/html;q=0.9, */*;q=0.8",
    ...(opts.headers ?? {}),
  };
  if (useCache && hit?.etag) headers["if-none-match"] = hit.etag;
  if (useCache && hit?.lastModified) headers["if-modified-since"] = hit.lastModified;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= (opts.retries ?? 2); attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body,
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (res.status === 304 && hit?.body) {
        return { text: hit.body, status: 200, headers: res.headers };
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        await sleep(800 * (attempt + 1) ** 2);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 200)}`);
      if (useCache) {
        c[url] = {
          etag: res.headers.get("etag") ?? undefined,
          lastModified: res.headers.get("last-modified") ?? undefined,
          body: text.length < 2_000_000 ? text : undefined,
          fetchedAt: new Date().toISOString(),
        };
        saveCache();
      }
      return { text, status: res.status, headers: res.headers };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < (opts.retries ?? 2)) await sleep(500 * (attempt + 1) ** 2);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { text } = await fetchText(url, {
    ...opts,
    headers: { accept: "application/json", ...(opts.headers ?? {}) },
  });
  return JSON.parse(text) as T;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}
