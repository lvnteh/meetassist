# Meetassist — System Specification v1

> **Purpose:** This document is the knowledge base for the Meetassist Slack bot as built and deployed in Phase 1. It describes everything the system currently does, how it works internally, and what groundwork has been laid for Phase 2. Use this as the starting point for any future development.

---

## 1. What the System Does

Meetassist is a Slack bot that helps meeting organisers coordinate async pre-meeting preparation. The core problem it solves: before a meeting, participants are expected to read a document, leave a comment, approve something, or take another action — but there is no lightweight way to track who has done it, follow up with those who haven't, and keep the organiser in the loop without a lot of manual effort.

The bot does not replace the meeting. It handles the coordination layer: send a structured nudge to each participant, let them respond with one click, escalate blockers to the organiser, and keep a record of everything.

**In one sentence:** Meetassist sends pre-meeting nudges to participants via Slack DM, collects their responses, tracks their status, and lets the organiser monitor and intervene — all through `/ma` slash commands.

---

## 2. System Architecture

### 2.1 Runtime

| Component | Technology |
|---|---|
| Bot framework | `@slack/bolt` v4.7 (Socket Mode) |
| Language | TypeScript, compiled to CommonJS |
| Node version | ≥22.0 |
| Database | PostgreSQL (provisioned by Railway) |
| Hosting | Railway (always-on, auto-deploys from GitHub) |
| Build | `tsc` → `dist/` |

**Socket Mode** means the bot connects outward to Slack's servers via WebSocket — no inbound HTTP port is needed. This simplifies hosting and works on Railway's free tier without any port configuration.

### 2.2 Deployment

The bot is hosted on Railway. The GitHub repository is connected to Railway, so every push to `main` triggers an automatic redeploy. The build uses a `Dockerfile` (`node:22-alpine`) to guarantee Node 22, bypassing Railway's default Nixpacks builder which defaulted to Node 18.

Railway also provisions the Postgres database and injects `DATABASE_URL` automatically as a linked reference variable.

### 2.3 Source Layout

```
src/
├── index.ts              — Entry point: wires all services, runs migrations, starts bot
├── types.ts              — All shared TypeScript types and interfaces
├── db/
│   ├── client.ts         — pg.Pool singleton (DATABASE_URL)
│   └── schema.ts         — createTables() — idempotent CREATE TABLE IF NOT EXISTS
├── services/
│   ├── meeting.ts        — MeetingService: all DB operations for meetings/users/participants
│   ├── nudge.ts          — NudgeService: message builders and nudge/message DB writes
│   ├── confluence.ts     — ConfluenceService: Confluence REST API client
│   └── claude.ts         — ClaudeService: Phase 2 stub (currently no-ops)
└── bot/
    ├── app.ts            — Bolt App singleton (Socket Mode)
    ├── commands.ts       — /ma command handler (all subcommands)
    ├── actions.ts        — Block Kit button action handlers
    └── relay.ts          — RelayService: DM delivery, operator forwarding, DM listener
scheduler/
└── cron.ts               — Two scheduled jobs (overdue detection, daily digest)
```

---

## 3. Data Model

All UUIDs are generated with `uuid` v4. All timestamps are ISO 8601 strings stored as TEXT (Postgres accepts this via text equality comparisons).

### `users`
Stores every person the bot knows about — both operators and participants.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `email` | TEXT | Confluence email (used for comment matching) |
| `slack_user_id` | TEXT UNIQUE | e.g. `U01DJNTLHLY` |
| `display_name` | TEXT | From Slack `users.info` profile |

Users are auto-seeded from the Slack API when a meeting is created or the bot starts. Manual seeding via `/ma seed-user` is also available as a fallback.

### `meetings`
One row per meeting coordination effort.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `title` | TEXT | Meeting name, set during creation |
| `start_time` | TEXT | ISO 8601 datetime |
| `organizer_user_id` | TEXT FK→users | Which operator owns this meeting |
| `purpose` | TEXT | Free-text purpose description |
| `document_url` | TEXT | Full Confluence page URL |
| `document_title` | TEXT | Human-readable doc name |
| `document_action` | TEXT | One of: `read`, `comment`, `approve`, `provide_input`, `confirm_decision` |
| `confluence_page_id` | TEXT | Extracted from URL (`/pages/123456`) |
| `status` | TEXT | `draft` → `active` → `completed` |
| `created_at` | TEXT | ISO 8601 |

