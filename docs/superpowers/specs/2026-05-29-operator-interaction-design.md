# Operator Interaction Refinement — Design Spec

**Date:** 2026-05-29
**Status:** Approved, ready for implementation plan

## Goal

Replace the slash-command-driven operator flow with a Slack modal-based "form" experience for creating meetings, plus persistent per-meeting control cards posted into the operator DM for follow-up actions. Slash commands remain as a fallback.

## Motivation

Current flow forces operators to type `/ma create` and walk through a stepwise text wizard, then type `/ma status <id>`, `/ma set-action <id> <action>`, etc. for follow-ups. Operators want:

- A single form to fill out (one screen, multiple fields visible at once)
- @-mention based participant selection (no manual seeding step)
- Persistent inline controls per meeting (no remembering subcommands or IDs)

App Home tab — the typical Slack pattern for this — is disabled at the org level, so the persistent surface lives in the operator DM instead.

## Architecture

Two new Slack surfaces, both reusing existing services (`MeetingService`, `NudgeService`, `RelayService`, `ConfluenceService`):

1. **Creation modal** — opened from a persistent "➕ Create meeting" button pinned in the operator DM. Submitting the modal creates the meeting, auto-seeds participants via `users.info`, and posts a control card.
2. **Per-meeting control card** — Block Kit message in the operator DM with live status + action buttons. Updated in place via `chat.update` as state changes.

No NLP, no App Home, no external participants, no email path.

## Section 1 — Meeting creation modal

### Trigger

A persistent message in each operator's DM with a single "➕ Create meeting" button. Posted once on boot per operator (tracked in DB to avoid duplicates), restored if missing.

### Modal fields (`views.open`)

| Field | Type | Required | Notes |
|---|---|---|---|
| Title | `plain_text_input` | yes | |
| Document URL | `plain_text_input` | yes | Validated: must contain `/pages/\d+`. URL is unwrapped via `unwrapSlackUrl` on submit (handles Slack auto-link wrapping). |
| Action | `static_select` | yes | Options: read / comment / approve / provide input / confirm decision |
| Purpose / context | `plain_text_input` (multiline) | no | |
| Start time | `datetimepicker` | yes | Must be in the future |
| Participants | `multi_users_select` | yes (min 1) | Slack returns live workspace search — operator types `@name` |

### Validation

Server-side via `view_submission` response. Returns inline `errors` keyed to block IDs on failure. Validations:

- Title non-empty
- Document URL matches `/pages/\d+` after unwrapping
- Start time > now
- ≥ 1 participant selected

### On success

1. Resolve each picked Slack user via `client.users.info` and `meetingService.upsertUser` (auto-seed; no manual `/ma seed-user` step).
2. Derive document title via `confluenceService.getPageTitle(documentUrl)`.
3. `meetingService.createMeeting(...)` — same path as today's `/ma create`.
4. Post the control card (Section 2) into the operator DM and persist `control_channel_id` + `control_message_ts`.

## Section 2 — Per-meeting control card

### Layout

Block Kit message, one per meeting. Example:

```
📋 *Take Template Ownership* — Problem Resolution Proposal    `e619b4ed`
Starts: Tue Jun 2 · 14:00 UTC
Document: <https://emarsys.jira.com/...|Take Template Ownership>
Action: provide input
Progress: 2/5 done · 1 blocked
─────────────────────────────────────
[View status] [Change action] [Send reminder] [Cancel]
```

### Buttons

| Button | Action ID | Behavior |
|---|---|---|
| View status | `meeting_view_status` | Ephemeral message with the participant table (slack_user_id, status, last updated, latest reply). Same data the dashboard renders. |
| Change action | `meeting_change_action` | Opens a small modal containing the action `static_select`. Submit → `meetingService.setAction(...)` → re-render this card. |
| Send reminder | `meeting_send_reminder` | Calls `nudgeService.sendNudges(meetingId)` for participants not in `completed` state. Ephemeral confirmation. |
| Cancel | `meeting_cancel` | Confirmation dialog (Slack native). On confirm: marks meeting cancelled, updates the card to a strikethrough/archived footer state. |

