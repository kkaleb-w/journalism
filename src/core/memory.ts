import fs from "node:fs";
import path from "node:path";
import type { Config, PrimaryEvent } from "./types.js";
import { chat } from "./llm.js";
import { ensureVaultDirs, expandHome } from "../vault/vault.js";
import { dataDir } from "./config.js";
import { readJsonFile, safeSlug, tokenize, truncate, writeJsonFile } from "./util.js";

type Ref = number;

type Synthesis = {
  summary?: string;
  timeline?: { date?: string; text?: string; refs?: Ref[] }[];
  profile?: { section?: string; text?: string; refs?: Ref[] }[];
  topics?: { title?: string; text?: string; refs?: Ref[] }[];
  connections?: { text?: string; refs?: Ref[] }[];
  open_questions?: string[];
};

const ALLOWED_SECTIONS = ["What they say", "What they do", "Money", "Speeches", "Record gaps"];

const RULES = `HARD RULES
1. Use only the numbered RECORDS supplied in this message. Never use outside knowledge, never infer motives, never add context that is not in a record.
2. Every sentence you write must be supported by at least one record and end with its bracket refs, like [1] or [2][5].
3. If the records do not support a claim, omit the claim. Silence is correct.
4. Attribute speech precisely: "said", "posted", "voted", "paid". Do not say "believes" or "wants" unless the person said it in those words.
5. Prefer concrete detail: dates, bill numbers, amounts, exact phrases. No filler.
6. Do not describe the tool, the records, or your process.`;

const SYNTH_SYSTEM = `You are the archivist inside a journalism research tool. You maintain a file on one political person of interest.

${RULES}

SECTION DEFINITIONS (use exactly these strings)
- "What they say": posts, press releases and direct statements the person published.
- "What they do": votes cast, bills introduced, official actions taken.
- "Money": campaign disbursements, amounts paid, payees.
- "Speeches": content from transcripts of recorded remarks or events. Never put a short social post here.
- "Record gaps": a factual note that a record is missing or contradictory, only when the records show it.

Return JSON only, matching:
{
  "summary": "2-4 sentences on what is new and why it matters, with refs",
  "timeline": [{"date":"YYYY-MM-DD","text":"one factual sentence with refs","refs":[1]}],
  "profile": [{"section":"What they say|What they do|Money|Speeches|Record gaps","text":"one factual bullet with refs","refs":[1]}],
  "topics": [{"title":"Short topic name","text":"one paragraph, refs on each sentence","refs":[1,2]}],
  "connections": [{"text":"a pattern visible across records, with refs","refs":[1,2]}],
  "open_questions": ["a question the record does not answer"]
}`;

const ANSWER_SYSTEM = `You are a research assistant answering a reporter's question from a file of primary records.

${RULES}

Write plain prose, not JSON. Answer in the first paragraph. Cite each sentence with [n]. If the records do not answer the question, say exactly what is missing. Never fill the gap with outside knowledge.`;

const DIGEST_SYSTEM = `You are writing a one-page daily briefing from primary records about one political person.

${RULES}

Write Markdown, not JSON. Use these sections when the records support them: "What changed", "Direct statements", "Record" (votes and bills), "Money", "Still unknown". Cite each sentence with [n]. Be short and factual. If a section has no records, omit it.`;

export function formatCitation(ev: PrimaryEvent): string {
  const date = ev.publishedAt.slice(0, 10);
  return `([${ev.sourceLabel}](${ev.url}), ${date})`;
}

function recordsBlock(events: PrimaryEvent[]): string {
  return events
    .map((ev, i) => {
      const date = ev.publishedAt.slice(0, 10);
      return `[${i + 1}] ${date} · ${ev.sourceLabel} · ${ev.title}\nURL: ${ev.url}\n${truncate(ev.text, 3000)}`;
    })
    .join("\n\n---\n\n");
}

function citations(refs: Ref[] | undefined, events: PrimaryEvent[]): string {
  const valid = [...new Set((refs ?? []).filter((r) => Number.isInteger(r) && r >= 1 && r <= events.length))];
  if (!valid.length) return "";
  return valid.map((r) => `[${r}](${events[r - 1].url})`).join(" ");
}

function withCites(text: string, refs: Ref[] | undefined, events: PrimaryEvent[]): string {
  const c = citations(refs, events);
  if (!c) return "";
  const clean = text.replace(/\s*\[\d+\](\[\d+\])*/g, "").trim();
  return `${clean} ${c}`;
}

