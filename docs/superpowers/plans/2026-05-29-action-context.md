# Action Context Note Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the existing `meetings.purpose` field to participants in the pre-meeting nudge, reminder, follow-up, verification follow-up DM, and Confluence dashboard. Make `purpose` editable via `/ma set-action`. Cap new writes at 280 characters.

**Architecture:** No DB changes. The `purpose` column already exists. We thread it into the three nudge templates in `src/services/nudge.ts`, the verification handler in `src/services/verification.ts`, the dashboard renderer in `src/services/dashboard.ts`, and extend `MeetingService.updateAction` to optionally also set `purpose`. The `/ma create` flow gets a length check; `/ma set-action` gets an optional trailing text argument.

**Tech Stack:** TypeScript, Vitest (`npm test -- --run`), `pg` Pool, `@slack/bolt` 4.x. No DB migration. No new env vars.

**Spec:** `docs/superpowers/specs/2026-05-29-action-context-design.md`

---

### Task 1: Extend `MeetingService.updateAction` to optionally update `purpose`

**Files:**
- Modify: `src/services/meeting.ts:69-71`
- Test: `tests/services/meeting.test.ts`

**Why:** The new `/ma set-action <id> <action> [purpose...]` syntax needs an atomic single-statement update of action and (optionally) purpose. The existing two-arg signature stays valid as a no-purpose call.

- [ ] **Step 1: Write the failing tests**

In `tests/services/meeting.test.ts`, append three new tests inside the existing `describe('MeetingService', ...)` block (insert before the final `});` of the `describe`):

```typescript
  it('updateAction without purpose updates only the action column', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    await service.updateAction('m1', 'comment');
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('UPDATE meetings SET document_action');
    expect(call[0]).not.toContain('purpose');
    expect(call[1]).toEqual(['comment', 'm1']);
  });

  it('updateAction with purpose updates both columns in one statement', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    await service.updateAction('m1', 'comment', 'Please review the migration plan');
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('document_action = $1');
    expect(call[0]).toContain('purpose = $2');
    expect(call[1]).toEqual(['comment', 'Please review the migration plan', 'm1']);
  });

  it('updateAction with empty-string purpose still updates the column', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    await service.updateAction('m1', 'comment', '');
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('purpose = $2');
    expect(call[1]).toEqual(['comment', '', 'm1']);
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --run tests/services/meeting.test.ts`
Expected: FAIL — `updateAction` only accepts 2 args, the new tests with 3 args either fail to compile or assert against the wrong query.

- [ ] **Step 3: Update `updateAction` signature and body**

In `src/services/meeting.ts`, replace the existing method (currently lines 69-71):

```typescript
  async updateAction(id: string, action: string): Promise<void> {
    await this.pool.query(`UPDATE meetings SET document_action = $1 WHERE id = $2`, [action, id]);
  }
```

With:

```typescript
  async updateAction(id: string, action: string, purpose?: string): Promise<void> {
    if (purpose === undefined) {
      await this.pool.query(`UPDATE meetings SET document_action = $1 WHERE id = $2`, [action, id]);
    } else {
      await this.pool.query(
        `UPDATE meetings SET document_action = $1, purpose = $2 WHERE id = $3`,
        [action, purpose, id]
      );
    }
  }
```

- [ ] **Step 4: Run tests to verify passing**

Run: `npm test -- --run tests/services/meeting.test.ts`
Expected: PASS — the three new tests plus all existing meeting tests.

- [ ] **Step 5: Run full test suite + build**

Run: `npm test -- --run && npm run build`
Expected: PASS — full suite green, TypeScript clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/meeting.ts tests/services/meeting.test.ts
git commit -m "feat: extend updateAction to optionally update purpose"
```

---

### Task 2: Render `purpose` in the three nudge templates

**Files:**
- Modify: `src/services/nudge.ts:48-102`
- Test: `tests/services/nudge.test.ts` (create — does not exist today)

**Why:** Once participants can read the purpose, all three nudges (pre-meeting, reminder, follow-up) should carry it. Pre-meeting is highest priority; reminder and follow-up come along for free since they share the meeting object.

Note on escaping: Slack's mrkdwn doesn't strictly need `<` and `>` escaped in plain text, but it does for `&` to avoid HTML entity confusion in some clients. The `escapeForSlack` helper in `verification.ts` already does the safe minimum (`& < >`). Task 4 exports it; for this task, since we're touching `nudge.ts` first, inline the same three-character replacement as a private helper. Task 4 will dedupe it.

- [ ] **Step 1: Write the failing tests**

Create `tests/services/nudge.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { NudgeService } from '../../src/services/nudge';
import type { Meeting } from '../../src/types';

