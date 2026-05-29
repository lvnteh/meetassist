# Meetassist — System Specification

> **Purpose:** This is the single knowledge base for Meetassist as deployed today. It describes everything the system does, how it's wired internally, and the known gaps. Use this as the starting point for any future development. Older dated specs and implementation plans were retired on 2026-05-29 — their content has been folded in here.

---

## 1. What the System Does

Meetassist is a Slack bot that helps meeting organisers coordinate async pre-meeting preparation. The problem it solves: before a meeting, participants are expected to read a document, leave a comment, approve something, or take another action — but there is no lightweight way to track who has done it, follow up with those who haven't, and keep the organiser in the loop without manual chasing.

The bot does not replace the meeting. It handles the coordination layer: send a structured nudge to each participant, let them respond with one click, escalate blockers to the organiser, verify they actually engaged with the document, and keep a running record of everything.

**In one sentence:** Meetassist sends pre-meeting nudges to participants via Slack DM, collects their responses, tracks their status, verifies engagement on Confluence, and lets the organiser monitor and intervene — through a modal-based DM control surface, with `/ma` slash commands as a fallback.

---

## 2. System Architecture

### 2.1 Runtime

| Component | Technology |
|---|---|
| Bot framework | `@slack/bolt` v4.x (Socket Mode) |
| Language | TypeScript strict, compiled to CommonJS |
| Node version | ≥22.0 |
| Database | PostgreSQL (provisioned by Railway) |
| Hosting | Railway (always-on, auto-deploys from GitHub `main`) |
| Build | `tsc` → `dist/` |
| Tests | Vitest, pg pool mocked |

**Socket Mode** means the bot connects outward to Slack's servers via WebSocket — no inbound HTTP port is needed for Slack itself. A small HTTP server is still started for the Confluence-style dashboard (see §7).

### 2.2 Deployment

Hosted on Railway. The GitHub repo is connected, so every push to `main` triggers an automatic redeploy. The build uses a `Dockerfile` (`node:22-alpine`) to guarantee Node 22, bypassing Railway's default Nixpacks builder. Railway also provisions Postgres and injects `DATABASE_URL` as a linked reference variable.

### 2.3 Source Layout

```
src/
├── index.ts                    — Entry: wires services, runs migrations, starts bot, bootstraps operator DMs
├── types.ts                    — All shared TypeScript types
├── db/
│   ├── client.ts               — pg.Pool singleton (DATABASE_URL)
│   └── schema.ts               — createTables(): CREATE TABLE IF NOT EXISTS + ALTER TABLE … ADD COLUMN IF NOT EXISTS migrations
├── services/
│   ├── meeting.ts              — MeetingService: meetings/users/participants persistence
│   ├── nudge.ts                — NudgeService: message builders, nudge logging
│   ├── confluence.ts           — ConfluenceService: REST client (pages, comments)
│   ├── dashboard.ts            — Renders the live HTML dashboard file after every state mutation
│   ├── dashboard-server.ts     — Tiny HTTP server that serves the dashboard with optional token auth
│   ├── verification.ts         — Post-completion engagement check (60s delayed Confluence comment lookup)
│   └── claude.ts               — Phase 2 stub (gated by CLAUDE_ENABLED)
├── bot/
│   ├── app.ts                  — Bolt App singleton (Socket Mode)
│   ├── commands.ts             — /ma command router + interactive create wizard
│   ├── actions.ts              — Participant button handlers (mark_done, need_clarification, cannot_complete, etc.)
│   ├── modals.ts               — Block Kit modal builders + create_meeting_modal / change_action_modal handlers
│   ├── control-card.ts         — Per-meeting control card builder + post/update helpers
│   ├── control-actions.ts      — Operator button handlers on the control card
│   ├── dm-bootstrap.ts         — Posts the persistent "➕ Create meeting" button into each operator DM
│   └── relay.ts                — Operator DM relay (forwards participant DMs, sends operator replies)
└── scheduler/
    └── cron.ts                 — Three scheduled jobs (overdue, daily digest, control-card refresh)
```

