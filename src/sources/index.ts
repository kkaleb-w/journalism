import type { Config, SourceAdapter } from "../core/types.js";
import { xSource } from "./x.js";
import { truthSocialSource } from "./truthsocial.js";
import { blueskySource } from "./bluesky.js";
import { youtubeSource } from "./youtube.js";
import { congressSource } from "./congress.js";
import { senateVotesSource } from "./senate-votes.js";
import { houseVotesSource } from "./house-votes.js";
import { fecSource } from "./fec.js";
import { rssSource } from "./rss.js";

export const SOURCES: SourceAdapter[] = [
  xSource,
  truthSocialSource,
  blueskySource,
  youtubeSource,
  congressSource,
  senateVotesSource,
  houseVotesSource,
  fecSource,
  rssSource,
];

export function sourceById(id: string): SourceAdapter | undefined {
  return SOURCES.find((s) => s.id === id);
}

export function enabledSources(config: Config): SourceAdapter[] {
  return SOURCES.filter((s) => config.sources[s.id]?.enabled);
}

export function sourceSummary(config: Config): { id: string; label: string; enabled: boolean; interval: number }[] {
  return SOURCES.map((s) => ({
    id: s.id,
    label: s.label,
    enabled: Boolean(config.sources[s.id]?.enabled),
    interval: config.sources[s.id]?.intervalMinutes ?? s.defaultIntervalMinutes,
  }));
}

/** Human-readable reason the app can claim every item is primary. */
export const PRIMARY_SOURCE_POLICY = `Every adapter in this tool reads either (a) the person's own account or feed, or (b) an official government record of their actions. No news articles, aggregators, Wikipedia, pundits or second-hand summaries are fetched. If a claim cannot be tied to one of those records, the agent must leave it out.`;
