# Meetassist

Slack bot that coordinates async pre-meeting preparation: send structured nudges to participants, collect their responses, verify they engaged with the linked Confluence document, and keep the organiser in the loop — without manual chasing.

**For a full system description (data model, surfaces, scheduler, env vars, known limitations), read [`docs/specs/meetassist-v1.md`](docs/specs/meetassist-v1.md). This README is a navigation map.**

---

## Quick start

```bash
npm install
npm test                       # vitest run, pg pool mocked, no DB needed
npm run dev                    # tsx watch — needs DATABASE_URL + Slack tokens
npm run build && npm start     # production-style local run
```

The bot is hosted on Railway, auto-deploying from `main`. Pushing to `main` is the deploy.

---

## Where things live

### `src/` — runtime code

```
src/
├── index.ts                    Entry. Wires all services, runs migrations, starts Bolt,
│                                 bootstraps the operator DM, registers cron, seeds operators.
├── types.ts                    Shared TypeScript types (Meeting, Participant, statuses, etc.).
│
├── db/
│   ├── client.ts               pg.Pool singleton (DATABASE_URL).
│   └── schema.ts               createTables(): CREATE TABLE IF NOT EXISTS + idempotent
│                                 ALTER TABLE … ADD COLUMN IF NOT EXISTS migrations.
│
├── services/
│   ├── meeting.ts              MeetingService — meetings/users/participants persistence,
│   │                             auto-seeding from Slack users.info, control-card progress
│   │                             tracking (last_card_progress, getMeetingsWithStaleCard).
│   ├── nudge.ts                NudgeService — message builders (buildNudgeMessage,
│   │                             buildReminderMessage, buildFollowUpMessage) + nudges log.
│   ├── confluence.ts           ConfluenceService — REST client (getPage, getComments,
│   │                             buildDocCheckSummary).
│   ├── dashboard.ts            Renders the live HTML dashboard file. Called by every
│   │                             state mutation site via publishDashboard(). humaniseAction()
│   │                             lives here too.
│   ├── dashboard-server.ts     Tiny HTTP server that serves the dashboard with optional
│   │                             token gate (DASHBOARD_TOKEN).
│   ├── verification.ts         60-second post-completion engagement check: if the
│   │                             participant didn't comment on Confluence, DM the operator
│   │                             with a one-click follow-up nudge prompt.
│   └── claude.ts               Phase 2 stub — no-ops unless CLAUDE_ENABLED=true.
│
├── bot/
│   ├── app.ts                  @slack/bolt App singleton (Socket Mode).
│   ├── commands.ts             /ma slash-command router. Handles create/list/status/send/
│   │                             remind/followup/set-action/check-doc/reply/seed-user
│   │                             plus the legacy DM text wizard.
│   ├── actions.ts              Participant button handlers: mark_done, need_clarification,
│   │                             cannot_complete, plus send_nudge_yes/skip and verification
│   │                             nudge buttons. Triggers control-card refresh on each click.
│   ├── modals.ts               Block Kit modal builders + submission handlers:
│   │                             buildCreateMeetingModal, buildChangeActionModal,
│   │                             create_meeting_modal, change_action_modal.
│   ├── control-card.ts         Per-meeting Block Kit card builder + postControlCard /
│   │                             updateControlCard helpers. Tracks progress signature.
│   ├── control-actions.ts      Operator buttons on the control card: View status,
│   │                             Change action, Send reminder, Cancel meeting (danger).
│   ├── dm-bootstrap.ts         Posts the persistent "➕ Create meeting" message into each
│   │                             operator DM at boot; persists ts on users table.
│   └── relay.ts                RelayService — forwards participant DMs to the operator,
│                                 sends operator replies, registers DM listener.
│
└── scheduler/
    └── cron.ts                 Three jobs: hourly overdue detection, 08:00 UTC daily
                                  digest, every-5-min stale control-card refresh.
```

### `tests/` — vitest, pg pool mocked

```
tests/
├── bot/
│   ├── control-card.test.ts    Block Kit shape + cancelled state + progress signature
│   ├── dm-bootstrap.test.ts    Persistent DM bootstrap + repost-on-update-failure
│   └── modals.test.ts          Modal builders (no Bolt singleton — lazy-required handlers)
├── db/
│   └── schema.test.ts          createTables emits the expected DDL strings
└── services/
    ├── confluence.test.ts      REST client + summary helper
    ├── dashboard.test.ts       Dashboard HTML rendering
    ├── meeting.test.ts         MeetingService CRUD + control-card helpers
    ├── nudge.test.ts           Message builders + nudge logging
    └── verification.test.ts    60s scheduling + Confluence-engagement decision
```

### `docs/`

```
docs/
└── specs/
    └── meetassist-v1.md        Single canonical knowledge base.
                                  Replaces all prior dated specs/plans (deleted 2026-05-29).
```

### Build / deploy

| File | Role |
|---|---|
| `Dockerfile` | `node:22-alpine` build for Railway (forces Node 22, bypasses Nixpacks default of Node 18). |
| `nixpacks.toml` | Legacy fallback build config. Dockerfile takes precedence. |
| `Procfile` | Railway entry. |
| `railway.json` | Railway service config. |
| `tsconfig.json` | Source build (→ `dist/`). |
| `tsconfig.test.json` | Test build config. |
| `vitest.config.ts` | Vitest setup. |

---

## Where to look for…

| If you want to… | Open |
|---|---|
| Understand the system end-to-end | [`docs/specs/meetassist-v1.md`](docs/specs/meetassist-v1.md) |
| Change the create-meeting modal | `src/bot/modals.ts` |
| Change the operator control card | `src/bot/control-card.ts` + `src/bot/control-actions.ts` |
| Change participant nudge wording | `src/services/nudge.ts` (build* functions) |
| Add a new `/ma` subcommand | `src/bot/commands.ts` |
| Change scheduler behaviour | `src/scheduler/cron.ts` |
| Change the live dashboard rendering | `src/services/dashboard.ts` |
| Change DB schema / add a column | `src/db/schema.ts` (use `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`) |
| Change Confluence API calls | `src/services/confluence.ts` |
| Change post-completion verification | `src/services/verification.ts` |

---

## Conventions

- **TypeScript strict.** Run `npx tsc --noEmit` before committing if you've touched types.
- **Tests are mock-only.** No live DB, no live Slack. The pg `Pool` is mocked via `vi.mock`. Slack `WebClient` is hand-stubbed per test.
- **Schema migrations are idempotent.** `createTables()` always runs at boot; new columns must use `ADD COLUMN IF NOT EXISTS`. No separate migration runner.
- **Lazy-load `./app` inside handlers** when a module also exports pure builders that need to be importable from tests (the Bolt App singleton requires env vars at import time). See `src/bot/modals.ts` for the pattern.
- **No `git add -A`.** Stage files explicitly to avoid sweeping in `.DS_Store` etc.

---

## Phase 2 (not yet active)

`src/services/claude.ts` is a stub gated by `CLAUDE_ENABLED=true` + `ANTHROPIC_API_KEY`. Three intended capabilities (doc-state analysis, free-text reply classification, draft replies) are documented in the spec under §14. Three DB columns (`doc_checks.summary`, `doc_checks.suggested_nudges`, `participant_messages.ai_classification`) already exist for the output.
