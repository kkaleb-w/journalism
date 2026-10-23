import fs from "node:fs";
import path from "node:path";
import type { Config, PrimaryEvent } from "../core/types.js";
import { loadEvents } from "../core/store.js";
import { loadState, saveConfig, statePath } from "../core/config.js";
import { runCycle, agentRunning } from "../core/agent.js";
import { restartAgent, serviceStatus } from "../core/service.js";
import { sourceSummary, SOURCES } from "../sources/index.js";
import { chatTurn, type ChatTurn } from "../core/memory.js";
import { listModels } from "../core/llm.js";
import { expandHome } from "../vault/vault.js";

const TABS = ["FILES", "POI", "TALK", "SETTINGS"] as const;
type Tab = (typeof TABS)[number];

type TreeNode = {
  name: string;
  full: string;
  dir: boolean;
  depth: number;
  children?: TreeNode[];
};

type FileRow = { node: TreeNode; depth: number };
type TalkEntry = ChatTurn & { sources?: PrimaryEvent[] };

type Setting = {
  key: string;
  label: string;
  kind: "text" | "number" | "bool" | "action" | "readonly" | "source";
  value: () => string;
  hint?: string;
  edit?: (v: string) => void;
  action?: () => Promise<string | void>;
  left?: () => void;
  right?: () => void;
};

const A = {
  reset: "\x1b[0m",
  reverse: "\x1b[7m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[38;5;190m",
  red: "\x1b[38;5;203m",
  amber: "\x1b[38;5;214m",
  grey: "\x1b[38;5;245m",
};

export async function dashboard(config: Config): Promise<"onboard" | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("The dashboard needs an interactive terminal. Use `journalism status` for scripts.");
  }
  const app = new Dashboard(config);
  return app.run();
}

class Dashboard {
  private config: Config;
  private tab = 0;
  private w = 100;
  private h = 30;
  private status = "";
  private statusUntil = 0;
  private dirty = true;
  private spinner = 0;
  private timer?: NodeJS.Timeout;
  private resolveRun?: (value: "onboard" | null) => void;

  private root!: TreeNode;
  private expanded = new Set<string>();
  private rows: FileRow[] = [];
  private fileSel = 0;
  private fileScroll = 0;
  private preview: string[] = [];
  private previewName = "";
  private previewScroll = 0;

  private talk: TalkEntry[] = [];
  private input = "";
  private busy = false;
  private talkScroll = 0;

  private settings: Setting[] = [];
  private setSel = 0;
  private setScroll = 0;
  private editing: { label: string; key: string; buffer: string } | null = null;

  constructor(config: Config) {
    this.config = config;
    this.w = process.stdout.columns ?? 100;
    this.h = process.stdout.rows ?? 30;
    this.buildTree();
    const profile = this.rows.findIndex((r) => !r.node.dir && r.node.name === "Profile.md");
    if (profile >= 0) {
      this.fileSel = profile;
      this.openFile(this.rows[profile].node.full);
    }
    this.buildSettings();
  }

