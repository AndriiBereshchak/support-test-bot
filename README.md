# Support and Zhora v1: local setup and verification

This repository contains the `support` backend and scripts for local development and testing. Zhora helps operators in Telegram by translating requests, drafting replies, running `/fix` and `/brief`, using templates, searching the knowledge base (KB), and recording suggestion outcomes. A draft is **not sent to the customer automatically**: the operator must press “Отправить” (Send). A regular operator message in a ticket topic is sent to the customer immediately.

Admin pages, KB candidate approval, and aggregated admin analytics belong to other services. See [zhora-how-it-works.md](zhora-how-it-works.md) for Zhora behavior and [support/README_EXPORT.md](support/README_EXPORT.md) for the original service export.

## Where to find the implementation

| Area | Location | Purpose |
| --- | --- | --- |
| Telegram workflows | `support/src/telegram/` | Zhora buttons and commands, previews, sending, translations, ratings, templates, and tags. |
| AI and background work | `support/src/apps/services/zhora/` | OpenRouter, call journal, budget, queue and worker, ticket context, KB, and candidates. |
| Internal HTTP API | `support/src/apps/routes/` | KB, templates, KB candidates, and chat routes used by the `exchange` proxy. |
| Data | `support/prisma/` | Migrations and models for Zhora, KB, templates, and suggestion outcomes. |
| Tests | `support/tests/standalone/`, `support/tests/` | Isolated test infrastructure, synthetic users, unit tests, and integration tests. |

## Prerequisites and configuration

Use Node.js **22.18+**, Yarn **4.9.4** through Corepack, and a running Docker daemon. Run all commands from the **repository root**. The local runner accepts only a database on `localhost` whose name ends in `_test` and files under `support/.tmp`; do not point it at a production database. The test infrastructure uses PostgreSQL with pgvector, Redis, and NATS.

```sh
corepack enable
cp support/.env.test.example support/.env.test
cp support/.env.example support/.env
```

Set at least these values in `support/.env` for standalone development. Other safe local settings can be taken from `.env.test.example`:

```dotenv
NODE_ENV="development"
APP_PORT="3020"
SUPPORT_ROLE="all"
METRICS_ENABLED="false"
DATABASE_SUPPORT="postgresql://test:test@127.0.0.1:55432/support_test"
DATABASE_EXCHANGE="postgresql://test:test@127.0.0.1:55432/support_test"
DATABASE_AFFILIATE="postgresql://test:test@127.0.0.1:55432/support_test"
REDIS_HOST="127.0.0.1"
REDIS_PORT="16379"
NATS_URL="nats://127.0.0.1:14222"
SUPPORT_FILES_DIR="./.tmp/support-files"
SUPPORT_CHAT_ID="-1002000000001"
SUPPORT_INTERNAL_TOKEN="your-local-token"
SUPPORT_BOT_TOKEN=""
SUPPORT_WEBHOOK_URL=""
DEV_TELEGRAM_POLLING="false"
ZHORA_ENABLED="false"
```

Keep `.env.test` free of real Telegram and OpenRouter keys and set `ZHORA_ENABLED="false"` there. Automated tests intentionally avoid paid and external services. Do not commit local `.env` or `.env.test` files.

```sh
yarn install
yarn dev
```

`yarn install` generates Prisma clients. `yarn dev` starts test infrastructure, applies migrations, builds TypeScript, seeds three synthetic users, and starts HTTP on `127.0.0.1:3020`. With an empty `SUPPORT_BOT_TOKEN`, Telegram is replaced by a local event recorder, allowing delivery checks without a real group.

To check the code separately:

```sh
yarn typecheck
yarn test
yarn test:integration
```

`yarn test:integration` starts the test infrastructure and migrates `support_test`; `yarn test` runs unit tests. `yarn dev:reset` removes data only for the three known synthetic users; it does not remove Telegram topics or files.

## Optional manual HTTP checks without Telegram

The commands in this section are examples for a developer who wants to check the standalone backend without Telegram. This complete HTTP-only flow was **not run as part of the manual Telegram verification described below**; do not count it as a confirmed test result. Set `TOKEN` to the `SUPPORT_INTERNAL_TOKEN` value from `support/.env` and keep it local. These service routes are intended for a trusted backend, not direct browser use. In `yarn dev`, the same token protects Zhora management routes and `/__dev/*`.

```sh
BASE=http://127.0.0.1:3020
TOKEN='value-from-support/.env'
curl "$BASE/healthz"
curl -H "x-internal-token: $TOKEN" "$BASE/__dev/fixtures"
```

Expect `{"status":"ok"}` and three synthetic profiles. Use the first profile for a minimal message flow:

