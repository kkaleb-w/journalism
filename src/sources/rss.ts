import type { SourceAdapter, PrimaryEvent } from "../core/types.js";
import { fetchText, hostOf, isOfficialDomain, parseDate, stripHtml, truncate, xmlBlocks, xmlText, pickLink } from "../core/util.js";
import { newEvent } from "../core/store.js";

export const rssSource: SourceAdapter = {
  id: "rss",
  label: "Official press feeds",
  description: "RSS/Atom feeds from the person's official site, chamber page or campaign.",
  primaryReason: "First-party published statements, not reporting about them.",
  requires: ["handles.rss"],
  defaultIntervalMinutes: 60,
  async poll({ config, log }) {
    const feeds = config.poi.handles.rss ?? [];
    const events: PrimaryEvent[] = [];
    const allowedHosts = feeds.map((f) => hostOf(f)).filter(Boolean);
    for (const feed of feeds) {
      try {
        const res = await fetchText(feed, { cache: true, timeoutMs: 30_000 });
        const items = xmlBlocks(res.text, "item").length
          ? xmlBlocks(res.text, "item")
          : xmlBlocks(res.text, "entry");
        for (const item of items.slice(0, 25)) {
          const link = pickLink(item) || xmlText(item, "guid");
          if (!link) continue;
          if (!isOfficialDomain(link, allowedHosts)) {
            log(`skipping non-official feed item ${link}`);
            continue;
          }
          const title = xmlText(item, "title") || "Official statement";
          const body =
            xmlText(item, "content:encoded") ||
            xmlText(item, "content") ||
            xmlText(item, "description") ||
            xmlText(item, "summary") ||
            title;
          const date =
            xmlText(item, "pubDate") || xmlText(item, "published") || xmlText(item, "updated") || undefined;
          const guid = xmlText(item, "guid") || link;
          events.push(
            newEvent({
              id: `rss:${guid}`,
              source: "rss",
              sourceType: "statement",
              sourceLabel: "Official statement",
              title,
              text: truncate(stripHtml(body), 30_000),
              url: link,
              publishedAt: parseDate(date),
              meta: { feed, host: hostOf(link) },
            }),
          );
        }
      } catch (err) {
        log(`feed failed ${feed}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return events;
  },
};
