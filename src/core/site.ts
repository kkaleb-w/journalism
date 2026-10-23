import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import type { Config } from "./types.js";
import { ensureVaultDirs } from "../vault/vault.js";
import { loadEvents } from "./store.js";

type TimelineEntry = { date: string; html: string };
type Topic = { slug: string; title: string; html: string };

export function exportSite(config: Config, outDir: string): { file: string; records: number } {
  const vault = ensureVaultDirs(config);
  const out = path.resolve(outDir);
  fs.mkdirSync(out, { recursive: true });
  const idx = loadEvents();

  const profileMd = readIf(path.join(vault, "Profile.md"));
  const profileHtml = render(
    profileMd.replace(/^#\s+.+$/m, "").replace(/^>\s+.+$/m, "").trim(),
  );

  const timeline = readTimeline(vault);
  const topics = readTopics(vault);
  const briefings = fs
    .readdirSync(path.join(vault, "Briefings"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, 3)
    .map((f) => ({ name: f.replace(/\.md$/, ""), html: render(readIf(path.join(vault, "Briefings", f))) }));
  const sourcesHtml = render(readIf(path.join(vault, "Sources", "Primary Sources.md")));

  const topCounts = new Map<string, number>();
  for (const e of idx.all) topCounts.set(e.sourceType, (topCounts.get(e.sourceType) ?? 0) + 1);

  const html = page({
    config,
    profileHtml,
    timeline,
    topics,
    briefings,
    sourcesHtml,
    records: idx.all.length,
    counts: [...topCounts.entries()].map(([k, v]) => `${v} ${k}`).join(" · "),
    lastUpdated: new Date().toISOString(),
  });

  const file = path.join(out, "index.html");
  fs.writeFileSync(file, html);
  return { file, records: idx.all.length };
}

function readIf(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readTimeline(vault: string): TimelineEntry[] {
  const dir = path.join(vault, "Timeline");
  if (!fs.existsSync(dir)) return [];
  const entries: TimelineEntry[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse()) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const blocks = text.split(/^## /gm).slice(1);
    for (const block of blocks) {
      const [dateLine, ...rest] = block.split("\n");
      const date = dateLine.trim();
      entries.push({ date, html: render(rest.join("\n")) });
    }
  }
  return entries.sort((a, b) => (a.date < b.date ? 1 : -1));
}

function readTopics(vault: string): Topic[] {
  const dir = path.join(vault, "Topics");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "Index.md")
    .map((f) => {
      const md = fs.readFileSync(path.join(dir, f), "utf8");
      const title = md.match(/^#\s+(.+)$/m)?.[1] ?? f.replace(/\.md$/, "");
      return { slug: f.replace(/\.md$/, ""), title, html: render(md.replace(/^---[\s\S]*?---\s*/, "").replace(/^#\s+.+$/m, "")) };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

function render(md: string): string {
  if (!md.trim()) return "";
  let html = marked.parse(md, { async: false, gfm: true }) as string;
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "");
  return html;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function page(input: {
  config: Config;
  profileHtml: string;
  timeline: TimelineEntry[];
  topics: Topic[];
  briefings: { name: string; html: string }[];
  sourcesHtml: string;
  records: number;
  counts: string;
  lastUpdated: string;
}): string {
  const { config } = input;
  const name = esc(config.poi.name);
  const role = esc(config.poi.role ?? "");
  const timelineHtml = input.timeline
    .map(
      (t) => `<article class="entry" data-search="${esc(t.date + " " + strip(t.html)).toLowerCase()}">
        <time>${esc(t.date)}</time>
        <div class="entry-body">${t.html}</div>
      </article>`,
    )
    .join("\n");
  const topicsHtml = input.topics
    .map(
      (t) => `<article class="topic" data-search="${esc(t.title + " " + strip(t.html)).toLowerCase()}">
        <h3>${esc(t.title)}</h3>
        <div>${t.html}</div>
      </article>`,
    )
    .join("\n");
  const briefingsHtml = input.briefings
    .map(
      (b) => `<article class="briefing" data-search="${esc(b.name + " " + strip(b.html)).toLowerCase()}">
        <h3>${esc(b.name)}</h3>
        <div>${b.html}</div>
      </article>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — primary record</title>
<meta name="description" content="A cited primary-source file on ${name}, maintained by journalism.">
<style>
:root{
  --bg:#0b0c0e; --panel:#111317; --ink:#ece8df; --dim:#8b8f96; --line:#23262c;
  --accent:#d7ff3f; --accent2:#ff6b4a; --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
  --sans:ui-sans-serif,-apple-system,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.6}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid rgba(215,255,63,.3)}
a:hover{border-color:var(--accent)}
.wrap{display:grid;grid-template-columns:300px minmax(0,1fr);min-height:100vh}
aside{position:sticky;top:0;height:100vh;padding:34px 28px;border-right:1px solid var(--line);background:linear-gradient(180deg,#0d0f12,#0b0c0e);display:flex;flex-direction:column;gap:26px}
.brand{font-family:var(--sans);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim)}
.brand b{color:var(--accent);font-weight:600}
h1{font-family:var(--serif);font-size:38px;line-height:1.02;margin:8px 0 6px;letter-spacing:-.02em}
.role{color:var(--dim);font-size:14px}
.badge{display:inline-flex;align-items:center;gap:7px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);border:1px solid rgba(215,255,63,.35);padding:5px 9px;border-radius:999px;width:fit-content}
.badge i{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent)}
nav{display:flex;flex-direction:column;gap:2px;font-size:14px}
nav a{color:var(--dim);border:0;padding:6px 0}
nav a:hover{color:var(--ink)}
.stats{margin-top:auto;font-size:12px;color:var(--dim);border-top:1px solid var(--line);padding-top:16px}
.stats b{color:var(--ink);font-weight:600}
main{padding:40px clamp(22px,5vw,72px) 100px;max-width:980px}
.hero{border-bottom:1px solid var(--line);padding-bottom:26px;margin-bottom:34px}
.hero p{color:var(--dim);max-width:62ch;margin:10px 0 0}
.search{width:100%;background:var(--panel);border:1px solid var(--line);color:var(--ink);padding:12px 14px;border-radius:8px;font-size:14px;margin:22px 0 8px;outline:none}
.search:focus{border-color:rgba(215,255,63,.5)}
section{padding:26px 0;border-bottom:1px solid var(--line)}
section:last-child{border:0}
h2{font-family:var(--serif);font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);font-weight:500;margin:0 0 20px}
h3{font-family:var(--serif);font-size:22px;margin:0 0 8px;letter-spacing:-.01em}
.entry{display:grid;grid-template-columns:115px 1fr;gap:20px;padding:16px 0;border-top:1px solid var(--line)}
.entry:first-of-type{border-top:0}
.entry time{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums;padding-top:4px}
.entry-body p{margin:0 0 6px}
.entry-body a{border:0;color:var(--accent2)}
.topic,.briefing{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px 22px;margin-bottom:14px}
.topic p,.briefing p{margin:0 0 8px;color:#cfcbc2}
.topic a,.briefing a{color:var(--accent2);border:0}
#profile p,#profile li{max-width:72ch}
#profile h2{border-top:1px solid var(--line);padding-top:18px;margin-top:24px;color:var(--ink);font-size:15px;letter-spacing:.04em}
#profile ul{padding-left:20px}
#profile li{margin:7px 0}
#profile strong{color:var(--accent)}
.footer{margin-top:50px;font-size:12px;color:var(--dim)}
.hidden{display:none!important}
@media (max-width:820px){
  .wrap{display:block}
  aside{position:relative;height:auto;border-right:0;border-bottom:1px solid var(--line)}
  nav{flex-direction:row;flex-wrap:wrap;gap:14px}
  .stats{margin-top:8px}
  .entry{grid-template-columns:1fr;gap:4px}
  h1{font-size:32px}
}
</style>
</head>
<body>
<div class="wrap">
<aside>
  <div>
    <div class="brand">journalism <b>/ primary record</b></div>
    <h1>${name}</h1>
    <div class="role">${role}</div>
  </div>
  <div class="badge"><i></i> primary sources only</div>
  <nav>
    <a href="#profile">Profile</a>
    <a href="#timeline">Timeline</a>
    <a href="#topics">Topics</a>
    <a href="#briefings">Briefings</a>
    <a href="#sources">Sources</a>
  </nav>
  <div class="stats">
    <div><b>${input.records}</b> records collected</div>
    <div>${esc(input.counts)}</div>
    <div style="margin-top:8px">Updated ${input.lastUpdated.slice(0, 10)}</div>
  </div>
</aside>
<main>
  <div class="hero">
    <h2 style="margin-bottom:8px">The file</h2>
    <p>Everything below is the person's own words or an official record of what they did. No news, no summaries, no outside context. Each line links to its source.</p>
    <input class="search" id="q" placeholder="Search the record…" autocomplete="off">
  </div>

  <section id="profile">
    <h2>Profile</h2>
    <div>${input.profileHtml}</div>
  </section>

  <section id="timeline">
    <h2>Timeline</h2>
    <div id="timeline-list">${timelineHtml || "<p>No dated records yet.</p>"}</div>
  </section>

  <section id="topics">
    <h2>Topics</h2>
    ${topicsHtml || "<p>No topics yet.</p>"}
  </section>

  <section id="briefings">
    <h2>Briefings</h2>
    ${briefingsHtml || "<p>No briefings yet.</p>"}
  </section>

  <section id="sources">
    <h2>Sources</h2>
    ${input.sourcesHtml}
  </section>

  <div class="footer">
    Generated by <a href="https://github.com/kkaleb-w/journalism">journalism</a>.
    Collection is automatic; every note is written from numbered primary records and rejected if it cannot cite one.
  </div>
</main>
</div>
<script>
const q = document.getElementById('q');
q.addEventListener('input', () => {
  const term = q.value.trim().toLowerCase();
  for (const el of document.querySelectorAll('[data-search]')) {
    el.classList.toggle('hidden', term.length > 0 && !el.dataset.search.includes(term));
  }
});
</script>
</body>
</html>`;
}

function strip(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
