# App Home Tab — Design Spec

**Status:** Design approved 2026-05-28
**Builds on:** `docs/specs/meetassist-v1.md` (Phase 1 system spec)

> **Goal:** Add a persistent, interactive Slack App Home tab that serves operators a meeting dashboard and participants their open action items, refreshed in real time as state changes.

---

## 1. Overview

The Slack App Home tab is a persistent Block Kit view rendered when a user opens the bot's Home tab. Two distinct views are shown depending on the viewer's role:

- **Operator view** — full meeting dashboard with active meetings, progress, and action buttons (Send, Remind, Status, Check doc, Set action, Followup) plus a Create meeting flow.
- **Participant view** — list of meetings where the participant's status is not `completed`, with the same Mark done / Need clarification / Cannot complete buttons used in DM nudges.

Role detection: a user is an operator if their Slack ID appears in `OPERATOR_SLACK_IDS`; otherwise they are a participant.

The view refreshes in two situations: when the user opens the Home tab (`app_home_opened` event), and after any state mutation in the system (nudge send, status change, action change, etc.). Refresh failures are logged but never break the underlying operation.

---

## 2. File Structure

### New file
**`src/bot/home.ts`** — exports `registerHome(meetingService, nudgeService, relayService, confluenceService)`. Contains:
- `app.event('app_home_opened', ...)` listener
- `buildOperatorView(operatorUser): View` — builds operator Block Kit view
- `buildParticipantView(user): View` — builds participant Block Kit view
- `publishHomeView(slackUserId): Promise<void>` — refresh helper exported for use by other modules
- Action handlers: `home_create_meeting`, `home_send`, `home_remind`, `home_status`, `home_check_doc`, `home_set_action`, `home_followup`
- Modal handlers (`view_submission` events): create meeting, set action

### Modified files
- **`src/index.ts`** — call `registerHome(...)` during boot
- **`src/services/meeting.ts`** — add `listOpenForParticipant(userId): Promise<(Meeting & MeetingParticipant)[]>`
- **`src/bot/commands.ts`** — call `publishHomeView()` after every state mutation
- **`src/bot/actions.ts`** — call `publishHomeView()` after participant button clicks
- **`src/bot/relay.ts`** — call `publishHomeView()` after participant DM relay (status → replied)

---

## 3. Slack App Configuration (one-time, manual)

Required changes in api.slack.com:

- **Event Subscriptions:** Add `app_home_opened`
- **OAuth Scopes (Bot Token):** Add `views:write`
- **App Home settings:** Enable Home Tab
- Reinstall app to workspace to apply new scope

---

## 4. Operator View

### Layout

```
Header: "Meetassist"
Subtitle: "<N> active meeting(s) · <M> pending replies"

(per active meeting:)
  Section block:
    *<title>*
    <date> · <time> · <id-prefix>
    Action: <action label>
    Progress: <done>/<total> done · <blocked> blocked
    Doc: <document_title link>
  Actions block: [Send] [Remind] [Status] [Check doc] [Set action] [Followup]
  Divider

Footer actions block: [+ Create meeting]
```

### Block Kit details

- `header` block: text "Meetassist"
- `section` block (mrkdwn) for subtitle
- Per meeting: a `section` block (mrkdwn) followed by an `actions` block with 6 buttons, separated by a `divider` block
- Final `actions` block always has a single primary button "Create meeting"

**Note on Slack limits:** A single `actions` block accepts up to 25 elements; 6 buttons fits comfortably. The Home tab view itself can hold up to 100 blocks total — at ~3 blocks per meeting (section + actions + divider) plus header/footer, this allows roughly 30 active meetings before hitting the cap.

### Empty state

When `listActive(operatorUserId)` returns an empty array:
- Header
- One `section` block with friendly message: "No active meetings yet. Create your first one to get started."
- `actions` block with "Create meeting" button

### Action IDs and values

| Button | action_id | value |
|---|---|---|
| Send | `home_send` | meeting UUID |
| Remind | `home_remind` | meeting UUID |
| Status | `home_status` | meeting UUID |
| Check doc | `home_check_doc` | meeting UUID |
| Set action | `home_set_action` | meeting UUID |
| Followup | `home_followup` | meeting UUID |
| Create meeting | `home_create_meeting` | (none) |

Each handler calls the same underlying service methods that the equivalent `/ma` slash command uses. Logic is shared, not duplicated.

---

## 5. Participant View

### Layout