---

## 3. Operator Surfaces

There are **two ways** an operator interacts with the bot. They coexist; the modal flow is the primary one and slash commands are kept as a fallback.

### 3.1 Modal-driven DM control surface (primary)

When the bot starts, `bootstrapOperatorDms` posts a persistent message in each operator's DM with one button: **➕ Create meeting**. The message ID is persisted on `users.operator_dm_message_ts` so the bot can update it in place if needed; on update failure it falls back to reposting.

**Creating a meeting (Block Kit modal):**
- Click the button → `open_create_modal` opens `buildCreateMeetingModal()`.
- Fields: title, document URL, action (static select), purpose (multi-line, optional), start time (`datetimepicker`), participants (`multi_users_select`).
- Submission handler validates server-side, returns `response_action: 'errors'` for any failure, or:
  - Auto-seeds operator + every participant via `users.info` (no manual `/ma seed-user` needed)
  - Best-effort fetches the Confluence document title; falls back to the modal title
  - Creates the meeting (`status='active'`)
  - Posts a per-meeting control card into the operator DM

**Per-meeting control card:**

A Block Kit message in the operator DM that shows live state and updates in place via `chat.update`. Built by `buildControlCardBlocks(meeting, participants)`:

- Title, start time, document link, action label, purpose
- Progress line: `done/total · blocked` (or strikethrough state if cancelled)
- Action buttons: **View status** / **Change action** / **Send reminder** / **Cancel meeting** (danger button + native confirm dialog)

Card persistence is tracked on `meetings.control_channel_id`, `control_message_ts`, and `last_card_progress` (a `done/total/blocked` signature used by the scheduler to detect drift).

**Card refresh triggers:**
- Direct: any operator click on the card refreshes after the action runs
- Direct: any participant button click (`mark_done`, `need_clarification`, `cannot_complete`) refreshes the card immediately
- Scheduled: a `*/5 * * * *` cron job calls `getMeetingsWithStaleCard()` and reissues `chat.update` for any whose persisted progress signature no longer matches reality

### 3.2 `/ma` slash commands (fallback)

All commands are guarded by `OPERATOR_SLACK_IDS`. Responses are ephemeral. Meeting IDs are UUIDs but commands accept the first 8 characters as a short prefix.

When `/ma create` runs, it now leads with a tip pointing the operator at the modal button before continuing the legacy text wizard.

| Command | Purpose |
|---|---|
| `/ma create` | DM-driven text wizard (legacy). Modal button is preferred. |
| `/ma list` | Lists `draft` and `active` meetings owned by this operator. |
| `/ma status [id]` | Per-participant breakdown (name, mention, status, reminder count). |
| `/ma send [id]` | Sends pre-meeting Block Kit nudge to all `pending` participants. |
| `/ma remind [id]` | Plain-text reminder to `nudge_sent` / `replied`. Increments `reminder_count`. |
| `/ma followup [id]` | Post-meeting follow-up to anyone not `completed`. |
| `/ma set-action [id] <action> [purpose...]` | Changes action (and optionally `purpose`); resets all participants to `pending` so a fresh `/ma send` can go out. |
| `/ma check-doc [id]` | Fetches Confluence page + comments, summarises engagement, offers per-non-commenter spot-nudge buttons. |
| `/ma reply @handle <message>` | DM a participant as the bot, logs to `operator_replies`. |
| `/ma seed-user <slack_id> <email> <display_name>` | Manual user upsert fallback when `users.info` lookup fails (guests / restricted profiles). |

Valid `document_action` values: `read`, `comment`, `approve`, `provide_input`, `confirm_decision`.

---

## 4. Participant Experience

Participants never type slash commands. Their entire interaction is through DMs.

**Receiving a nudge** (`/ma send` or modal-create-then-send): a Block Kit DM with meeting title, date/time, document link, the action requirement, the meeting `purpose` rendered inline so they know *what* to comment on, and three buttons.

