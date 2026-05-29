# Action Verification — Design Spec

**Status:** Design approved 2026-05-29
**Builds on:** `docs/specs/meetassist-v1.md` (Phase 1) + `docs/superpowers/specs/2026-05-29-confluence-dashboard-design.md`

> **Goal:** Detect when a participant marks an action as `done` without actually performing it on Confluence, and offer the meeting organizer a one-click follow-up nudge.

---

## 1. Overview

When a participant clicks "Mark done" on a nudge, we record completion immediately (no UX change for them). 60 seconds later, the bot re-fetches the meeting + participant, fetches comments on the Confluence document, and checks whether the participant's email appears among the comment authors. If not — and if the action is one we can verify — the bot DMs the meeting organizer with a "send a follow-up nudge?" prompt. The participant's status remains `completed`; nothing in the dashboard changes unless the operator chooses to send a follow-up nudge.

The 60-second delay accommodates Confluence API propagation lag and lets a participant who comments-then-clicks not be falsely flagged.

If the bot restarts within the 60-second window, the pending verification is lost. Acceptable trade-off for v1 simplicity. No DB schema changes.

Verification is best-effort: we only verify actions where Confluence's API gives a strong signal (`comment`, `provide_input`, `approve`, `confirm_decision` — all checked the same way: any comment by the participant counts as engagement). For `read`, no API support exists; we trust self-report.

---

## 2. File Structure

### New files

**`src/services/verification.ts`** — exports:
- `scheduleVerification(meetingId: string, userId: string): void` — schedules a 60s in-process timer keyed on `<meetingId>:<userId>`. If a timer already exists for this key, clears it first.
- `runVerification(meetingId: string, userId: string): Promise<void>` — the verification logic, exported so it's testable in isolation without real timers. Wrapped in a single try/catch that logs `[verification]` errors and never throws.
- `configureVerification(deps: { meetingService, confluenceService, relayService, nudgeService })` — module-level singleton init, mirrors the `configureDashboard` pattern.

**`tests/services/verification.test.ts`** — unit tests for `runVerification` (mocked services, no fake timers) plus the two button handlers.

### Modified files

