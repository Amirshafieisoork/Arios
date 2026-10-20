# ARIOS implementation contract — v0.2

## Isolation and production data

ARIOS is an independent project. Never access or reuse Doctor Man files, databases, environment credentials, node_modules, accounts, services, or deployment configuration. Use dedicated ARIOS resources and `ARIOS_*` application settings only. Existing unrelated injected variables are not permission or configuration for ARIOS. Real keys, bot tokens, passwords, service tokens, databases, and runtime records must never enter tracked source, browser storage, public bundles, source archives, logs, or schedule prompts.

Production starts with an empty workspace and one owner manager. Demo names, projects, rates, reports, and amounts are fictitious and remain separate. Never import browser-local demo data into hosted production automatically.

## Runtime architecture

- `public/domain.mjs` is the shared pure domain layer. It exports `createSeedState`, `publicState`, `applyAction`, `projectAccess`, and `DomainError`. `applyAction` validates a detached state and only mutates the supplied state after success.
- `worker/index.mjs` is the production Sites Worker entrypoint. It serves bundled public assets and same-origin JSON/multipart APIs. `worker/voice.mjs` handles bounded provider/Telegram requests and cautious report extraction. `worker/storage.mjs` handles D1 state, compare-and-swap writes, settings, and AES-GCM encryption.
- `.openai/hosting.json` retains the existing opaque Site ID and logical `DB` D1 / `BUCKET` R2 bindings. The user has explicitly requested a public Site; set the audience through the native Sites access tool. Public entry pages do not make operational APIs or stored records anonymous. A static-only deployment cannot execute the hosted backend.
- `db/schema.ts`, `drizzle.config.ts`, and append-only generated `drizzle/` migrations own the hosted schema. Never create or alter migration-owned tables in request handlers. Generate and inspect new migrations after schema edits; applied SQL and metadata are immutable.
- `npm run build` bundles the Worker and public assets to `dist/server/index.js`, copies the hosting manifest and migrations into `dist/.openai`, and verifies that the public API adapter is not in static-preview mode. Publish the exact pushed source/build through Sites.
- `server.mjs` remains a separate Node 24 zero-runtime-dependency backend with SQLite, scrypt passwords, secure hashed sessions, origin checks, and explicit localhost-only demo mode. Hosted voice APIs, ChatGPT identity, D1, and R2 do not run in this Node process.
- `npm run build:preview` is an explicit alternative that replaces `dist` with the legacy browser-local fictional demo. It does not run production accounts, shared storage, Telegram receipt, payments, or live AI. Rebuild hosted output before hosted publication.

## Public entry and authorized operational access

Sites owns hosted ChatGPT sign-in/out and validates the injected `oai-authenticated-user-id` / `oai-authenticated-user-email` headers. Do not implement or replace its reserved auth routes. Sign-in is a normal top-level anchor; sign-out navigates through the platform route.

`ARIOS_OWNER_EMAIL` gates initial empty-state bootstrap. Later accounts must already exist in ARIOS with the exact normalized email; the first valid Site identity is durably bound to that ARIOS account. Email alone is not a client-provided authentication credential. ARIOS membership and project access are checked server-side for every operation. Public visitors may load the landing/login assets and safe session metadata. Sign-in alone does not grant workspace membership or project access. No anonymous operational records, uploads, or sync routes are permitted.

There is no anonymous service-sync exception. `POST /api/telegram/sync` requires an authenticated ARIOS manager and the normal same-origin checks. Do not infer authorization from a missing browser identity, absent `Origin`, public Site audience, or platform service credential. This version has no webhook or background scheduler; manager polling operates only while the voice page is open. A future unattended integration needs an explicit authenticated design and verification before scheduling.

## State and domain invariants

State has `schemaVersion: 1` and arrays `users`, `projects`, `reports`, `materials`, `invoices`, `messages`, `tickets`, `inventory`, `receipts`, `audit`. D1 stores the domain state with a monotonic revision; retry compare-and-swap conflicts rather than overwriting another writer. Domain errors leave persisted state unchanged.

