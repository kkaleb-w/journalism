import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { Config } from "./types.js";
import { fetchJson, truncate } from "./util.js";

export type Transcript = { text: string; provider: string; model: string };

export async function transcribeFile(config: Config, filePath: string): Promise<Transcript> {
  if (!config.transcription.enabled) throw new Error("Transcription is disabled in config");
  const t = config.transcription;
  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath);

  if (t.kind === "openai-audio") {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)]), name);
    form.append("model", t.model);
    form.append("response_format", "json");
    const res = await fetch(`${t.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Transcription failed: HTTP ${res.status} ${truncate(await res.text(), 300)}`);
    const data = (await res.json()) as { text?: string };
    return { text: data.text ?? "", provider: t.providerId, model: t.model };
  }

  if (t.kind === "deepgram") {
    const res = await fetch(`${t.baseUrl.replace(/\/+$/, "")}/listen?model=${encodeURIComponent(t.model)}&smart_format=true&punctuate=true`, {
      method: "POST",
      headers: { authorization: `Token ${t.apiKey}`, "content-type": "audio/*" },
      body: buf,
    });
    if (!res.ok) throw new Error(`Deepgram failed: HTTP ${res.status} ${truncate(await res.text(), 300)}`);
    const data = (await res.json()) as {
      results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
    };
    return {
      text: data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "",
      provider: "deepgram",
      model: t.model,
    };
  }

  if (t.kind === "gemini-audio") {
    const data = await fetchJson<{ candidates?: { content?: { parts?: { text?: string }[] } }[] }>(
      `${t.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(t.model)}:generateContent?key=${encodeURIComponent(t.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: false,
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: "Transcribe this recording verbatim. Output only the transcript, no commentary. Mark inaudible parts as [inaudible]." },
                { inlineData: { mimeType: mimeFor(name), data: buf.toString("base64") } },
              ],
            },
          ],
          generationConfig: { temperature: 0 },
        }),
        timeoutMs: 180_000,
      },
    );
    return {
      text: data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "",
      provider: "gemini",
      model: t.model,
    };
  }

  throw new Error(`Unsupported transcription provider kind: ${t.kind}`);
}

export async function downloadToTmp(url: string, filenameHint = "audio"): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "journalism-cli/0.1" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  const ext = extFor(contentType, url);
  const dir = path.join(os.tmpdir(), "journalism-audio");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${filenameHint.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60)}-${Date.now()}.${ext}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return file;
}

function mimeFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mp3";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".webm") return "audio/webm";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".mp4") return "video/mp4";
  return "audio/mpeg";
}

function extFor(contentType: string, url: string): string {
  if (contentType.includes("mpeg")) return "mp3";
  if (contentType.includes("mp4")) return "m4a";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("ogg")) return "ogg";
  const m = url.match(/\.(mp3|m4a|wav|webm|ogg|mp4)(?:\?|$)/i);
  return m ? m[1].toLowerCase() : "mp3";
}

export function whisperAvailable(): boolean {
  try {
    execSync("which whisper-cli || which whisper", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

/**
 * Transcribe an audio file of any length. Files above the provider's upload cap
 * are split with ffmpeg into ten-minute parts and joined.
 */
export async function transcribeAudioLong(config: Config, filePath: string): Promise<Transcript> {
  const size = fs.statSync(filePath).size;
  if (size <= MAX_UPLOAD_BYTES) return transcribeFile(config, filePath);

  let ffmpeg = "ffmpeg";
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
  } catch {
    throw new Error(
      `Audio is ${(size / 1024 / 1024).toFixed(0)}MB, above the 24MB upload cap, and ffmpeg is not installed. Install ffmpeg or use a shorter clip.`,
    );
  }

  const dir = path.join(os.tmpdir(), `journalism-split-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  execSync(
    `${ffmpeg} -hide_banner -loglevel error -i ${JSON.stringify(filePath)} -f segment -segment_time 600 -c copy ${JSON.stringify(path.join(dir, "part-%03d.mp3"))}`,
    { stdio: "pipe", timeout: 600_000 },
  );
  const parts = fs.readdirSync(dir).filter((f) => f.endsWith(".mp3")).sort();
  const pieces: string[] = [];
  let provider = "";
  let model = "";
  for (const part of parts) {
    const t = await transcribeFile(config, path.join(dir, part));
    pieces.push(t.text.trim());
    provider = t.provider;
    model = t.model;
  }
  return { text: pieces.join("\n\n"), provider, model };
}