```
Header: "Meetassist"
Subtitle: "<N> action(s) waiting for you"

(per open item:)
  Section block:
    *<meeting title>*
    <date> · <time>
    Action requested: <action label>
    Document: <document_title link>
    Status: <humanised status>
  Actions block: [Mark done] [Need clarification] [Cannot complete]
  Divider
```

### Filtering

Uses new `meetingService.listOpenForParticipant(userId)`, which returns rows where `meeting_participants.status != 'completed'`.

### Reused action handlers

The buttons reuse existing handlers in `src/bot/actions.ts` (`mark_done`, `need_clarification`, `cannot_complete`) — they accept a meeting UUID as `value` and don't care about origin (DM or Home).

### Empty state

When `listOpenForParticipant(userId)` returns empty:
- Header
- One `section` block: "You're all caught up. No actions needed right now."

### Status humanisation

| Internal status | Displayed text |
|---|---|
| `pending` | waiting for nudge |
| `nudge_sent` | nudge sent |
| `replied` | you replied — awaiting follow-up |
| `clarification_needed` | clarification requested |
| `blocked` | marked as blocked |
| `overdue` | overdue |

`completed` is never shown (filtered out).

---

## 6. Modals

### Create meeting modal

Trigger: `home_create_meeting` button click → `app.client.views.open()`.

**Fields (Block Kit input blocks):**
| Field | Element type | Required |
|---|---|---|
| Meeting title | `plain_text_input` | Yes |
| Date and time | `datetimepicker` | Yes |
| Meeting purpose | `plain_text_input` (multiline) | Yes |
| Confluence page URL | `plain_text_input` | Yes |
| Document title | `plain_text_input` | Yes |
| Required action | `static_select` (5 options) | Yes |
| Participants | `multi_users_select` | Yes |

**Submit handler (`view_submission`):**
1. Validate Confluence URL contains `/pages/<digits>` — if invalid, return `response_action: 'errors'` with field-level error on the URL field
2. Auto-seed each selected participant via `autoSeedFromSlack()`
3. Call `meetingService.createMeeting()` with the operator as organiser
4. Add participants via `addParticipant()`
5. Call `meetingService.updateStatus(id, 'active')`
6. Call `publishHomeView()` for operator and each participant

**Advantage over `/ma create` wizard:** `multi_users_select` is Slack's native user picker — no manual ID entry needed.

### Set action modal

Trigger: `home_set_action` button click → `views.open()`.

**Fields:**
- `static_select` — Action dropdown, pre-selected to the meeting's current `document_action`
- `section` block with confirmation text: "All participants will be reset to pending. You'll need to send a new nudge afterwards."

**Submit handler:**
1. Call `meetingService.updateAction(meetingId, newAction)`
2. For each participant: `updateParticipantStatus(meetingId, userId, 'pending')`
3. Call `publishHomeView()` for operator and each participant

### Status modal

Trigger: `home_status` button click → `views.open()`.

Read-only modal containing:
- Meeting title and status
- Document link
- Per-participant: name, mention, current status, reminder count

Same content as `/ma status [id]`. No submit action; only a Close button.

---

## 7. Refresh Strategy

Two refresh triggers:

### Trigger 1: User opens the Home tab

`app.event('app_home_opened')` fires when a user opens the tab. Handler:
1. Look up user via `meetingService.getUserBySlackId()`
2. Determine role: operator if `OPERATOR_SLACK_IDS.includes(slackUserId)`, else participant
3. Build appropriate view
4. Call `app.client.views.publish({ user_id, view })`

### Trigger 2: State changes

After any mutation, the calling code invokes `publishHomeView(slackUserId)`. Specific trigger points:

| Trigger | Refresh targets |
|---|---|
| `/ma send`, `home_send` | Operator + all affected participants |
| `/ma remind`, `home_remind` | Operator + all affected participants |
| `/ma followup`, `home_followup` | Operator + all affected participants |
| `/ma set-action`, `home_set_action` modal submit | Operator + all participants |
| `/ma create` wizard or create modal submit | Operator + all participants |
| `mark_done`, `need_clarification`, `cannot_complete` | Operator (organiser) + that participant |
| Participant DM (status → replied) | Organiser + that participant |
| `/ma check-doc`, `home_check_doc` | Operator only (no state change for participants) |

### Implementation

`publishHomeView(slackUserId)`:
1. Look up user via `getUserBySlackId()`. If not found, return silently.
2. Determine role from `OPERATOR_SLACK_IDS`.
3. Build view (operator or participant).
4. Call `views.publish({ user_id, view })`.
5. Wrap entire function in try/catch — log errors, never throw.