Roles are `manager`, `worker`, and `customer`. Managers see and manage all workspace records. Workers see only current assigned projects and their own scoped reports, without budgets, contracts, worker rates, material prices, finance, receipts, inventory, or audit. Customers see only their own projects, published material items, invoices, receipts, public messages, and scoped support; never internal messages, worker rates, reports, internal costs, inventory, or audit. Use allowlisted detached `publicState` snapshots; never expose password/session/settings fields. AI receives only the authorized selected project's minimal operational data, without unrelated projects, finance, or rates.

Money is nonnegative whole toman. Work time is integer minutes. Material/inventory quantities have at most three decimal places. Validate IDs and role/project membership on the server. Manager `project.update` can change progress, status, client note, customer, and assigned workers. Assignment changes alter current visibility without deleting historical reports or finance. A project may have no customer.

`report.create` is worker/self or manager/assigned-worker only. Validate a real ISO date, `HH:MM` range with end after start, and integer break shorter than the range. Capture the applicable historical hourly rate; submitted labor cost is zero. `report.update` requires the current `version`, ownership/manager permission, valid current project membership, and a nonapproved report; it resubmits the same record and increments version. Preserve captured rate when date is unchanged; select historical rate again when date changes.

Only manager `report.review` approves, returns for correction, or rejects. Approved reports are immutable; repeated identical approval is idempotent. Reject overlap with any approved report for the same worker/date, including across projects. Approved labor cost is rounded once from rate × minutes / 60; draft creation and transcription never approve or charge labor.

Manager `inventory.create` supports zero initial quantity and validated minimum/price. Linked material consumption checks matching units and sufficient stock atomically. Payments are manual receipts only: reject duplicate references, overpayments, and fractional money. No gateway, successful bank verification, automatic invoice settlement, or real payment is claimed.

Messages, tickets, replies, and status changes remain scoped to authorized projects. Customers cannot write internal messages. AI escalation creates an idempotent scoped support ticket, not an unrestricted tool action.

## Voice and Telegram contract

Hosted endpoints:

- `GET /api/session`, `GET /api/state`, `POST /api/actions`, `POST /api/assistant` retain the shared frontend adapter shape. Hosted session is `{user, demo:false, authMode:'chatgpt', capabilities:{hosted,ai,voice,telegram,payments:false}}`.
- `GET /api/voice` returns allowlisted draft records, safe connection metadata, and permitted Telegram links. Workers receive only their own drafts; customers cannot use voice APIs.
- `POST /api/integrations` is manager-only. The provider origin is exactly AvalAI or OpenAI `/v1`; changing provider requires a new dedicated key. Empty secrets preserve existing values. Verify bot identity and `getWebhookInfo` before accepting a token. Never delete an existing webhook. Token rotation for the same bot is supported; replacing a bot after Telegram history exists is rejected to avoid cursor/deduplication collisions.
- `POST /api/telegram/link` issues a random, hashed, ten-minute one-time code for self or an authorized manager-selected member. Link only a private-chat `/start CODE` update with a real nonbot sender. Persist one ARIOS user per Telegram identity and one Telegram identity per ARIOS user. `POST /api/telegram/unlink` revokes the authorized link and outstanding codes without deleting historical drafts.
- `POST /api/telegram/sync` is manager-only and requires authenticated membership and normal same-origin checks, including on the public Site. It receives incoming messages only; never call `sendMessage` or any other outbound-message operation without separate user authorization.
- `POST /api/voice/upload` accepts bounded multipart audio, `POST /api/voice/text` accepts a transcript, `POST /api/voice/retry` resumes a permitted draft, and `POST /api/voice/submit` creates exactly one domain report. Submission is validated again server-side, uses the linked worker identity, and remains submitted until manager review.

