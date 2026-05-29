# Confluence Dashboard — Design Spec

**Status:** Design approved 2026-05-29
**Builds on:** `docs/specs/meetassist-v1.md` (Phase 1 system spec)
**Replaces:** `docs/specs/2026-05-28-app-home-tab-design.md` was reverted due to workspace-level Slack scope restrictions on `views:*`. This spec achieves the same "real-time dashboard" goal via Confluence instead.

> **Goal:** Maintain a single Confluence page that always reflects the current state of every active meeting Meetassist tracks. The page is updated automatically after every state mutation, so operators and participants can read the live status without entering Slack.

---

## 1. Overview

A dedicated Confluence page, owned and edited by the bot, serves as a global read-only dashboard. The page lists every active meeting (`status IN ('draft','active')`) regardless of organizer, with a per-participant table showing each participant's status, last-update time (relative), and reply preview if any.

The page is updated by the bot after every state mutation in the system — slash commands, participant button clicks, DM replies, create-wizard finalize. Updates are best-effort and never block or fail the underlying operation.

The page itself is created and configured manually once. Its page ID lives in an env var. The bot only edits the body; it never creates or moves the page.

**Page URL (operator-provided):** `https://emarsys.jira.com/wiki/spaces/~607278290/pages/6460702733/Meetassist+dashboard`

---

## 2. File Structure

### New files

**`src/services/dashboard.ts`** — exports:
- `publishDashboard(): Promise<void>` — fetches active meetings, renders body, updates the page. Wrapped in try/catch internally. Never throws.
- `renderDashboardBody(input: DashboardInput): string` — pure function that produces Confluence storage-format XHTML. Tested in isolation.
- `relativeTime(from: Date, now?: Date): string` — small util ("just now" / "Xm ago" / "Xh ago" / "Xd ago" / "Xw ago"). Tested in isolation.

**`tests/services/dashboard.test.ts`** — unit tests for `renderDashboardBody` (empty + populated), `relativeTime` buckets, `publishDashboard` integration (mocked services).

### Modified files

**`src/services/confluence.ts`**
- Add `getPageVersion(pageId: string): Promise<number>` — fetches the page and returns its current version number.
- Add `updatePage(pageId: string, title: string, body: string): Promise<void>` — PUTs to `/rest/api/content/{pageId}` with version+1 and storage-format body. On 409 conflict, refetches version and retries once.

**`src/services/meeting.ts`**
- Add `listAllActive(): Promise<Meeting[]>` — returns every meeting with `status IN ('draft','active')`, organiser-agnostic. Existing `listActive(operatorUserId)` stays untouched.
- Add `getLatestReply(meetingId: string, userId: string): Promise<string | null>` — returns the most recent `participant_messages.message_text` for that meeting+user, or null. Used for the reply-preview column.

**`src/bot/commands.ts`** — call `publishDashboard()` at the same trigger points the reverted Home tab used (`/ma send`, `/ma remind`, `/ma followup`, `/ma set-action`, create-wizard finalize).

**`src/bot/actions.ts`** — call `publishDashboard()` after `mark_done`, `need_clarification`, `cannot_complete`.

**`src/bot/relay.ts`** — call `publishDashboard()` after the DM relay updates a participant's status.

**`src/index.ts`** — read `MEETASSIST_DASHBOARD_PAGE_ID` from env, pass into a new `registerDashboard(meetingService, confluenceService, pageId)` initializer (or simpler: store on a module-level ref the way `home.ts` did with `meetingServiceRef`).

**`.env.example`** — document the new env var.

---

## 3. Configuration

### New environment variable

```
# Confluence page ID for the global Meetassist dashboard.
# Bot owns the page body and updates it after every state mutation.
MEETASSIST_DASHBOARD_PAGE_ID=6460702733
```

If the env var is unset or blank, `publishDashboard()` returns immediately without doing anything. The bot logs a one-time warning at startup so the operator notices, but the bot continues to function — every other feature works without the dashboard.

### Confluence permissions

The existing `CONFLUENCE_API_TOKEN` and `CONFLUENCE_USER_EMAIL` env vars are reused. The user behind those credentials must have **edit** permission on the dashboard page. If the bot account can edit the page in a browser, the API has the same permission.

---

## 4. Page Body Format

The page body is rendered as Confluence storage format (an XHTML-like dialect). Below is the structure of the rendered output as it appears on the rendered page.

### Header

A short info macro at the top showing the last update time:

```
[Info macro] Last updated: 2026-05-29 10:30 (Europe/Berlin)
```

### Per-meeting block

For each active meeting, in chronological order by `start_time` ASC:

```
## <meeting title>

<weekday> <month> <day> · <HH:MM> · <id-prefix>
Document: <link to document_url> "<document_title>"
Action requested: <humanised document_action>
Progress: <done>/<total> done · <blocked> blocked   (the "blocked" half is omitted when blocked = 0)

| Participant | Status              | Last updated | Reply                          |
| ----------- | ------------------- | ------------ | ------------------------------ |
| @alice      | done                | 2h ago       | approved, looks good           |
| @bob        | nudge sent          | 1d ago       |                                |
| @carol      | clarification asked | 30m ago      | what about the Q2 numbers?     |
```