### `meeting_participants`
Join table linking users to meetings with per-participant state.

| Column | Type | Notes |
|---|---|---|
| `meeting_id` | TEXT FK→meetings | |
| `user_id` | TEXT FK→users | |
| `role` | TEXT | `participant` or `organizer` |
| `status` | TEXT | See lifecycle below |
| `reminder_count` | INTEGER | How many reminder nudges sent |
| `completed_at` | TEXT | ISO 8601, set when status=`completed` |

**Participant status lifecycle:**
```
pending → nudge_sent → replied / completed / clarification_needed / blocked / overdue
```
- `pending` — added to meeting, no nudge sent yet
- `nudge_sent` — pre-meeting nudge delivered
- `replied` — participant sent a free-text DM response
- `completed` — clicked "Mark done" button
- `clarification_needed` — clicked "Need clarification" button
- `blocked` — clicked "Cannot complete" button
- `overdue` — meeting start time has passed and still pending/nudge_sent

### `nudges`
Log of every message the bot sent to participants.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `user_id` | TEXT FK→users | |
| `meeting_id` | TEXT FK→meetings | |
| `slack_channel_id` | TEXT | DM channel ID returned by Slack |
| `message_ts` | TEXT | Slack message timestamp |
| `type` | TEXT | `pre_meeting`, `reminder`, `post_meeting`, `doc_check` |
| `sent_at` | TEXT | ISO 8601 |

### `participant_messages`
Records every inbound DM from a participant.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `user_id` | TEXT FK→users | |
| `meeting_id` | TEXT FK→meetings | Resolved via `getMeetingForParticipant` |
| `nudge_id` | TEXT FK→nudges nullable | Not yet linked automatically |
| `raw_text` | TEXT | Full message text |
| `ai_classification` | TEXT nullable | Phase 2: intent classification |
| `created_at` | TEXT | ISO 8601 |

### `operator_replies`
Records replies sent by the operator via `/ma reply`.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `participant_message_id` | TEXT FK→participant_messages | |
| `raw_text` | TEXT | |
| `sent_at` | TEXT | ISO 8601 |

### `doc_checks`
Records each time `/ma check-doc` is run.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `meeting_id` | TEXT FK→meetings | |
| `checked_at` | TEXT | ISO 8601 |
| `confluence_version` | INTEGER | Page version number at time of check |
| `comment_count` | INTEGER | Number of comments at time of check |
| `summary` | TEXT nullable | Phase 2: AI-generated summary |
| `suggested_nudges` | TEXT nullable | Phase 2: AI-suggested nudge text |

---

## 4. Operator Commands

All commands use the `/ma` Slack slash command. Only users whose Slack ID appears in `OPERATOR_SLACK_IDS` can use them. All responses are ephemeral (visible only to the operator).

Meeting IDs are UUIDs. Commands accept the first 8 characters as a short ID prefix for convenience (e.g. `ad2bb88e` instead of the full UUID).

### Meeting lifecycle commands

#### `/ma create`
Opens an interactive DM-based creation wizard. The bot sends a DM asking for each field in sequence:

1. Meeting title
2. Date and time (ISO 8601, e.g. `2026-06-04T09:00:00Z`)
3. Meeting purpose (free text)
4. Confluence page URL (validated: must contain `/pages/<digits>`)
5. Document title
6. Required action (`read` | `comment` | `approve` | `provide_input` | `confirm_decision`)
7. Participant Slack IDs (comma-separated, e.g. `U001,U002,U003`)

On completion the bot auto-seeds any unknown participant IDs from the Slack API, creates the meeting in `draft` status, adds all participants, then sets it to `active`.

**Important:** Only the operator who ran `/ma create` can see this meeting in list/status/send commands — meetings are isolated per organiser.

#### `/ma list`
Lists all `draft` and `active` meetings for the calling operator.
Output: `• *Title* — \`id-prefix\` — status — start_time`

#### `/ma status [id]`
Shows full participant state for a meeting.
Output: meeting title, status, document link, and per-participant: name, Slack mention, status, reminder count.

