import type { SourceAdapter } from "../core/types.js";
import { fetchJson, parseDate, stripHtml } from "../core/util.js";
import { newEvent } from "../core/store.js";

type TruthAccount = { id: string; username: string; display_name?: string };
type TruthStatus = {
  id: string;
  content: string;
  created_at: string;
  url?: string;
  reblog?: unknown;
  media_attachments?: { type: string; description?: string }[];
};

export const truthSocialSource: SourceAdapter = {
  id: "truthsocial",
  label: "Truth Social",
  description: "The person's own Truth Social posts through the public Mastodon-compatible API.",
  primaryReason: "Verbatim posts from the person's own account.",
  requires: ["handles.truth"],
  defaultIntervalMinutes: 30,
  async poll({ config }) {
    const handle = config.poi.handles.truth?.replace(/^@/, "");
    if (!handle) return [];
    const account = await fetchJson<TruthAccount>(
      `https://truthsocial.com/api/v1/accounts/lookup?acct=${encodeURIComponent(handle)}`,
      { cache: false },
    );
    if (!account?.id) throw new Error(`Truth Social account @${handle} not found`);
    const statuses = await fetchJson<TruthStatus[]>(
      `https://truthsocial.com/api/v1/accounts/${account.id}/statuses?limit=40&exclude_replies=true&exclude_reblogs=true`,
      { cache: false },
    );
    return (Array.isArray(statuses) ? statuses : []).map((s) => {
      const text = stripHtml(s.content ?? "");
      return newEvent({
        id: `truthsocial:${s.id}`,
        source: "truthsocial",
        sourceType: "post",
        sourceLabel: "Truth Social post",
        title: `Truth Social post by ${config.poi.name}`,
        text,
        url: s.url ?? `https://truthsocial.com/@${handle}/${s.id}`,
        publishedAt: parseDate(s.created_at),
        meta: { handle, media: s.media_attachments?.length ?? 0 },
      });
    });
  },
};