const baseMeeting: Meeting = {
  id: 'm1',
  title: 'Q3 Planning',
  start_time: '2026-06-04T09:00:00Z',
  organizer_user_id: 'org',
  purpose: 'Review the proposed roadmap and flag anything blocking your team',
  document_url: 'https://example.atlassian.net/wiki/spaces/X/pages/12345/Page',
  document_title: 'Q3 Roadmap',
  document_action: 'comment',
  confluence_page_id: '12345',
  status: 'draft',
  created_at: '2026-05-29T10:00:00Z',
} as any;

function makePool() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
}

describe('NudgeService.buildPreMeetingMessage', () => {
  it('includes the meeting purpose between intro and requested checklist', () => {
    const service = new NudgeService(makePool());
    const msg = service.buildPreMeetingMessage(baseMeeting);

    expect(msg.text).toContain('Review the proposed roadmap and flag anything blocking your team');
    const introIdx = msg.text.indexOf('needs your async input');
    const purposeIdx = msg.text.indexOf('Review the proposed roadmap');
    const requestedIdx = msg.text.indexOf('Requested:');
    expect(introIdx).toBeGreaterThanOrEqual(0);
    expect(purposeIdx).toBeGreaterThan(introIdx);
    expect(requestedIdx).toBeGreaterThan(purposeIdx);

    const blockText = (msg.blocks[0] as any).text.text;
    expect(blockText).toContain('Review the proposed roadmap');
  });

  it('escapes &, <, > in purpose', () => {
    const service = new NudgeService(makePool());
    const meeting = { ...baseMeeting, purpose: 'A & B <script>' };
    const msg = service.buildPreMeetingMessage(meeting);
    const blockText = (msg.blocks[0] as any).text.text;
    expect(blockText).toContain('A &amp; B &lt;script&gt;');
    expect(blockText).not.toContain('A & B <script>');
  });
});

describe('NudgeService.buildReminderMessage', () => {
  it('includes the meeting purpose', () => {
    const service = new NudgeService(makePool());
    const text = service.buildReminderMessage(baseMeeting);
    expect(text).toContain('Review the proposed roadmap');
  });
});

describe('NudgeService.buildFollowUpMessage', () => {
  it('includes the meeting purpose', () => {
    const service = new NudgeService(makePool());
    const text = service.buildFollowUpMessage(baseMeeting);
    expect(text).toContain('Review the proposed roadmap');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --run tests/services/nudge.test.ts`
Expected: FAIL — purpose text not found in any of the three messages.

- [ ] **Step 3: Add a private `escapeMrkdwn` helper at the top of `nudge.ts`**

In `src/services/nudge.ts`, after the `ACTION_LABELS` constant (currently lines 25-31), add:

```typescript
function escapeMrkdwn(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 4: Update `buildPreMeetingMessage` to splice in purpose**

In `src/services/nudge.ts`, replace lines 48-92 (`buildPreMeetingMessage` method body) with:

```typescript
  buildPreMeetingMessage(meeting: Meeting): SlackMessage {
    const meetingDate = new Date(meeting.start_time);
    const dateStr = meetingDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const timeStr = meetingDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const actionLabel = ACTION_LABELS[meeting.document_action] ?? meeting.document_action;
    const purposeEscaped = escapeMrkdwn(meeting.purpose);

    const text = `Meetassist: ${meeting.title} needs your async input before ${dateStr} ${timeStr}.\n\n${meeting.purpose}\n\nRequested:\n☐ ${actionLabel}\n☐ Confirm when done\n\nDocument: ${meeting.document_title}\n${meeting.document_url}`;

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Meetassist:* ${meeting.title} needs your async input before *${dateStr} ${timeStr}*.\n\n${purposeEscaped}\n\nRequested:\n☐ ${actionLabel}\n☐ Confirm when done\n\n*Document:* <${meeting.document_url}|${meeting.document_title}>`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Mark done' },
            action_id: 'mark_done',
            style: 'primary',
            value: meeting.id,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Need clarification' },
            action_id: 'need_clarification',
            value: meeting.id,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Cannot complete' },
            action_id: 'cannot_complete',
            style: 'danger',
            value: meeting.id,
          },
        ],
      },
    ];

    return { text, blocks };
  }
