import type { SourceAdapter } from "../core/types.js";
import { fetchJson, parseDate, truncate } from "../core/util.js";
import { newEvent } from "../core/store.js";

type Committees = {
  results?: { committee_id: string; name: string; designation?: string; cycles?: number[] }[];
};

type Disbursements = {
  results?: {
    disbursement_date?: string;
    disbursement_amount?: number;
    disbursement_description?: string;
    recipient_name?: string;
    payee_first_name?: string;
    payee_last_name?: string;
    committee_id?: string;
    entity_type?: string;
    memo_text?: string;
  }[];
};

export const fecSource: SourceAdapter = {
  id: "fec",
  label: "FEC campaign money",
  description: "Disbursements from the person's principal campaign committee, from the official FEC API.",
  primaryReason: "Official campaign-finance filings: where the money actually went.",
  requires: ["ids.fecCandidateId", "FEC API key"],
  defaultIntervalMinutes: 1440,
  async poll({ config }) {
    const candidateId = config.poi.ids.fecCandidateId;
    if (!candidateId) return [];
    const apiKey =
      (config.sources.fec?.options?.apiKey as string | undefined) || process.env.FEC_API_KEY || "DEMO_KEY";
    const cycle = new Date().getUTCFullYear() % 2 === 0 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() + 1;
    const committees = await fetchJson<Committees>(
      `https://api.open.fec.gov/v1/candidate/${encodeURIComponent(candidateId)}/committees/?api_key=${encodeURIComponent(apiKey)}&cycle=${cycle}&per_page=20`,
      { cache: false, timeoutMs: 45_000 },
    );
    const principal =
      committees.results?.find((c) => c.designation === "P") ?? committees.results?.[0];
    if (!principal) return [];
    const disbursements = await fetchJson<Disbursements>(
      `https://api.open.fec.gov/v1/schedules/schedule_b/?committee_id=${encodeURIComponent(principal.committee_id)}&api_key=${encodeURIComponent(apiKey)}&sort=-disbursement_date&per_page=25&two_year_transaction_period=${cycle}`,
      { cache: false, timeoutMs: 60_000 },
    );
    return (disbursements.results ?? [])
      .filter((d) => d.disbursement_date)
      .map((d) => {
        const payee =
          d.recipient_name ||
          [d.payee_first_name, d.payee_last_name].filter(Boolean).join(" ") ||
          "Unknown payee";
        const amount = Number(d.disbursement_amount ?? 0);
        return newEvent({
          id: `fec:${principal.committee_id}:${d.disbursement_date}:${d.disbursement_amount}:${payee}`,
          source: "fec",
          sourceType: "money",
          sourceLabel: "Campaign disbursement",
          title: `${formatMoney(amount)} to ${payee}`,
          text: truncate(
            [
              `Amount: ${formatMoney(amount)}`,
              `Paid to: ${payee}`,
              `Date: ${d.disbursement_date}`,
              `Purpose: ${d.disbursement_description ?? "not stated"}`,
              d.memo_text ? `Memo: ${d.memo_text}` : "",
              `Committee: ${principal.name}`,
            ]
              .filter(Boolean)
              .join("\n"),
            4000,
          ),
          url: `https://www.fec.gov/data/disbursements/?committee_id=${encodeURIComponent(principal.committee_id)}`,
          publishedAt: parseDate(d.disbursement_date),
          meta: {
            committeeId: principal.committee_id,
            committeeName: principal.name,
            amount,
            payee,
            description: d.disbursement_description,
          },
        });
      });
  },
};

function formatMoney(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
