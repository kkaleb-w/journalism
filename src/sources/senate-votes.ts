import type { SourceAdapter, PrimaryEvent } from "../core/types.js";
import { fetchText, parseDate, truncate, xmlBlocks, xmlText } from "../core/util.js";
import { newEvent } from "../core/store.js";

export const senateVotesSource: SourceAdapter = {
  id: "senate-votes",
  label: "Senate roll-call votes",
  description: "The person's individual Senate votes from the official Senate roll-call XML.",
  primaryReason: "Official roll-call record: how the person actually voted.",
  requires: ["ids.bioguide", "ids.congress", "ids.senateSession", "ids.state"],
  defaultIntervalMinutes: 360,
  async poll({ config, log }) {
    const { congress, senateSession, state } = config.poi.ids;
    if (!congress || !senateSession) return [];
    const lastName = config.poi.name.trim().split(/\s+/).pop()?.toLowerCase();
    if (!lastName) return [];

    const menuUrl = `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${congress}_${senateSession}.xml`;
    const menu = await fetchText(menuUrl, { cache: true, timeoutMs: 45_000 });
    const votes = xmlBlocks(menu.text, "vote").slice(-12);
    const events: PrimaryEvent[] = [];

    for (const vote of votes.reverse()) {
      const number = xmlText(vote, "vote_number");
      if (!number) continue;
      const issue = xmlText(vote, "issue") || xmlText(vote, "question") || "Roll call";
      const date = xmlText(vote, "vote_date");
      const question = xmlText(vote, "question");
      const result = xmlText(vote, "result");
      const voteUrl = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${senateSession}/vote_${congress}_${senateSession}_${String(number).padStart(5, "0")}.xml`;
      try {
        const detail = await fetchText(voteUrl, { cache: true, timeoutMs: 30_000 });
        const members = xmlBlocks(detail.text, "member");
        const mine = members.find((m) => {
          const ln = xmlText(m, "last_name").toLowerCase();
          const st = xmlText(m, "state").toLowerCase();
          return ln === lastName && (!state || st === state.toLowerCase());
        });
        if (!mine) continue;
        const cast = xmlText(mine, "vote_cast");
        if (!cast) continue;
        events.push(
          newEvent({
            id: `senate-votes:${congress}-${senateSession}-${number}`,
            source: "senate-votes",
            sourceType: "vote",
            sourceLabel: "Senate roll call",
            title: `Voted ${cast}: ${truncate(issue, 180)}`,
            text: truncate(
              [
                `Vote: ${cast}`,
                `Question: ${question}`,
                `Measure: ${issue}`,
                `Result: ${result}`,
                `Roll call: ${number}, Congress ${congress}, session ${senateSession}`,
              ].join("\n"),
              4000,
            ),
            url: voteUrl.replace(".xml", ".htm"),
            publishedAt: parseDate(date),
            meta: { congress, session: senateSession, rollCall: number, cast, question, result },
          }),
        );
      } catch (err) {
        log(`senate vote ${number} skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return events;
  },
};