For multi-target refreshes, deduplicate Slack IDs first, then refresh each unique user once. Refreshes can run in parallel via `Promise.allSettled()` — the operator's view doesn't block participant refreshes.

### Why on every change?

Slack's Home tab is sticky. Once published, the view stays until the next `views.publish` call. Refreshing only on open would show stale data while the tab is visible. The Slack API cost is one call per refresh — cheap.

---

## 8. Data Flow

### Operator view build
1. `meetingService.listActive(operatorUserId)` → meetings
2. For each meeting, `meetingService.getParticipantsWithUsers(meeting.id)` → compute `done/total` and `blocked` count
3. Compose Block Kit blocks
4. Return `{ type: 'home', blocks }`

### Participant view build
1. `meetingService.listOpenForParticipant(userId)` → joined rows of meetings + participant status (one query)
2. Map each row to a section + actions block group
3. Return `{ type: 'home', blocks }`

### New service method

```ts
// src/services/meeting.ts
async listOpenForParticipant(userId: string): Promise<(Meeting & { participant_status: ParticipantStatus })[]> {
  const { rows } = await this.pool.query(
    `SELECT m.*, mp.status as participant_status
     FROM meetings m
     JOIN meeting_participants mp ON mp.meeting_id = m.id
     WHERE mp.user_id = $1
       AND mp.status != 'completed'
       AND m.status IN ('draft','active')
     ORDER BY m.start_time ASC`,
    [userId]
  );
  return rows;
}
```

---

## 9. Error Handling

### View publish failures
- `publishHomeView()` is wrapped in try/catch
- Log to console: `[home] publish failed for ${slackUserId}:`, error
- Never throw — must not break the underlying operation
- Common causes: deactivated user account, app uninstalled

### Action handler failures
- Each `app.action()` handler is wrapped in try/catch
- On error, post ephemeral message via `respond()` or `chat.postEphemeral`
- Log full error to console

### Modal submit failures
- Field-level validation errors return Slack's native `response_action: 'errors'` (modal stays open with error highlighted)
- Server-side errors (DB write fails) close the modal and post ephemeral error message

### Stale button clicks
- If a meeting was deleted or completed before the user clicks a Home button, the action handler resolves the meeting by ID and finds nothing
- Respond ephemerally: "Meeting not found or no longer active. Refresh your Home tab."

### Concurrent state changes
- Multi-operator scenario: two operators acting on the same meeting simultaneously = last refresh wins
- Acceptable trade-off for this scale (single-team usage)

---

## 10. Testing

New file: `tests/home.test.ts`. Mock the pg pool the same way existing tests do (`vi.mock`).

**Tests:**
- `buildOperatorView()` with empty meetings → returns header + empty state + Create button
- `buildOperatorView()` with 2 meetings → correct block count (header + subtitle + 2 × (section + actions + divider) + footer)
- `buildOperatorView()` progress math: 3 of 5 completed and 1 blocked → "3/5 done · 1 blocked"
- `buildParticipantView()` filters out completed items
- `buildParticipantView()` empty state when no open items
- `buildParticipantView()` status humanisation correct for each status value
- `listOpenForParticipant()` query excludes completed rows
- `listOpenForParticipant()` query excludes non-active meetings

Action handler tests follow the existing pattern (mock app + service calls). One test per handler verifying it calls the correct service method and triggers a refresh.

---

## 11. Out of Scope

The following are intentionally NOT part of this feature:

- **Pagination on the operator dashboard** — assumes < 50 active meetings per operator. If usage grows, revisit with pagination or "show more" pattern.
- **Editing existing meetings** — the only modal-driven write is Create. Edits to title, time, doc URL, etc. are deferred to a future iteration. Set action stays in scope as it's a high-value workflow.
- **Deleting/cancelling meetings from the Home tab** — no Delete button. Future work.
- **Notifications/badges on the Home tab** — Slack does not currently support push notifications for Home tab updates.
- **Multi-operator visibility** — operators still only see their own meetings (per the existing `organizer_user_id` filter). The Home tab does not change isolation behaviour.

---

## 12. Migration & Rollout

- No database schema changes required (the new `listOpenForParticipant` is a pure read query)
- No environment variable changes
- Slack app config changes are one-time and additive — existing functionality unaffected
- Deployment is via the existing Railway auto-deploy on push to `main`

After deploy:
1. Apply Slack app config (event subscription + scope + App Home enabled)
2. Reinstall the app to refresh the OAuth token with the new `views:write` scope
3. Open the Home tab as operator and as participant to verify both views render