```

(The only changes vs. the original: a `purposeEscaped` local, an extra `\n\n${meeting.purpose}` in the `text` after the intro, and `\n\n${purposeEscaped}` in the block mrkdwn after the intro.)

- [ ] **Step 5: Update `buildReminderMessage` and `buildFollowUpMessage`**

Replace lines 94-102 (the two methods) with:

```typescript
  buildReminderMessage(meeting: Meeting): string {
    const actionLabel = ACTION_LABELS[meeting.document_action] ?? meeting.document_action;
    return `Meetassist reminder: ${meeting.title} is coming up. Please ${actionLabel.toLowerCase()} and confirm.\n\n${meeting.purpose}\n\nDocument: ${meeting.document_title}\n${meeting.document_url}`;
  }

  buildFollowUpMessage(meeting: Meeting): string {
    const actionLabel = ACTION_LABELS[meeting.document_action] ?? meeting.document_action;
    return `Meetassist follow-up: ${meeting.title} has passed. Your action is still open: ${actionLabel.toLowerCase()}.\n\n${meeting.purpose}\n\nDocument: ${meeting.document_title}\n${meeting.document_url}`;
  }
```

(Reminder and follow-up are plain `text` strings, not Slack blocks, so they don't need mrkdwn escaping. Slack will render them as plain text; `<` and `>` won't render as tags.)

- [ ] **Step 6: Run tests to verify passing**

Run: `npm test -- --run tests/services/nudge.test.ts`
Expected: PASS — all 4 tests in this file.

- [ ] **Step 7: Run full suite + build**

Run: `npm test -- --run && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/nudge.ts tests/services/nudge.test.ts
git commit -m "feat: include meeting purpose in pre-meeting nudge, reminder, and follow-up"
```

---

### Task 3: Render `purpose` in the verification follow-up nudge

**Files:**
- Modify: `src/services/verification.ts` (`handleVerificationNudgeYes` body)
- Modify: `tests/services/verification.test.ts` (extend the existing button handler tests)

**Why:** When the operator clicks "Yes, send nudge" on the verification DM, the participant gets a follow-up DM. That DM should remind them what the ask actually was.

- [ ] **Step 1: Write the failing test**

In `tests/services/verification.test.ts`, find the `describe('verification button handlers', ...)` block (added in the previous feature). Append a new test inside it, before the closing `});`:

```typescript
  it('handleVerificationNudgeYes includes meeting purpose in the follow-up DM', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const meetingWithPurpose = {
      ...baseMeeting,
      purpose: 'Review the proposed roadmap before Friday',
    };
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(meetingWithPurpose),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
      },
    });
    configureVerification(deps as any);

    await handleVerificationNudgeYes('m1|u1', respond);

    const sendArgs = deps.relayService.sendToParticipant.mock.calls[0][0];
    expect(sendArgs.text).toContain('The ask was: Review the proposed roadmap before Friday');
  });
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- --run tests/services/verification.test.ts`
Expected: FAIL — current handler text does not include "The ask was:".

- [ ] **Step 3: Update `handleVerificationNudgeYes` body**

In `src/services/verification.ts`, find the `handleVerificationNudgeYes` function. Locate the lines that build the `text` constant — currently:

```typescript
    const actionLabel = humaniseActionForDm(meeting.document_action);
    const text =
      `Meetassist: Just checking — your action for *${escapeForSlack(meeting.title)}* was to ${actionLabel}, ` +
      `but I don't see it on the doc yet. Could you take a moment to follow up?\n${meeting.document_url}`;
