# App Home Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Slack App Home tab serving operators a meeting dashboard and participants their open action items, refreshed in real time as state changes.

**Architecture:** All Home tab logic lives in a new `src/bot/home.ts` module exporting `registerHome()` and `publishHomeView()`. The module subscribes to `app_home_opened`, builds Block Kit views per role, and registers Home-specific button/modal handlers. Existing modules call `publishHomeView()` after every state mutation so the tab stays current. A new `MeetingService.listOpenForParticipant()` method serves the participant view's data needs.

**Tech Stack:** TypeScript, `@slack/bolt` v4, PostgreSQL via `pg`, Block Kit views (`app.client.views.publish`, `views.open`, `view_submission` events), `vitest` for tests.

---

## Pre-flight: Verify environment

Before starting, the engineer should ensure:

```bash
cd /Users/i525473/ClaudeCode/slackbot
npm install
npm test
```

All existing tests must pass (currently 11 tests across `tests/services/` and `tests/db/`). If any fail, stop and investigate before starting tasks.

---

## Task 1: Add `listOpenForParticipant` query to MeetingService

**Files:**
- Modify: `src/services/meeting.ts` — add new method
- Modify: `src/types.ts` — add return type
- Test: `tests/services/meeting.test.ts` — add tests

- [ ] **Step 1: Write the failing test**

Append to `tests/services/meeting.test.ts` inside the existing `describe('MeetingService', ...)` block:

```typescript
  it('listOpenForParticipant returns meetings joined with participant status', async () => {
    const rows = [
      { id: 'mtg-1', title: 'Roadmap', participant_status: 'nudge_sent', start_time: '2026-06-01T09:00:00Z' },
      { id: 'mtg-2', title: 'Review', participant_status: 'pending', start_time: '2026-06-02T09:00:00Z' },
    ];
    const pool = makePool(rows);
    const service = new MeetingService(pool);

    const result = await service.listOpenForParticipant('user-1');
    expect(result).toHaveLength(2);
    expect(result[0].participant_status).toBe('nudge_sent');

    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('meeting_participants');
    expect(sql).toContain("status != 'completed'");
    expect(sql).toContain("status IN ('draft','active')");
    expect(pool.query.mock.calls[0][1]).toEqual(['user-1']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/services/meeting.test.ts`
Expected: FAIL with "service.listOpenForParticipant is not a function"

- [ ] **Step 3: Add return type to `src/types.ts`**

Append to `src/types.ts`:

```typescript
export interface MeetingWithParticipantStatus extends Meeting {
  participant_status: ParticipantStatus;
}
```

- [ ] **Step 4: Add the method to `src/services/meeting.ts`**

Add to the `MeetingService` class (place after `getMeetingForParticipant`, before `recordDocCheck`):

```typescript
  async listOpenForParticipant(userId: string): Promise<MeetingWithParticipantStatus[]> {
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

Update the import at the top of the file:

```typescript
import type { Meeting, MeetingParticipant, User, DocumentAction, ParticipantRole, ParticipantStatus, MeetingWithParticipantStatus } from '../types';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/services/meeting.test.ts`
Expected: PASS — all MeetingService tests green

- [ ] **Step 6: Commit**

```bash
git add src/services/meeting.ts src/types.ts tests/services/meeting.test.ts
git commit -m "feat: add listOpenForParticipant to MeetingService"
```

---

## Task 2: Create operator role helper

**Files:**
- Create: `src/bot/roles.ts` — operator detection helper
- Test: `tests/bot/roles.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/bot/roles.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isOperator, getOperatorIds } from '../../src/bot/roles';

