import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "journalism-test-"));
process.env.JOURNALISM_HOME = path.join(tmp, "home");

const util = await import("../dist/core/util.js");
const catalog = await import("../dist/providers/catalog.js");
const config = await import("../dist/core/config.js");
const vault = await import("../dist/vault/vault.js");

test("stripHtml removes tags and decodes entities", () => {
  const out = util.stripHtml("<p>Hello &amp; <b>welcome</b></p><p>Second&nbsp;line</p>");
  assert.match(out, /Hello & welcome/);
  assert.match(out, /Second line/);
  assert.doesNotMatch(out, /<p>/);
});

test("xmlText reads CDATA and decodes", () => {
  const xml = "<entry><title><![CDATA[A & B]]></title><link href=\"https://x.gov/a\" /></entry>";
  assert.equal(util.xmlText(xml, "title"), "A & B");
  assert.equal(util.pickLink(xml), "https://x.gov/a");
});

test("official domain enforcement", () => {
  assert.equal(util.isOfficialDomain("https://www.senate.gov/legislative/x.xml"), true);
  assert.equal(util.isOfficialDomain("https://www.whitehouse.gov/briefing-room/"), true);
  assert.equal(util.isOfficialDomain("https://clerk.house.gov/evs/2026/roll001.xml"), true);
  assert.equal(util.isOfficialDomain("https://www.nytimes.com/2026/01/01/x.html"), false);
  assert.equal(util.isOfficialDomain("https://example.com/a", ["example.com"]), true);
  assert.equal(util.isOfficialDomain("https://sub.example.com/a", ["example.com"]), true);
});

test("extractJson handles fences and prose", () => {
  assert.deepEqual(util.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(util.extractJson('Here you go: {"a":{"b":2}} done'), { a: { b: 2 } });
});

test("provider catalog is broad and unique", () => {
  assert.ok(catalog.PROVIDERS.length >= 25, `only ${catalog.PROVIDERS.length} providers`);
  const ids = new Set(catalog.PROVIDERS.map((p) => p.id));
  assert.equal(ids.size, catalog.PROVIDERS.length);
  for (const id of ["openai", "anthropic", "google", "xai", "deepseek", "openrouter", "ollama"]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  assert.ok(catalog.TRANSCRIPTION_PROVIDERS.length >= 5);
});

test("config round trip and permissions", () => {
  const cfg = config.newConfig({
    vault: path.join(tmp, "vault"),
    poi: {
      name: "Test Person",
      handles: { bluesky: "test.bsky.social" },
      ids: { bioguide: "A000001", congress: 119, senateSession: 2, state: "CA" },
    },
    provider: {
      id: "openai",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-1234567890",
      model: "gpt-4.1-mini",
    },
    transcription: { enabled: false },
    autoStart: false,
  });
  config.saveConfig(cfg);
  const loaded = config.loadConfig();
  assert.equal(loaded.poi.name, "Test Person");
  assert.equal(loaded.sources.bluesky.enabled, true);
  assert.equal(loaded.sources["house-votes"].enabled, true);
  const mode = fs.statSync(config.configPath()).mode & 0o777;
  if (process.platform !== "win32") assert.equal(mode, 0o600);
});

test("vault scaffold is idempotent", () => {
  const cfg = config.loadConfig();
  const first = vault.scaffoldVault(cfg);
  const second = vault.scaffoldVault(cfg);
  assert.ok(first.length > 0);
  assert.equal(second.length, 0);
  assert.ok(fs.existsSync(path.join(cfg.vault, "Profile.md")));
  assert.ok(fs.existsSync(path.join(cfg.vault, ".obsidian", "app.json")));
  assert.ok(fs.existsSync(path.join(cfg.vault, "Sources", "Primary Sources.md")));
});

test("event dedupe by id and hash", async () => {
  const store = await import("../dist/core/store.js");
  const { newEvent } = store;
  const ev = newEvent({
    id: "x:1",
    source: "x",
    sourceType: "post",
    sourceLabel: "X post",
    title: "t",
    text: "hello",
    url: "https://x.com/a/status/1",
    publishedAt: "2026-01-01T00:00:00.000Z",
    meta: {},
  });
  const one = store.ingestEvents([ev]);
  const two = store.ingestEvents([ev]);
  assert.equal(one.added.length, 1);
  assert.equal(two.added.length, 0);
});