```

Replace those four lines with:

```typescript
    const actionLabel = humaniseActionForDm(meeting.document_action);
    const text =
      `Meetassist: Just checking — your action for *${escapeForSlack(meeting.title)}* was to ${actionLabel}, ` +
      `but I don't see it on the doc yet. Could you take a moment to follow up?\n\n` +
      `The ask was: ${escapeForSlack(meeting.purpose)}\n\n` +
      `${meeting.document_url}`;
```

- [ ] **Step 4: Run test to verify passing**

Run: `npm test -- --run tests/services/verification.test.ts`
Expected: PASS — the new test plus all existing verification tests (existing tests pass mocks with `purpose` undefined, but `escapeForSlack` already handles `null`/`undefined` via its `?? ''` fallback, so they'll render `The ask was: ` with a blank value but won't crash).

If existing tests fail because they assert exact text, update their expectations: `baseMeeting` in those describes should add `purpose: 'Take Template Ownership'` or similar. Check `runVerification — comment check` describe in particular — its `baseMeeting` constant.

- [ ] **Step 5: Add `purpose` to existing test fixtures if needed**

If Step 4 surfaced any failing tests, add `purpose: 'some purpose'` to the relevant `baseMeeting` fixtures in `tests/services/verification.test.ts`. Don't loosen any other assertions.

- [ ] **Step 6: Run full suite + build**

Run: `npm test -- --run && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/verification.ts tests/services/verification.test.ts
git commit -m "feat: include purpose in verification follow-up nudge"
```

---

### Task 4: Export `escapeForSlack` from `verification.ts` and dedupe in `nudge.ts`

**Files:**
- Modify: `src/services/verification.ts` (export `escapeForSlack`)
- Modify: `src/services/nudge.ts` (import and use `escapeForSlack`, remove local `escapeMrkdwn`)

**Why:** Two functions doing the same three-character escape is a clear DRY violation. We added `escapeMrkdwn` in `nudge.ts` (Task 2) only because `escapeForSlack` was private. Now we centralize.

- [ ] **Step 1: Export `escapeForSlack` from `verification.ts`**

In `src/services/verification.ts`, find the `escapeForSlack` function (currently `function escapeForSlack(...)` near the bottom). Change to `export function escapeForSlack(...)`. No other change.

- [ ] **Step 2: Replace the local helper in `nudge.ts`**

In `src/services/nudge.ts`:

1. Remove the `escapeMrkdwn` function added in Task 2.
2. Add import at the top: `import { escapeForSlack } from './verification';`
3. Replace the single call site `escapeMrkdwn(meeting.purpose)` with `escapeForSlack(meeting.purpose)`.

- [ ] **Step 3: Run full test suite + build**

Run: `npm test -- --run && npm run build`
Expected: PASS — no behavioural change; the two helpers were identical.

- [ ] **Step 4: Commit**

```bash
git add src/services/verification.ts src/services/nudge.ts
git commit -m "refactor: dedupe Slack escape helper between nudge and verification"
```

---

### Task 5: Render `Purpose` line on the Confluence dashboard

**Files:**
- Modify: `src/services/dashboard.ts:56-148`
- Modify: `tests/services/dashboard.test.ts`

**Why:** Operators need to see at a glance what the ask is for each active meeting. Putting it on the dashboard means they can reuse it as a reference when chasing replies, and it's the same source of truth participants are seeing.

- [ ] **Step 1: Write the failing tests**

In `tests/services/dashboard.test.ts`, find the `describe('renderDashboardBody — populated', ...)` block. The existing `meeting` fixture (around line 88) lacks a `purpose` field. Add `purpose: 'Decide on the new template format'` to that fixture.

Then append a new test inside the same describe block, before its closing `});`:

```typescript
  it('renders the meeting purpose between action and progress lines', () => {
    const body = renderDashboardBody({ meetings: [meeting], now });

    expect(body).toContain('Purpose: Decide on the new template format');
    const actionIdx = body.indexOf('Action requested:');
    const purposeIdx = body.indexOf('Purpose:');
    const progressIdx = body.indexOf('Progress:');
    expect(actionIdx).toBeGreaterThanOrEqual(0);
    expect(purposeIdx).toBeGreaterThan(actionIdx);
    expect(progressIdx).toBeGreaterThan(purposeIdx);
  });

  it('truncates long purpose text to 200 chars with ellipsis on the dashboard', () => {
    const longPurpose = 'A'.repeat(250);
    const m = { ...meeting, purpose: longPurpose };
    const body = renderDashboardBody({ meetings: [m], now });
    const expected = 'A'.repeat(199) + '…';
    expect(body).toContain(`Purpose: ${expected}`);
    expect(body).not.toContain('A'.repeat(250));
  });

  it('escapes special chars in purpose', () => {
    const m = { ...meeting, purpose: 'A & B <c>' };
    const body = renderDashboardBody({ meetings: [m], now });
    expect(body).toContain('Purpose: A &amp; B &lt;c&gt;');
    expect(body).not.toContain('A & B <c>');
  });
