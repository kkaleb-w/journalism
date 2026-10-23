import type { SourceAdapter } from "../core/types.js";
import { fetchJson, parseDate, truncate } from "../core/util.js";
import { newEvent } from "../core/store.js";

type Sponsored = {
  sponsoredLegislation?: {
    congress: number;
    type: string;
    number: string;
    title: string;
    introducedDate?: string;
    policyArea?: { name?: string };
    latestAction?: { actionDate?: string; text?: string };
    url?: string;
  }[];
};

export const congressSource: SourceAdapter = {
  id: "congress",
  label: "Congress.gov (bills)",
  description: "Bills the person sponsored or cosponsored, straight from the official Congress.gov API.",
  primaryReason: "Official legislative record: what the person actually introduced.",
  requires: ["ids.bioguide", "Congress.gov API key"],
  defaultIntervalMinutes: 720,
  async poll({ config }) {
    const bioguide = config.poi.ids.bioguide;
    if (!bioguide) return [];
    const apiKey =
      (config.sources.congress?.options?.apiKey as string | undefined) ||
      process.env.CONGRESS_API_KEY ||
      "DEMO_KEY";
    const url = `https://api.congress.gov/v3/member/${encodeURIComponent(bioguide)}/sponsored-legislation?api_key=${encodeURIComponent(apiKey)}&format=json&limit=25&sort=updateDate+desc`;
    const data = await fetchJson<Sponsored>(url, { cache: false, timeoutMs: 45_000 });
    return (data.sponsoredLegislation ?? []).map((b) => {
      const chamber = b.type?.startsWith("H") ? "house-bill" : "senate-bill";
      const billType = (b.type || "HR").toUpperCase();
      const link =
        b.url?.replace("api.congress.gov/v3/bill", "www.congress.gov/bill") ??
        `https://www.congress.gov/bill/${b.congress}th-congress/${chamber}/${b.number}`;
      return newEvent({
        id: `congress:${b.congress}:${b.type}:${b.number}`,
        source: "congress",
        sourceType: "bill",
        sourceLabel: "Sponsored bill",
        title: `${billType} ${b.number}: ${b.title}`,
        text: truncate(
          [
            b.title,
            b.policyArea?.name ? `Policy area: ${b.policyArea.name}` : "",
            b.latestAction?.text ? `Latest action: ${b.latestAction.text}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          4000,
        ),
        url: link,
        publishedAt: parseDate(b.latestAction?.actionDate ?? b.introducedDate),
        meta: {
          congress: b.congress,
          billType: b.type,
          number: b.number,
          policyArea: b.policyArea?.name,
          introducedDate: b.introducedDate,
          latestAction: b.latestAction?.text,
        },
      });
    });
  },
};