describe('roles', () => {
  const original = process.env.OPERATOR_SLACK_IDS;
  afterEach(() => {
    process.env.OPERATOR_SLACK_IDS = original;
  });

  it('isOperator returns true for ID in OPERATOR_SLACK_IDS', () => {
    process.env.OPERATOR_SLACK_IDS = 'U001,U002,U003';
    expect(isOperator('U002')).toBe(true);
  });

  it('isOperator returns false for ID not in OPERATOR_SLACK_IDS', () => {
    process.env.OPERATOR_SLACK_IDS = 'U001,U002';
    expect(isOperator('U999')).toBe(false);
  });

  it('isOperator handles whitespace in env var', () => {
    process.env.OPERATOR_SLACK_IDS = ' U001 , U002 , U003 ';
    expect(isOperator('U002')).toBe(true);
  });

  it('isOperator handles empty env var', () => {
    process.env.OPERATOR_SLACK_IDS = '';
    expect(isOperator('U001')).toBe(false);
  });

  it('getOperatorIds returns trimmed array', () => {
    process.env.OPERATOR_SLACK_IDS = 'U001, U002 ,U003';
    expect(getOperatorIds()).toEqual(['U001', 'U002', 'U003']);
  });

  it('getOperatorIds falls back to OPERATOR_SLACK_ID', () => {
    process.env.OPERATOR_SLACK_IDS = '';
    process.env.OPERATOR_SLACK_ID = 'U_LEGACY';
    expect(getOperatorIds()).toEqual(['U_LEGACY']);
    delete process.env.OPERATOR_SLACK_ID;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/bot/roles.test.ts`
Expected: FAIL with "Cannot find module '../../src/bot/roles'"

- [ ] **Step 3: Create `src/bot/roles.ts`**

```typescript
export function getOperatorIds(): string[] {
  const raw = process.env.OPERATOR_SLACK_IDS ?? process.env.OPERATOR_SLACK_ID ?? '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function isOperator(slackUserId: string): boolean {
  return getOperatorIds().includes(slackUserId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/bot/roles.test.ts`
Expected: PASS — 6 tests green

- [ ] **Step 5: Commit**

```bash
git add src/bot/roles.ts tests/bot/roles.test.ts
git commit -m "feat: add operator role detection helper"
```

---

## Task 3: Add humanised status labels and action labels

**Files:**
- Create: `src/bot/labels.ts` — humanisation helpers
- Test: `tests/bot/labels.test.ts`

These labels are referenced by both view builders (operator and participant), so they get their own module to keep the home view builder lean.

- [ ] **Step 1: Write the failing test**

Create `tests/bot/labels.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { humaniseParticipantStatus, humaniseDocumentAction } from '../../src/bot/labels';

describe('labels', () => {
  it('humaniseParticipantStatus returns expected label for each status', () => {
    expect(humaniseParticipantStatus('pending')).toBe('waiting for nudge');
    expect(humaniseParticipantStatus('nudge_sent')).toBe('nudge sent');
    expect(humaniseParticipantStatus('replied')).toBe('you replied — awaiting follow-up');
    expect(humaniseParticipantStatus('clarification_needed')).toBe('clarification requested');
    expect(humaniseParticipantStatus('blocked')).toBe('marked as blocked');
    expect(humaniseParticipantStatus('overdue')).toBe('overdue');
    expect(humaniseParticipantStatus('completed')).toBe('completed');
  });

  it('humaniseDocumentAction returns expected label for each action', () => {
    expect(humaniseDocumentAction('read')).toBe('Read the document');
    expect(humaniseDocumentAction('comment')).toBe('Add a comment or mark no concerns');
    expect(humaniseDocumentAction('approve')).toBe('Approve the document');
    expect(humaniseDocumentAction('provide_input')).toBe('Provide your input');
    expect(humaniseDocumentAction('confirm_decision')).toBe('Confirm the decision');
  });

  it('humaniseDocumentAction falls back to the raw value for unknown action', () => {
    expect(humaniseDocumentAction('unknown_action' as any)).toBe('unknown_action');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/bot/labels.test.ts`
Expected: FAIL with "Cannot find module '../../src/bot/labels'"

- [ ] **Step 3: Create `src/bot/labels.ts`**

```typescript
import type { ParticipantStatus, DocumentAction } from '../types';

const PARTICIPANT_STATUS_LABELS: Record<ParticipantStatus, string> = {
  pending: 'waiting for nudge',
  nudge_sent: 'nudge sent',
  replied: 'you replied — awaiting follow-up',
  clarification_needed: 'clarification requested',
  blocked: 'marked as blocked',
  overdue: 'overdue',
  completed: 'completed',
};

const DOCUMENT_ACTION_LABELS: Record<DocumentAction, string> = {
  read: 'Read the document',
  comment: 'Add a comment or mark no concerns',
  approve: 'Approve the document',
  provide_input: 'Provide your input',
  confirm_decision: 'Confirm the decision',
};

export function humaniseParticipantStatus(status: ParticipantStatus): string {
  return PARTICIPANT_STATUS_LABELS[status] ?? status;
}

export function humaniseDocumentAction(action: DocumentAction): string {
  return DOCUMENT_ACTION_LABELS[action] ?? action;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/bot/labels.test.ts`
Expected: PASS — 3 tests green

- [ ] **Step 5: Commit**

```bash
git add src/bot/labels.ts tests/bot/labels.test.ts
git commit -m "feat: add humanised status and action labels"
```

---

## Task 4: Build operator Home view (empty state)

**Files:**
- Create: `src/bot/home-views.ts` — pure view builder functions
- Test: `tests/bot/home-views.test.ts`

Pure functions that take data and return Block Kit JSON. No Slack client calls. This separation makes the views easy to test.

- [ ] **Step 1: Write the failing test**

Create `tests/bot/home-views.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildOperatorView } from '../../src/bot/home-views';

describe('buildOperatorView', () => {
  it('returns empty state when no meetings', () => {
    const view = buildOperatorView({ meetings: [] });

    expect(view.type).toBe('home');
    expect(view.blocks).toBeDefined();

    const headerBlock = view.blocks.find((b: any) => b.type === 'header');
    expect(headerBlock).toBeDefined();
    expect((headerBlock as any).text.text).toBe('Meetassist');

    const sectionTexts = view.blocks
      .filter((b: any) => b.type === 'section')
      .map((b: any) => b.text?.text ?? '');
    expect(sectionTexts.some((t) => t.includes('No active meetings'))).toBe(true);

    const actions = view.blocks.find((b: any) => b.type === 'actions');
    expect(actions).toBeDefined();
    const button = (actions as any).elements[0];
    expect(button.action_id).toBe('home_create_meeting');
    expect(button.text.text).toContain('Create meeting');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/bot/home-views.test.ts`
Expected: FAIL with "Cannot find module '../../src/bot/home-views'"

- [ ] **Step 3: Create `src/bot/home-views.ts`**

```typescript
import type { Meeting, MeetingParticipant, User, MeetingWithParticipantStatus } from '../types';
import { humaniseParticipantStatus, humaniseDocumentAction } from './labels';

interface OperatorMeetingSummary {
  meeting: Meeting;
  participants: (MeetingParticipant & User)[];
}

interface OperatorViewInput {
  meetings: OperatorMeetingSummary[];
}

interface ParticipantViewInput {
  meetings: MeetingWithParticipantStatus[];
}

export interface SlackHomeView {
  type: 'home';
  blocks: any[];
}

export function buildOperatorView(input: OperatorViewInput): SlackHomeView {
  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Meetassist' } },
  ];

  if (input.meetings.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'No active meetings yet. Create your first one to get started.' },
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '+ Create meeting' },
          action_id: 'home_create_meeting',
          style: 'primary',
        },
      ],
    });
    return { type: 'home', blocks };
  }

  // (multi-meeting branch — added in Task 5)
  return { type: 'home', blocks };
}

export function buildParticipantView(_input: ParticipantViewInput): SlackHomeView {
  // Implemented in Task 6
  return { type: 'home', blocks: [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/bot/home-views.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bot/home-views.ts tests/bot/home-views.test.ts
git commit -m "feat: build operator Home view empty state"
```

---

## Task 5: Build operator Home view (meetings populated)

**Files:**
- Modify: `src/bot/home-views.ts`
- Modify: `tests/bot/home-views.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/bot/home-views.test.ts` inside the existing `describe('buildOperatorView', ...)`:

```typescript
  it('returns one card per meeting with progress and 6 action buttons', () => {
    const meeting1 = {
      id: 'mtg-aaaaaaaaaaa1', title: 'Roadmap', start_time: '2026-06-01T09:00:00Z',
      organizer_user_id: 'op1', purpose: 'p', document_url: 'https://x/wiki/spaces/A/pages/1/r',
      document_title: 'Doc1', document_action: 'comment' as const, confluence_page_id: '1',
      status: 'active' as const, created_at: '',
    };
    const meeting2 = { ...meeting1, id: 'mtg-bbbbbbbbbbb2', title: 'Review', document_action: 'read' as const };

    const view = buildOperatorView({
      meetings: [
        {
          meeting: meeting1,
          participants: [
            { meeting_id: 'mtg-aaaaaaaaaaa1', user_id: 'u1', role: 'participant', status: 'completed', reminder_count: 0, completed_at: null, slack_user_id: 'U1', display_name: 'A', email: 'a@x', id: 'u1' } as any,
            { meeting_id: 'mtg-aaaaaaaaaaa1', user_id: 'u2', role: 'participant', status: 'completed', reminder_count: 0, completed_at: null, slack_user_id: 'U2', display_name: 'B', email: 'b@x', id: 'u2' } as any,
            { meeting_id: 'mtg-aaaaaaaaaaa1', user_id: 'u3', role: 'participant', status: 'completed', reminder_count: 0, completed_at: null, slack_user_id: 'U3', display_name: 'C', email: 'c@x', id: 'u3' } as any,
            { meeting_id: 'mtg-aaaaaaaaaaa1', user_id: 'u4', role: 'participant', status: 'pending', reminder_count: 0, completed_at: null, slack_user_id: 'U4', display_name: 'D', email: 'd@x', id: 'u4' } as any,
            { meeting_id: 'mtg-aaaaaaaaaaa1', user_id: 'u5', role: 'participant', status: 'blocked', reminder_count: 0, completed_at: null, slack_user_id: 'U5', display_name: 'E', email: 'e@x', id: 'u5' } as any,
          ],
        },
        { meeting: meeting2, participants: [] },
      ],
    });

    const sectionTexts = view.blocks
      .filter((b: any) => b.type === 'section')
      .map((b: any) => b.text?.text ?? '');

    const subtitle = sectionTexts.find((t) => t.includes('active meeting'));
    expect(subtitle).toContain('2 active');

    const card1 = sectionTexts.find((t) => t.includes('Roadmap'));
    expect(card1).toContain('mtg-aaaa');
    expect(card1).toContain('3/5 done');
    expect(card1).toContain('1 blocked');
    expect(card1).toContain('Add a comment or mark no concerns');

    const actionsBlocks = view.blocks.filter((b: any) => b.type === 'actions');
    const meetingActions = actionsBlocks.filter((b: any) =>
      b.elements.some((e: any) => e.action_id === 'home_send')
    );
    expect(meetingActions).toHaveLength(2);

    const buttons = meetingActions[0].elements.map((e: any) => e.action_id);
    expect(buttons).toEqual([
      'home_send', 'home_remind', 'home_status', 'home_check_doc', 'home_set_action', 'home_followup',
    ]);
    expect(meetingActions[0].elements[0].value).toBe('mtg-aaaaaaaaaaa1');

    const dividers = view.blocks.filter((b: any) => b.type === 'divider');
    expect(dividers.length).toBeGreaterThanOrEqual(2);

    const footer = actionsBlocks[actionsBlocks.length - 1];
    expect(footer.elements[0].action_id).toBe('home_create_meeting');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/bot/home-views.test.ts`
Expected: FAIL — assertions about subtitle, cards, buttons fail (operator multi-meeting branch unimplemented).

- [ ] **Step 3: Replace the multi-meeting branch in `src/bot/home-views.ts`**

Replace the entire `buildOperatorView` function with:

```typescript
export function buildOperatorView(input: OperatorViewInput): SlackHomeView {
  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Meetassist' } },
  ];

  if (input.meetings.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'No active meetings yet. Create your first one to get started.' },
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '+ Create meeting' },
          action_id: 'home_create_meeting',
          style: 'primary',
        },
      ],
    });
    return { type: 'home', blocks };
  }

  const totalPending = input.meetings.reduce(
    (sum, m) => sum + m.participants.filter((p) => p.status !== 'completed').length,
    0
  );
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${input.meetings.length} active meeting${input.meetings.length === 1 ? '' : 's'} · ${totalPending} pending replies`,
    },
  });
  blocks.push({ type: 'divider' });

  for (const { meeting, participants } of input.meetings) {
    const done = participants.filter((p) => p.status === 'completed').length;
    const total = participants.length;
    const blocked = participants.filter((p) => p.status === 'blocked').length;

    const date = new Date(meeting.start_time);
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const idPrefix = meeting.id.slice(0, 8);
    const actionLabel = humaniseDocumentAction(meeting.document_action);

    const progressLine = blocked > 0
      ? `Progress: ${done}/${total} done · ${blocked} blocked`
      : `Progress: ${done}/${total} done`;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${meeting.title}*`,
          `${dateStr} · ${timeStr} · \`${idPrefix}\``,
          `Action: ${actionLabel}`,
          progressLine,
          `Doc: <${meeting.document_url}|${meeting.document_title}>`,
        ].join('\n'),
      },
    });
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Send' },       action_id: 'home_send',        value: meeting.id, style: 'primary' },
        { type: 'button', text: { type: 'plain_text', text: 'Remind' },     action_id: 'home_remind',      value: meeting.id },
        { type: 'button', text: { type: 'plain_text', text: 'Status' },     action_id: 'home_status',      value: meeting.id },
        { type: 'button', text: { type: 'plain_text', text: 'Check doc' },  action_id: 'home_check_doc',   value: meeting.id },
        { type: 'button', text: { type: 'plain_text', text: 'Set action' }, action_id: 'home_set_action',  value: meeting.id },
        { type: 'button', text: { type: 'plain_text', text: 'Followup' },   action_id: 'home_followup',    value: meeting.id },
      ],
    });
    blocks.push({ type: 'divider' });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '+ Create meeting' },
        action_id: 'home_create_meeting',
        style: 'primary',
      },
    ],
  });

  return { type: 'home', blocks };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/bot/home-views.test.ts`
Expected: PASS — both buildOperatorView tests green

- [ ] **Step 5: Commit**

```bash
git add src/bot/home-views.ts tests/bot/home-views.test.ts
git commit -m "feat: build operator Home view with meeting cards"
```

---

## Task 6: Build participant Home view

**Files:**
- Modify: `src/bot/home-views.ts`
- Modify: `tests/bot/home-views.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/bot/home-views.test.ts`:

```typescript
describe('buildParticipantView', () => {
  it('returns empty state when no open items', () => {
    const view = buildParticipantView({ meetings: [] });

    const headerBlock = view.blocks.find((b: any) => b.type === 'header');
    expect((headerBlock as any).text.text).toBe('Meetassist');

    const sectionTexts = view.blocks
      .filter((b: any) => b.type === 'section')
      .map((b: any) => b.text?.text ?? '');
    expect(sectionTexts.some((t) => t.includes("You're all caught up"))).toBe(true);
  });

  it('renders one card per open item with three reply buttons', () => {
    const view = buildParticipantView({
      meetings: [
        {
          id: 'mtg-1', title: 'Roadmap Review', start_time: '2026-06-01T09:00:00Z',
          organizer_user_id: 'op1', purpose: 'p', document_url: 'https://x/wiki/spaces/A/pages/1/r',
          document_title: 'Doc', document_action: 'read', confluence_page_id: '1',
          status: 'active', created_at: '', participant_status: 'nudge_sent',
        },
      ],
    });

    const sectionTexts = view.blocks
      .filter((b: any) => b.type === 'section')
      .map((b: any) => b.text?.text ?? '');

    const subtitle = sectionTexts.find((t) => t.includes('action'));
    expect(subtitle).toContain('1 action');

    const card = sectionTexts.find((t) => t.includes('Roadmap Review'));
    expect(card).toContain('Read the document');
    expect(card).toContain('nudge sent');
    expect(card).toContain('<https://x/wiki/spaces/A/pages/1/r|Doc>');

    const actionsBlock = view.blocks.find((b: any) => b.type === 'actions') as any;
    const ids = actionsBlock.elements.map((e: any) => e.action_id);
    expect(ids).toEqual(['mark_done', 'need_clarification', 'cannot_complete']);
    expect(actionsBlock.elements[0].value).toBe('mtg-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/bot/home-views.test.ts`
Expected: FAIL — buildParticipantView returns empty array.

- [ ] **Step 3: Replace `buildParticipantView` in `src/bot/home-views.ts`**

Replace the placeholder with:

```typescript
export function buildParticipantView(input: ParticipantViewInput): SlackHomeView {
  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Meetassist' } },
  ];

  if (input.meetings.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: "You're all caught up. No actions needed right now." },
    });
    return { type: 'home', blocks };
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${input.meetings.length} action${input.meetings.length === 1 ? '' : 's'} waiting for you`,
    },
  });
  blocks.push({ type: 'divider' });

  for (const meeting of input.meetings) {
    const date = new Date(meeting.start_time);
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const actionLabel = humaniseDocumentAction(meeting.document_action);
    const statusLabel = humaniseParticipantStatus(meeting.participant_status);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${meeting.title}*`,
          `${dateStr} · ${timeStr}`,
          `Action requested: ${actionLabel}`,
          `Document: <${meeting.document_url}|${meeting.document_title}>`,
          `Status: ${statusLabel}`,
        ].join('\n'),
      },
    });
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Mark done' },          action_id: 'mark_done',            value: meeting.id, style: 'primary' },
        { type: 'button', text: { type: 'plain_text', text: 'Need clarification' }, action_id: 'need_clarification',   value: meeting.id },
        { type: 'button', text: { type: 'plain_text', text: 'Cannot complete' },    action_id: 'cannot_complete',      value: meeting.id, style: 'danger' },
      ],
    });
    blocks.push({ type: 'divider' });
  }

  return { type: 'home', blocks };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/bot/home-views.test.ts`
Expected: PASS — both buildParticipantView tests green

- [ ] **Step 5: Commit**

```bash
git add src/bot/home-views.ts tests/bot/home-views.test.ts
git commit -m "feat: build participant Home view"
```

---

## Task 7: Wire `publishHomeView` and `app_home_opened` listener

**Files:**
- Create: `src/bot/home.ts`
- Test: (manual smoke test only — Slack client mocking is heavy; pure logic is in `home-views.ts`)

The orchestrator. Composes data, calls `home-views`, calls Slack API.

- [ ] **Step 1: Create `src/bot/home.ts`**

```typescript
import { app } from './app';
import type { MeetingService } from '../services/meeting';
import type { NudgeService } from '../services/nudge';
import type { RelayService } from './relay';
import type { ConfluenceService } from '../services/confluence';
import { buildOperatorView, buildParticipantView } from './home-views';
import { isOperator } from './roles';

let meetingServiceRef: MeetingService;

export async function publishHomeView(slackUserId: string): Promise<void> {
  try {
    const user = await meetingServiceRef.getUserBySlackId(slackUserId);
    if (!user) return;

    if (isOperator(slackUserId)) {
      const meetings = await meetingServiceRef.listActive(user.id);
      const summaries = await Promise.all(
        meetings.map(async (m) => ({
          meeting: m,
          participants: await meetingServiceRef.getParticipantsWithUsers(m.id),
        }))
      );
      const view = buildOperatorView({ meetings: summaries });
      await app.client.views.publish({ user_id: slackUserId, view: view as any });
    } else {
      const meetings = await meetingServiceRef.listOpenForParticipant(user.id);
      const view = buildParticipantView({ meetings });
      await app.client.views.publish({ user_id: slackUserId, view: view as any });
    }
  } catch (err: any) {
    console.error(`[home] publish failed for ${slackUserId}:`, err?.data ?? err?.message ?? err);
  }
}

export async function publishHomeViews(slackUserIds: string[]): Promise<void> {
  const unique = Array.from(new Set(slackUserIds.filter(Boolean)));
  await Promise.allSettled(unique.map((id) => publishHomeView(id)));
}

export function registerHome(
  meetingService: MeetingService,
  _nudgeService: NudgeService,
  _relayService: RelayService,
  _confluenceService: ConfluenceService
): void {
  meetingServiceRef = meetingService;

  app.event('app_home_opened', async ({ event }) => {
    const e = event as any;
    if (e.tab !== 'home') return;
    await publishHomeView(e.user);
  });
}
```

- [ ] **Step 2: Wire it from `src/index.ts`**

Open `src/index.ts`. After the `registerActions(...)` line, add:

```typescript
import { registerHome } from './bot/home';
```

(Add at the top alongside other imports.)

And in the body, after `registerActions(meetingService, relayService);`:

```typescript
  registerHome(meetingService, nudgeService, relayService, confluenceService);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npm run build`
Expected: clean compile, no errors. The `dist/` folder is regenerated.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: all tests still pass (this task adds no new tests; existing ones must stay green)

- [ ] **Step 5: Commit**

```bash
git add src/bot/home.ts src/index.ts
git commit -m "feat: wire app_home_opened listener and publishHomeView helper"
```

---

## Task 8: Operator action handlers — Send/Remind/Followup/Status/Check-doc

**Files:**
- Modify: `src/bot/home.ts` — register handlers
- Test: (manual — handlers call already-tested service methods)

These mirror the matching `/ma` slash commands. Each handler resolves the meeting by ID, calls existing services, then refreshes Home views.

- [ ] **Step 1: Append handlers to `src/bot/home.ts`**

Add at the end of the `registerHome(...)` body, before the function closes:

```typescript
  app.action('home_send', async ({ ack, body, action }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    if (!isOperator(slackUserId)) return;

    try {
      const meeting = await meetingService.getById(meetingId);
      if (!meeting) {
        await app.client.chat.postEphemeral({ channel: slackUserId, user: slackUserId, text: 'Meeting not found.' });
        return;
      }
      const participants = (await meetingService.getParticipantsWithUsers(meetingId)).filter(
        (p) => p.status === 'pending'
      );
      const { text, blocks } = _nudgeService.buildPreMeetingMessage(meeting);
      const targetSlackIds: string[] = [slackUserId];
      for (const p of participants) {
        try {
          const { channel, ts } = await _relayService.sendBlocksToParticipant({
            slackUserId: p.slack_user_id, text, blocks,
          });
          await _nudgeService.recordNudge({
            user_id: p.user_id, meeting_id: meetingId,
            slack_channel_id: channel, message_ts: ts, type: 'pre_meeting',
          });
          await meetingService.updateParticipantStatus(meetingId, p.user_id, 'nudge_sent');
          targetSlackIds.push(p.slack_user_id);
        } catch (err: any) {
          console.error(`[home_send] Failed for ${p.slack_user_id}:`, err?.data ?? err?.message ?? err);
        }
      }
      await publishHomeViews(targetSlackIds);
      await app.client.chat.postEphemeral({
        channel: slackUserId, user: slackUserId,
        text: `Meetassist: Pre-meeting nudge sent to ${participants.length} participant(s).`,
      });
    } catch (err: any) {
      console.error('[home_send] error:', err);
    }
  });

  app.action('home_remind', async ({ ack, body, action }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    if (!isOperator(slackUserId)) return;

    try {
      const meeting = await meetingService.getById(meetingId);
      if (!meeting) return;
      const participants = (await meetingService.getParticipantsWithUsers(meetingId)).filter(
        (p) => p.status === 'nudge_sent' || p.status === 'replied'
      );
      const text = _nudgeService.buildReminderMessage(meeting);
      const targetSlackIds: string[] = [slackUserId];
      for (const p of participants) {
        const { channel, ts } = await _relayService.sendToParticipant({ slackUserId: p.slack_user_id, text });
        await _nudgeService.recordNudge({
          user_id: p.user_id, meeting_id: meetingId,
          slack_channel_id: channel, message_ts: ts, type: 'reminder',
        });
        await meetingService.incrementReminderCount(meetingId, p.user_id);
        targetSlackIds.push(p.slack_user_id);
      }
      await publishHomeViews(targetSlackIds);
      await app.client.chat.postEphemeral({
        channel: slackUserId, user: slackUserId,
        text: `Meetassist: Reminder sent to ${participants.length} participant(s).`,
      });
    } catch (err: any) {
      console.error('[home_remind] error:', err);
    }
  });

  app.action('home_followup', async ({ ack, body, action }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    if (!isOperator(slackUserId)) return;

    try {
      const meeting = await meetingService.getById(meetingId);
      if (!meeting) return;
      const participants = (await meetingService.getParticipantsWithUsers(meetingId)).filter(
        (p) => p.status !== 'completed'
      );
      const text = _nudgeService.buildFollowUpMessage(meeting);
      const targetSlackIds: string[] = [slackUserId];
      for (const p of participants) {
        const { channel, ts } = await _relayService.sendToParticipant({ slackUserId: p.slack_user_id, text });
        await _nudgeService.recordNudge({
          user_id: p.user_id, meeting_id: meetingId,
          slack_channel_id: channel, message_ts: ts, type: 'post_meeting',
        });
        targetSlackIds.push(p.slack_user_id);
      }
      await publishHomeViews(targetSlackIds);
      await app.client.chat.postEphemeral({
        channel: slackUserId, user: slackUserId,
        text: `Meetassist: Follow-up sent to ${participants.length} participant(s).`,
      });
    } catch (err: any) {
      console.error('[home_followup] error:', err);
    }
  });

  app.action('home_status', async ({ ack, body, action, client }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    if (!isOperator(slackUserId)) return;

    try {
      const meeting = await meetingService.getById(meetingId);
      if (!meeting) return;
      const participants = await meetingService.getParticipantsWithUsers(meetingId);
      const lines = participants.map(
        (p) => `• ${p.display_name} (<@${p.slack_user_id}>) — *${p.status}* (reminders: ${p.reminder_count})`
      );
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Meeting status' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*${meeting.title}* — ${meeting.status}\nDocument: <${meeting.document_url}|${meeting.document_title}>\n\nParticipants:\n${lines.join('\n')}`,
              },
            },
          ],
        },
      });
    } catch (err: any) {
      console.error('[home_status] error:', err);
    }
  });

  app.action('home_check_doc', async ({ ack, body, action }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    if (!isOperator(slackUserId)) return;

    try {
      const meeting = await meetingService.getById(meetingId);
      if (!meeting) return;
      const page = await _confluenceService.getPage(meeting.confluence_page_id);
      const comments = await _confluenceService.getComments(meeting.confluence_page_id);
      const participants = await meetingService.getParticipantsWithUsers(meetingId);
      const participantEmails = participants.map((p) => p.email).filter(Boolean);
      const summary = _confluenceService.buildDocCheckSummary(page, comments, participantEmails);

      await app.client.chat.postMessage({ channel: slackUserId, text: summary });
      await meetingService.recordDocCheck(meetingId, page.version, comments.length);
    } catch (err: any) {
      await _relayService.notifyOperator(`[Meetassist] Doc check failed: ${err.message}`);
    }
  });