```

- [ ] **Step 2: Update `publishDashboard` test to include purpose**

In the same file, find the `describe('publishDashboard', ...)` block. The `meeting` constant inside the second `it` (around line 191) is missing `purpose`. Add `purpose: 'do the thing'` to that fixture so the test continues to pass after the type widens.

- [ ] **Step 3: Run tests to verify failure**

Run: `npm test -- --run tests/services/dashboard.test.ts`
Expected: FAIL on the three new assertions.

- [ ] **Step 4: Add `purpose` to `DashboardMeeting` interface**

In `src/services/dashboard.ts:56-64`, replace the `DashboardMeeting` interface to include a `purpose` field:

```typescript
export interface DashboardMeeting {
  id: string;
  title: string;
  start_time: string;
  document_url: string;
  document_title: string;
  document_action: DocumentAction;
  purpose: string;
  participants: DashboardParticipant[];
}
```

- [ ] **Step 5: Update `renderMeeting` to render the Purpose line**

In `src/services/dashboard.ts`, find the `renderMeeting` function (around lines 100-140). Add a truncate helper at module scope (anywhere above `renderMeeting`):

```typescript
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
```

Then in `renderMeeting`, locate the array of strings returned from the `return [...]` block. Currently it includes:

```typescript
    `<p>Action requested: ${escapeXml(humaniseAction(m.document_action))}</p>`,
    `<p>${escapeXml(progress)}</p>`,
```

Insert one new line between them:

```typescript
    `<p>Action requested: ${escapeXml(humaniseAction(m.document_action))}</p>`,
    `<p>Purpose: ${escapeXml(truncate(m.purpose, 200))}</p>`,
    `<p>${escapeXml(progress)}</p>`,
```

- [ ] **Step 6: Update `publishDashboard` to populate `purpose`**

In `src/services/dashboard.ts:184-193`, the `dashboardMeetings.push({...})` call lists all the fields copied from `m`. Add `purpose: m.purpose` to that object literal.

- [ ] **Step 7: Run tests to verify passing**

Run: `npm test -- --run tests/services/dashboard.test.ts`
Expected: PASS — three new tests plus all existing.

- [ ] **Step 8: Run full suite + build**

Run: `npm test -- --run && npm run build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/services/dashboard.ts tests/services/dashboard.test.ts
git commit -m "feat: show meeting purpose on Confluence dashboard"
```

---

### Task 6: Length-validate `purpose` in `/ma create` and reword the prompt

**Files:**
- Modify: `src/bot/commands.ts:355-360` (the `purpose` step in the create flow)

**Why:** Spec says cap at 280 chars and reword the prompt so operators know participants will read it.

- [ ] **Step 1: Update the `start_time` step's "next prompt" wording**

In `src/bot/commands.ts:355-358`, the `start_time` case currently reads:

```typescript
      case 'start_time':
        session.start_time = text;
        session.step = 'purpose';
        await say('What is the meeting purpose?');
        break;
```

Replace the `say` line with:

```typescript
        await say('What\'s the ask for participants? They\'ll see this in their nudge. (Max 280 chars.)');
```

- [ ] **Step 2: Add length validation to the `purpose` step**

In `src/bot/commands.ts:360-364`, the `purpose` case currently reads:

```typescript
      case 'purpose':
        session.purpose = text;
        session.step = 'document_url';
        await say('Paste the Confluence page URL:');
        break;
```

Replace with:

```typescript
      case 'purpose':
        if (text.length > 280) {
          await say(`Meetassist: That's longer than 280 characters (you wrote ${text.length}). Please shorten and try again.`);
          return;
        }
        session.purpose = text;
        session.step = 'document_url';
        await say('Paste the Confluence page URL:');
        break;