**Button responses:**
- **Mark done** → `completed` → confirmation DM, operator notification, control card refresh, **and** verification scheduled (see §7).
- **Need clarification** → `clarification_needed` → operator gets reply instructions.
- **Cannot complete** → `blocked` → operator gets reply instructions.

**Free-text DM replies:** logged in `participant_messages`, status set to `replied`, message forwarded verbatim to the operator's DM with mention + meeting title. Operator can respond with `/ma reply @handle <message>`.

---

## 5. Data Model

All UUIDs are v4. Timestamps are ISO 8601 strings stored as TEXT.

### `users`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `email` | TEXT | Confluence email — used for comment matching |
| `slack_user_id` | TEXT UNIQUE | e.g. `U01DJNTLHLY` |
| `display_name` | TEXT | From `users.info` profile |
| `operator_dm_channel_id` | TEXT nullable | Persistent DM channel for the bootstrap card |
| `operator_dm_message_ts` | TEXT nullable | Timestamp of the persistent ➕ Create meeting message |

### `meetings`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `title` | TEXT | |
| `start_time` | TEXT | ISO 8601 |
| `organizer_user_id` | TEXT FK→users | |
| `purpose` | TEXT | Cap 280 chars on writes; existing rows honoured as-is |
| `document_url` | TEXT | |
| `document_title` | TEXT | |
| `document_action` | TEXT | One of: `read`, `comment`, `approve`, `provide_input`, `confirm_decision` |
| `confluence_page_id` | TEXT | Parsed from URL via `/pages/<digits>` |
| `status` | TEXT | `draft` → `active` → `completed` → `cancelled` |
| `created_at` | TEXT | ISO 8601 |
| `control_channel_id` | TEXT nullable | DM channel hosting the control card |
| `control_message_ts` | TEXT nullable | Timestamp of the control card |
| `last_card_progress` | TEXT nullable | `done/total/blocked` signature used to detect stale cards |

### `meeting_participants`
| Column | Type | Notes |
|---|---|---|
| `meeting_id` | TEXT FK→meetings | |
| `user_id` | TEXT FK→users | |
| `role` | TEXT | `participant` or `organizer` |
| `status` | TEXT | See lifecycle below |
| `reminder_count` | INTEGER | |
| `completed_at` | TEXT nullable | ISO 8601 |

**Participant status lifecycle:**
```
pending → nudge_sent → replied / completed / clarification_needed / blocked / overdue
```

### `nudges`
Log of every outbound bot message to a participant. Columns: `id`, `user_id`, `meeting_id`, `slack_channel_id`, `message_ts`, `type` (`pre_meeting`, `reminder`, `post_meeting`, `doc_check`), `sent_at`.

### `participant_messages`
Inbound DMs from participants. Columns: `id`, `user_id`, `meeting_id`, `nudge_id` (nullable), `raw_text`, `ai_classification` (Phase 2, nullable), `created_at`.

### `operator_replies`
Logged operator replies via `/ma reply`. Columns: `id`, `participant_message_id`, `raw_text`, `sent_at`.

### `doc_checks`
One row per `/ma check-doc`. Columns: `id`, `meeting_id`, `checked_at`, `confluence_version`, `comment_count`, `summary` (Phase 2), `suggested_nudges` (Phase 2).

---

## 6. Confluence Integration

`ConfluenceService` uses the v1 REST API with Basic Auth (email + API token).

- **`getPage(pageId)`** — title, version, last-modified, last-modified author, plain-text body.
- **`getComments(pageId)`** — author name, author email, plain-text body, created timestamp. **No pagination** — first page only (known limit).
- **`buildDocCheckSummary(page, comments, participantEmails)`** — coverage ratio + commenter/non-commenter list.

`confluence_page_id` is parsed from the document URL at meeting creation by extracting the numeric segment of `/pages/<id>`.

**Email matching** between Slack and Confluence works because both use the same email domain in this org.

---

## 7. Live Dashboard