```

Update the `registerHome` parameter names — change leading underscores to real names since they're now used:

```typescript
export function registerHome(
  meetingService: MeetingService,
  nudgeService: NudgeService,
  relayService: RelayService,
  confluenceService: ConfluenceService
): void {
  meetingServiceRef = meetingService;
```

And throughout the new handlers, replace `_nudgeService` → `nudgeService`, `_relayService` → `relayService`, `_confluenceService` → `confluenceService`.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npm run build`
Expected: clean compile

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: all tests pass (no behaviour change to existing code)

- [ ] **Step 4: Commit**

```bash
git add src/bot/home.ts
git commit -m "feat: add operator action handlers for Home tab buttons"
```

---

## Task 9: Set-action modal

**Files:**
- Modify: `src/bot/home.ts` — open modal + handle submit

- [ ] **Step 1: Append set-action modal handlers to `src/bot/home.ts`**

Add inside `registerHome(...)`:

```typescript
  app.action('home_set_action', async ({ ack, body, action, client }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    if (!isOperator(slackUserId)) return;

    try {
      const meeting = await meetingService.getById(meetingId);
      if (!meeting) return;

      const options = ['read', 'comment', 'approve', 'provide_input', 'confirm_decision'].map((a) => ({
        text: { type: 'plain_text', text: a },
        value: a,
      }));

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'home_set_action_submit',
          private_metadata: meetingId,
          title: { type: 'plain_text', text: 'Change action' },
          submit: { type: 'plain_text', text: 'Change' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `*${meeting.title}*\nCurrent action: \`${meeting.document_action}\`` },
            },
            {
              type: 'input',
              block_id: 'action_block',
              label: { type: 'plain_text', text: 'New action' },
              element: {
                type: 'static_select',
                action_id: 'new_action',
                options: options as any,
                initial_option: { text: { type: 'plain_text', text: meeting.document_action }, value: meeting.document_action },
              },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '_All participants will be reset to pending. You\'ll need to send a new nudge afterwards._' },
            },
          ],
        },
      });
    } catch (err: any) {
      console.error('[home_set_action] open error:', err);
    }
  });

  app.view('home_set_action_submit', async ({ ack, view, body }) => {
    await ack();
    const meetingId = view.private_metadata;
    const newAction = (view.state.values as any).action_block.new_action.selected_option.value;
    const slackUserId = body.user.id;

    try {
      await meetingService.updateAction(meetingId, newAction);
      const participants = await meetingService.getParticipantsWithUsers(meetingId);
      for (const p of participants) {
        await meetingService.updateParticipantStatus(meetingId, p.user_id, 'pending');
      }
      const targetIds = [slackUserId, ...participants.map((p) => p.slack_user_id)];
      await publishHomeViews(targetIds);
      await app.client.chat.postEphemeral({
        channel: slackUserId, user: slackUserId,
        text: `Meetassist: Action updated to \`${newAction}\`. All participants reset to pending.`,
      });
    } catch (err: any) {
      console.error('[home_set_action_submit] error:', err);
    }
  });
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npm run build`
Expected: clean compile

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: all green

- [ ] **Step 4: Commit**

```bash
git add src/bot/home.ts
git commit -m "feat: add set-action modal to Home tab"
```

---

## Task 10: Create-meeting modal

**Files:**
- Modify: `src/bot/home.ts` — open + submit handlers

- [ ] **Step 1: Append create-meeting modal handlers to `src/bot/home.ts`**

Add inside `registerHome(...)`:

```typescript
  app.action('home_create_meeting', async ({ ack, body, client }) => {
    await ack();
    const slackUserId = body.user.id;
    if (!isOperator(slackUserId)) return;

    try {
      const actionOptions = ['read', 'comment', 'approve', 'provide_input', 'confirm_decision'].map((a) => ({
        text: { type: 'plain_text', text: a },
        value: a,
      }));

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'home_create_meeting_submit',
          title: { type: 'plain_text', text: 'New meeting' },
          submit: { type: 'plain_text', text: 'Create' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'input', block_id: 'title_block',
              label: { type: 'plain_text', text: 'Meeting title' },
              element: { type: 'plain_text_input', action_id: 'title' },
            },
            {
              type: 'input', block_id: 'time_block',
              label: { type: 'plain_text', text: 'Date and time' },
              element: { type: 'datetimepicker', action_id: 'time' },
            },
            {
              type: 'input', block_id: 'purpose_block',
              label: { type: 'plain_text', text: 'Meeting purpose' },
              element: { type: 'plain_text_input', action_id: 'purpose', multiline: true },
            },
            {
              type: 'input', block_id: 'doc_url_block',
              label: { type: 'plain_text', text: 'Confluence page URL' },
              element: { type: 'plain_text_input', action_id: 'doc_url' },
            },
            {
              type: 'input', block_id: 'doc_title_block',
              label: { type: 'plain_text', text: 'Document title' },
              element: { type: 'plain_text_input', action_id: 'doc_title' },
            },
            {
              type: 'input', block_id: 'action_block',
              label: { type: 'plain_text', text: 'Required action' },
              element: { type: 'static_select', action_id: 'action', options: actionOptions as any },
            },
            {
              type: 'input', block_id: 'participants_block',
              label: { type: 'plain_text', text: 'Participants' },
              element: { type: 'multi_users_select', action_id: 'participants' },
            },
          ],
        },
      });
    } catch (err: any) {
      console.error('[home_create_meeting] open error:', err);
    }
  });

  app.view('home_create_meeting_submit', async ({ ack, view, body, client }) => {
    const values = view.state.values as any;
    const title = values.title_block.title.value;
    const timeUnix = values.time_block.time.selected_date_time;
    const purpose = values.purpose_block.purpose.value;
    const docUrl = values.doc_url_block.doc_url.value as string;
    const docTitle = values.doc_title_block.doc_title.value;
    const action = values.action_block.action.selected_option.value;
    const participantSlackIds = values.participants_block.participants.selected_users as string[];

    if (!docUrl.match(/\/pages\/\d+/)) {
      await ack({
        response_action: 'errors',
        errors: { doc_url_block: 'URL must contain /pages/<id>' },
      } as any);
      return;
    }

    await ack();

    const slackUserId = body.user.id;
    try {
      const operatorUser = await meetingService.getUserBySlackId(slackUserId);
      if (!operatorUser) {
        await app.client.chat.postEphemeral({
          channel: slackUserId, user: slackUserId,
          text: 'Meetassist: Operator user not found in DB.',
        });
        return;
      }
      const startTime = new Date(timeUnix * 1000).toISOString();
      const meeting = await meetingService.createMeeting({
        title, start_time: startTime, organizer_user_id: operatorUser.id, purpose,
        document_url: docUrl, document_title: docTitle, document_action: action,
      });
      const failed: string[] = [];
      for (const sid of participantSlackIds) {
        try {
          const u = await meetingService.autoSeedFromSlack(sid, client as any);
          await meetingService.addParticipant(meeting.id, u.id, 'participant');
        } catch (err: any) {
          console.error(`[home_create_meeting_submit] autoSeed failed for ${sid}:`, err?.data ?? err?.message ?? err);
          failed.push(sid);
        }
      }
      await meetingService.updateStatus(meeting.id, 'active');
      await publishHomeViews([slackUserId, ...participantSlackIds]);

      const failNote = failed.length > 0 ? `\n⚠️ Could not look up: ${failed.join(', ')}` : '';
      await app.client.chat.postEphemeral({
        channel: slackUserId, user: slackUserId,
        text: `Meetassist: Meeting created. *${title}* — \`${meeting.id.slice(0, 8)}\`${failNote}`,
      });
    } catch (err: any) {
      console.error('[home_create_meeting_submit] error:', err);
    }
  });
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npm run build`
Expected: clean compile

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: all green

- [ ] **Step 4: Commit**

```bash
git add src/bot/home.ts
git commit -m "feat: add create-meeting modal to Home tab"
```

---

## Task 11: Refresh Home views from existing slash commands

**Files:**
- Modify: `src/bot/commands.ts` — call `publishHomeViews` after mutations

- [ ] **Step 1: Add import to `src/bot/commands.ts`**

At the top, add:

```typescript
import { publishHomeViews } from './home';
```

- [ ] **Step 2: Refresh after `/ma send` (in commands.ts)**

In the `case 'send':` block, after the existing `for (const p of participants) { ... sent++; }` loop and before the `await respond(...)` call, add:

```typescript
        await publishHomeViews([command.user_id, ...participants.map((p) => p.slack_user_id)]);