export async function synthesize(config: Config, events: PrimaryEvent[]): Promise<{ written: number; summary: string }> {
  if (!events.length) return { written: 0, summary: "" };
  const batch = events.slice(0, 24);
  const vault = ensureVaultDirs(config);
  const res = await chat(
    config.provider,
    [
      { role: "system", content: SYNTH_SYSTEM },
      {
        role: "user",
        content: `PERSON: ${config.poi.name}${config.poi.role ? ` (${config.poi.role})` : ""}\n\nRECORDS:\n\n${recordsBlock(batch)}`,
      },
    ],
    { json: true, maxTokens: 3500, temperature: 0.1 },
  );

  let parsed: Synthesis;
  try {
    parsed = JSON.parse(res.text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()) as Synthesis;
  } catch {
    const start = res.text.indexOf("{");
    const end = res.text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("Synthesis returned no JSON");
    parsed = JSON.parse(res.text.slice(start, end + 1)) as Synthesis;
  }

  const seenFile = path.join(dataDir(), "written-notes.json");
  const seen = readJsonFile<Record<string, string>>(seenFile) ?? {};
  let written = 0;

  const bullets = (parsed.profile ?? [])
    .filter((p) => p.text && p.refs?.length)
    .map((p) => ({
      section: ALLOWED_SECTIONS.includes(p.section ?? "") ? p.section! : "What they do",
      line: withCites(p.text!, p.refs, batch),
    }))
    .filter((p) => p.line);

  for (const b of bullets) {
    const key = `profile:${b.section}:${safeSlug(b.line).slice(0, 60)}`;
    if (seen[key]) continue;
    appendUnderHeading(path.join(vault, "Profile.md"), b.section, `- ${b.line}\n`);
    seen[key] = new Date().toISOString();
    written++;
  }

  for (const t of parsed.timeline ?? []) {
    if (!t.text || !t.refs?.length) continue;
    const date = (t.date ?? batch[0].publishedAt).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const line = withCites(t.text, t.refs, batch);
    const key = `timeline:${date}:${safeSlug(line).slice(0, 60)}`;
    if (seen[key]) continue;
    appendTimeline(vault, date, line);
    seen[key] = new Date().toISOString();
    written++;
  }

  for (const topic of parsed.topics ?? []) {
    if (!topic.title || !topic.text || !topic.refs?.length) continue;
    const body = withCites(topic.text, topic.refs, batch);
    if (!body) continue;
    const slug = safeSlug(topic.title);
    const file = path.join(vault, "Topics", `${slug}.md`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        `---\ntags: [topic]\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n# ${topic.title}\n\n`,
      );
    }
    const key = `topic:${slug}:${safeSlug(body).slice(0, 60)}`;
    if (seen[key]) continue;
    fs.appendFileSync(file, `## ${new Date().toISOString().slice(0, 10)}\n\n${body}\n\n`);
    const index = path.join(vault, "Topics", "Index.md");
    const indexText = fs.existsSync(index) ? fs.readFileSync(index, "utf8") : "# Topics\n\n";
    if (!indexText.includes(`[[${slug}]]`)) fs.appendFileSync(index, `- [[${slug}|${topic.title}]]\n`);
    seen[key] = new Date().toISOString();
    written++;
  }

  for (const c of parsed.connections ?? []) {
    if (!c.text || !c.refs?.length) continue;
    const line = withCites(c.text, c.refs, batch);
    const key = `connection:${safeSlug(line).slice(0, 60)}`;
    if (seen[key]) continue;
    fs.appendFileSync(path.join(vault, "Connections.md"), `- ${line}\n`);
    seen[key] = new Date().toISOString();
    written++;
  }

  for (const q of parsed.open_questions ?? []) {
    const line = q.trim();
    if (!line) continue;
    const key = `question:${safeSlug(line).slice(0, 60)}`;
    if (seen[key]) continue;
    fs.appendFileSync(path.join(vault, "Open Questions.md"), `- ${line}\n`);
    seen[key] = new Date().toISOString();
    written++;
  }

  if (parsed.summary) {
    const key = `summary:${safeSlug(parsed.summary).slice(0, 70)}`;
    seen[key] = new Date().toISOString();
  }

  writeJsonFile(seenFile, seen);
  return { written, summary: parsed.summary ?? "" };
}