#### `/ma send [id]`
Sends the pre-meeting nudge to all `pending` participants. The nudge is a Block Kit message with:
- Meeting title, date/time, document link
- Required action label (human-readable)
- Three buttons: **Mark done** / **Need clarification** / **Cannot complete**

Records each nudge in the `nudges` table. Updates participant status to `nudge_sent`. Reports errors per-participant if any DM fails (e.g. DM not allowed by workspace policy).

#### `/ma remind [id]`
Sends a plain-text reminder to participants with status `nudge_sent` or `replied`. Increments `reminder_count`. Uses `buildReminderMessage()`.

#### `/ma followup [id]`
Sends a plain-text post-meeting follow-up to all participants that have not yet reached `completed` status. Uses `buildFollowUpMessage()`.

#### `/ma set-action [id] <action>`
Changes the required action for an existing meeting mid-flight. Resets all participants back to `pending`. The operator should then run `/ma send [id]` to send a fresh nudge with the new action.

Valid actions: `read`, `comment`, `approve`, `provide_input`, `confirm_decision`

Use case: after everyone reads a document, switch the action to `comment` and nudge again without creating a new meeting.

#### `/ma check-doc [id]`
Fetches the Confluence page and its comments. Posts a summary to the operator's DM showing:
- Page title, last-modified time and author
- Comments received (with author and excerpt)
- Which participants have not yet commented
- Per-person buttons: **Yes, send** / **Skip** to immediately DM a reminder to non-commenters

Records the check in `doc_checks`.

### User management commands

#### `/ma seed-user <slack_id> <email> <display_name>`
Manually upserts a user record. Useful as a fallback when `autoSeedFromSlack` cannot reach the Slack API (e.g. the user is a guest account or has restricted visibility).

#### `/ma reply @handle <message>`
Sends a free-text DM to a participant as the bot. The handle can be a Slack ID or a display name formatted as `firstname.lastname`. Records the reply in `operator_replies`.

---

## 5. Participant Experience

Participants never use any slash commands. Their entire interaction is through DMs with the bot.

### Receiving a nudge
When the operator runs `/ma send`, each pending participant receives a DM with:
- Context: meeting title, date/time, document link
- Action required (e.g. "Read the document", "Add a comment or mark no concerns")
- Three buttons: **Mark done** / **Need clarification** / **Cannot complete**

### Button responses
- **Mark done** → status set to `completed`, participant receives confirmation, operator gets a notification
- **Need clarification** → status set to `clarification_needed`, operator gets notified with reply instructions
- **Cannot complete** → status set to `blocked`, operator gets notified with reply instructions

### Free-text DM replies
If a participant types a message to the bot (instead of clicking a button), the bot:
1. Records the message in `participant_messages`
2. Sets the participant's status to `replied`
3. Forwards the message verbatim to the operator's DM with the participant's mention and meeting title

The operator can then respond using `/ma reply @handle <message>`.

---

## 6. Automated Scheduler

Two cron jobs run continuously (using `node-cron`):

### Overdue detection — every hour (`0 * * * *`)
Scans all active meetings. For any meeting whose `start_time` has passed, finds participants still in `pending` or `nudge_sent` status and:
- Updates their status to `overdue`
- Sends the operator a single notification listing all overdue participants

### Daily digest — 08:00 UTC (`0 8 * * *`)
If there are any active meetings, sends the operator a morning summary:
```
*Meetassist Daily Digest*
• Meeting Title — 3/5 done, 1 blocked — <doc link>
• Meeting Title — 2/2 done
```

---

## 7. Confluence Integration

The `ConfluenceService` uses Confluence REST API v1 with Basic Auth (email + API token).

**`getPage(pageId)`** — fetches page metadata: title, version number, last-modified timestamp, last-modified author, and plain-text body (HTML stripped).

**`getComments(pageId)`** — fetches all inline/footer comments: author name, author email, plain-text body, created timestamp.

**`buildDocCheckSummary(page, comments, participantEmails)`** — produces the human-readable summary shown by `/ma check-doc`: who has commented, who hasn't, overall coverage ratio.

The `confluence_page_id` is parsed from the document URL at meeting creation time by extracting the numeric ID from the `/pages/123456` segment.