  run(): Promise<"onboard" | null> {
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (data: string) => this.onKey(data);
    const onResize = () => {
      this.w = process.stdout.columns ?? 100;
      this.h = process.stdout.rows ?? 30;
      this.dirty = true;
      this.render();
    };
    process.stdin.on("data", onData);
    process.stdout.on("resize", onResize);

    this.render();
    this.timer = setInterval(() => {
      this.spinner = (this.spinner + 1) % 4;
      if (this.busy || Date.now() < this.statusUntil) this.dirty = true;
      if (this.dirty) this.render();
    }, 400);

    return new Promise((resolve) => {
      this.resolveRun = (value) => {
        clearInterval(this.timer);
        process.stdin.off("data", onData);
        process.stdout.off("resize", onResize);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\x1b[?25h\x1b[?1049l");
        resolve(value);
      };
    });
  }

  private quit(action: "onboard" | null): void {
    this.resolveRun?.(action);
  }

  private buildTree(): void {
    const rootPath = expandHome(this.config.vault);
    const skip = new Set(["node_modules", ".git", "dist", ".next", "coverage"]);
    const walk = (dir: string, depth: number): TreeNode[] => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      return entries
        .filter((e) => !skip.has(e.name))
        .filter((e) => !e.name.startsWith(".") || e.name === ".obsidian")
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((e) => {
          const full = path.join(dir, e.name);
          const node: TreeNode = { name: e.name, full, dir: e.isDirectory(), depth };
          if (node.dir) node.children = walk(full, depth + 1);
          return node;
        });
    };
    this.root = { name: path.basename(rootPath) || "vault", full: rootPath, dir: true, depth: 0, children: walk(rootPath, 1) };
    this.expanded = new Set([rootPath]);
    this.flatten();
  }

  private flatten(): void {
    const out: FileRow[] = [];
    const walk = (node: TreeNode) => {
      for (const child of node.children ?? []) {
        out.push({ node: child, depth: child.depth });
        if (child.dir && this.expanded.has(child.full)) walk(child);
      }
    };
    walk(this.root);
    this.rows = out;
    if (this.fileSel >= out.length) this.fileSel = Math.max(0, out.length - 1);
  }

  private buildSettings(): void {
    const c = this.config;
    const list: Setting[] = [
      {
        key: "model",
        label: "MODEL",
        kind: "text",
        value: () => c.provider.model,
        edit: (v) => {
          if (v.trim()) c.provider.model = v.trim();
        },
      },
      { key: "provider", label: "PROVIDER", kind: "readonly", value: () => `${c.provider.id} / ${c.provider.baseUrl}` },
      { key: "vault", label: "VAULT", kind: "readonly", value: () => c.vault },
      {
        key: "batch",
        label: "MEMORY BATCH",
        kind: "number",
        value: () => String(c.agent.synthesizeEveryNewItems),
        edit: (v) => {
          const n = Number(v);
          if (n >= 1) c.agent.synthesizeEveryNewItems = Math.floor(n);
        },
      },
      {
        key: "budget",
        label: "DAILY TOKENS",
        kind: "number",
        value: () => c.agent.dailyTokenBudget.toLocaleString(),
        edit: (v) => {
          const n = Number(v.replace(/[^0-9]/g, ""));
          if (n >= 0) c.agent.dailyTokenBudget = n;
        },
      },
      {
        key: "digest",
        label: "DIGEST HOUR",
        kind: "number",
        value: () => String(c.agent.digestHour),
        edit: (v) => {
          const n = Number(v);
          if (n >= 0 && n <= 23) c.agent.digestHour = Math.floor(n);
        },
      },
      {
        key: "quiet",
        label: "QUIET HOURS",
        kind: "text",
        value: () => (c.agent.quietHours ? `${c.agent.quietHours.start}-${c.agent.quietHours.end}` : "OFF"),
        edit: (v) => {
          if (/^off$/i.test(v.trim())) c.agent.quietHours = null;
          const m = v.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
          if (m) c.agent.quietHours = { start: Number(m[1]) % 24, end: Number(m[2]) % 24 };
        },
      },
    ];

    for (const s of sourceSummary(c)) {
      list.push({
        key: `src:${s.id}`,
        label: `SOURCE ${s.id.toUpperCase()}`,
        kind: "source",
        value: () => `${s.enabled ? "ON " : "OFF"}  ${s.interval}M`,
        left: () => this.bumpSource(s.id, -15),
        right: () => this.bumpSource(s.id, 15),
        action: async () => {
          c.sources[s.id].enabled = !c.sources[s.id].enabled;
          saveConfig(c);
          this.buildSettings();
          return `${s.id} ${c.sources[s.id].enabled ? "enabled" : "disabled"}`;
        },
      });
    }

    list.push(
      {
        key: "run",
        label: "RUN COLLECTION NOW",
        kind: "action",
        value: () => (this.busy ? "WORKING" : "ENTER"),
        action: async () => {
          this.busy = true;
          try {
            const r = await runCycle(c, { force: true });
            return `${r.added.length} new records, ${r.synthesized} notes, ${r.errors.length} errors`;
          } finally {
            this.busy = false;
          }
        },
      },
      {
        key: "restart",
        label: "RESTART AGENT",
        kind: "action",
        value: () => (agentRunning().running || serviceStatus().running ? "RUNNING" : "STOPPED"),
        action: async () => restartAgent(),
      },
      {
        key: "verify",
        label: "VERIFY PROVIDER",
        kind: "action",
        value: () => "ENTER",
        action: async () => {
          this.busy = true;
          try {
            const models = await listModels(c.provider);
            return models.length ? `connected, ${models.length} models` : "could not list models";
          } finally {
            this.busy = false;
          }
        },
      },
      {
        key: "onboard",
        label: "RUN ONBOARDING AGAIN",
        kind: "action",
        value: () => "ENTER",
        action: async () => {
          this.quit("onboard");
        },
      },
    );
    this.settings = list;
  }

  private bumpSource(id: string, delta: number): void {
    const s = this.config.sources[id];
    s.intervalMinutes = Math.max(5, s.intervalMinutes + delta);
    saveConfig(this.config);
    this.buildSettings();
    this.setStatus(`${id} every ${s.intervalMinutes} min`);
  }

  private setStatus(text: string): void {
    this.status = text;
    this.statusUntil = Date.now() + 6000;
    this.dirty = true;
  }

  private onKey(data: string): void {
    if (data === "\x03") return this.quit(null);

    if (this.editing) {
      if (data === "\x1b") {
        this.editing = null;
      } else if (data === "\r") {
        const e = this.editing;
        const setting = this.settings.find((s) => s.key === e.key);
        setting?.edit?.(e.buffer);
        saveConfig(this.config);
        this.editing = null;
        this.buildSettings();
        this.setStatus(`${setting?.label ?? e.key} saved`);
      } else if (data === "\x7f") {
        this.editing.buffer = this.editing.buffer.slice(0, -1);
      } else if (!data.startsWith("\x1b")) {
        this.editing.buffer += data;
      }
      this.dirty = true;
      return;
    }

    if (data === "\t") {
      this.tab = (this.tab + 1) % TABS.length;
      this.dirty = true;
      return;
    }
    if (data === "\x1b[Z") {
      this.tab = (this.tab + TABS.length - 1) % TABS.length;
      this.dirty = true;
      return;
    }
    if (data === "q" || data === "Q") {
      if (TABS[this.tab] !== "TALK") return this.quit(null);
    }

    const tab = TABS[this.tab];
    if (tab === "FILES") this.filesKey(data);
    else if (tab === "POI") this.poiKey(data);
    else if (tab === "TALK") this.talkKey(data);
    else this.settingsKey(data);
    this.dirty = true;
  }

  private filesKey(data: string): void {
    if (data === "\x1b[A") this.fileSel = Math.max(0, this.fileSel - 1);
    else if (data === "\x1b[B") this.fileSel = Math.min(this.rows.length - 1, this.fileSel + 1);
    else if (data === "\x1b[C") {
      const row = this.rows[this.fileSel];
      if (row?.node.dir) {
        this.expanded.add(row.node.full);
        this.flatten();
      }
    } else if (data === "\x1b[D") {
      const row = this.rows[this.fileSel];
      if (row?.node.dir && this.expanded.has(row.node.full)) {
        this.expanded.delete(row.node.full);
        this.flatten();
      }
    } else if (data === "\r") {
      const row = this.rows[this.fileSel];
      if (!row) return;
      if (row.node.dir) {
        if (this.expanded.has(row.node.full)) this.expanded.delete(row.node.full);
        else this.expanded.add(row.node.full);
        this.flatten();
      } else {
        this.openFile(row.node.full);
      }
    } else if (data === "[") {
      this.previewScroll = Math.max(0, this.previewScroll - 5);
    } else if (data === "]") {
      this.previewScroll += 5;
    }
    this.ensureFileVisible();
    const row = this.rows[this.fileSel];
    if (row && !row.node.dir) this.openFile(row.node.full);
  }

  private poiKey(data: string): void {
    if (data === "\x1b[A") this.previewScroll = Math.max(0, this.previewScroll - 2);
    if (data === "\x1b[B") this.previewScroll += 2;
  }

  private talkKey(data: string): void {
    if (this.busy) return;
    if (data === "\r") return this.sendTalk();
    if (data === "\x1b[A") {
      this.talkScroll = Math.min(this.talkScroll + 2, Math.max(0, this.talk.length - 1));
      return;
    }
    if (data === "\x1b[B") {
      this.talkScroll = Math.max(0, this.talkScroll - 2);
      return;
    }
    if (data === "\x7f" || data === "\b") {
      this.input = this.input.slice(0, -1);
      return;
    }
    if (!data.startsWith("\x1b")) this.input += data;
  }

  private settingsKey(data: string): void {
    if (data === "\x1b[A") this.setSel = Math.max(0, this.setSel - 1);
    else if (data === "\x1b[B") this.setSel = Math.min(this.settings.length - 1, this.setSel + 1);
    else if (data === "\x1b[D") this.settings[this.setSel]?.left?.();
    else if (data === "\x1b[C") this.settings[this.setSel]?.right?.();
    else if (data === "\r" || data === " ") {
      const s = this.settings[this.setSel];
      if (!s) return;
      if (s.kind === "text" || s.kind === "number") {
        this.editing = { label: s.label, key: s.key, buffer: s.value() };
      } else if (s.kind === "source") {
        void s.action?.().then((msg) => msg && this.setStatus(msg));
      } else if (s.kind === "action") {
        this.setStatus(`${s.label}...`);
        void s.action?.().then((msg) => msg && this.setStatus(msg));
      }
    }
    this.ensureSettingVisible();
  }

  private openFile(full: string): void {
    try {
      const text = fs.readFileSync(full, "utf8");
      this.preview = text.split("\n").slice(0, 400);
      this.previewName = full;
      this.previewScroll = 0;
    } catch {
      this.preview = ["(cannot read file)"];
      this.previewName = full;
    }
  }

  private ensureFileVisible(): void {
    const rows = Math.max(4, this.h - 8);
    if (this.fileSel < this.fileScroll) this.fileScroll = this.fileSel;
    if (this.fileSel >= this.fileScroll + rows) this.fileScroll = this.fileSel - rows + 1;
  }

  private ensureSettingVisible(): void {
    const rows = Math.max(4, this.h - 8);
    if (this.setSel < this.setScroll) this.setScroll = this.setSel;
    if (this.setSel >= this.setScroll + rows) this.setScroll = this.setSel - rows + 1;
  }

  private sendTalk(): void {
    const q = this.input.trim();
    if (!q) return;
    const history = [...this.talk];
    this.talk.push({ role: "user", content: q });
    this.input = "";
    this.busy = true;
    this.talkScroll = 0;
    this.dirty = true;
    void chatTurn(this.config, q, history)
      .then((res) => {
        this.talk.push({ role: "assistant", content: res.text, sources: res.sources });
      })
      .catch((err) => {
        this.talk.push({ role: "assistant", content: `ERROR: ${err instanceof Error ? err.message : String(err)}` });
      })
      .finally(() => {
        this.busy = false;
        this.dirty = true;
      });
  }

  private render(): void {
    this.dirty = false;
    this.w = process.stdout.columns ?? this.w;
    this.h = process.stdout.rows ?? this.h;
    if (this.w < 72 || this.h < 20) {
      process.stdout.write("\x1b[H\x1b[2J" + "TERMINAL TOO SMALL. RESIZE TO AT LEAST 72 X 20, PRESS Q TO QUIT.\r\n");
      return;
    }

    const lines: string[] = [];
    const border = (l: string, m: string, r: string) => l + m.repeat(this.w - 2) + r;
    lines.push(border("+", "-", "+"));

    const state = loadState();
    const idx = loadEvents();
    const running = agentRunning().running || serviceStatus().running;
    const left = ` JOURNALISM // PRIMARY RECORD`;
    const rightInfo = `${running ? "AGENT ON" : "AGENT OFF"}  |  ${idx.all.length} RECORDS  |  ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit" })} PT `;
    const leftWidth = this.w - 2 - rightInfo.length;
    lines.push("|" + pad(clipRight(left, leftWidth), leftWidth) + rightInfo + "|");
    lines.push("|" + tabsLine(this.tab, this.w - 2) + "|");
    lines.push(border("+", "-", "+"));

    const body = Math.max(4, this.h - 8);
    const tab = TABS[this.tab];
    let bodyLines: string[] = [];
    if (tab === "FILES") bodyLines = this.renderFiles(body);
    else if (tab === "POI") bodyLines = this.renderPoi(body);
    else if (tab === "TALK") bodyLines = this.renderTalk(body);
    else bodyLines = this.renderSettings(body);
    while (bodyLines.length < body) bodyLines.push("|" + " ".repeat(this.w - 2) + "|");
    lines.push(...bodyLines.slice(0, body));

    lines.push(border("+", "-", "+"));
    lines.push("|" + pad(" TAB / SHIFT-TAB  SWITCH   UP/DOWN  MOVE   ENTER  OPEN / RUN   LEFT/RIGHT  COLLAPSE / ADJUST   Q  QUIT", this.w - 2) + "|");
    const status = this.editing
      ? ` ${this.editing.label}: ${this.editing.buffer}_   (ENTER SAVE, ESC CANCEL)`
      : this.busy
        ? ` WORKING${".".repeat(this.spinner)}`
        : ` ${this.status || `VAULT ${this.config.vault}`}`;
    lines.push("|" + pad(status, this.w - 2) + "|");
    lines.push(border("+", "-", "+"));

    process.stdout.write("\x1b[H" + lines.slice(0, this.h).join("\n"));
  }

  private renderFiles(body: number): string[] {
    const inner = this.w - 2;
    const lw = Math.min(34, Math.floor(inner * 0.36));
    const rw = inner - lw - 1;
    const out: string[] = [];
    const visible = this.rows.slice(this.fileScroll, this.fileScroll + body);
    for (let i = 0; i < body; i++) {
      const row = visible[i];
      let left = "";
      if (row) {
        const marker = row.node.dir ? (this.expanded.has(row.node.full) ? "-" : "+") : " ";
        left = `${" ".repeat(Math.max(0, row.depth - 1) * 2)}${marker} ${row.node.name}`;
      }
      const selected = this.fileScroll + i === this.fileSel;
      const leftBlock = selected
        ? A.reverse + pad(" " + left, lw) + A.reset
        : pad(" " + left, lw);

      const p = this.preview[this.previewScroll + i] ?? (i === 0 ? "(select a file)" : "");
      out.push("|" + leftBlock + "|" + pad(" " + truncate(p.replace(/\t/g, "  "), rw - 1), rw) + "|");
    }
    return out;
  }

  private renderPoi(body: number): string[] {
    const inner = this.w - 2;
    const lw = Math.min(40, Math.floor(inner * 0.42));
    const rw = inner - lw - 1;
    const idx = loadEvents();
    const counts = new Map<string, number>();
    for (const e of idx.all) counts.set(e.sourceType, (counts.get(e.sourceType) ?? 0) + 1);
    const p = this.config.poi;
    const identity = [
      ` NAME       ${p.name.toUpperCase()}`,
      ` ROLE       ${p.role ?? "-"}`,
      ` PLACE      ${p.jurisdiction ?? "-"}`,
      ` PARTY      ${p.party ?? "-"}`,
      "",
      ` RECORDS    ${idx.all.length}`,
      ` TYPES      ${[...counts.entries()].map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`,
      ` PENDING    ${loadState().pending?.length ?? 0}`,
      ` TOKENS     ${loadState().tokensUsedToday.toLocaleString()} / ${this.config.agent.dailyTokenBudget.toLocaleString()}`,
      "",
      " HANDLES",
      ` X          ${p.handles.x ?? "-"}`,
      ` TRUTH      ${p.handles.truth ?? "-"}`,
      ` BLUESKY    ${p.handles.bluesky ?? "-"}`,
      ` YOUTUBE    ${p.handles.youtubeChannelId ?? "-"}`,
      ` BIOGUIDE   ${p.ids.bioguide ?? "-"}`,
      ` FEC        ${p.ids.fecCandidateId ?? "-"}`,
      "",
      " SOURCES",
      ...sourceSummary(this.config).map((s) => ` ${s.enabled ? "*" : "-"} ${s.id.padEnd(14)} ${s.interval}m`),
    ];
    const recent = idx.all.slice(this.previewScroll, this.previewScroll + body);
    const out: string[] = [];
    for (let i = 0; i < body; i++) {
      const r = recent[i]
        ? `${recent[i].publishedAt.slice(0, 10)}  ${truncate(recent[i].title, rw - 13)}`
        : "";
      out.push("|" + pad(" " + truncate(identity[i] ?? "", lw - 1), lw) + "|" + pad(" " + r, rw) + "|");
    }
    return out;
  }

  private renderTalk(body: number): string[] {
    const inner = this.w - 2;
    const width = inner - 4;
    const rendered: string[] = [];
    for (const m of this.talk) {
      const prefix = m.role === "user" ? "YOU> " : "AGT> ";
      const text = m.content.replace(/\r/g, "");
      const wrapped = wrap(text, width - prefix.length);
      wrapped.forEach((line, i) => rendered.push((i === 0 ? prefix : " ".repeat(prefix.length)) + line));
      if (m.sources?.length) {
        for (const s of m.sources.slice(0, 4)) {
          rendered.push(`     SRC ${truncate(s.sourceLabel + ": " + s.title, width - 9)}`);
          rendered.push(`     ${truncate(s.url, width - 5)}`);
        }
      }
      rendered.push("");
    }
    const inputLine = "> " + this.input + (this.busy ? `  [THINKING${".".repeat(this.spinner)}]` : "_");
    const available = body - 1;
    const total = rendered.length;
    const start = Math.max(0, total - available - this.talkScroll);
    const out: string[] = [];
    for (let i = 0; i < available; i++) {
      const line = rendered[start + i] ?? "";
      const colored = line.startsWith("YOU>") ? A.green + line + A.reset : line.startsWith("AGT>") ? A.bold + line + A.reset : line;
      out.push("|" + padVisible(" " + colored, inner) + "|");
    }
    out.push("|" + pad(" " + inputLine, inner) + "|");
    return out;
  }

  private renderSettings(body: number): string[] {
    const inner = this.w - 2;
    const lw = 26;
    const out: string[] = [];
    const visible = this.settings.slice(this.setScroll, this.setScroll + body);
    for (let i = 0; i < body; i++) {
      const s = visible[i];
      if (!s) {
        out.push("|" + " ".repeat(inner) + "|");
        continue;
      }
      const selected = this.setScroll + i === this.setSel;
      const raw = `${selected ? ">" : " "} ${s.label.padEnd(lw)} ${s.value()}`;
      out.push("|" + (selected ? A.reverse + pad(" " + raw, inner) + A.reset : pad(" " + raw, inner)) + "|");
    }
    return out;
  }
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function padVisible(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return s + " ".repeat(Math.max(0, width - visible));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1));
}

function clipRight(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s;
}

function tabsLine(active: number, width: number): string {
  let out = " ";
  TABS.forEach((t, i) => {
    out += i === active ? `[ ${t} ]` : `  ${t}  `;
    if (i < TABS.length - 1) out += " ";
  });
  const rightSide = "TAB / SHIFT-TAB TO SWITCH";
  return pad(out, width - rightSide.length - 1) + A.grey + rightSide + A.reset + " ";
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if ((line + " " + word).trim().length > width) {
        if (line) out.push(line);
        line = word;
      } else {
        line = line ? line + " " + word : word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export { statePath };
