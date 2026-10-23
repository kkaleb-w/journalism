import type { SourceAdapter } from "../core/types.js";
import { fetchJson } from "../core/util.js";
import { newEvent } from "../core/store.js";

type XTweets = {
  data?: {
    id: string;
    text: string;
    created_at?: string;
    public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number };
  }[];
  includes?: { users?: { id: string; username: string; name: string }[] };
  errors?: { detail?: string }[];
};

export const xSource: SourceAdapter = {
  id: "x",
  label: "X / Twitter",
  description: "The person's own posts, pulled from the official X API.",
  primaryReason: "Verbatim posts from the person's own account.",
  requires: ["handles.x", "X API bearer token"],
  defaultIntervalMinutes: 30,
  async poll({ config }) {
    const handle = config.poi.handles.x?.replace(/^@/, "");
    if (!handle) return [];
    const token =
      (config.sources.x?.options?.token as string | undefined) || process.env.X_BEARER_TOKEN || "";
    if (!token) throw new Error("X source needs a bearer token in sources.x.options.token");
    const headers = { authorization: `Bearer ${token}` };
    const user = await fetchJson<{ data?: { id: string } }>(
      `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}`,
      { headers, cache: false },
    );
    const userId = user.data?.id;
    if (!userId) throw new Error(`X user @${handle} not found`);
    const tweets = await fetchJson<XTweets>(
      `https://api.x.com/2/users/${userId}/tweets?max_results=100&exclude=retweets,replies&tweet.fields=created_at,public_metrics,referenced_tweets`,
      { headers, cache: false },
    );
    if (tweets.errors?.length) throw new Error(tweets.errors.map((e) => e.detail).join("; "));
    return (tweets.data ?? []).map((t) =>
      newEvent({
        id: `x:${t.id}`,
        source: "x",
        sourceType: "post",
        sourceLabel: "X post",
        title: `Post by ${config.poi.name}`,
        text: t.text,
        url: `https://x.com/${handle}/status/${t.id}`,
        publishedAt: t.created_at ?? new Date().toISOString(),
        meta: { handle, metrics: t.public_metrics ?? {} },
      }),
    );
  },
};