```

- [ ] **Step 3: Refresh after `/ma remind`**

In the `case 'remind':` block, before the closing `await respond(...)`:

```typescript
        await publishHomeViews([command.user_id, ...participants.map((p) => p.slack_user_id)]);
```

- [ ] **Step 4: Refresh after `/ma followup`**

In the `case 'followup':` block, before the closing `await respond(...)`:

```typescript
        await publishHomeViews([command.user_id, ...participants.map((p) => p.slack_user_id)]);
```

- [ ] **Step 5: Refresh after `/ma set-action`**

In the `case 'set-action':` block, after the participants reset loop and before the closing `await respond(...)`:

```typescript
        await publishHomeViews([command.user_id, ...participants.map((p) => p.slack_user_id)]);
```

- [ ] **Step 6: Refresh after the create-wizard finalises**

In the DM-message handler, inside `case 'participants':` after `await meetingService.updateStatus(meeting.id, 'active');` and before the `await say(...)` reporting back, add:

```typescript
        await publishHomeViews([msg.user, ...session.participants!]);
```

- [ ] **Step 7: Verify build & tests**

Run: `npm run build && npm test`
Expected: clean compile, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/bot/commands.ts
git commit -m "feat: refresh Home views after slash command state changes"
```

---

## Task 12: Refresh Home views from action handlers and DM relay