The bot maintains a single live HTML dashboard file (default `./dashboard.html`) and serves it via a small HTTP server (`dashboard-server.ts`) on `PORT` (default 3000). Optional `DASHBOARD_TOKEN` gates access via `?token=…`.

`publishDashboard()` is called after every state mutation in commands, actions, modals, and the relay listener. It re-renders the file in-place; failures are logged but never block the underlying operation.

The dashboard renders every active meeting (regardless of organiser) with per-participant status, last-update relative time, and a reply preview snippet.

The Confluence-page variant of this dashboard was descoped (workspace-level Slack scope restrictions made the original App Home tab approach infeasible; the HTML+Confluence-link approach replaced it).

---

## 8. Action Verification

When a participant clicks **Mark done**, completion is recorded immediately (no UX change). 60 seconds later, `verification.ts` re-fetches the meeting + participant + Confluence comments. If the participant's email is missing from comment authors and the action is one we can verify (`comment`, `provide_input`, `approve`, `confirm_decision`), the bot DMs the meeting organizer with a "send a follow-up nudge?" prompt and two buttons (`verification_nudge_yes` / `verification_nudge_skip`).

The 60-second delay accommodates Confluence API propagation lag and avoids false positives for participants who comment-then-click.

For `read` actions there is no API signal; we trust self-report. If the bot restarts inside the 60s window the pending verification is lost — accepted trade-off for v1 simplicity, no DB state.

---

## 9. Automated Scheduler

Three cron jobs (`node-cron`):

| Schedule | Job |
|---|---|
| `0 * * * *` (hourly) | **Overdue detection** — scans active meetings whose `start_time` has passed; flips lingering `pending` / `nudge_sent` participants to `overdue` and notifies the operator with a single batched message. |
| `0 8 * * *` (08:00 UTC) | **Daily digest** — morning summary of all active meetings: title, done/total, blocked count, doc link. |
| `*/5 * * * *` (every 5 min) | **Stale-card refresh** — `getMeetingsWithStaleCard()` finds control cards whose persisted `last_card_progress` no longer matches actual `done/total/blocked`, and reissues `chat.update`. Belt-and-braces backstop for missed direct refreshes. |

---

## 10. Multi-Operator Support

Multiple operators can share the bot. `OPERATOR_SLACK_IDS` is a comma-separated list (e.g. `U001,U002`).

- **Isolation**: each operator's commands and modal create flow filter on `organizer_user_id`. `/ma list`, `/ma status`, etc. only show that operator's meetings.
- **Bootstrap**: every operator gets the persistent ➕ button DM at startup.
- **Auto-seed**: operators are seeded into `users` from the Slack API at boot, with fallback to `CONFLUENCE_EMAIL` + `OPERATOR_NAME` if the API call fails.

Known issue: `RelayService` still reads `OPERATOR_SLACK_ID` (singular) for forwarding. See §13.

---

## 11. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Bot OAuth token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | yes | App-level Socket Mode token (`xapp-…`) |
| `SLACK_SIGNING_SECRET` | yes | Request verification secret |
| `OPERATOR_SLACK_IDS` | yes | Comma-separated authorised operator Slack IDs |
| `OPERATOR_SLACK_ID` | legacy | Singular var still read by the relay (see §13). Ideally equal to first entry of `OPERATOR_SLACK_IDS`. |
| `OPERATOR_NAME` | no | Fallback display name for operator seed |
| `CONFLUENCE_BASE_URL` | yes | e.g. `https://your-org.atlassian.net` |
| `CONFLUENCE_EMAIL` | yes | Email for Confluence Basic Auth |
| `CONFLUENCE_API_TOKEN` | yes | Confluence API token |
| `DATABASE_URL` | yes | Postgres connection string (Railway-injected) |
| `PORT` | no | Dashboard HTTP port, default 3000 |
| `DASHBOARD_TOKEN` | no | If set, dashboard requires `?token=…` to load |
| `CLAUDE_ENABLED` | no | `true` to activate Phase 2 AI features |
| `ANTHROPIC_API_KEY` | Phase 2 | Key for the Claude integration |