Draft status is `pending`, `processing`, `ready`, `failed`, or `submitted`; source is `telegram`, `upload`, or `text`. Preserve the transcript, extracted fields, safe error, report linkage, timestamps, and processing claim in D1. Telegram `update_id` is a durable unique deduplication key. Persist fetched updates before advancing the offset. Use a shared expiring inbox lock and per-draft claims to avoid duplicate work; recover expired claims. Duplicate delivery/submission must not create duplicate reports or labor cost. Submitted draft readback uses canonical persisted report fields.

Use fixed Telegram API/download origins and safe file paths. The bot token appears in Telegram URLs, so never surface raw URLs or network errors. In Cloudflare Workers use `redirect: 'manual'` for upstream requests and reject every 3xx explicitly; do not use the incompatible redirect-error mode or forward secrets to a redirect target. Cover this runtime behavior in tests. Keep response bodies, downloads, and execution deadlines bounded; enforce the 20 MiB audio limit in metadata and streamed bytes. Direct Telegram OGG upload to transcription uses multipart with Persian language. Treat provider transcripts and project text as untrusted data, not instructions.

Extraction returns a cautious editable report with nullable unknown project/date/start/end/break, description, output, and warnings. Never fabricate dates or hours; referencing today's Tehran date is allowed only when the transcript explicitly refers to today. Validate extracted dates/times and membership again before using them. No report, finance, account, or approval action is executed by the model.

Uploaded raw audio is stored privately under `BUCKET` for retry until its transcript is saved, then deleted. Retain the transcript for extraction retry without a second transcription. During sync/upload, bounded cleanup removes untranscribed uploads older than seven days; do not promise immediate cron deletion. Telegram files can be downloaded again through `getFile`. Failed conversion is visible and retryable; never show fabricated ready status.

Manager settings are encrypted using AES-256-GCM with fresh 12-byte IVs, authenticated context, and `ARIOS_ENCRYPTION_KEY` (Base64 of exactly 32 random bytes) stored as a Sites runtime secret. Public responses expose only configured flags and nonsecret origin/model/bot metadata. Optional dedicated runtime `ARIOS_AI_BASE_URL`, `ARIOS_AI_API_KEY`, `ARIOS_AI_MODEL`, `ARIOS_TRANSCRIPTION_MODEL`, and `ARIOS_TELEGRAM_BOT_TOKEN` override encrypted form values. Preserve the encryption key across deployment or perform a deliberate migration.

## Frontend behavior

Keep the established Persian RTL design, accessible labels, responsive layout, and escaped untrusted text. `public/api.mjs` calls hosted APIs in normal mode; multipart requests must not force a JSON content type. The static adapter is explicitly fictional and isolated.

The voice page explains the provider transfer, preserves raw transcript readback, shows missing-field warnings and failures, and requires human review before submission. Manager Telegram sync polls while that page is open; worker refresh reads only own draft status. Pause background refresh while a modal, chosen file, or unfinished text would be lost. Never store keys/tokens in localStorage, logs, exported JSON, HTML values, or retained frontend state. Closing the page does not itself provide unattended receipt.

## Validation and publication

Run `npm test` for domain, standalone API, D1 storage/CAS, voice provider boundaries, and hosted Worker flow tests; external services are mocked and no test sends Telegram messages or uses paid credentials. `npm run build` validates a deployable hosted artifact. Browser QA, live provider/bot checks, scheduled execution, saved source, and successful production deployment are distinct claims; report only checks actually completed.

For a schema edit, run `npm run db:generate`, review the appended migration, and include it in the exact source/build being published. Keep the existing Site identity; apply the user-authorized public audience through Sites while retaining authenticated operational APIs. No schedule is active or implemented; do not describe browser polling as unattended receipt. Source archives must include Worker/db/migrations/tests/configuration examples and exclude real runtime data, secrets, SQLite, node_modules, and generated deployment output.