**Files:**
- Modify: `src/bot/actions.ts` — refresh after participant button clicks
- Modify: `src/bot/relay.ts` — refresh after DM relay

- [ ] **Step 1: Add import to `src/bot/actions.ts`**

At the top:

```typescript
import { publishHomeViews } from './home';
import { getOperatorIds } from './roles';
```

- [ ] **Step 2: Refresh after `mark_done`**

Inside the `app.action('mark_done', ...)` handler, after the `relayService.notifyOperator(...)` call and before the function ends, add:

```typescript
    await publishHomeViews([slackUserId, ...getOperatorIds()]);
```

- [ ] **Step 3: Refresh after `need_clarification`**

Same pattern inside `need_clarification` handler:

```typescript
    await publishHomeViews([slackUserId, ...getOperatorIds()]);
```

- [ ] **Step 4: Refresh after `cannot_complete`**

Same pattern:

```typescript
    await publishHomeViews([slackUserId, ...getOperatorIds()]);
```

- [ ] **Step 5: Add import to `src/bot/relay.ts`**

At the top:

```typescript
import { publishHomeViews } from './home';
import { getOperatorIds } from './roles';
```

- [ ] **Step 6: Refresh inside DM listener**

Inside `registerDmListener`, in the `app.message(async ({ message }) => { ... })` handler, after the existing `await this.forwardToOperator(...)` call, add:

```typescript
      await publishHomeViews([slackUserId, ...getOperatorIds()]);
```

- [ ] **Step 7: Verify build & tests**

Run: `npm run build && npm test`
Expected: clean compile, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/bot/actions.ts src/bot/relay.ts
git commit -m "feat: refresh Home views after participant interactions"
```

---

## Task 13: Final integration check & deployment

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (existing 11 + 3 new files of tests)

- [ ] **Step 2: Run a clean build**

Run: `npm run build`
Expected: TypeScript compiles cleanly to `dist/`

- [ ] **Step 3: Push to GitHub**

```bash
git push
```

Expected: Railway auto-deploys (visible in Railway dashboard).

- [ ] **Step 4: Apply Slack app config (manual, one-time)**

In api.slack.com → your Meetassist app:

1. **Event Subscriptions** → enable, add bot event `app_home_opened`
2. **OAuth & Permissions** → add bot scope `views:write`
3. **App Home** → enable Home Tab (toggle)
4. Reinstall the app to the workspace (top of OAuth page) — accept the new scope

- [ ] **Step 5: Manual smoke test as operator**

In Slack, open the Meetassist app → click the **Home** tab.

Expected:
- See "Meetassist" header
- See subtitle with active meeting count
- See one card per active meeting with 6 buttons
- See "+ Create meeting" button at the bottom

Click each button on a test meeting:
- **Send** → ephemeral confirmation, view refreshes with updated participant statuses
- **Status** → modal opens with participant breakdown
- **Set action** → modal opens with action dropdown; submit changes the action and resets participants
- **+ Create meeting** → modal opens with all 7 fields including native multi-user picker

- [ ] **Step 6: Manual smoke test as participant**

Have a participant (non-operator user) open the Meetassist app's Home tab.

Expected:
- See "Meetassist" header
- See subtitle showing how many open items
- See one card per open meeting with 3 reply buttons (Mark done / Need clarification / Cannot complete)
- Click **Mark done** → view refreshes, item disappears (now completed, filtered out)

- [ ] **Step 7: Done — no commit needed**

If all smoke tests pass, the feature is live. If any fail, capture the issue and create a follow-up task.

---

## Self-Review

I checked the plan against the spec:

**Spec coverage:**
- §2 File structure → Tasks 1, 2, 3, 4 (new files) and 7, 11, 12 (modifications) ✓
- §3 Slack app config → Task 13 step 4 ✓
- §4 Operator view → Tasks 4, 5 ✓
- §5 Participant view → Task 6 ✓
- §6 Modals (create, set-action, status) → Tasks 8 (status), 9 (set-action), 10 (create) ✓
- §7 Refresh strategy → Task 7 (`publishHomeView`/`publishHomeViews`), Tasks 11, 12 (call sites) ✓
- §8 New service method → Task 1 ✓
- §9 Error handling → embedded in every handler (try/catch + console.error) ✓
- §10 Testing → unit tests in Tasks 1, 2, 3, 4, 5, 6 ✓
- §11 Out of scope → not implemented (correct) ✓

**Type consistency:** `MeetingWithParticipantStatus` (defined Task 1) is used in Task 6. `SlackHomeView` defined and used in Task 4. `publishHomeView` / `publishHomeViews` signatures match between definition (Task 7) and call sites (Tasks 11, 12).

**Placeholder scan:** No "TBD"/"TODO" markers. All code blocks contain runnable code. Manual smoke tests in Task 13 list specific buttons and expected behaviours.
