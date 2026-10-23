# journalism

A terminal agent that keeps a file on one political person of interest, using **only primary records**: what the person said, what they posted, how they voted, and where their money went.

No news. No aggregators. No pundits. No "sources say". Every line in the vault links back to the exact record it came from.

```bash
npm install -g github:kkaleb-w/journalism
journalism
```

The npm registry release is pending; the GitHub install is the same build. A live demo of the generated file is at **[journalism.kkaleb.com](https://journalism.kkaleb.com)**.

The first run walks you through onboarding, builds an Obsidian vault, installs a background service, and starts collecting.

---

## Why this exists

A reporter covering a politician spends hours a day asking the same questions:

- What did they say today, in their own words?
- What did they actually vote for, not what a press release says they voted for?
- Which speeches have they given, and what is in them?
- Who is paying them, and where is that money going?
- What changed since yesterday?

Most tools answer with somebody else's summary. This one refuses. It only reads first-party material, stores the raw record, and writes cited notes on top.

## The primary-source rule

Every adapter is one of two things:

1. **The person's own account or feed** — X, Truth Social, Bluesky, their YouTube channel, their official RSS.
2. **An official government record of their actions** — Congress.gov bills, House and Senate roll-call XML, FEC disbursements.

Anything else is rejected at ingestion. `journalism ingest` refuses non-official domains unless you explicitly force a campaign site you know is theirs. The model prompt forbids outside knowledge and requires a citation on every sentence. An uncited claim is dropped before it reaches the vault.

## What it tracks

| Source | What it gives you | Needs |
|---|---|---|
| X | The person's own posts | X API bearer token |
| Truth Social | The person's own posts | nothing |
| Bluesky | The person's own posts | nothing |
| YouTube | Official uploads + speech transcripts | channel ID; transcription for audio |
| Congress.gov | Bills sponsored and cosponsored | free API key |
| House Clerk | Individual roll-call votes | free Congress.gov key |
| Senate | Individual roll-call votes | official XML (may be bot-walled on some hosts) |
| FEC | Campaign disbursements, payee and amount | free API key |
| RSS | Official press releases and statements | feed URLs |

Sources are independent. Turn on what applies. A state legislator with no federal record still gets social posts, YouTube and press feeds.

## Onboarding

```
journalism onboard
```

1. **Where the notes live.** Defaults to `~/JournalismVault`, creates a real Obsidian vault with `.obsidian` config.
2. **Model provider.** 30+ providers, including OpenAI, Anthropic, Gemini, xAI, DeepSeek, Mistral, Groq, Together, Fireworks, OpenRouter, Cohere, Cerebras, SambaNova, NVIDIA, Azure, Bedrock, Vertex, Cloudflare, Ollama, LM Studio, vLLM and more. Your key is verified against the live models endpoint.
3. **Default model.** Picked from the models your key can actually see.
4. **Transcription.** Auto-detected when your provider has a speech model. Otherwise pick a separate provider (Deepgram, Groq, OpenAI, Gemini, Mistral) or run without transcripts.
5. **Person of interest.** Name, office, handles, official IDs, feeds.
6. **Auto-start.** On by default: systemd on Linux, LaunchAgent on macOS, Task Scheduler on Windows.

Everything is stored in `~/.journalism/config.json` with mode `600`.

## Daily use

```bash
journalism status                 # what is running, what came in, what is pending
journalism digest                 # one-page briefing for the last 24 hours
journalism ask "What did they say about the bill?"
journalism ingest <url-or-file>   # add one official document, speech or transcript
journalism sources                # list adapters
journalism sources disable x      # turn one off
journalism doctor                 # diagnose keys, vault, provider, service
```

The agent runs continuously. Each source has its own interval and jitter. Conditional HTTP requests (`ETag` / `Last-Modified`) and per-record IDs mean a poll only costs what actually changed. The model is only called when new records arrive, not on a timer.

## The vault

```
JournalismVault/
  Profile.md            living summary, cited line by line
  Timeline.md           index by month
  Timeline/2026-10.md   dated entries
  Connections.md        patterns across records, cited
  Open Questions.md     gaps worth reporting
  Topics/               one note per recurring subject
  Transcripts/          full speech text
  Briefings/            daily digests
  Queries/              saved answers with their source list
  Sources/              the exact feeds being watched
```

Open the folder in Obsidian. Backlinks, graph and search work with no plugin.

## How memory works

A background cycle does three things:

1. **Collect** new records from due sources. Raw payloads are written to `~/.journalism/data/raw/`.
2. **Deduplicate** by source ID and content hash. Re-polling the same post is free.
3. **Synthesize** a batch of new records into the vault. The model receives numbered records only, and must return citations by number. Citations that do not match a supplied record are discarded. The same note is never written twice.

Memory is incremental. The agent does not re-read the whole file for every post, and it does not let the model invent context that is not in the batch.

## Cost

Collection is free apart from API quotas. Model calls happen only on new records. A typical day of social posts plus a weekly batch of votes costs cents on a small model. `agent.dailyTokenBudget` is a hard stop (default 250k tokens); collection continues, synthesis pauses.

## Configuration

```bash
journalism config show
journalism config set agent.digestHour 7
journalism config set agent.dailyTokenBudget 500000
```

Key paths:

- `agent.quietHours` — pause cycles overnight, e.g. `{"start":23,"end":6}`
- `sources.<id>.intervalMinutes` — polling cadence
- `sources.youtube.options.transcribe` — set `false` to skip audio transcription
- `agent.synthesizeEveryNewItems` — batch size before a memory pass

## Auto-start

```bash
journalism service install
journalism service status
journalism service uninstall
```

Linux uses a systemd **user** unit. To run before login:

```bash
loginctl enable-linger "$USER"
```

## Development

```bash
git clone https://github.com/kkaleb-w/journalism
cd journalism
npm install
npm run dev -- --help
npm test
```

Layout:

```
src/cli/          commander entry, onboarding, doctor
src/core/         config, store, llm, transcription, memory, scheduler, service
src/providers/    provider catalog
src/sources/      one adapter per primary source
src/vault/        Obsidian scaffold
```

Adding a source: implement `SourceAdapter` in `src/sources/`, register it in `src/sources/index.ts`, and make sure it can explain in one sentence why every item is first-party.

## Limits, stated honestly

- X's API is paid and rate-limited. Without a token, the X adapter is off.
- Senate.gov blocks some datacenter IPs. The Senate adapter may need a residential connection or a mirror you control.
- Instagram, Facebook and TikTok have no usable first-party API for arbitrary public figures. They are not pretended to be supported.
- Financial disclosure PDFs (House/Senate) are not parsed yet. Campaign disbursements through the FEC are.
- The agent records what the person says. It does not fact-check them, and it does not add context from reporting.

## License

MIT