```

- [ ] **Step 3: Build to verify TypeScript types**

Run: `npm run build`
Expected: PASS — clean build.

- [ ] **Step 4: Run full test suite**

Run: `npm test -- --run`
Expected: PASS — full suite green. (No test file exists for the create-flow conversation handler in `commands.ts`; the end-to-end behaviour is covered by manual smoke testing.)

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands.ts
git commit -m "feat: validate purpose length in /ma create and reword prompt"
```

---

### Task 7: Extend `/ma set-action` to accept optional trailing purpose text

**Files:**
- Modify: `src/bot/commands.ts:226-246` (the `set-action` case)

**Why:** Today `/ma set-action <id> <action>` only updates the action. Spec says we should accept everything after token 2 as the new purpose, with an empty trailing text meaning "keep current purpose".

- [ ] **Step 1: Replace the `set-action` case body**

In `src/bot/commands.ts:226-246`, the `set-action` case currently reads:

```typescript
      case 'set-action': {
        const meetingId = await resolveMeetingId(parts[1], command.user_id, meetingService);
        if (!meetingId) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: Meeting not found.' });
          return;
        }
        const validActions = ['read', 'comment', 'approve', 'provide_input', 'confirm_decision'];
        const newAction = parts[2];
        if (!newAction || !validActions.includes(newAction)) {
          await respond({ response_type: 'ephemeral', text: `Usage: \`/ma set-action <id> <action>\`\nValid actions: ${validActions.join(', ')}` });
          return;
        }
        await meetingService.updateAction(meetingId, newAction);
        const participants = await meetingService.getParticipantsWithUsers(meetingId);
        for (const p of participants) {
          await meetingService.updateParticipantStatus(meetingId, p.user_id, 'pending');
        }
        await publishDashboard();
        await respond({ response_type: 'ephemeral', text: `Meetassist: Action updated to \`${newAction}\`. All participants reset to pending. Use \`/ma send ${parts[1]}\` to send the new nudge.` });
        break;
      }
```

Replace the entire case body with:

```typescript
      case 'set-action': {
        const meetingId = await resolveMeetingId(parts[1], command.user_id, meetingService);
        if (!meetingId) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: Meeting not found.' });
          return;
        }
        const validActions = ['read', 'comment', 'approve', 'provide_input', 'confirm_decision'];
        const newAction = parts[2];
        if (!newAction || !validActions.includes(newAction)) {
          await respond({ response_type: 'ephemeral', text: `Usage: \`/ma set-action <id> <action> [purpose...]\`\nValid actions: ${validActions.join(', ')}` });
          return;
        }
        const trailingPurpose = parts.slice(3).join(' ').trim();
        if (trailingPurpose.length > 280) {
          await respond({ response_type: 'ephemeral', text: `Meetassist: Purpose is longer than 280 characters (you wrote ${trailingPurpose.length}). Action not updated.` });
          return;
        }
        const purposeArg = trailingPurpose === '' ? undefined : trailingPurpose;
        await meetingService.updateAction(meetingId, newAction, purposeArg);
        const participants = await meetingService.getParticipantsWithUsers(meetingId);
        for (const p of participants) {
          await meetingService.updateParticipantStatus(meetingId, p.user_id, 'pending');
        }
        await publishDashboard();
        const purposeNote = purposeArg
          ? ` Purpose: "${purposeArg}".`
          : ' Purpose unchanged.';
        await respond({ response_type: 'ephemeral', text: `Meetassist: Action updated to \`${newAction}\`.${purposeNote} All participants reset to pending. Use \`/ma send ${parts[1]}\` to send the new nudge.` });
        break;
      }
```

- [ ] **Step 2: Build to verify TypeScript types**

Run: `npm run build`
Expected: PASS — clean build (the new `purposeArg: string | undefined` matches `updateAction`'s new signature from Task 1).

- [ ] **Step 3: Run full test suite**

Run: `npm test -- --run`
Expected: PASS.

- [ ] **Step 4: Update the `/ma help` text if it lists `set-action`**

In `src/bot/commands.ts:328`, the help text currently reads:

```typescript
'`/ma set-action [id] <action>` — change required action and re-open for nudging',
```

Update to:

```typescript
'`/ma set-action [id] <action> [purpose...]` — change action (and optionally purpose) and re-open for nudging',
```

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands.ts
git commit -m "feat: /ma set-action accepts optional trailing purpose text"
```

