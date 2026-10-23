import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Config } from "./types.js";
import { homeDir } from "./config.js";

const UNIT = "journalism.service";

function cliPath(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../cli/index.js");
}

export function installService(config: Config): { ok: boolean; message: string; path?: string } {
  const platform = process.platform;
  if (platform === "linux") return installSystemd();
  if (platform === "darwin") return installLaunchd();
  if (platform === "win32") return installWindows();
  return { ok: false, message: `Auto-start is not implemented for ${platform}. Run \`journalism start\` manually.` };
}

export function restartAgent(): string {
  if (process.platform === "linux") {
    try {
      execFileSync("systemctl", ["--user", "restart", "journalism.service"], { stdio: "pipe" });
      return "agent restarted";
    } catch (err) {
      return `restart failed: ${err instanceof Error ? err.message : String(err)}. Run \`journalism start\` instead.`;
    }
  }
  if (process.platform === "darwin") {
    try {
      execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/com.journalism.agent`], { stdio: "pipe" });
      return "agent restarted";
    } catch (err) {
      return `restart failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (process.platform === "win32") {
    try {
      execFileSync("schtasks", ["/End", "/TN", "journalism"], { stdio: "pipe" });
      execFileSync("schtasks", ["/Run", "/TN", "journalism"], { stdio: "pipe" });
      return "agent restarted";
    } catch (err) {
      return `restart failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return "run `journalism start` to restart on this platform";
}

export function uninstallService(): { ok: boolean; message: string } {
  if (process.platform === "linux") {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", UNIT], { stdio: "pipe" });
    } catch {
      /* may not exist */
    }
    const file = path.join(os.homedir(), ".config", "systemd", "user", UNIT);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
    } catch {
      /* ignore */
    }
    return { ok: true, message: "Removed the systemd user service." };
  }
  if (process.platform === "darwin") {
    const file = launchdPath();
    try {
      execFileSync("launchctl", ["unload", file], { stdio: "pipe" });
    } catch {
      /* ignore */
    }
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true, message: "Removed the LaunchAgent." };
  }
  if (process.platform === "win32") {
    try {
      execFileSync("schtasks", ["/Delete", "/TN", "journalism", "/F"], { stdio: "pipe" });
    } catch {
      /* ignore */
    }
    return { ok: true, message: "Removed the scheduled task." };
  }
  return { ok: false, message: "Nothing to remove on this platform." };
}

export function serviceStatus(): { installed: boolean; running: boolean; detail: string } {
  if (process.platform === "linux") {
    const file = path.join(os.homedir(), ".config", "systemd", "user", UNIT);
    let running = false;
    let detail = "";
    try {
      detail = execFileSync("systemctl", ["--user", "is-active", UNIT], { encoding: "utf8" }).trim();
      running = detail === "active";
    } catch (err) {
      detail = err instanceof Error ? err.message : "inactive";
    }
    return { installed: fs.existsSync(file), running, detail };
  }
  if (process.platform === "darwin") {
    const file = launchdPath();
    let running = false;
    try {
      const out = execFileSync("launchctl", ["list"], { encoding: "utf8" });
      running = out.includes("com.journalism.agent");
    } catch {
      /* ignore */
    }
    return { installed: fs.existsSync(file), running, detail: running ? "loaded" : "not loaded" };
  }
  if (process.platform === "win32") {
    try {
      const out = execFileSync("schtasks", ["/Query", "/TN", "journalism"], { encoding: "utf8" });
      return { installed: true, running: out.includes("Running"), detail: out.trim().split("\n")[0] };
    } catch {
      return { installed: false, running: false, detail: "no task" };
    }
  }
  return { installed: false, running: false, detail: "unsupported platform" };
}

function installSystemd(): { ok: boolean; message: string; path: string } {
  const dir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, UNIT);
  const unit = `[Unit]
Description=journalism agent (primary-source political tracker)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${cliPath()} start --foreground
WorkingDirectory=${process.cwd()}
Environment=JOURNALISM_HOME=${homeDir()}
Restart=always
RestartSec=15
StandardOutput=append:${path.join(homeDir(), "logs", "service.log")}
StandardError=append:${path.join(homeDir(), "logs", "service.log")}

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(file, unit);
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
    execFileSync("systemctl", ["--user", "enable", "--now", UNIT], { stdio: "pipe" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Wrote ${file} but could not start it (${msg}). Try: systemctl --user enable --now ${UNIT}`,
      path: file,
    };
  }
  return {
    ok: true,
    message: `Installed and started ${UNIT}. It will start on boot. Run \`loginctl enable-linger $USER\` if you want it running before you log in.`,
    path: file,
  };
}

function launchdPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.journalism.agent.plist");
}

function installLaunchd(): { ok: boolean; message: string; path: string } {
  const file = launchdPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.journalism.agent</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${cliPath()}</string><string>start</string><string>--foreground</string></array>
  <key>EnvironmentVariables</key><dict><key>JOURNALISM_HOME</key><string>${homeDir()}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(homeDir(), "logs", "service.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(homeDir(), "logs", "service.log")}</string>
</dict></plist>
`;
  fs.writeFileSync(file, plist);
  try {
    execFileSync("launchctl", ["load", "-w", file], { stdio: "pipe" });
  } catch (err) {
    return { ok: false, message: `Wrote ${file} but launchctl failed: ${err instanceof Error ? err.message : err}`, path: file };
  }
  return { ok: true, message: "Installed the LaunchAgent. It starts at login and restarts if it dies.", path: file };
}

function installWindows(): { ok: boolean; message: string } {
  try {
    execFileSync(
      "schtasks",
      [
        "/Create",
        "/TN",
        "journalism",
        "/SC",
        "ONLOGON",
        "/RL",
        "LIMITED",
        "/TR",
        `"${process.execPath}" "${cliPath()}" start --foreground`,
        "/F",
      ],
      { stdio: "pipe" },
    );
    execFileSync("schtasks", ["/Run", "/TN", "journalism"], { stdio: "pipe" });
    return { ok: true, message: "Created a Task Scheduler job that starts at logon." };
  } catch (err) {
    return { ok: false, message: `Could not create scheduled task: ${err instanceof Error ? err.message : err}` };
  }
}
