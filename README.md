# Hookline: viral video analysis and original script generation

You upload an Excel sheet of Facebook video or Reel URLs, and Hookline:

1. Downloads each video.
2. Transcribes the speech with **AssemblyAI**.
3. Analyses the visual story with **Gemini**, at the same time as transcription.
4. Scores how consistent the transcript is with the screenplay analysis, using a **deterministic MatchingService**. No LLM is involved in scoring.
5. For videos that pass, hands a structural **Story DNA** abstraction to your **Claude Skill**, which writes a new, original script.

Everything appears in a live dashboard and can be exported.

> **Claude is used in one place only:** final script generation, through the configured skill. Matching, scoring, explanations, Story DNA and originality checks are all deterministic code.

---

## Contents

- [Quick look: demo mode](#quick-look-demo-mode)
- [Architecture](#architecture)
- [Setup](#setup)
- [Running](#running)
- [Configuration](#configuration)
- [How matching works](#how-matching-works)
- [Claude Skill integration](#claude-skill-integration)
- [API](#api)
- [Testing](#testing)
- [Deploying to Render](#deploying-to-render)
- [Security](#security)
- [Known limitations and unverified integrations](#known-limitations-and-unverified-integrations)

---

## Quick look: demo mode

```bash
npm install
npm run demo          # builds the dashboard, then starts the API on http://127.0.0.1:5000
```

The demo needs no external services:

- **Database:** a real PostgreSQL started from npm (`embedded-postgres`) and stored in `server/storage/demo-pg`.
- **Queue:** the in-process queue.
- **Code paths:** the real pipeline, matcher and dashboard.
- **Providers:** **mock** downloader, transcriber, Gemini analyzer and skill. Their output is labelled "mock".

Upload `server/storage/demo/sample-videos.xlsx`. It contains six cases:

| Case | Expected result |
|---|---|
| Hindi match | Matched, script generated |
| Hinglish match | Matched, script generated |
| Unrelated audio | Mismatched |
| Re-edited version | Below threshold |
| Private video | Failed |
| Silent video | Needs review |

It also contains an invalid row and a duplicate row.

---

## Architecture

```text
client/  React + Vite + Tailwind (JavaScript)   dashboard, live updates over SSE
server/  Node + Express (JavaScript)
  routes/            REST API (zod-validated)
  services/
    excel/           .xlsx/.xls parsing + per-row validation (SheetJS)
    url/             URL normalisation, allowlist, SSRF guard (DNS + redirect checks)
    video/           VideoDownloader → YtDlpDownloader | MockDownloader | UnavailableDownloader
    audio/           AudioExtractor (FFmpeg → 16 kHz mono FLAC)
    transcription/   AssemblyAITranscriber (+ mock)
    normalization/   TranscriptNormalizer (deterministic, no LLM)
    screenplay/      GeminiVideoAnalyzer (Files API, JSON schema, retries, chunking) + ScreenplayNormalizer
    embeddings/      EmbeddingService → Gemini | local multilingual-e5 | hash fallback, cached in Postgres
    matching/        MatchingService (story / character / dialogue), no LLM
    generation/      StoryDNABuilder, ScriptGenerationService, skill adapters, OriginalityValidator
    pipeline/        state machine + stage handlers (orchestrator.js)
  queues/            BullMQ (Redis) per-stage queues | in-memory driver for tests/demo
  workers/           worker process (per-stage concurrency)
  models/ migrations/ Sequelize + Umzug migrations (PostgreSQL, JSONB)
shared/  JSON schemas (screenplay analysis, transcript, Story DNA, match result) + constants
tests/   Vitest unit + integration (real PostgreSQL via embedded-postgres; mocked providers)
```

### Pipeline

```text
Excel → validate rows → videos (PENDING)
  download ─→ audio ─┬─→ transcribe (AssemblyAI) ─→ normalise ─┐
                     └─→ analyze (Gemini)        ─→ validate  ─┴─→ match ─→ eligible? ─→ Story DNA ─→ skill ─→ originality check
                                                                          └─ no → SKIPPED_LOW_SCORE / INCONCLUSIVE
```

- **One queue per stage.** Each stage has its own retry policy, exponential backoff and timeout.
- **Concurrency.** Transcription and analysis run at the same time. The `match` job id is deduplicated, so whichever task finishes last triggers matching exactly once.
- **Idempotent handlers.** Each handler checks for persisted output first, so retries and restarts never redo completed work.
- **Retry from the failed stage.** Manual retry resumes at the failed stage, and transcripts and analyses already stored are reused.
- **Cancellation.** Every unfinished video is marked cancelled first, then queued jobs are removed. Running handlers stop at their next stage boundary.
- **Recovery.** On worker start, `recoverInFlight()` re-enqueues unfinished videos. BullMQ also re-runs stalled jobs itself.
- **Caching.** The same normalised URL, or the same downloaded content hash, with compatible provider and model reuses the stored transcript and analysis.
- **Permanent errors.** Private or deleted videos, bad credentials and unsupported formats fail immediately without retries. One failed video never stops the batch.

Video states: `PENDING → DOWNLOADING → AUDIO_EXTRACTION → ANALYSIS_PENDING → TRANSCRIBING / SCREENPLAY_ANALYSIS → MATCHING → GENERATION_PENDING → SCRIPT_GENERATION → COMPLETED`, plus `INCONCLUSIVE`, `SKIPPED_LOW_SCORE`, `FAILED` and `CANCELLED`. Transcription, analysis and generation also have their own sub-statuses, so the parallel work stays visible.

---

## Setup

Prerequisites:

- **Node 20 or newer** (developed on Node 24).
- **Python 3.9 or newer on PATH while running `npm install`.** The `youtube-dl-exec` installer checks for it. To skip the check, set `YOUTUBE_DL_SKIP_PYTHON_CHECK=1`.

FFmpeg, ffprobe and yt-dlp binaries are installed through npm (`ffmpeg-static`, `ffprobe-static`, `youtube-dl-exec`), so no system installs are needed. npm 11 asks you to approve their install scripts; this repository's `package.json` already lists them under `allowScripts`.

```bash
npm install
cp .env.example .env          # then fill in keys (see Configuration)
```

### Database (Neon) and Redis

**Database: Neon (default).** Hookline uses [Neon](https://neon.tech), which is hosted PostgreSQL.

1. Create a project at [console.neon.tech](https://console.neon.tech) in the region closest to your server (for example AWS Singapore for India).
2. Click **Connect**. Copy the **pooled** connection string into `DATABASE_URL`. Turn pooling off and copy the **direct** string into `DATABASE_URL_UNPOOLED`.
3. Leave `DB_SSL` empty. SSL switches on automatically for `*.neon.tech`, and the server certificate is verified.
4. Start the API. Migrations run over the direct connection and create every table.

Neon databases are UTF8 by default. A compute that has scaled to zero wakes on the first query, and the server retries its first connection while that happens.

**Redis** still runs the job queue:

```bash
docker compose up -d          # redis:7 on :6379
```

You can also use a hosted Redis (e.g. Upstash: `REDIS_URL=rediss://...`), or `QUEUE_DRIVER=memory` on a single machine.

**Local PostgreSQL instead of Neon (optional).** With Docker:

```bash
docker compose --profile local-db up -d   # postgres:17 (UTF8) on :5432 plus redis
```

Then set `DATABASE_URL=postgres://reelscript:reelscript@localhost:5432/reelscript` and leave `DATABASE_URL_UNPOOLED` empty.

**Native services:**

- Install PostgreSQL 15 or newer, and Redis 6.2 or newer (on Windows use [Memurai](https://www.memurai.com/) or WSL).
- Create the database as UTF8. Transcripts contain Hindi and other scripts, and the server refuses to start on a non-UTF8 database:

  ```sql
  CREATE DATABASE reelscript ENCODING 'UTF8' TEMPLATE template0;
  ```

Migrations run automatically when the API starts. To skip that, set `AUTO_MIGRATE=false` and run them yourself:

```bash
npm run db:migrate            # apply
npm run db:rollback -w server # revert the last migration
```

---

## Running

```bash
npm run dev:server     # API on :5000 (node --watch)
npm run dev:worker     # BullMQ workers (separate process)
npm run dev:client     # dashboard on http://localhost:5173 (proxies /api)
```

For production, build the dashboard once. Express then serves it on the API port:

```bash
npm run build && npm start      # API + dashboard on :5000
npm run worker                  # one or more worker processes
```

To run workers inside the API process on a single machine, set `RUN_WORKERS_IN_API=true`. `QUEUE_DRIVER=memory` is for tests and the demo only, because jobs don't survive a restart.

---

## Configuration

Every variable is documented in [`.env.example`](.env.example), and the server validates them at startup. The most important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `DB_SSL` | Neon pooled connection, Neon direct connection (migrations), SSL (empty = automatic) |
| `REDIS_URL` | Redis for the job queue |
| `ASSEMBLYAI_API_KEY` | Transcription. Models default to `universal-3-5-pro,universal-2`, both of which support Hindi |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Video analysis. Default `gemini-3.8-flash` |
| `EMBEDDING_PROVIDER` | `gemini` (`gemini-embedding-001`), `local` (offline `multilingual-e5-small`) or `hash` (lexical fallback) |
| `EMBEDDING_CALIBRATION` | `floor,ceil` from `npm run calibrate -w server` |
| `SKILL_MODE`, `SKILL_DIR`, `ANTHROPIC_API_KEY` | Script generation (see below) |
| `MATCH_THRESHOLD`, `*_WEIGHT`, `MIN_MATCH_CONFIDENCE` | Scoring defaults. Editable later in the dashboard |
| `MAX_CONCURRENT_JOBS`, `CONCURRENCY_*` | Per-stage concurrency to respect provider rate limits |
| `MAX_VIDEO_DURATION_SECONDS`, `MAX_VIDEO_SIZE_MB`, `MEDIA_RETENTION_HOURS` | Media limits and clean-up |
| `APP_PASSWORD` | Password wall for the web app (sign-in screen). Required in production |
| `API_AUTH_TOKEN` | Optional bearer token for programmatic API access |

---

## How matching works

`server/src/services/matching/` compares the normalised transcript with the validated screenplay analysis. It never calls an LLM.

| Dimension | Weight | Evidence |
|---|---:|---|
| Story & event sequence | 40% | Each narrative beat that occurs while someone is speaking is matched, by meaning, to a transcript window near its timestamp. Event-order and cause→effect concordance are checked, and key structural elements (conflict, turning point, resolution and so on) are compared. Beats with no speech nearby are listed as *not scored*, not penalised. |
| Characters & relationships | 30% | Speakers are mapped to characters by timestamp overlap plus semantic agreement. Scored on speaker consistency, role/motivation alignment, speaker-count plausibility and name references. Without diarization, identities are marked uncertain and an explicit discount applies. |
| Dialogue meaning & intent | 30% | Each key dialogue moment (summary, intent, reveal flag) is matched to what was actually said nearby. The check also runs in reverse (are important statements reflected?) and checks sequence. Different wording is not a mismatch. |

- **Overall score.** `story × w_story + character × w_char + dialogue × w_dlg`, with weights validated as non-negative and summing to 100. Values stay unrounded internally.
- **Contradictions are explicit penalties.** These include dialogue placed where there is no speech, speech in a scene described as silent, the content at a dialogue moment contradicting the screenplay, speaker attribution conflicts, and reversed event order.
- **Confidence means evidence quality, not similarity.** It combines transcription confidence, language confidence, amount of speech, diarization, the strength of the speaker mapping, analysis completeness, the share of events that could be scored, and embedding quality. Half of it is the weakest factor, so one poor input can't be averaged away.
- **INCONCLUSIVE.** Any of these leads to INCONCLUSIVE rather than a guess:
  - missing or malformed input
  - an empty or incomplete transcript
  - little or no speech
  - low transcription confidence
  - a transcript and analysis in different scripts when the embedding model isn't multilingual
  - confidence below 0.35
- **Eligibility.** A video is eligible when `overall ≥ threshold` **and** `confidence ≥ MIN_MATCH_CONFIDENCE`. The threshold and full scoring configuration are stored with every result.
- **Explanations.** They are generated from the structured evidence, which the dashboard shows item by item.

### Embeddings and calibration

Raw cosine similarity is not a percentage. Each provider has a calibration, a `floor` and a `ceil` that map cosine onto a 0–1 agreement scale. To measure it for your provider:

```bash
npm run calibrate -w server            # uses shared/calibration/pairs.json (Hindi/English pairs)
```

Add your own reviewed pairs to `pairs.json` to improve it.

Measured on this machine with the offline model (`EMBEDDING_PROVIDER=local`):

- Related pairs scored 0.801–0.929 and unrelated pairs 0.685–0.798, which gives a default of floor 0.795 and ceil 0.86.
- The Gemini embedding calibration is still provisional. Run `calibrate` once a valid key is configured.
- The `hash` fallback **cannot** separate cross-language pairs, so the matcher marks those cases INCONCLUSIVE.

With the real offline model, the bundled fixtures scored as follows:

| Case | Overall | Status |
|---|---:|---|
| Genuine Hindi | 79 | Matched |
| Genuine Hinglish (romanised) | 70 | Partial |
| Scrambled story | 53 | Partial |
| Contradictory speech | 23 | Mismatched |

**The ranking is correct, but treat 75 as a starting threshold and tune it on reviewed videos.** Romanised Hindi scores lower than Devanagari.

---

## Training dataset and the Scripts tab

The app can also learn from your own results and write **new standalone episodes**.

1. **Upload training videos.** On **Upload**, choose **Training dataset (best / bad)**. The spreadsheet needs `video_url` and a `performance` column:
   - `best` labels: best, top, good, hit, viral, 1
   - `bad` labels: bad, flop, poor, low, 0
   - Every row must be labelled. Columns named `label`, `result` or `class` are also accepted in place of `performance`.
2. **Same analysis pipeline.** Each video is downloaded, transcribed (AssemblyAI) and analysed (Gemini, which now also returns a **subgenre**), then matched. Training videos get Story DNA but **no per-video script**.
   - **Already have transcripts and screenplays?** Add `transcript`, `screenplay` and (optionally) `duration_sec` columns to the training sheet (`.xlsx`, `.xls` or UTF-8 `.csv`). Those rows are not downloaded or transcribed again. Gemini reads the screenplay **text** and fills in the same analysis (text only, about $0.03–0.04 per video), and your transcript is stored for matching and the originality check. Rows without screenplay text go through the normal video pipeline. Common encoding damage such as `‚Äô` is repaired on import.
3. **Review the analysed sheet.** When a training batch finishes, its batch page shows one row per video with what AssemblyAI + Gemini found: label, genre, subgenre, length, scenes, language, hook, pacing, ending and emotional arc (`GET /api/batches/:id/analysis`, also downloadable as CSV). Untick any rows you don't want, then click **Build dataset** (`POST /api/datasets` with `excludeVideoIds`). Nothing is built automatically. The deterministic `DatasetBuilder` compares best and bad videos:
   - **Genres and subgenres:** win rate (share of best), smoothed so tiny groups can't top the ranking, with small groups flagged.
   - **Length:** typical length and interquartile range of best versus bad videos, plus the duration "sweet spot".
   - **What worked and what to skip:** hooks, pacing, endings, opening and closing emotions, story steps and dialogue functions that are at least 1.5× more common in best than in bad videos, or the reverse.
   - **Caveats:** sample-size and class-imbalance notes, plus a reminder that these are correlations, not proof of cause.
4. **The Scripts tab** lets you pick a genre or subgenre (ranked by win rate), a length (pre-filled from what worked), a language, an optional premise and notes, and 1–5 variants. The **scriptwriter skill** (`../scriptwriter-skill-1.0.0`) then writes standalone episodes.
   - **Playbook.** The skill receives a playbook built from the dataset: target length, scene count, patterns to use and to avoid, and up to three structural examples. The examples carry mechanics only, never source names, lines or premises.
   - **Standalone instructions.** It is told to skip the skill's series-continuity steps.
   - **Checks.** Every script is checked for originality against **all** training videos' dialogue and character names, and for the skill's output format (`## Scene N - INT./EXT.` headings, at least 9 beat candidates, no frontmatter).
   - **Output.** Download as a Word document (`.docx`) or PDF in standard screenplay layout, rewrite, or paste an edited version back in. PDF of non-Latin scripts (e.g. Hindi) needs a Unicode font on the server; one is found automatically on Windows, or set `PDF_FONT_PATH`.

Endpoints: `POST /api/datasets`, `GET /api/datasets/latest`, `GET /api/datasets/:id/playbook?genre=&subgenre=`, `GET|POST /api/scripts`, `GET /api/scripts/:id`, `POST /api/scripts/:id/regenerate|import`, `GET /api/scripts/:id/download?format=docx|pdf|md`, `DELETE /api/scripts/:id`.

The demo includes `server/storage/demo/training-videos.xlsx`: 20 labelled videos across four genres.

## Claude Skill integration

The skill's writing method lives in its `SKILL.md` and is never hardcoded. Generation runs **only** for approved matches. It receives the Story DNA, an abstract structure outline and a non-verbatim transcript summary. The raw transcript is never sent. Source dialogue listed in the Story DNA "avoid" list stays on the server and is used for checking.

| `SKILL_MODE` | How it runs |
|---|---|
| `agent-sdk` | Runs the skill folder through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). Details below. |
| `manual` | For skills that only run inside an interactive Claude Code session. Writes `server/storage/skill-exchange/pending/<videoId>.json` (Story DNA plus instructions). Run the skill in Claude Code, then paste the script into **Video → Script → Import** (or `POST /api/videos/:id/script`). Imports go through the same originality checks. |
| `disabled` | Story DNA only; scripts show "Skill not configured". |

Defaults: `SKILL_DIR` is `../scriptwriter-skill-1.0.0` when that folder exists, and `SKILL_MODE` is `agent-sdk` when `ANTHROPIC_API_KEY` is set, otherwise `manual`.

**The skill is not part of this repository.** Keep your skill folder (the one containing `SKILL.md`) next to the project as `../scriptwriter-skill-1.0.0`, or set `SKILL_DIR` to its location, including on any server you deploy to. Without a skill, script generation shows "Skill not configured"; analysis, matching and the dataset still work.

How `agent-sdk` mode works:

- The skill folder is copied into an isolated workspace (`<exchange>/agent-workspace/.claude/skills/<name>/`) and loaded with `settingSources: ["project"]`.
- The skill is requested by name ("Use the `<skill-name>` skill…") rather than as a `/command`, so skills marked `user-invocable: false` work too. The input is passed as data.
- The only tools allowed are `Skill` and `Read`. Bash, file writes and web access are disabled.
- Authentication needs `ANTHROPIC_API_KEY`, or Bedrock/Vertex/Foundry environment variables.
- The skill version is taken from the frontmatter `version`, or a content hash of the folder.

Example:

```env
SKILL_MODE=agent-sdk
SKILL_DIR=../scriptwriter-skill-1.0.0
ANTHROPIC_API_KEY=sk-ant-...
SKILL_MODEL=claude-sonnet-5-5
```

That skill's frontmatter lists `allowed-tools: Read, Write`. The adapter deliberately blocks `Write`, because source-derived input must not trigger file writes, so the skill has to return the script as text.

Every generated or imported script is checked by `OriginalityValidator`. It rejects:

- long verbatim runs from the source
- high 5-gram overlap
- reused character names
- the source's signature lines
- scene-by-scene paraphrase (semantic)

A failing script is stored as `REJECTED` and can be regenerated.

---

## API

```http
POST   /api/batches                       multipart "file" → DRAFT batch + validation preview
GET    /api/batches
GET    /api/batches/:id                   batch, validation summary, stats, provider usage
GET    /api/batches/:id/validation-report CSV of invalid rows
POST   /api/batches/:id/process
POST   /api/batches/:id/cancel
GET    /api/batches/:id/videos            ?status=&threshold=above|below&minScore=&maxScore=&category=&generationStatus=&matchStatus=&q=
GET    /api/batches/:id/export            ?format=csv|xlsx|json&scope=all|qualifying|selected&ids=&detailed=true

GET    /api/videos                        same filters + batchId
GET    /api/videos/export                 ?ids=&format=&detailed=
GET    /api/videos/:id                    everything for the detail view
GET    /api/videos/:id/transcript | screenplay | match | story-dna | script | export
POST   /api/videos/:id/retry              resume from the failed stage
POST   /api/videos/:id/regenerate         re-run generation from stored Story DNA
POST   /api/videos/:id/script             { content } manual skill import

GET    /api/settings      PATCH /api/settings   { matchThreshold, storyWeight, characterWeight, dialogueWeight, minMatchConfidence, contradictionPenalty }
GET    /api/stats
GET    /api/health        database, queue, ffmpeg/ffprobe, provider status
GET    /api/events        Server-Sent Events (video + batch progress), ?batchId=
```

Scores and thresholds are always computed on the server. Unknown settings keys are rejected.

---

## Testing

```bash
npm test                 # 109 tests: unit + integration (real PostgreSQL via embedded-postgres, mocked providers)
npm run lint
npm run build
RUN_LOCAL_EMBEDDINGS=1 npx vitest run tests/integration/real-embeddings.test.js   # opt-in: real multilingual model
```

The suite needs no API keys or paid calls. It starts a throwaway UTF8 PostgreSQL; set `TEST_DATABASE_URL` to use your own server instead. Coverage by area:

| Area | What's tested |
|---|---|
| Input | Excel parsing, URL validation and normalisation, SSRF guards, duplicates |
| Media | Download failures and yt-dlp error classification, FFmpeg audio extraction (including silent and invalid media) |
| Providers | AssemblyAI request shape and error classification, transcript normalisation, Gemini schema validation and retries, screenplay repairs and chunk merging |
| Matching | Embeddings and calibration; weighted scoring, weights, thresholds and determinism; the inconclusive and low-confidence cases |
| Matching fixtures | Same meaning in different wording or language, similar wording with a different story, uncertain identities, incomplete transcript, contradiction, silent video, Hindi, Hinglish |
| Generation | Story DNA, originality validation, eligibility gating, skill adapters (agent-sdk via a fake `query()`, manual, disabled) and skill failures |
| Pipeline | End-to-end pipeline, concurrency, retries, failure isolation, retry-from-stage, duplicate-job prevention, cancellation, worker recovery, cross-batch reuse, regeneration, manual import, media retention |
| API | Upload, filters, details, CSV/XLSX/JSON exports (including formula-injection protection), settings validation, SSE, auth |

---

## Security

- **Credentials** stay on the server, are validated at startup, and are never sent to the client.
- **URL safety:** a URL allowlist, rejection of IP-literal and credentialed URLs, and short-link redirects followed manually with a host and private-IP check at every hop.
- **Uploads:** checked by type (magic bytes plus extension), size and row count.
- **Inputs and media:** zod validation on every route, rate limiting, helmet with a strict CSP, `spawn` with argument arrays (no shell), FFmpeg and download timeouts, safe id-based filenames, media paths never exposed by the API, and automatic media clean-up.
- **Exports:** cells that could execute as spreadsheet formulas are neutralised.
- **Untrusted content:** video-derived text and AI output are treated as untrusted. Prompts tell Gemini and the skill to treat embedded instructions as content, the skill has no write, shell or web tools, and React escapes everything rendered.
- **Password wall:** set `APP_PASSWORD` and the web app shows a sign-in screen. A correct password sets a signed, HttpOnly, `SameSite=Lax` session cookie (Secure in production) valid for 30 days; sign-in attempts are rate-limited to 10 per 15 minutes per IP. Sessions survive restarts, and changing the password signs everyone out. Optional `API_AUTH_TOKEN` allows programmatic access with `Authorization: Bearer …`. A password (or token) is optional locally but **required in production**: the server refuses to start with `NODE_ENV=production` and neither set, unless `ALLOW_PUBLIC_API=true` is set behind your own access control. Signed out, `/api/health` only reports up or down.

Only download videos you are authorised to access. The downloader does not bypass authentication, DRM or platform restrictions; `YTDLP_COOKIES_FILE` is for videos *you* are allowed to view.

---

## Deploying to Render

The repository includes a [`render.yaml`](render.yaml) Blueprint: one web service that runs the API, serves the built web app and processes jobs in-process. The database stays on Neon; no Redis is needed.

1. Push the repository to GitHub (private is recommended).
2. In Render: **New → Blueprint**, pick the repository. Render reads `render.yaml`.
3. Fill in the secret values when prompted: `APP_PASSWORD` (the sign-in password, 12+ characters), `DATABASE_URL` (Neon pooled), `DATABASE_URL_UNPOOLED` (Neon direct), `GEMINI_API_KEY`, `ASSEMBLYAI_API_KEY`, and optionally `ANTHROPIC_API_KEY` and `SKILL_MODEL`.
4. Deploy. The build runs `npm ci --include=dev && npm run build`; the start command applies database migrations automatically.
5. Open the site and sign in with the `APP_PASSWORD` you set. Browsers stay signed in for 30 days; changing `APP_PASSWORD` signs everyone out.

Notes:

- **Plan.** The Blueprint uses Render's **free** instance (512 MB, shared CPU). It sleeps after 15 minutes without visitors, which pauses batches until the next visit (unfinished videos then resume), and the first request after sleeping takes about a minute. For long batches, change `plan: free` to `plan: starter` (paid) in `render.yaml`.
- **Region.** `singapore`, next to a Neon database in `ap-southeast-1`. Change both together if you move.
- **One instance.** With `QUEUE_DRIVER=memory`, run a single instance. To scale out, add Redis and set `QUEUE_DRIVER=bullmq` and `REDIS_URL`.
- **Disk.** Render's disk is temporary, so the Blueprint sets `MEDIA_RETENTION_HOURS=0` (downloaded media is deleted once a video is matched).
- **Skill.** The scriptwriter skill is not in this repository. For automatic scripts on Render, add the skill folder to the repository (e.g. `skills/scriptwriter-skill/`) and set `SKILL_DIR` to it.
- **Video downloads** from cloud servers can be blocked or rate-limited by Facebook; spreadsheets with `transcript` and `screenplay` columns don't download anything. The Linux build of yt-dlp may need Python 3 on the server; this has not been verified on Render.

---

## API usage and credits

**Settings → API usage & credits** shows every billable call this server made to Gemini, AssemblyAI and Anthropic, for the last 24 hours, 7 days, 30 days or all time:

- **Recorded per call** in the `api_usage` table: tokens (input, output, cache reads) or audio seconds as the provider reports them, including failed or retried attempts, which are billed too.
- **Cost:** Anthropic reports its own cost per run. Gemini and AssemblyAI calls are priced from the editable price table when they are recorded, so a later price change doesn't rewrite history. Gemini embeddings return no token count and are estimated (about 4 characters per token).
- **Credits:** none of the providers offers an API for the remaining balance. Enter the credit you added and the date for each provider; Settings shows what's been used since and what's left.
- **History:** Gemini analysis usage from before the ledger existed is backfilled from the processing logs.

Endpoints: `GET /api/usage?period=24h|7d|30d|all`, `PATCH /api/usage/settings` with `{ prices, credits }`.

---

## Known limitations and unverified integrations

- **Not tested against live services:** AssemblyAI, Gemini analysis, Gemini embeddings, real Facebook downloads and the Claude Agent SDK. Their code follows the current SDK documentation and is tested with fake clients, but none of them ran against the real service:
  - The Gemini key in the old `.env` is blocked by Google as leaked.
  - No AssemblyAI or Anthropic key was available.
  - No authorised sample Facebook URLs were used.
- **BullMQ and Redis were not run.** Redis isn't installed on this machine. The queue layer is exercised through the in-memory driver, which has the same semantics; the BullMQ driver is written to the BullMQ API but unexecuted here.
- **Calibration:** the Gemini embedding calibration is provisional, and the threshold needs tuning on reviewed data.
- **Hindi diarization:** AssemblyAI's documentation doesn't list per-language diarization support. Without diarization the matcher marks speaker identities uncertain and lowers confidence.
- **Long videos:** chunked Gemini analysis merges per-chunk results heuristically, by matching character labels.
- **Cost tracking:** records tokens, audio seconds and the skill's reported cost, but doesn't convert provider usage into prices.

### Remaining manual configuration

1. Create a Neon project and set `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct). Provide Redis and set `REDIS_URL`.
2. Set a new `GEMINI_API_KEY` and an `ASSEMBLYAI_API_KEY`.
3. Choose embeddings (`EMBEDDING_PROVIDER=gemini` or `local`) and run `npm run calibrate -w server`.
4. Configure the skill (`SKILL_MODE`, `SKILL_DIR`, `ANTHROPIC_API_KEY`), or use `manual` mode.
5. Set `APP_PASSWORD` before exposing the app to anyone else.