---

### Task 8: Final integration check + push + manual smoke

**Files:** None — verification step.

**Why:** Confirm full suite + build + nothing left uncommitted before deploy. Then a manual smoke through Slack to verify what participants actually see.

- [ ] **Step 1: Run full test suite**

Run: `npm test -- --run`
Expected: PASS — all tests green.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS — clean TypeScript build.

- [ ] **Step 3: Verify no leftover changes**

Run: `git status`
Expected: working tree clean.

- [ ] **Step 4: Spot-check existing `purpose` values before deploy**

Run a database query to see what existing meetings will start showing in nudges:

```sql
SELECT id, title, purpose FROM meetings WHERE status != 'archived' ORDER BY created_at DESC LIMIT 20;
```

If any look like operator-internal jargon or placeholders, ask the operator whether to clean them up before pushing. (`UPDATE meetings SET purpose = '...' WHERE id = '...'` is fine; the column has no constraint beyond NOT NULL.)

- [ ] **Step 5: Push to origin**

Run: `git push`
Expected: pushes new commits to `origin/main`. Railway redeploys automatically.

- [ ] **Step 6: Manual smoke test (after Railway redeploy completes)**

1. `/ma create` and step through the prompts. When asked about the ask, type something natural like *"Decide whether to adopt the new template format and flag any concerns"*.
2. Try entering a 300-character purpose first to confirm the length error fires and re-prompts.
3. After meeting creation, `/ma send <id>` to a test participant.
4. Confirm the participant DM contains the purpose as a paragraph between the intro and the requested checklist.
5. Confirm the Confluence dashboard shows `Purpose: <text>` under the meeting heading.
6. `/ma set-action <id> approve` (no trailing text) → confirmation says "Purpose unchanged"; dashboard purpose unchanged.
7. `/ma set-action <id> approve New ask: please review the security implications` → confirmation says `Purpose: "New ask: ..."`; dashboard updates; all participants are reset to pending.
8. `/ma send <id>` again → participant DM shows the new purpose.
9. As the participant, click "Mark done" without commenting on the doc.
10. Wait 60 seconds. Operator receives the verification DM.
11. Click "Yes, send nudge" → participant DM contains `The ask was: New ask: please review the security implications`.

---

## Self-Review Notes

**Spec coverage:**
- §2 No DB migration → confirmed; no schema task.
- §3 `/ma create` length validation + reworded prompt → Task 6.
- §3 `/ma set-action` trailing text + 280-char cap → Task 7.
- §3 Confirmation message variants ("Purpose: ..." / "Purpose unchanged.") → Task 7.
- §4 Pre-meeting nudge purpose insertion → Task 2.
- §4 Reminder + follow-up purpose insertion → Task 2.
- §4 Verification follow-up "The ask was: ..." → Task 3.
- §4 Escaping → Task 2 + Task 4 (dedupe).
- §5 Dashboard `Purpose:` line, 200-char truncation, escaping → Task 5.
- §6 `MeetingService.updateAction` new signature → Task 1.
- §7 Test plan covers updateAction (Task 1), nudge (Task 2), verification (Task 3), dashboard (Task 5).
- §9 Spot-check existing rows → Task 8 step 4.

**Type/name consistency:**
- `updateAction(id, action, purpose?)` signature consistent across Task 1 (definition), Task 7 (call site).
- `escapeForSlack` is private in Task 2 and 3, exported in Task 4. The transitional `escapeMrkdwn` in Task 2 is removed in Task 4.
- `DashboardMeeting.purpose: string` consistent in Task 5.

**No placeholders:** every step has concrete code, file paths, run commands, and expected output.

**Order check:** Task 4 deliberately runs after Tasks 2 and 3. The transitional `escapeMrkdwn` in `nudge.ts` keeps Task 2 self-contained (you can run, test, and ship Task 2 alone). Task 4 is pure refactor with no behaviour change.