**`src/bot/actions.ts`**
- In the existing `mark_done` handler: after recording completion + publishing dashboard, call `scheduleVerification(meetingId, userId)`.
- Register two new button action handlers: `verification_nudge_yes` and `verification_nudge_skip` (operator's response to the verification DM).

**`src/services/meeting.ts`**
- Add `getUserById(id: string): Promise<User | null>` — `SELECT * FROM users WHERE id = $1`. Used by `runVerification` to resolve the organizer's internal user UUID into a Slack user ID for DM-posting.

**`src/index.ts`**
- After constructing services, call `configureVerification({ meetingService, confluenceService, relayService, nudgeService })`. Mirrors the existing `configureDashboard(...)` boot wiring.

### No DB changes

No schema migration. No new tables. Verification state lives only in the in-process `Map<string, NodeJS.Timeout>`.

---

## 3. Verification Logic

`runVerification(meetingId, userId)` does the following, all wrapped in a single try/catch that logs `[verification]` errors and never throws:

1. Re-fetch meeting via `meetingService.getById(meetingId)`. If null → silently exit (meeting deleted).
2. Re-fetch participants via `meetingService.getParticipantsWithUsers(meetingId)`, find the row where `user_id === userId`. If not found → silently exit (participant removed).
3. If `meeting.document_action === 'read'` → silently exit (cannot verify).
4. If participant `status !== 'completed'` → silently exit (status changed since timer was scheduled, e.g. via `/ma set-action`).
5. Fetch comments via `confluenceService.getComments(meeting.confluence_page_id)`. Returns `{ authorEmail, ... }[]` (already implemented; used by `/ma check-doc`).
6. Compare emails: `comments.some(c => c.authorEmail?.trim().toLowerCase() === participant.email?.trim().toLowerCase())`. If participant email is empty/falsy, the match always fails — treat as unverified.
7. If a matching comment exists → done, silent.
8. If no match → DM the operator (see Section 4).

### Edge cases handled

| Case | Behavior |
| --- | --- |
| Meeting deleted between click and timer firing | Silent skip |
| Participant removed | Silent skip |
| Action changed to `read` after click | Silent skip (action check at step 3) |
| Participant status reset (e.g. via `/ma set-action`) | Silent skip (status check at step 4) |
| Participant email empty | Match fails, operator gets prompted (visibility benefit) |
| Confluence API throws | Outer try/catch catches, logs `[verification]`, no DM |
| Two `mark_done` clicks within 60s | First timer cancelled; only one verification runs |

### Operator identification

The verification DM goes to the meeting organizer. The chain is:

```
meeting.organizer_user_id (UUID in users table) → users.slack_user_id
```

`MeetingService` does not currently expose a "get user by internal id" method (only `getUserBySlackId`). Add a new method `MeetingService.getUserById(id: string): Promise<User | null>` querying `SELECT * FROM users WHERE id = $1`. Use it in `runVerification` to resolve the organizer's Slack ID before posting the DM.

---

## 4. Operator DM Format & Button Handlers

### Verification DM

When verification fails, post to the operator's IM:

```
Meetassist: <Alice> marked *Take Template Ownership* as done, but I don't see her comment on the doc yet.

Send a follow-up nudge asking her to comment?
[Yes, send nudge]  [Skip]
```

Posted via `app.client.chat.postMessage` with `channel: <operator slack id>` (DM channel auto-resolves) and blocks containing:
- A `section` with the message text (mrkdwn)
- An `actions` block with two `button` elements:
  - `action_id: 'verification_nudge_yes'`, `value: '<meetingId>|<userId>'`, `style: 'primary'`, text "Yes, send nudge"
  - `action_id: 'verification_nudge_skip'`, `value: '<meetingId>|<userId>'`, text "Skip"

The text is humanised:
- `<Alice>` → participant `display_name`
- `*Take Template Ownership*` → meeting `title` (escaped/wrapped in `*…*` for Slack mrkdwn bold)
- `comment` → humanised version of `meeting.document_action`. Reuse the `humaniseAction` function exported from `src/services/dashboard.ts` (already exists, exported, returns labels like "comment", "provide input", "approve").

### Button handlers

Both registered in `src/bot/actions.ts` alongside existing handlers (`mark_done`, `need_clarification`, `cannot_complete`).

**`verification_nudge_yes`** — on click:
1. Parse `value` as `<meetingId>|<userId>`.
2. Fetch meeting, fetch participant.
3. Build the follow-up nudge text. Suggested format:
   ```
   Meetassist: Just checking — your action for *<meeting.title>* was to *<humanised action>*, but I don't see it on the doc yet. Could you take a moment to <action verb>?
   <meeting.document_url>
   ```
   Where `<action verb>` is "comment", "approve", etc. (reuse `ACTION_LABELS`).
4. Send to participant via `relayService.sendToParticipant({ slackUserId, text })`.
5. Record nudge via `nudgeService.recordNudge({ user_id, meeting_id, slack_channel_id, message_ts, type: 'reminder' })`.
6. Increment reminder count via `meetingService.incrementReminderCount(meetingId, userId)`.
7. Update the original operator DM via `respond({ replace_original: true, blocks: [...], text: '...' })` to:
   ```
   ✓ Nudge sent to <Alice>.
   ```
   (Single section block, no buttons.)

**`verification_nudge_skip`** — on click:
1. `respond({ replace_original: true, blocks: [...], text: '...' })` with:
   ```
   Skipped.
   ```
   (Single section block, no buttons.) No DB writes, no DMs.

### Idempotency

Both handlers use `replace_original: true`. If the operator somehow clicks twice (network glitch, etc.), the second click's `respond` either no-ops or re-replaces with the same content — no duplicate nudges, no duplicate DB writes.

### No participant status change

The participant remains `completed`. The follow-up nudge does not reset their status. If the operator wants the participant to redo the action, they can use `/ma set-action <id> <action>` to reset everyone to `pending`.

---

## 5. Module-Level Timer Management

```typescript
const VERIFICATION_DELAY_MS = 60_000;
const pendingVerifications = new Map<string, NodeJS.Timeout>();

export function scheduleVerification(meetingId: string, userId: string): void {
  const key = `${meetingId}:${userId}`;
  const existing = pendingVerifications.get(key);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(async () => {
    pendingVerifications.delete(key);
    await runVerification(meetingId, userId);
  }, VERIFICATION_DELAY_MS);

  pendingVerifications.set(key, handle);
}
```

### Decisions

- **No explicit cancel-on-status-change.** When `/ma set-action` resets a participant from `completed` to `pending`, we don't actively cancel the pending timer. When it fires, `runVerification`'s status check at step 4 catches it and exits silently. Less code, same outcome.
- **No tests for the timer itself.** The mechanics (clear existing, set new, fire callback) are simple. All meaningful behavior lives in `runVerification`, which we test directly.
- **Process restart loses pending timers.** Accepted trade-off (per design discussion). If reliability becomes critical, revisit with a `pending_verifications` DB table.

---

## 6. Testing

### Unit tests (`tests/services/verification.test.ts`)

All target `runVerification` directly with mocked services (no fake timers, no real `setTimeout`):

1. Returns silently if `getById` returns null — assert no DM sent
2. Returns silently if participant not in `getParticipantsWithUsers` result — assert no DM sent
3. Returns silently if `meeting.document_action === 'read'` — assert `getComments` NOT called, no DM sent
4. Returns silently if participant `status !== 'completed'` — assert `getComments` NOT called, no DM sent
5. For `comment` + matching comment by participant email → silent, no DM
6. For `comment` + no comment by participant email → DM sent to organizer with meeting title, participant name, both buttons
7. For `provide_input` + no matching comment → DM sent
8. For `approve` + no matching comment → DM sent
9. Email comparison is case-insensitive: participant `Alice@Example.com`, comment author `alice@example.com` → silent
10. Empty participant email → treated as unverified, DM sent
11. `confluenceService.getComments` throws → caught, logged with `[verification]` prefix, no DM sent (assert `console.error` called)

### Button handler tests

Inline in the same test file, dispatching the action handlers via Bolt's testing patterns (mock `respond`, `client.chat.postMessage`, etc.):

- `verification_nudge_yes` click → `relayService.sendToParticipant` called once with expected text + slackUserId; `nudgeService.recordNudge` called once with `type: 'reminder'`; `incrementReminderCount` called once; `respond` called with `replace_original: true` containing "Nudge sent".
- `verification_nudge_skip` click → `respond` called with `replace_original: true` containing "Skipped"; no relay/nudge/DB writes.

### Manual smoke test

1. Create a meeting with `document_action: comment` (or have one already).
2. `/ma send <id>` to nudge a test participant.
3. As participant, click "Mark done" without commenting on the doc.
4. Wait 60 seconds.
5. Verify operator receives a DM with the verification prompt.
6. Click "Yes, send nudge".
7. Verify participant receives the follow-up DM.
8. Verify the operator's DM is replaced with "✓ Nudge sent to <name>".
9. Repeat with a participant who DID comment on the doc → verify NO DM is sent.
10. Repeat with `document_action: read` → verify NO DM is sent (regardless of doc state).

---

## 7. Out of Scope

- **Persistent verification queue.** Process restart loses pending timers. If reliability becomes a problem, add a `pending_verifications` table.
- **Keyword detection for `approve` / `confirm_decision`.** Currently any comment by the participant counts as verification. Could later require keywords like "approve", "lgtm", "+1".
- **Page edit verification.** We don't check if the participant edited the doc itself, only commented. Could add later via `/content/{pageId}/history?expand=contributors`.
- **Read-action verification.** No Confluence API for view tracking on standard plans. Skipped.
- **Dashboard markers.** No "completed (unverified)" state. The participant remains `completed`; the dashboard does not change.
- **Auto-nudge.** Bot does not send a follow-up nudge automatically. Operator-in-the-loop only.
- **Verification on `cannot_complete`.** Only `mark_done` triggers verification.
- **Continuous sweep.** No periodic background job over all active participants.

---

## 8. Migration & Rollout

- No DB schema changes
- No new env vars
- No external dependencies
- Existing features unaffected — verification is purely additive
- On deploy: bot restarts; any prior in-flight `mark_done` timers from the old process are lost (acceptable)