```sh
curl -sS -X POST "$BASE/v1/internal/messages" \
  -H "x-internal-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"userId":"00000000-0000-4000-8000-000000000001","userNId":2100000001,"text":"Where is my withdrawal?","requestId":"readme-example-1","originDomain":"binodex.io"}'
curl -sS -H "x-internal-token: $TOKEN" "$BASE/__dev/events"
```

Find the `relayUserMessage` event and its `data.ticket.tgTopicId` in `/__dev/events`. Substitute that topic ID below. `/__dev/reply` works **only without a real Telegram bot** and simulates a regular operator message:

```sh
TOPIC_ID=12345
curl -sS -X POST "$BASE/__dev/reply" \
  -H "x-internal-token: $TOKEN" -H 'content-type: application/json' \
  -d "{\"topicId\":$TOPIC_ID,\"text\":\"We are checking your withdrawal.\"}"
curl -sS -X POST "$BASE/v1/internal/thread" \
  -H "x-internal-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"userId":"00000000-0000-4000-8000-000000000001"}'
```

Check that `/thread` contains a message with direction `out`. `requestId` makes customer submission idempotent: use a **new value for every new message**.

| Route | Purpose |
| --- | --- |
| `GET /healthz` | HTTP and database availability. |
| `POST /v1/internal/messages`, `POST /v1/internal/thread` | Incoming customer messages and thread history; require `x-internal-token`. |
| `GET /__dev/fixtures`, `GET /__dev/events`, `POST /__dev/reply` | Synthetic data, recorded Telegram events, and operator simulation; standalone dev server only. |
| `GET/POST /v1/internal/zhora/kb`, `GET/PATCH/DELETE /v1/internal/zhora/kb/:id` | KB listing and CRUD. Creation requires `question`, `answer_ru`, `category`, and `updatedById`; entries can start as `draft`. |
| `POST /v1/internal/zhora/kb/import` | Import one UTF-8 `.json` or `.csv` file as multipart data, plus `updatedById`. JSON may be an array or `{"entries":[...]}`. |
| `GET/PATCH /v1/internal/zhora/kb/config` | KB links; PATCH requires `updatedById`. |
| `GET/POST /v1/internal/zhora/templates`, `GET/PATCH/DELETE /v1/internal/zhora/templates/:id`, `GET /v1/internal/zhora/templates/:id/usages` | Templates and usage history. Creation requires `code`, `category`, `textRu`, and `updatedById`. |
| `GET /v1/internal/zhora/kb-candidates`, `GET /v1/internal/zhora/kb-candidates/:id` | KB candidate inspection; approval is not implemented here. |
| `POST /v1/internal/tg-webhook` | Telegram updates in webhook mode; checks `X-Telegram-Bot-Api-Secret-Token`, not the internal token. Do not call it in polling mode. |

KB, template, and candidate routes always require a **nonempty** `SUPPORT_INTERNAL_TOKEN`. Creating or changing KB entries and templates can start background AI jobs; use synthetic records and account for cost when Zhora is enabled. Read-only examples:

```sh
curl -sS -H "x-internal-token: $TOKEN" "$BASE/v1/internal/zhora/kb?limit=10"
curl -sS -H "x-internal-token: $TOKEN" "$BASE/v1/internal/zhora/templates?limit=10"
curl -sS -H "x-internal-token: $TOKEN" "$BASE/v1/internal/zhora/kb-candidates?limit=10"
```

To create a **draft** KB entry in the local database:

```sh
curl -sS -X POST "$BASE/v1/internal/zhora/kb" \
  -H "x-internal-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"question":"Test question?","answer_ru":"Test answer.","category":"other","status":"draft","updatedById":"local-test"}'
curl -sS -H "x-internal-token: $TOKEN" "$BASE/v1/internal/zhora/kb?status=draft&limit=10"
```

Creating a template follows the same pattern but uses `code`, `category`, `textRu`, and `updatedById`. Example KB import: `curl -H "x-internal-token: $TOKEN" -F updatedById=local-test -F file=@./local-kb.json "$BASE/v1/internal/zhora/kb/import"`, where `local-kb.json` is your prepared UTF-8 file of synthetic records. If `GET /kb/config` returns 404, the link configuration has not been created through import yet.

## Verification in a private Telegram group

Button workflows require a **dedicated test bot**, a private forum group, and permission for the bot to manage topics. Set `SUPPORT_BOT_TOKEN` and a negative `SUPPORT_CHAT_ID` in `support/.env`; set `DEV_TELEGRAM_POLLING="true"` and `SUPPORT_WEBHOOK_URL=""`. `yarn dev` receives updates through long polling without an exposed external port. Do not run another webhook/getUpdates process for the same bot. Restart `yarn dev` after editing `.env`.