**Email matching**: Confluence comment authors are matched to meeting participants by email address. This works because both Slack and Confluence use the same `@emarsys.com` domain for this organisation.

---

## 8. Multi-Operator Support

Multiple operators can use the bot simultaneously. Operator Slack IDs are stored in the `OPERATOR_SLACK_IDS` environment variable as a comma-separated list (e.g. `U001,U002`).

**Isolation**: Each operator sees only the meetings they created. `listActive()` filters by `organizer_user_id`. This means `/ma list`, `/ma status`, `/ma send`, etc. all operate on the calling operator's meetings only.

**Participant routing**: When a participant DMs the bot, the relay service looks up the participant's active meeting and forwards the message to the meeting's organiser (using `OPERATOR_SLACK_ID` — note: currently the relay still uses the single `OPERATOR_SLACK_ID` env var for forwarding, not the meeting organiser. This is a known limitation for Phase 2 to address).

**Operator auto-seed**: On bot startup, every operator in `OPERATOR_SLACK_IDS` is auto-seeded into the `users` table via the Slack API, with a fallback to `CONFLUENCE_EMAIL` and `OPERATOR_NAME` if the API call fails.

---

## 9. User Auto-Seeding

Users are auto-seeded from the Slack API (`users.info`) instead of requiring manual registration. This happens:
- **At startup**: for each operator in `OPERATOR_SLACK_IDS`
- **At meeting creation**: for each participant Slack ID entered in the create wizard

The `autoSeedFromSlack(slackUserId, client)` method:
1. Checks if the user already exists in the DB
2. If not, calls `client.users.info({ user: slackUserId })`
3. Extracts `profile.real_name` (falls back to `profile.display_name`, then the Slack ID)
4. Extracts `profile.email` for Confluence comment matching
5. Upserts the user record

If lookup fails (guest accounts, restricted visibility), the creation wizard reports the failed IDs back to the operator, and `/ma seed-user` can be used as a manual fallback.

---

## 10. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | Bot OAuth token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | Yes | App-level Socket Mode token (`xapp-…`) |
| `SLACK_SIGNING_SECRET` | Yes | Request verification secret |
| `OPERATOR_SLACK_IDS` | Yes | Comma-separated Slack IDs of authorised operators |
| `OPERATOR_NAME` | No | Display name for fallback operator seed |
| `CONFLUENCE_BASE_URL` | Yes | e.g. `https://your-org.atlassian.net` |
| `CONFLUENCE_EMAIL` | Yes | Email for Confluence Basic Auth |
| `CONFLUENCE_API_TOKEN` | Yes | Confluence API token |
| `DATABASE_URL` | Yes | PostgreSQL connection string (injected by Railway) |
| `CLAUDE_ENABLED` | No | `true` to activate Phase 2 AI features (default: `false`) |
| `ANTHROPIC_API_KEY` | Phase 2 | API key for Claude integration |

**Important note on Railway:** Variables must be entered individually in the Railway UI (not via JSON import). Token values must be pasted without line breaks — long tokens can get silently truncated if the terminal line-wraps during paste.

---

## 11. Slack App Configuration

The Slack app requires the following configuration in api.slack.com:

**OAuth Scopes (Bot Token):**
- `chat:write` — send messages
- `im:write` — open DM channels
- `users:read` — look up user profiles for auto-seeding
- `users:read.email` — read email addresses from profiles
- `commands` — register slash commands

**Event Subscriptions:**
- `message.im` — receive DMs from participants and operators

**Slash Commands:**
- `/ma` — the single command entry point for all operator actions

**App Home:**
- Messages Tab must be enabled (allows participants to DM the bot)
- Workspace policy may restrict DMs — if users see "Sending messages to this app has been turned off", an admin must enable it at workspace level

**Socket Mode:** Must be enabled. Requires an App-Level Token (`xapp-…`).

---

## 12. Known Limitations and Technical Debt

### Relay forwards to wrong operator (multi-operator bug)
`RelayService.forwardToOperator()` and `notifyOperator()` read `process.env.OPERATOR_SLACK_ID` (singular). In a multi-operator setup, all participant replies and notifications go to the first/only `OPERATOR_SLACK_ID` variable regardless of which operator owns the meeting. Fix: look up the meeting's `organizer_user_id` and forward to that operator's Slack ID.

