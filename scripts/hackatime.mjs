#!/usr/bin/env node
/**
 * Hackatime heartbeat sender for terminal-first work.
 *
 * It watches this repository for real file writes and sends a WakaTime-compatible
 * heartbeat only when something actually changed. No idle time is reported.
 *
 * Key: HACKATIME_API_KEY, or ~/.wakatime.cfg (api_key = ...).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const project = flag("--project", path.basename(process.cwd()));
const dir = path.resolve(flag("--dir", process.cwd()));
const once = args.includes("--once");
const interval = Number(flag("--interval", "30")) * 1000;
const home = os.homedir();
const logFile = path.join(home, ".journalism", "hackatime.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line);
  } catch {
    /* ignore */
  }
  if (args.includes("--verbose")) process.stdout.write(line);
}

function apiKey() {
  if (process.env.HACKATIME_API_KEY) return process.env.HACKATIME_API_KEY.trim();
  try {
    const cfg = fs.readFileSync(path.join(home, ".wakatime.cfg"), "utf8");
    const m = cfg.match(/^\s*api_key\s*=\s*(.+)$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

const IGNORE = new Set(["node_modules", ".git", "dist", ".next", "coverage", ".cache", "test-tmp"]);
const LANG = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".mjs": "javascript",
  ".cjs": "javascript", ".json": "json", ".md": "markdown", ".css": "css", ".html": "html",
  ".py": "python", ".rs": "rust", ".go": "go", ".sh": "bash", ".yml": "yaml", ".yaml": "yaml",
};

function scan(root) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      if (IGNORE.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          out.push({ file: full, mtime: st.mtimeMs, size: st.size });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root);
  return out;
}

async function send(file) {
  const key = apiKey();
  if (!key) {
    log("no HACKATIME_API_KEY and no ~/.wakatime.cfg api_key");
    return false;
  }
  const payload = {
    entity: file,
    type: "file",
    time: Math.floor(Date.now() / 1000),
    project,
    project_root: dir,
    language: LANG[path.extname(file).toLowerCase()] ?? "text",
    is_write: true,
    category: "coding",
    editor: "terminal",
  };
  try {
    const res = await fetch("https://hackatime.hackclub.com/api/hackatime/v1/users/current/heartbeats", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(key).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log(`heartbeat rejected HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    log(`heartbeat ${path.relative(dir, file)}`);
    return true;
  } catch (err) {
    log(`heartbeat error ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

let state = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(path.join(home, ".journalism", "hackatime-state.json"), "utf8"));
  state = new Map(Object.entries(saved));
} catch {
  /* first run */
}

function persist() {
  try {
    fs.mkdirSync(path.join(home, ".journalism"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".journalism", "hackatime-state.json"),
      JSON.stringify(Object.fromEntries(state)),
    );
  } catch {
    /* ignore */
  }
}

async function tick() {
  const files = scan(dir);
  const changed = files.filter((f) => {
    const prev = state.get(f.file);
    return !prev || f.mtime > prev + 1;
  });
  for (const f of files) state.set(f.file, f.mtime);
  persist();
  if (!changed.length) return;
  const newest = changed.sort((a, b) => b.mtime - a.mtime)[0];
  const ok = await send(newest.file);
  if (!ok && once) process.exitCode = 1;
}

if (once) {
  await tick();
  log("one-shot complete");
} else {
  log(`watching ${dir} as project ${project}`);
  await tick();
  setInterval(() => {
    tick().catch((e) => log(`tick error ${e.message}`));
  }, interval);
}
