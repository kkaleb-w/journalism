import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { Config } from "../core/types.js";
import { configPath, dataDir, exists, homeDir, loadConfig } from "../core/config.js";
import { listModels } from "../core/llm.js";
import { serviceStatus } from "../core/service.js";
import { agentRunning } from "../core/agent.js";
import { sourceSummary } from "../sources/index.js";

export async function doctor(): Promise<number> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js",
    ok: major >= 20,
    detail: `${process.version}${major >= 20 ? "" : " (need 20.11+)"}`,
  });

  const hasConfig = exists();
  checks.push({ name: "Config", ok: hasConfig, detail: hasConfig ? configPath() : "missing — run journalism onboard" });

  let config: Config | null = null;
  if (hasConfig) {
    try {
      config = loadConfig();
      checks.push({ name: "Config parse", ok: true, detail: `v${config.version}` });
    } catch (err) {
      checks.push({ name: "Config parse", ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  if (config) {
    try {
      fs.mkdirSync(config.vault, { recursive: true });
      const probe = path.join(config.vault, ".journalism-write-test");
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      checks.push({ name: "Vault writable", ok: true, detail: config.vault });
    } catch (err) {
      checks.push({ name: "Vault writable", ok: false, detail: err instanceof Error ? err.message : String(err) });
    }

    try {
      const models = await listModels(config.provider);
      checks.push({
        name: "Model provider",
        ok: models.length > 0,
        detail: models.length ? `${config.provider.model} (${models.length} models visible)` : `could not list models at ${config.provider.baseUrl}`,
      });
    } catch (err) {
      checks.push({ name: "Model provider", ok: false, detail: err instanceof Error ? err.message : String(err) });
    }

    for (const s of sourceSummary(config)) {
      if (!s.enabled) continue;
      const opts = config.sources[s.id]?.options ?? {};
      const needsKey =
        (s.id === "x" && !opts.token && !process.env.X_BEARER_TOKEN) ||
        (s.id === "congress" && !opts.apiKey && !process.env.CONGRESS_API_KEY) ||
        (s.id === "fec" && !opts.apiKey && !process.env.FEC_API_KEY);
      checks.push({
        name: `Source ${s.id}`,
        ok: !needsKey,
        detail: needsKey ? "enabled but missing API key" : `every ${s.interval} min`,
      });
    }

    const agent = agentRunning();
    const svc = serviceStatus();
    checks.push({
      name: "Agent process",
      ok: agent.running || svc.running,
      detail: agent.running ? `pid ${agent.pid}` : svc.running ? "running under service manager" : "not running",
    });
    checks.push({ name: "Auto-start", ok: svc.installed, detail: svc.installed ? svc.detail : "not installed" });
  }

  console.log(chalk.bold("\njournalism doctor\n"));
  for (const c of checks) {
    console.log(`${c.ok ? chalk.green("✓") : chalk.red("✗")} ${c.name.padEnd(18)} ${chalk.dim(c.detail)}`);
  }
  console.log(chalk.dim(`\nHome: ${homeDir()}`));
  console.log(chalk.dim(`Data: ${dataDir()}\n`));
  return checks.every((c) => c.ok) ? 0 : 1;
}