### Lifecycle

- Posted on creation. `channel_id` + `ts` saved in the `meetings` row.
- Scheduler tick: for any meeting whose progress signature (`done/total/blocked`) has changed since `last_card_progress`, call `chat.update` to re-render the card.
- 24h after `start_time`: card is rewritten one final time to "✅ Archived" footer state, then never touched again.

## Section 3 — Slash command coexistence

All existing `/ma` subcommands keep working unchanged. No deprecation, no removal.

The only change: `/ma create` (text wizard) gets a one-line hint at the start of the flow:

> 💡 Tip: you can also use the **➕ Create meeting** button in this DM for a faster form-based flow. Continuing with text wizard…

Existing subcommands (unchanged):

- `/ma create` — stepwise text wizard (with new hint)
- `/ma list` — list active meetings
- `/ma status <id>` — participant status table
- `/ma set-action <id> <action>` — change document action
- `/ma cancel <id>` — cancel meeting
- `/ma seed-user` — manual seed (kept for edge cases)

No new slash commands are added. All new functionality lives in the modal + control card.

## Section 4 — Implementation surface

### New files

- **`src/bot/modals.ts`** — Modal view JSON builders (`buildCreateMeetingModal()`, `buildChangeActionModal(meetingId, currentAction)`) and `view_submission` handler registrations.
- **`src/bot/control-card.ts`** — Block Kit builder (`buildControlCardBlocks(meeting, participants)`) plus `postControlCard(...)` / `updateControlCard(...)` helpers wrapping `chat.postMessage` / `chat.update`.
- **`src/bot/dm-bootstrap.ts`** — `bootstrapOperatorDms(operatorIds, client)`: ensures each operator has the persistent "➕ Create meeting" message in their DM. If `operator_dm_message_ts` is null or the message has been deleted, posts a fresh one.

### Modified files

- **`src/bot/app.ts`** — Register button action handlers (`open_create_modal`, `meeting_view_status`, `meeting_change_action`, `meeting_send_reminder`, `meeting_cancel`) and view-submission handlers (`create_meeting_modal`, `change_action_modal`).
- **`src/bot/commands.ts`** — `/ma create` adds the one-line hint at the top of the wizard.
- **`src/services/meeting.ts`** — New methods:
  - `setControlMessage(meetingId, channelId, ts)`
  - `getMeetingsWithStaleCard()` — meetings whose progress signature differs from `last_card_progress`
  - Refactor: extract `autoSeedSlackUser(slackUserId, client)` from existing `autoSeedFromSlack` so the modal-submission handler can reuse it.
- **`src/scheduler/cron.ts`** — After each tick, iterate `getMeetingsWithStaleCard()` and call `updateControlCard`. Also archive cards whose meeting `start_time + 24h` has passed.
- **`src/index.ts`** — Call `bootstrapOperatorDms(operatorIds, app.client)` after services are wired.

### Schema delta (one migration)

```sql
ALTER TABLE meetings
  ADD COLUMN control_channel_id text,
  ADD COLUMN control_message_ts text,
  ADD COLUMN last_card_progress text;  -- "done/total/blocked" e.g. "2/5/1"

ALTER TABLE users
  ADD COLUMN operator_dm_channel_id text,
  ADD COLUMN operator_dm_message_ts text;
```

All columns nullable. Existing rows unaffected.

## Out of scope

- External (non-Slack) participants
- App Home tab (org-disabled)
- NLP / conversational intent parsing
- Removing or deprecating slash commands
- Email-based nudges
- Migrating existing meetings to have control cards (only newly created meetings get one; existing ones continue to work via slash commands)

## Open follow-ups (later, not in this spec)

- Backfill control cards for already-active meetings (low priority — operators can recreate or use slash commands).
- "Reopen" button on cancelled meetings.
- Editing other fields (title, document URL) post-creation.