For live AI workflows, supply your own `ZHORA_OPENROUTER_API_KEY`, configure `ZHORA_MODEL_*` and the budget using `support/.env.example`, and set `ZHORA_ENABLED="true"`. This makes real paid OpenRouter calls. The local database and synthetic users stay the same. Set the search threshold through `ZHORA_KB_MIN_SCORE` in `support/.env` (initial value `0.5`) and restart the server after changing it. This value is provisional: retrieval quality has not been calibrated against a fully indexed KB.

Suggested sequence:

1. Run `yarn dev` and create an incoming request for a synthetic user through `POST /v1/internal/messages`. The bot should create a topic and show the original text; non-Russian text should also have a Russian translation visible only to operators. Optionally name the operator with `/setname <name>`.
2. Press “Жора, ответь” under the incoming message or run `/zhora` in its topic. Check the preview for the customer-language answer, Russian version, KB sources, and warnings. **The customer must not receive the draft before “Отправить” is pressed.**
3. Check “Ещё вариант” (Another variant), “Перевести” (Translate), “Скопировать” (Copy), 👍/👎, and “Карточка” (Card). “Депозиты” (Deposits) and “Выводы” (Withdrawals) appear for relevant tags; change the ticket tag with `/tag`.
4. Press “Отправить” on the chosen variant and check `POST /v1/internal/thread`: it should contain one operator `out` message. Pressing Send again must not duplicate it.
5. Separately check `/fix <text>`, `/fix` as a reply to the operator's own message, `/brief`, `/t`, and `/t <code>`. For a missing template variable, reply to its preview with `/t variable_name="value"`; to edit completed text, reply with `/t edit <final text>`. An unfilled template must not be sent. `/brief` stays in the operator topic.

When `/fix` replies to an operator message, that original regular message has already been delivered to the customer. Read the warning in the preview before sending the correction. Checking how replies appear **in the customer's browser** requires integration with `exchange`/frontend: standalone `/thread` proves that the backend stored the message, not how the UI renders it.

### Manually verified with the test bot

The results below were observed locally with synthetic customers. To repeat them, use a **new `requestId`** for every new request; a reused ID may return the previous result. Regular operator text in the topic is delivered immediately, so do not use a real customer account.

| Scenario | How to repeat it and what to expect |
| --- | --- |
| Draft, variants, ratings | Press “Жора, ответь”, inspect the preview, then try “Ещё вариант”, “Перевести”, and 👍/👎. A draft creates no `out` before sending. Ratings are stored in `ZhoraSuggestion.rating`, `ratedAt`, and `ratedByTgUserId`. |
| Copy | For an answer of at most 256 characters, press “Скопировать” and paste outside the operator topic: only the customer answer should appear, without the Russian version or sources. For a longer answer, copy from the monospaced block. |
| Send | Press “Отправить” on a preview. `/thread` gains one `out`; `ZhoraSuggestion` has `outcome = sent` and a `sentMessageId`. A second press must not send a duplicate. |
| `copied_sent` | Create a draft without pressing Send. Copy its answer and post it as an ordinary message in the topic within 10 minutes. `/thread` has one `out`; `ZhoraSuggestion` has `outcome = copied_sent` and a `sentMessageId`. |
| `edited` | Create a new draft and use Telegram Reply **on the preview with buttons** to send substantially changed text. `/thread` has an `out`; `ZhoraSuggestion` has `outcome = edited`, a `sentMessageId`, and the changed text in `finalText`. |
| `ignored` | Show a draft and leave it unused. Close the ticket with `/close` at the end. `ZhoraSuggestion` has `outcome = ignored` and no `sentMessageId`. |
| Deposits and withdrawals | “Депозиты” and “Выводы” open the existing `/deposits` and `/withdrawals` lists. In deposits, press a currency/card filter such as “₴ карты”, then “✓ Все”, and check that the list changes. These filters belong to `/deposits`. |
| `/t` template | Create a test template through `POST /v1/internal/zhora/templates`; open `/t` or `/t <code>`. Fill a missing variable by replying `/t variable_name="value"`, optionally edit through reply `/t edit <final text>`, then press Send. `GET /v1/internal/zhora/templates/:id/usages` records usage. `editedBeforeSend = false` when only a variable was filled, and `true` after the completed text was edited. |
| KB candidates | Suggestion checks create `ZhoraKbCandidate` and `ZhoraKbCandidateOccurrence` records; `ZhoraSuggestion.candidateCheckedAt` indicates a completed check. Candidates and ratings were inspected in the local database. |
| Mute | In a test topic, run `/mute 5min test`. A new `POST /v1/internal/messages` from that same synthetic customer with a fresh `requestId` returns `403 SUPPORT_MUTED` and does not appear in the topic. After `/unmute`, another request with a different ID succeeds. |
| `/fix` | Check both `/fix <text>` and `/fix` as a reply to the operator's own message. The latter produces a correction preview warning that the original message was already delivered. |

