import type { SourceAdapter, PrimaryEvent } from "../core/types.js";
import { fetchJson, fetchText, parseDate, truncate, xmlBlocks, xmlText } from "../core/util.js";
import { newEvent } from "../core/store.js";

type HouseVoteList = {
  houseRollCallVotes?: {
    rollCallNumber: number;
    sessionNumber: number;
    legislationNumber?: string;
    legislationType?: string;
    legislationUrl?: string;
    result?: string;
    startDate?: string;
    sourceDataURL?: string;
  }[];
};

export const houseVotesSource: SourceAdapter = {
  id: "house-votes",
  label: "House roll-call votes",
  description: "The person's individual House votes from the official Clerk roll-call XML.",
  primaryReason: "Official roll-call record: how the person actually voted.",
  requires: ["ids.bioguide", "ids.congress", "Congress.gov API key"],
  defaultIntervalMinutes: 360,
  async poll({ config, log }) {
    const bioguide = config.poi.ids.bioguide;
    const congress = config.poi.ids.congress;
    if (!bioguide || !congress) return [];
    const apiKey =
      (config.sources.congress?.options?.apiKey as string | undefined) ||
      process.env.CONGRESS_API_KEY ||
      "DEMO_KEY";
    const session = config.poi.ids.senateSession ?? 2;

    const list = await fetchJson<HouseVoteList>(
      `https://api.congress.gov/v3/house-vote/${congress}/${session}?api_key=${encodeURIComponent(apiKey)}&format=json&limit=40&sort=updateDate+desc`,
      { cache: false, timeoutMs: 45_000 },
    );
    const votes = (list.houseRollCallVotes ?? [])
      .filter((v) => v.sourceDataURL)
      .sort((a, b) => (a.startDate && b.startDate ? (a.startDate < b.startDate ? 1 : -1) : b.rollCallNumber - a.rollCallNumber))
      .slice(0, 14);

    const events: PrimaryEvent[] = [];
    for (const v of votes) {
      try {
        const detail = await fetchText(v.sourceDataURL!, { cache: true, timeoutMs: 30_000 });
        const mine = xmlBlocks(detail.text, "recorded-vote").find((blk) =>
          new RegExp(`name-id="${bioguide}"`, "i").test(blk),
        );
        if (!mine) continue;
        const cast = xmlText(mine, "vote");
        if (!cast) continue;
        const question = xmlText(detail.text, "vote-question");
        const measure = v.legislationType && v.legislationNumber ? `${v.legislationType} ${v.legislationNumber}` : xmlText(detail.text, "legis-num");
        events.push(
          newEvent({
            id: `house-votes:${congress}-${session}-${v.rollCallNumber}`,
            source: "house-votes",
            sourceType: "vote",
            sourceLabel: "House roll call",
            title: `Voted ${cast} — Roll ${v.rollCallNumber}: ${truncate(measure || question, 160)}`,
            text: truncate(
              [
                `Vote: ${cast}`,
                `Question: ${question}`,
                `Measure: ${measure}`,
                `Result: ${v.result ?? xmlText(detail.text, "vote-result")}`,
                `Roll call: ${v.rollCallNumber}, Congress ${congress}, session ${session}`,
              ].join("\n"),
              4000,
            ),
            url: v.sourceDataURL!.replace(".xml", ".htm"),
            publishedAt: parseDate(v.startDate),
            meta: {
              congress,
              session,
              rollCall: v.rollCallNumber,
              cast,
              question,
              result: v.result,
              measure,
            },
          }),
        );
      } catch (err) {
        log(`house vote ${v.rollCallNumber} skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return events;
  },
};
