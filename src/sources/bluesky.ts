import type { SourceAdapter } from "../core/types.js";
import { fetchJson, parseDate } from "../core/util.js";
import { newEvent } from "../core/store.js";

type FeedItem = {
  post?: {
    uri: string;
    record?: { text?: string; createdAt?: string; reply?: unknown };
    author?: { handle?: string; displayName?: string };
  };
  reason?: unknown;
};

export const blueskySource: SourceAdapter = {
  id: "bluesky",
  label: "Bluesky",
  description: "The person's own Bluesky posts through the public AT Protocol API.",
  primaryReason: "Verbatim posts from the person's own account.",
  requires: ["handles.bluesky"],
  defaultIntervalMinutes: 30,
  async poll({ config }) {
    const handle = config.poi.handles.bluesky?.replace(/^@/, "");
    if (!handle) return [];
    const feed = await fetchJson<{ feed?: FeedItem[] }>(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=50&filter=posts_no_replies`,
      { cache: false },
    );
    return (feed.feed ?? [])
      .filter((f) => !f.reason && f.post?.record?.text)
      .map((f) => {
        const uri = f.post!.uri;
        const rkey = uri.split("/").pop() ?? "";
        return newEvent({
          id: `bluesky:${uri}`,
          source: "bluesky",
          sourceType: "post",
          sourceLabel: "Bluesky post",
          title: `Bluesky post by ${config.poi.name}`,
          text: f.post!.record!.text!,
          url: `https://bsky.app/profile/${handle}/post/${rkey}`,
          publishedAt: parseDate(f.post!.record!.createdAt),
          meta: { handle, uri },
        });
      });
  },
};