function appendUnderHeading(file: string, heading: string, block: string): void {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : `# File\n\n`;
  const marker = `## ${heading}`;
  const idx = text.indexOf(marker);
  if (idx === -1) {
    text = text.trimEnd() + `\n\n${marker}\n\n${block}`;
    fs.writeFileSync(file, text);
    return;
  }
  const after = idx + marker.length;
  const next = text.indexOf("\n## ", after);
  if (next === -1) {
    text = text.trimEnd() + `\n${block}`;
  } else {
    text = text.slice(0, next).trimEnd() + `\n${block}\n` + text.slice(next);
  }
  fs.writeFileSync(file, text);
}

function appendTimeline(vault: string, date: string, line: string): void {
  const month = date.slice(0, 7);
  const file = path.join(vault, "Timeline", `${month}.md`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# ${month}\n\n`);
  }
  fs.appendFileSync(file, `## ${date}\n\n- ${line}\n\n`);
  const root = path.join(vault, "Timeline.md");
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const rootText = fs.readFileSync(root, "utf8");
  if (!rootText.includes(`[[${month}|`)) {
    fs.appendFileSync(root, `- [[${month}|${label}]]\n`);
  }
}

export async function digest(config: Config, hours = 24): Promise<string> {
  const { loadEvents } = await import("./store.js");
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const events = loadEvents().all.filter((e) => e.publishedAt >= since).slice(0, 60);
  const vault = ensureVaultDirs(config);
  const file = path.join(vault, "Briefings", `${new Date().toISOString().slice(0, 10)}.md`);

  if (!events.length) {
    const body = `# Briefing ${new Date().toISOString().slice(0, 10)}\n\nNo new primary records in the last ${hours} hours.\n`;
    fs.writeFileSync(file, body);
    return body;
  }

  const res = await chat(
    config.provider,
    [
      { role: "system", content: DIGEST_SYSTEM },
      {
        role: "user",
        content: `Write a one-page briefing on ${config.poi.name} from these records. Sections: What changed, Direct statements, Record (votes/bills), Money, Still unknown. Every sentence carries refs. No outside knowledge.\n\n${recordsBlock(events)}`,
      },
    ],
    { maxTokens: 2500, temperature: 0.1 },
  );
  const body = `# Briefing ${new Date().toISOString().slice(0, 10)}\n\n${res.text}\n\n## Records used\n\n${events
    .map((e, i) => `${i + 1}. [${e.title}](${e.url}) — ${e.sourceLabel}, ${e.publishedAt.slice(0, 10)}`)
    .join("\n")}\n`;
  fs.writeFileSync(file, body);
  return body;
}

export async function ask(config: Config, question: string): Promise<string> {
  const { loadEvents } = await import("./store.js");
  const all = loadEvents().all;
  if (!all.length) return "No records yet. Run `journalism start --once` to collect the first batch.";
  const terms = tokenize(question);
  const scored = all
    .map((e) => {
      const hay = `${e.title} ${e.text}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (e.title.toLowerCase().includes(t)) score += 4;
        score += Math.min(6, hay.split(t).length - 1);
      }
      const ageDays = (Date.now() - new Date(e.publishedAt).getTime()) / 86_400_000;
      score += Math.max(0, 3 - ageDays / 30);
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((x) => x.e);

  const pool = scored.length ? scored : all.slice(0, 25);
  const res = await chat(
    config.provider,
    [
      {
        role: "system",
        content: ANSWER_SYSTEM,
      },
      { role: "user", content: `QUESTION: ${question}\n\nRECORDS:\n\n${recordsBlock(pool)}` },
    ],
    { maxTokens: 1800, temperature: 0.1 },
  );
  const vault = ensureVaultDirs(config);
  const out = path.join(vault, "Queries", `${new Date().toISOString().slice(0, 10)}-${safeSlug(question).slice(0, 50)}.md`);
  fs.writeFileSync(
    out,
    `# ${question}\n\n_${new Date().toISOString()}_\n\n${res.text}\n\n## Records\n\n${pool
      .map((e, i) => `${i + 1}. [${e.title}](${e.url}) — ${e.sourceLabel}, ${e.publishedAt.slice(0, 10)}`)
      .join("\n")}\n`,
  );
  return `${res.text}\n\n_Saved to ${path.relative(expandHome(config.vault), out)}_`;
}