**Railway gotcha:** enter variables individually in the UI, not via JSON import. Long tokens can silently truncate when terminals line-wrap on paste.

---

## 12. Slack App Configuration

**OAuth scopes (bot token):** `chat:write`, `im:write`, `users:read`, `users:read.email`, `commands`.

**Event subscriptions:** `message.im`.

**Slash commands:** `/ma`.

**App Home → Messages tab** must be enabled (allows participants to DM the bot). The Home/Views tab is **not** used — `views:*` scopes were unavailable at workspace level, which is why the persistent surface lives in the operator DM rather than App Home.

**Socket Mode:** must be enabled. Requires an App-Level Token (`xapp-…`).

---

## 13. Known Limitations

- **Relay still uses singular `OPERATOR_SLACK_ID`.** `RelayService.forwardToOperator()` and `notifyOperator()` read `process.env.OPERATOR_SLACK_ID`. In a multi-operator setup, all participant replies and notifications go to that one ID rather than the meeting's owner. Fix: look up `meeting.organizer_user_id` and forward to that operator's Slack ID.
- **Meeting ID resolution doesn't search across statuses.** `resolveMeetingId()` only searches `draft` / `active`. Completed or cancelled meetings can't be referenced by short ID.
- **No Confluence comment pagination.** First page only; high-traffic docs may be silently truncated.
- **Workspace policy can block DMs.** `/ma send` and modal-create both surface per-participant errors; no retry mechanism.
- **No `/ma close`.** Active meetings stay active until manually cancelled. The hourly overdue job marks participants `overdue` but doesn't close the meeting.
- **`document_action` has no DB CHECK constraint.** TS enforces the enum, but raw SQL can insert anything.
- **Verification window is volatile.** A bot restart within the 60s post-completion window loses the pending verification.

---

## 14. Phase 2: Claude AI Integration

`src/services/claude.ts` is a stub (no-op until `CLAUDE_ENABLED=true` and an `ANTHROPIC_API_KEY` are present). Three capabilities are designed but inactive:

- **`analyzeDocState(meeting, page, comments) → DocAnalysis`** — read the page + comments, summarise discussion, identify unresolved concerns, suggest personalised nudges. Replaces or augments the rule-based `buildDocCheckSummary`.
- **`classifyReply(message, meetingTitle) → ReplyClassification`** — classify free-text DMs into `completed | blocked | needs_clarification | disagrees | unavailable | asks_question | unknown` so the bot can auto-update status and surface intent.
- **`draftReply(incomingMessage, meetingTitle) → string`** — propose an operator response to participant messages; operator still approves and sends.

The `doc_checks.summary` / `doc_checks.suggested_nudges` and `participant_messages.ai_classification` columns exist for this output.

---

## 15. Typical Operator Workflow

```
1. Open the bot DM → click the persistent "➕ Create meeting" button
2. Fill the modal: title, doc URL, action, purpose, start time, @-mention participants
3. Submit → meeting active, control card lands in DM
4. Click "Send reminder" on the card to fire the pre-meeting nudges
5. Watch participants tick through: card progress + dashboard refresh on every click
   - Free-text replies relay to your DM; respond with /ma reply
6. Click "View status" any time for full breakdown
7. If the action needs to change, "Change action" → modal → all participants reset to pending
8. After the meeting, /ma followup [id] for stragglers
9. "Cancel meeting" if the meeting is called off — card flips to strikethrough state
```

Slash commands remain available for any of the above — the modal flow is preferred but not exclusive.

---

## 16. Testing & Local Dev

```bash
npm test                # vitest run (pg pool mocked, no DB needed)
npm run test:watch      # watch mode
npm run dev             # tsx watch — requires DATABASE_URL
npm run build && npm start   # production-style local run
```

Test coverage spans `MeetingService`, `NudgeService`, `ConfluenceService`, `RelayService`, the schema migrations, the modal builders, the control-card builder, and the dashboard renderer.