### Meeting ID resolution does not search across statuses
`resolveMeetingId()` only searches `draft` and `active` meetings. Completed meetings cannot be referenced by short ID in any command.

### No pagination on Confluence comments
`getComments()` fetches a single page of results. Docs with many comments may be silently truncated.

### Participant DM can be blocked by workspace policy
If a Slack workspace disables DMs to bots, `/ma send` will fail per-participant with a Slack error. The operator is notified of failures, but there is no retry mechanism.

### No meeting completion workflow
There is no `/ma close` or `/ma complete` command. Meetings stay `active` indefinitely. The overdue detector marks participants as overdue but does not close the meeting.

### `document_action` is stored as TEXT in Postgres
The TypeScript `DocumentAction` type enforces valid values, but the DB column does not have a CHECK constraint. Invalid values inserted via raw SQL would not be caught.

---

## 13. Phase 2: Claude AI Integration

The `ClaudeService` (`src/services/claude.ts`) is a stub that currently returns empty/no-op results. It is gated by the `CLAUDE_ENABLED=true` environment variable.

Three capabilities are designed and stubbed:

**`analyzeDocState(meeting, page, comments)`** → `DocAnalysis`
Intended to: read the Confluence page content and comments, summarise what's been discussed, identify unresolved concerns, and suggest personalised nudge text for participants who haven't engaged. This would replace or augment the current rule-based `buildDocCheckSummary`.

**`classifyReply(message, meetingTitle)`** → `ReplyClassification`
Intended to: classify a participant's free-text DM into one of: `completed`, `blocked`, `needs_clarification`, `disagrees`, `unavailable`, `asks_question`, `unknown`. This would allow the bot to auto-update participant status on free-text replies instead of requiring button clicks, and give the operator better signal about what's happening.

**`draftReply(incomingMessage, meetingTitle)`** → `string`
Intended to: draft a suggested operator reply to a participant message. The operator would still approve and send, but would have a starting point.

The `DocCheck` table has `summary` and `suggested_nudges` columns pre-provisioned for Phase 2 output. The `participant_messages` table has `ai_classification` pre-provisioned.

**To activate Phase 2:** Set `CLAUDE_ENABLED=true` and `ANTHROPIC_API_KEY=<key>` in Railway, implement the three methods in `ClaudeService`, and wire them into the existing `check-doc` command and DM listener.

---

## 14. Typical Operator Workflow

A complete meeting coordination cycle looks like this:

```
1. /ma create
   → DM wizard: enter title, date, purpose, Confluence URL, doc title, action, participants
   → Bot seeds unknown participants from Slack API
   → Meeting created, status: active

2. /ma list
   → Confirm meeting appears with correct ID prefix

3. /ma status [id]
   → Verify all participants show as "pending"

4. /ma send [id]
   → Pre-meeting nudge delivered to all pending participants
   → Participants receive Block Kit message with action + 3 buttons

5. (participants click buttons or reply via DM)
   → Operator receives notifications for clarifications and blockers
   → Use /ma reply @handle <text> to respond to free-text DMs

6. /ma status [id]
   → Monitor progress: who's done, who's pending, who's blocked

7. /ma check-doc [id]   (optional)
   → Pull live Confluence comment data
   → See who has/hasn't commented, send spot nudges via buttons

8. /ma remind [id]   (for stragglers)
   → Re-nudge everyone still in nudge_sent or replied status

9. (after meeting)
   /ma followup [id]
   → Post-meeting nudge to anyone who never completed

10. (if action type changes mid-cycle)
    /ma set-action [id] comment
    /ma send [id]
    → All participants reset to pending, new nudge sent with updated action
```

---

## 15. Testing

Tests live in `tests/` and use `vitest`. The pg pool is mocked using `vitest`'s `vi.mock` so no database is needed to run tests.

```bash
npm test          # run all tests once
npm run test:watch  # watch mode
```

Current test coverage covers: MeetingService, NudgeService, ConfluenceService, and RelayService.

To run locally in dev mode (requires a local Postgres or a DATABASE_URL pointing to Railway):
```bash
npm run dev   # tsx watch — hot reload
```

To build for production:
```bash
npm run build   # tsc → dist/
npm start       # node dist/index.js
```