**Status humanisation** (matches the labels we built in `src/bot/labels.ts` before revert — recreate as a small inline lookup, do not pull `labels.ts` back from git history yet, keep this scoped):

| internal status         | rendered text          |
| ----------------------- | ---------------------- |
| `pending`               | waiting for nudge      |
| `nudge_sent`            | nudge sent             |
| `replied`               | replied                |
| `clarification_needed`  | clarification asked    |
| `blocked`               | blocked                |
| `overdue`               | overdue                |
| `completed`             | done                   |

**Document-action humanisation:**

| internal action       | rendered text     |
| --------------------- | ----------------- |
| `read`                | read              |
| `comment`             | comment           |
| `approve`             | approve           |
| `provide_input`       | provide input     |
| `confirm_decision`    | confirm decision  |

### Empty state

If `listAllActive()` returns no meetings:

```
[Info macro] Last updated: 2026-05-29 10:30 (Europe/Berlin)

No active meetings.
```

### Storage-format implementation notes

- Confluence storage format requires well-formed XHTML. Use entity-encoded `&amp;`, `&lt;`, `&gt;` in any user-supplied text (titles, reply text, document titles).
- Tables use `<table><tbody><tr><th>…</th></tr><tr><td>…</td></tr></tbody></table>`. The first row uses `<th>`.
- Participant mention is rendered as `@<slack_handle>` — plain text, **not** a Confluence user mention macro (the bot doesn't know Confluence user IDs and trying to map Slack→Confluence accounts is out of scope).
- Document link uses `<a href="…">…</a>`.
- Info macro at top uses `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>…</p></ac:rich-text-body></ac:structured-macro>`.

A complete reference snippet of the storage-format output is included at the end of this spec (Appendix A).

---

## 5. Data Sources

### `listAllActive()` — new

```sql
SELECT * FROM meetings
WHERE status IN ('draft', 'active')
ORDER BY start_time ASC
```

Returns every active meeting in the system. No organiser filter.

### Per-meeting participant rows

Existing `meetingService.getParticipantsWithUsers(meeting.id)` already returns rows joining `meeting_participants` and `users`. Each row gives us `slack_user_id`, `slack_handle`, `status`, and `updated_at` (or whatever timestamp column already tracks the last status change — verify in implementation).

### `getLatestReply(meetingId, userId)` — new

```sql
SELECT message_text
FROM participant_messages
WHERE meeting_id = $1 AND user_id = $2
ORDER BY created_at DESC
LIMIT 1
```

Returns the most recent participant DM message text, or null. Used as the "Reply" column. Replies coming from the `cannot_complete` button (which we may add a reason field to later) are out of scope for this spec — reply preview is DM-only for now.

---

## 6. Update Strategy

### Trigger points

`publishDashboard()` is called after every state mutation that affects what the dashboard displays. These are exactly the same trigger points we wired for `publishHomeViews` in the reverted Home tab feature:

| Trigger                                 | Where                |
| --------------------------------------- | -------------------- |
| `/ma send`                              | `src/bot/commands.ts` |
| `/ma remind`                            | `src/bot/commands.ts` |
| `/ma followup`                          | `src/bot/commands.ts` |
| `/ma set-action`                        | `src/bot/commands.ts` |
| `/ma create` wizard → 'participants' step finalize | `src/bot/commands.ts` |
| `mark_done` button                      | `src/bot/actions.ts`  |
| `need_clarification` button             | `src/bot/actions.ts`  |
| `cannot_complete` button                | `src/bot/actions.ts`  |
| Participant DM relay                    | `src/bot/relay.ts`    |

Each trigger calls `publishDashboard()` after the mutation has committed. The call is awaited so failures get logged on the same request, but the call itself never throws.

### `publishDashboard()` flow

1. Read `pageId` from module-level config (set by `registerDashboard` at boot). If empty, return.
2. Try-catch the entire body.
3. Fetch all active meetings via `meetingService.listAllActive()`.
4. For each meeting, fetch participants via `getParticipantsWithUsers`. For each participant with `status = 'replied'` (or any non-pending status where it makes sense), fetch their latest reply via `getLatestReply`.
5. Render body via `renderDashboardBody({ meetings, now: new Date() })`.
6. Call `confluenceService.updatePage(pageId, 'Meetassist dashboard', body)`.
7. On any error in steps 3–6, log and return.

### Concurrency / version conflicts

Confluence's REST API requires a `version.number` on PUT that equals the current version + 1. If two mutations land in quick succession and both try to update the page, the second will get a `409 Conflict`.

**Strategy:** `updatePage` catches 409, refetches the page version once, increments, retries once. If the retry also fails, log the error and give up — the next mutation will trigger another publish, so the page eventually catches up.

### Throttling (out of scope)

At the current scale (single team, < 50 active meetings, mutations bursty but not high-frequency), we do not throttle or batch updates. Every mutation = one Confluence write. If usage grows, revisit with a debounced "publish at most once per N seconds" wrapper.

---

## 7. Error Handling

- `publishDashboard()` catches every error internally, logs to console with the prefix `[dashboard]`, and returns. It never throws.
- `confluenceService.updatePage()` errors propagate up to `publishDashboard()`, which catches them. Distinguish 409 (handled with retry) from other errors (propagate).
- If `MEETASSIST_DASHBOARD_PAGE_ID` is missing at boot, log a single warning and continue. `publishDashboard()` becomes a no-op for that process.
- If the user behind `CONFLUENCE_API_TOKEN` lacks edit permission on the page, `updatePage()` will get a 403. Log and continue. Operator notices the page isn't updating and fixes permissions.

---

## 8. Testing

### Unit tests (`tests/services/dashboard.test.ts`)

- `renderDashboardBody({ meetings: [], now })` → contains "No active meetings"
- `renderDashboardBody` with one meeting + 3 participants → output contains the meeting title (HTML-escaped), participant names, the table headers, and one row per participant
- `renderDashboardBody` HTML-escapes user-supplied text — feed in a meeting title containing `<script>` and assert it does not appear unescaped
- `relativeTime` for various deltas: 30s → "just now", 5m → "5m ago", 90m → "1h ago", 25h → "1d ago", 8d → "1w ago"
- `publishDashboard()` no-op when page ID is empty
- `publishDashboard()` catches and logs `confluenceService.updatePage` errors

### Service tests

- `meetingService.listAllActive` — query verifies `status IN ('draft','active')` and no organiser filter
- `meetingService.getLatestReply` — query verifies `ORDER BY created_at DESC LIMIT 1`
- `confluenceService.updatePage` — mocks `fetch` and asserts the PUT URL, body, and that version is current+1
- `confluenceService.updatePage` — on first 409, refetches version and retries with new version+1; on second 409, throws

### Manual smoke test

1. Add `MEETASSIST_DASHBOARD_PAGE_ID=6460702733` to `.env`
2. Restart bot
3. Trigger `/ma send` on a test meeting
4. Refresh the Confluence page in the browser → see the dashboard rendered with that meeting
5. Reply to the DM as a participant → page updates with status change

---

## 9. Out of Scope

- **Interactivity** — no clickable buttons or links beyond the document URL. The page is a dashboard, not a control surface. Operators still drive the bot from Slack.
- **Per-operator dashboards** — single global dashboard. Splitting per-operator is straightforward later if needed.
- **Historical / completed meetings** — only `draft` and `active`. Confluence page edit history serves as the audit trail.
- **Custom reply truncation** — full reply text is shown, no length cap. If reply text grows long enough to be a problem, revisit.
- **Cannot-complete reasons in the reply column** — only DM replies populate the reply column for now. The `cannot_complete` button does not capture a reason today.
- **Confluence user mention mapping** — participants are shown as `@<slack_handle>` plain text, not as Confluence `<ac:link><ri:user>` mentions.
- **Multiple dashboards** — one page, one env var, one global view.

---

## 10. Migration & Rollout

- No database schema changes
- One new env var: `MEETASSIST_DASHBOARD_PAGE_ID`
- Operator creates the page once (already done — page exists)
- Bot edits page body on next mutation after deploy
- Existing Phase 1 features and slash commands unaffected
- Reverted Home tab code remains in git history at commit `49a7f11`; not restored

---

## Appendix A — storage-format reference output

Example rendered body for one meeting with two participants:

```xml
<ac:structured-macro ac:name="info">
  <ac:rich-text-body>
    <p>Last updated: 2026-05-29 10:30 (Europe/Berlin)</p>
  </ac:rich-text-body>
</ac:structured-macro>

<h2>Take Template Ownership</h2>
<p>Thu Jun 4 · 09:00 · ad2bb88e</p>
<p>Document: <a href="https://emarsys.atlassian.net/wiki/spaces/X/pages/12345/Take+Template+Ownership">Take Template Ownership</a></p>
<p>Action requested: approve</p>
<p>Progress: 1/2 done</p>
<table>
  <tbody>
    <tr>
      <th>Participant</th>
      <th>Status</th>
      <th>Last updated</th>
      <th>Reply</th>
    </tr>
    <tr>
      <td>@alice</td>
      <td>done</td>
      <td>2h ago</td>
      <td>approved, looks good</td>
    </tr>
    <tr>
      <td>@bob</td>
      <td>nudge sent</td>
      <td>1d ago</td>
      <td></td>
    </tr>
  </tbody>
</table>
```

Empty state:

```xml
<ac:structured-macro ac:name="info">
  <ac:rich-text-body>
    <p>Last updated: 2026-05-29 10:30 (Europe/Berlin)</p>
  </ac:rich-text-body>
</ac:structured-macro>

<p><em>No active meetings.</em></p>
```
