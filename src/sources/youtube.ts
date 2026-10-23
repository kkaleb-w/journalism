import type { SourceAdapter, PrimaryEvent } from "../core/types.js";
import { fetchText, mapLimit, parseDate, truncate, xmlBlocks, xmlText } from "../core/util.js";
import { newEvent } from "../core/store.js";
import { downloadToTmp, transcribeAudioLong, transcribeFile } from "../core/transcribe.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

type CaptionTrack = { baseUrl: string; languageCode: string; kind?: string; name?: { simpleText?: string } };

export const youtubeSource: SourceAdapter = {
  id: "youtube",
  label: "YouTube / official video",
  description: "New uploads from the person's official channel, with optional transcripts.",
  primaryReason: "The person's own recorded words on their own channel.",
  requires: ["handles.youtubeChannelId"],
  defaultIntervalMinutes: 120,
  async poll({ config, log }) {
    const channelId = config.poi.handles.youtubeChannelId;
    if (!channelId) return [];
    const feed = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
      cache: true,
      timeoutMs: 20_000,
    });
    const shouldTranscribe =
      config.transcription.enabled && config.sources.youtube?.options?.transcribe !== false;

    const entries = xmlBlocks(feed.text, "entry").slice(0, 6);
    const events: PrimaryEvent[] = [];
    for (const entry of entries) {
      const videoId = xmlText(entry, "yt:videoId");
      if (!videoId) continue;
      const title = xmlText(entry, "title") || `Video by ${config.poi.name}`;
      const published = parseDate(xmlText(entry, "published"));
      let text = xmlText(entry, "media:description") || title;
      let transcript: string | null = null;
      let transcriptModel: string | undefined;

      if (shouldTranscribe) {
        try {
          transcript = await fetchYouTubeTranscript(videoId);
        } catch {
          transcript = null;
        }
        if (!transcript) {
          try {
            const audio = await downloadYouTubeAudio(videoId);
            if (audio) {
              const t = await transcribeAudioLong(config, audio);
              transcript = t.text;
              transcriptModel = `${t.provider}/${t.model}`;
            }
          } catch (err) {
            log(`transcript failed for ${videoId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      if (transcript) text = transcript;

      events.push(
        newEvent({
          id: `youtube:${videoId}`,
          source: "youtube",
          sourceType: "speech",
          sourceLabel: transcript ? "Speech transcript" : "Official video",
          title,
          text: truncate(text, 60_000),
          url: `https://www.youtube.com/watch?v=${videoId}`,
          publishedAt: published,
          meta: {
            videoId,
            channelId,
            hasTranscript: Boolean(transcript),
            transcriptModel,
          },
        }),
      );
    }
    return events;
  },
};

export async function fetchYouTubeTranscript(videoId: string): Promise<string | null> {
  try {
    const { YoutubeTranscript } = await import("youtube-transcript");
    const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" });
    const fromApi = segments
      .map((s) => s.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (fromApi.length > 50) return fromApi;
  } catch {
    /* fall through to page scraping */
  }

  const page = await fetchText(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
    headers: { "user-agent": USER_AGENT, cookie: "CONSENT=YES+1" },
    cache: false,
    timeoutMs: 25_000,
  });
  const m = page.text.match(/"captionTracks":(\[[^\]]*\])/);
  if (!m) return null;
  let tracks: CaptionTrack[] = [];
  try {
    tracks = JSON.parse(m[1].replace(/\\"/g, '"').replace(/\\u0026/g, "&")) as CaptionTrack[];
  } catch {
    return null;
  }
  if (!tracks.length) return null;
  const ordered = tracks.sort((a, b) => scoreTrack(b) - scoreTrack(a));
  for (const track of ordered.slice(0, 2)) {
    try {
      const url = track.baseUrl.replace(/\\u0026/g, "&") + "&fmt=json3";
      const res = await fetchText(url, { cache: false, timeoutMs: 20_000 });
      const data = JSON.parse(res.text) as { events?: { segs?: { utf8?: string }[] }[] };
      const text = (data.events ?? [])
        .map((e) => (e.segs ?? []).map((s) => s.utf8 ?? "").join(""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length > 50) return text;
    } catch {
      /* try next track */
    }
  }
  return null;
}

function scoreTrack(t: CaptionTrack): number {
  let s = 0;
  if (t.languageCode?.startsWith("en")) s += 4;
  if (t.kind === "asr") s += 1;
  if (t.kind !== "asr") s += 2;
  return s;
}

export async function downloadYouTubeAudio(videoId: string): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const dir = await import("node:os").then((os) => os.tmpdir());
    const out = `${dir}/journalism-${videoId}.%(ext)s`;
    const args = [
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "5",
      "--no-playlist",
      "-o",
      out,
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    const cookies = process.env.JOURNALISM_YTDLP_COOKIES;
    if (cookies) args.unshift("--cookies", cookies);
    await run("yt-dlp", args, { timeout: 900_000, maxBuffer: 20 * 1024 * 1024 });
    const fs = await import("node:fs");
    const file = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`journalism-${videoId}.`) && f.endsWith(".mp3"))
      .sort()
      .pop();
    return file ? `${dir}/${file}` : null;
  } catch {
    return null;
  }
}

export async function transcribeUrl(config: Parameters<typeof transcribeFile>[0], url: string): Promise<string | null> {
  const file = await downloadToTmp(url, "speech");
  const t = await transcribeFile(config, file);
  return t.text;
}

export async function resolveYouTubeChannelId(input: string): Promise<string | null> {
  const trimmed = input.trim();
  if (/^UC[\w-]{22}$/.test(trimmed)) return trimmed;
  const url = trimmed.startsWith("http")
    ? trimmed
    : `https://www.youtube.com/@${trimmed.replace(/^@/, "")}`;
  try {
    const page = await fetchText(url, {
      headers: { "user-agent": USER_AGENT, cookie: "CONSENT=YES+1" },
      cache: false,
      timeoutMs: 25_000,
    });
    const m =
      page.text.match(/"channelId":"(UC[\w-]{22})"/) ||
      page.text.match(/"externalId":"(UC[\w-]{22})"/) ||
      page.text.match(/<meta itemprop="identifier" content="(UC[\w-]{22})"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export { mapLimit };
