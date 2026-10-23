import fs from "node:fs";
import path from "node:path";
import type { Config } from "../core/types.js";

export const VAULT_DIRS = [
  "Briefings",
  "Topics",
  "Timeline",
  "Transcripts",
  "Queries",
  "Sources",
  ".obsidian",
];

export function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, process.env.HOME ?? "");
}

export function scaffoldVault(config: Config): string[] {
  const vault = expandHome(config.vault);
  const created: string[] = [];
  for (const dir of VAULT_DIRS) {
    const full = path.join(vault, dir);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
      created.push(full);
    }
  }

  writeIfMissing(
    path.join(vault, ".obsidian", "app.json"),
    JSON.stringify({ alwaysUpdateLinks: true, newLinkFormat: "shortest", useMarkdownLinks: false }, null, 2),
    created,
  );
  writeIfMissing(
    path.join(vault, ".obsidian", "appearance.json"),
    JSON.stringify({ baseFontSize: 16, theme: "obsidian" }, null, 2),
    created,
  );
  writeIfMissing(
    path.join(vault, ".obsidian", "core-plugins.json"),
    JSON.stringify(["file-explorer", "global-search", "graph", "backlink", "outgoing-link", "tag-pane", "page-preview", "daily-notes", "templates"], null, 2),
    created,
  );

  writeIfMissing(
    path.join(vault, "README.md"),
    `# ${config.poi.name} — primary-source file

This vault is maintained by [journalism](https://github.com/kkaleb-w/journalism), a terminal agent.
It records only first-party material: the person's own posts, statements, speeches, votes and money.

## How to read it

- [[Profile]] — the living summary, every claim linked to a record
- [[Timeline]] — chronological index
- [[Connections]] — patterns the agent has noticed, with citations
- [[Open Questions]] — gaps worth reporting
- \`Sources/\` — the source policy and the exact feeds being watched
- \`Transcripts/\` — full speech transcripts
- \`Briefings/\` — daily digests

## Rule

No news. No summaries of summaries. If it is not the person's own words or an official record of
their actions, it does not belong here.
`,
    created,
  );

  writeIfMissing(path.join(vault, "Profile.md"), profileTemplate(config), created);
  writeIfMissing(
    path.join(vault, "Timeline.md"),
    `# Timeline\n\nChronological primary record for **${config.poi.name}**.\n\n`,
    created,
  );
  writeIfMissing(
    path.join(vault, "Connections.md"),
    `# Connections\n\nPatterns across statements, votes and money. Each entry cites the records it rests on.\n\n`,
    created,
  );
  writeIfMissing(
    path.join(vault, "Open Questions.md"),
    `# Open Questions\n\nGaps the record does not answer yet. These are reporting leads, not claims.\n\n`,
    created,
  );
  writeIfMissing(
    path.join(vault, "Topics", "Index.md"),
    `# Topics\n\n- [[Profile]]\n- [[Timeline]]\n`,
    created,
  );
  writeIfMissing(
    path.join(vault, "Sources", "Primary Sources.md"),
    sourcesTemplate(config),
    created,
  );

  return created;
}

function writeIfMissing(file: string, content: string, created: string[]): void {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  created.push(file);
}

export function profileTemplate(config: Config): string {
  const p = config.poi;
  return `# ${p.name}

> Living file. Every factual line is tied to a primary record. Maintained by journalism.

## Who they are

- **Name:** ${p.name}
${p.role ? `- **Role:** ${p.role}\n` : ""}${p.jurisdiction ? `- **Jurisdiction:** ${p.jurisdiction}\n` : ""}${p.party ? `- **Party:** ${p.party}\n` : ""}
## What they say

## What they do

## Money

## Speeches

## Record gaps
`;
}

export function sourcesTemplate(config: Config): string {
  const rows = Object.entries(config.sources)
    .filter(([, v]) => v.enabled)
    .map(([id, v]) => `| ${id} | every ${v.intervalMinutes} min |`);
  const handles = config.poi.handles;
  const feeds = (handles.rss ?? []).map((f) => `- ${f}`).join("\n");
  return `# Primary Sources

This project accepts only first-party records. Nothing here is a news outlet, aggregator or
second-hand account.

| Adapter | Cadence |
|---|---|
${rows.join("\n")}

## Configured handles

${handles.x ? `- X: @${handles.x}\n` : ""}${handles.truth ? `- Truth Social: @${handles.truth}\n` : ""}${
    handles.bluesky ? `- Bluesky: @${handles.bluesky}\n` : ""
  }${handles.youtubeChannelId ? `- YouTube channel: ${handles.youtubeChannelId}\n` : ""}${
    handles.website ? `- Website: ${handles.website}\n` : ""
  }${feeds ? `- Official feeds:\n${feeds}\n` : ""}

## Exclusions

No news articles, no Wikipedia, no social posts about the person, no punditry. If a source is not the
person or an official record of the person, it is rejected at ingestion.
`;
}

export function ensureVaultDirs(config: Config): string {
  const vault = expandHome(config.vault);
  for (const dir of VAULT_DIRS) fs.mkdirSync(path.join(vault, dir), { recursive: true });
  return vault;
}

export function appendToNote(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, content);
}
