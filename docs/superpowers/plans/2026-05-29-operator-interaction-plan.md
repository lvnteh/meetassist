# Operator Interaction Refinement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the slash-command-driven operator flow with a Slack modal-based "form" experience and persistent per-meeting DM control cards. Slash commands stay as a fallback.

**Architecture:** Two new Slack surfaces — a creation modal opened from a persistent "➕ Create meeting" button in the operator DM, and per-meeting Block Kit control cards posted into the operator DM and updated in place via `chat.update`. Reuse existing services (`MeetingService`, `NudgeService`, `RelayService`, `ConfluenceService`). Add five nullable columns across two tables. No removal of existing slash commands.

**Tech Stack:** TypeScript strict, @slack/bolt 4.x (socket mode), pg.Pool (Postgres on Railway), node-cron, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-29-operator-interaction-design.md`

---

## Task 1: Schema migration — add control card + DM bootstrap columns

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/schema.test.ts` (already exists — extend)

- [ ] **Step 1: Write failing test for the new columns**

Add to `tests/db/schema.test.ts`:

```typescript
it('meetings has control card columns', async () => {
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'meetings'
      AND column_name IN ('control_channel_id', 'control_message_ts', 'last_card_progress')
  `);
  const names = rows.map((r: any) => r.column_name).sort();
  expect(names).toEqual(['control_channel_id', 'control_message_ts', 'last_card_progress']);
});

it('users has operator DM bootstrap columns', async () => {
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'users'
      AND column_name IN ('operator_dm_channel_id', 'operator_dm_message_ts')
  `);
  const names = rows.map((r: any) => r.column_name).sort();
  expect(names).toEqual(['operator_dm_channel_id', 'operator_dm_message_ts']);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- --run tests/db/schema.test.ts`
Expected: FAIL — columns don't exist yet.

- [ ] **Step 3: Add ALTER TABLE statements idempotently**

Modify `src/db/schema.ts` — append after the existing `CREATE TABLE` block:

```typescript
  await pool.query(`
    ALTER TABLE meetings ADD COLUMN IF NOT EXISTS control_channel_id TEXT;
    ALTER TABLE meetings ADD COLUMN IF NOT EXISTS control_message_ts TEXT;
    ALTER TABLE meetings ADD COLUMN IF NOT EXISTS last_card_progress TEXT;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS operator_dm_channel_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS operator_dm_message_ts TEXT;
  `);
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test -- --run tests/db/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts tests/db/schema.test.ts
git commit -m "feat: add control card + DM bootstrap columns"
```

---

## Task 2: MeetingService — control card persistence helpers

**Files:**
- Modify: `src/services/meeting.ts`
- Test: `tests/services/meeting.test.ts` (extend)

- [ ] **Step 1: Write failing test for `setControlMessage`**

```typescript
it('setControlMessage persists channel + ts on a meeting', async () => {
  const m = await meetingService.createMeeting(/* ...standard fixture... */);
  await meetingService.setControlMessage(m.id, 'C123', '1700000000.000100');
  const updated = await meetingService.getById(m.id);
  expect((updated as any).control_channel_id).toBe('C123');
  expect((updated as any).control_message_ts).toBe('1700000000.000100');
});
```

- [ ] **Step 2: Write failing test for `getMeetingsWithStaleCard`**

```typescript
it('getMeetingsWithStaleCard returns meetings whose progress changed', async () => {
  const m = await meetingService.createMeeting(/* fixture */);
  await meetingService.setControlMessage(m.id, 'C1', 'ts1');
  // last_card_progress is null initially → considered stale if a card_ts exists
  const stale = await meetingService.getMeetingsWithStaleCard();
  expect(stale.find((x) => x.id === m.id)).toBeDefined();

  await meetingService.setLastCardProgress(m.id, '0/0/0');
  const stale2 = await meetingService.getMeetingsWithStaleCard();
  expect(stale2.find((x) => x.id === m.id)).toBeUndefined();
});
```

(`getMeetingsWithStaleCard` returns meetings where `control_message_ts IS NOT NULL` AND `last_card_progress IS DISTINCT FROM <currentSig>`. We compute the current signature inside the method.)

- [ ] **Step 3: Write failing test for `autoSeedSlackUser` extraction**

The existing `autoSeedFromSlack` already does the lookup-and-upsert. The plan is to expose it under a more accurate name (no rename of existing — add a new method that's an alias-with-cleaner-semantics, since `autoSeedFromSlack` is also called from `index.ts`). Actually — re-using the existing method is fine. Skip this step.

- [ ] **Step 4: Run tests, verify they fail**

Run: `npm test -- --run tests/services/meeting.test.ts`
Expected: FAIL — methods don't exist.

- [ ] **Step 5: Implement `setControlMessage`, `setLastCardProgress`, `getMeetingsWithStaleCard`**

Add to `src/services/meeting.ts`:

```typescript
async setControlMessage(meetingId: string, channelId: string, ts: string): Promise<void> {
  await this.pool.query(
    `UPDATE meetings SET control_channel_id = $1, control_message_ts = $2 WHERE id = $3`,
    [channelId, ts, meetingId]
  );
}

async setLastCardProgress(meetingId: string, signature: string): Promise<void> {
  await this.pool.query(
    `UPDATE meetings SET last_card_progress = $1 WHERE id = $2`,
    [signature, meetingId]
  );
}

async getMeetingsWithStaleCard(): Promise<Array<Meeting & { progress_signature: string }>> {
  const { rows } = await this.pool.query(`
    SELECT m.*,
      (
        SELECT COUNT(*) FILTER (WHERE status = 'completed')::text || '/' ||
               COUNT(*)::text || '/' ||
               COUNT(*) FILTER (WHERE status = 'blocked')::text
        FROM meeting_participants WHERE meeting_id = m.id
      ) AS progress_signature
    FROM meetings m
    WHERE m.control_message_ts IS NOT NULL
      AND m.status IN ('draft','active','cancelled')
  `);
  return rows.filter((r: any) => r.progress_signature !== r.last_card_progress);
}
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `npm test -- --run tests/services/meeting.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/meeting.ts tests/services/meeting.test.ts
git commit -m "feat: add control card persistence helpers"
```

---

## Task 3: Control card Block Kit builder

**Files:**
- Create: `src/bot/control-card.ts`
- Test: `tests/bot/control-card.test.ts`

- [ ] **Step 1: Write failing test for `buildControlCardBlocks`**

```typescript
import { buildControlCardBlocks } from '../../src/bot/control-card';

it('renders meeting summary + 4 buttons', () => {
  const meeting = {
    id: 'abcd1234-...',
    title: 'Take Template Ownership',
    start_time: '2026-06-02T14:00:00Z',
    document_url: 'https://emarsys.jira.com/wiki/spaces/ACS/pages/6426755229/Take+Template',
    document_title: 'Take Template Ownership',
    document_action: 'provide_input',
    purpose: 'Resolve who owns the template',
    status: 'active',
  } as any;
  const participants = [
    { user_id: 'u1', slack_user_id: 'U1', display_name: 'Alice', status: 'completed' },
    { user_id: 'u2', slack_user_id: 'U2', display_name: 'Bob', status: 'blocked' },
    { user_id: 'u3', slack_user_id: 'U3', display_name: 'Carol', status: 'pending' },
  ] as any;

  const blocks = buildControlCardBlocks(meeting, participants);

  // Title section
  expect(JSON.stringify(blocks)).toContain('Take Template Ownership');
  // Progress
  expect(JSON.stringify(blocks)).toContain('1/3 done');
  expect(JSON.stringify(blocks)).toContain('1 blocked');
  // 4 buttons present
  const actions = blocks.find((b: any) => b.type === 'actions') as any;
  expect(actions.elements).toHaveLength(4);
  expect(actions.elements.map((e: any) => e.action_id)).toEqual([
    'meeting_view_status',
    'meeting_change_action',
    'meeting_send_reminder',
    'meeting_cancel',
  ]);
});

it('renders cancelled state with strikethrough footer and no action buttons', () => {
  const meeting = { id: 'x', title: 'Old', start_time: '2026-06-02T14:00:00Z',
    document_url: 'https://x/pages/1', document_title: 'X', document_action: 'read',
    purpose: '', status: 'cancelled' } as any;
  const blocks = buildControlCardBlocks(meeting, []);
  expect(JSON.stringify(blocks)).toContain('Cancelled');
  expect(blocks.find((b: any) => b.type === 'actions')).toBeUndefined();
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- --run tests/bot/control-card.test.ts`
Expected: FAIL — file doesn't exist.

- [ ] **Step 3: Implement `buildControlCardBlocks`**

Create `src/bot/control-card.ts`:

```typescript
import type { Meeting, MeetingParticipant, User } from '../types';
import { humaniseAction } from '../services/dashboard';

function cleanUrl(url: string | null | undefined): string {
  if (!url) return '';
  const trimmed = url.trim();
  const match = trimmed.match(/^<(https?:\/\/[^|>]+)(?:\|[^>]*)?>$/);
  return match ? match[1] : trimmed;
}

function formatStart(iso: string): string {
  const d = new Date(iso);
  const wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  return `${wd} ${mo} ${d.getUTCDate()} · ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
}

export function progressSignature(participants: Array<MeetingParticipant & User>): string {
  const done = participants.filter(p => p.status === 'completed').length;
  const blocked = participants.filter(p => p.status === 'blocked').length;
  return `${done}/${participants.length}/${blocked}`;
}

export function buildControlCardBlocks(
  meeting: Meeting,
  participants: Array<MeetingParticipant & User>
): any[] {
  const idPrefix = meeting.id.slice(0, 8);
  const done = participants.filter(p => p.status === 'completed').length;
  const total = participants.length;
  const blocked = participants.filter(p => p.status === 'blocked').length;
  const progressText = blocked > 0 ? `${done}/${total} done · ${blocked} blocked` : `${done}/${total} done`;
  const docUrl = cleanUrl(meeting.document_url);
  const purposeLine = meeting.purpose && meeting.purpose.trim() !== ''
    ? `\n*Purpose:* ${meeting.purpose}` : '';

  const isCancelled = meeting.status === 'cancelled';
  const titleText = isCancelled ? `~${meeting.title}~ _(Cancelled)_` : `*${meeting.title}*`;

  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📋 ${titleText}    \`${idPrefix}\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*Starts:* ${formatStart(meeting.start_time)}\n` +
          `*Document:* <${docUrl}|${meeting.document_title}>\n` +
          `*Action:* ${humaniseAction(meeting.document_action as any)}` +
          purposeLine + `\n` +
          `*Progress:* ${progressText}`,
      },
    },
    { type: 'divider' },
  ];

  if (!isCancelled) {
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'meeting_view_status', text: { type: 'plain_text', text: 'View status' }, value: meeting.id },
        { type: 'button', action_id: 'meeting_change_action', text: { type: 'plain_text', text: 'Change action' }, value: meeting.id },
        { type: 'button', action_id: 'meeting_send_reminder', text: { type: 'plain_text', text: 'Send reminder' }, value: meeting.id },
        { type: 'button', action_id: 'meeting_cancel', text: { type: 'plain_text', text: 'Cancel' }, style: 'danger', value: meeting.id,
          confirm: {
            title: { type: 'plain_text', text: 'Cancel this meeting?' },
            text: { type: 'mrkdwn', text: 'This marks the meeting as cancelled. Participants will not be nudged further.' },
            confirm: { type: 'plain_text', text: 'Cancel meeting' },
            deny: { type: 'plain_text', text: 'Keep' },
          },
        },
      ],
    });
  }

  return blocks;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- --run tests/bot/control-card.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/control-card.ts tests/bot/control-card.test.ts
git commit -m "feat: add control card Block Kit builder"
```

---

## Task 4: Control card post / update helpers

**Files:**
- Modify: `src/bot/control-card.ts`

- [ ] **Step 1: Add `postControlCard` and `updateControlCard`**

Append to `src/bot/control-card.ts`:

```typescript
import type { WebClient } from '@slack/web-api';
import type { MeetingService } from '../services/meeting';

export async function postControlCard(
  client: WebClient,
  meetingService: MeetingService,
  meeting: Meeting,
  channelId: string,
): Promise<void> {
  const participants = await meetingService.getParticipantsWithUsers(meeting.id);
  const blocks = buildControlCardBlocks(meeting, participants);
  const result = await client.chat.postMessage({
    channel: channelId,
    blocks,
    text: `Meeting: ${meeting.title}`,
  });
  if (result.ts) {
    await meetingService.setControlMessage(meeting.id, channelId, result.ts);
    await meetingService.setLastCardProgress(meeting.id, progressSignature(participants));
  }
}

export async function updateControlCard(
  client: WebClient,
  meetingService: MeetingService,
  meeting: Meeting,
): Promise<void> {
  const channelId = (meeting as any).control_channel_id;
  const ts = (meeting as any).control_message_ts;
  if (!channelId || !ts) return;
  const participants = await meetingService.getParticipantsWithUsers(meeting.id);
  const blocks = buildControlCardBlocks(meeting, participants);
  try {
    await client.chat.update({
      channel: channelId,
      ts,
      blocks,
      text: `Meeting: ${meeting.title}`,
    });
    await meetingService.setLastCardProgress(meeting.id, progressSignature(participants));
  } catch (err: any) {
    console.error('[control-card] update failed:', err?.message ?? err);
  }
}
```

- [ ] **Step 2: Verify nothing broke**

Run: `npm test -- --run`
Expected: PASS (no behavior change yet since these aren't called).

- [ ] **Step 3: Commit**

```bash
git add src/bot/control-card.ts
git commit -m "feat: add control card post/update helpers"
```

---

## Task 5: Modal builders + view submission handler

**Files:**
- Create: `src/bot/modals.ts`
- Test: `tests/bot/modals.test.ts`

- [ ] **Step 1: Write failing test for `buildCreateMeetingModal`**

```typescript
import { buildCreateMeetingModal, buildChangeActionModal } from '../../src/bot/modals';

it('create modal has all required fields', () => {
  const view = buildCreateMeetingModal();
  expect(view.callback_id).toBe('create_meeting_modal');
  const blockIds = view.blocks.map((b: any) => b.block_id);
  expect(blockIds).toContain('title');
  expect(blockIds).toContain('document_url');
  expect(blockIds).toContain('action');
  expect(blockIds).toContain('purpose');
  expect(blockIds).toContain('start_time');
  expect(blockIds).toContain('participants');

  const partBlock: any = view.blocks.find((b: any) => b.block_id === 'participants');
  expect(partBlock.element.type).toBe('multi_users_select');
});

it('change action modal carries meeting id in private_metadata', () => {
  const view = buildChangeActionModal('meeting-abc', 'comment');
  expect(view.callback_id).toBe('change_action_modal');
  expect(view.private_metadata).toBe('meeting-abc');
  const actionBlock: any = view.blocks.find((b: any) => b.block_id === 'action');
  expect(actionBlock.element.type).toBe('static_select');
  expect(actionBlock.element.initial_option.value).toBe('comment');
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- --run tests/bot/modals.test.ts`
Expected: FAIL — file doesn't exist.

- [ ] **Step 3: Implement `buildCreateMeetingModal` and `buildChangeActionModal`**

Create `src/bot/modals.ts`:

```typescript
const ACTION_OPTIONS = [
  { value: 'read', label: 'Read' },
  { value: 'comment', label: 'Comment' },
  { value: 'approve', label: 'Approve' },
  { value: 'provide_input', label: 'Provide input' },
  { value: 'confirm_decision', label: 'Confirm decision' },
];

function actionOptions() {
  return ACTION_OPTIONS.map(o => ({
    text: { type: 'plain_text', text: o.label },
    value: o.value,
  }));
}

export function buildCreateMeetingModal(): any {
  return {
    type: 'modal',
    callback_id: 'create_meeting_modal',
    title: { type: 'plain_text', text: 'Create meeting' },
    submit: { type: 'plain_text', text: 'Create' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'title',
        label: { type: 'plain_text', text: 'Title' },
        element: { type: 'plain_text_input', action_id: 'value', max_length: 200 },
      },
      {
        type: 'input',
        block_id: 'document_url',
        label: { type: 'plain_text', text: 'Document URL' },
        element: { type: 'plain_text_input', action_id: 'value' },
        hint: { type: 'plain_text', text: 'Confluence page URL containing /pages/<id>' },
      },
      {
        type: 'input',
        block_id: 'action',
        label: { type: 'plain_text', text: 'Action' },
        element: { type: 'static_select', action_id: 'value', options: actionOptions() },
      },
      {
        type: 'input',
        block_id: 'purpose',
        optional: true,
        label: { type: 'plain_text', text: 'Purpose / context' },
        element: { type: 'plain_text_input', action_id: 'value', multiline: true },
      },
      {
        type: 'input',
        block_id: 'start_time',
        label: { type: 'plain_text', text: 'Start time' },
        element: { type: 'datetimepicker', action_id: 'value' },
      },
      {
        type: 'input',
        block_id: 'participants',
        label: { type: 'plain_text', text: 'Participants' },
        element: { type: 'multi_users_select', action_id: 'value' },
      },
    ],
  };
}

export function buildChangeActionModal(meetingId: string, currentAction: string): any {
  const initial = actionOptions().find(o => o.value === currentAction);
  return {
    type: 'modal',
    callback_id: 'change_action_modal',
    private_metadata: meetingId,
    title: { type: 'plain_text', text: 'Change action' },
    submit: { type: 'plain_text', text: 'Update' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'action',
        label: { type: 'plain_text', text: 'Action' },
        element: {
          type: 'static_select',
          action_id: 'value',
          options: actionOptions(),
          ...(initial ? { initial_option: initial } : {}),
        },
      },
    ],
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- --run tests/bot/modals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/modals.ts tests/bot/modals.test.ts
git commit -m "feat: add create-meeting + change-action modal builders"
```

---

## Task 6: Modal submission handlers (create + change-action)

**Files:**
- Modify: `src/bot/modals.ts` (add `registerModalHandlers`)
- Modify: `src/bot/actions.ts` (call `registerModalHandlers` from a new wiring point — see Task 8)

- [ ] **Step 1: Add submission handler scaffolding**

Append to `src/bot/modals.ts`:

```typescript
import { app } from './app';
import type { MeetingService } from '../services/meeting';
import type { ConfluenceService } from '../services/confluence';
import { unwrapSlackUrl } from './commands';
import { postControlCard, updateControlCard } from './control-card';

export function registerModalHandlers(
  meetingService: MeetingService,
  confluenceService: ConfluenceService,
): void {
  app.action('open_create_modal', async ({ ack, body, client }) => {
    await ack();
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: buildCreateMeetingModal(),
    });
  });

  app.view('create_meeting_modal', async ({ ack, body, view, client }) => {
    const values = view.state.values;
    const title = values.title?.value?.value?.trim() ?? '';
    const rawUrl = values.document_url?.value?.value?.trim() ?? '';
    const documentUrl = unwrapSlackUrl(rawUrl);
    const action = values.action?.value?.selected_option?.value ?? '';
    const purpose = values.purpose?.value?.value?.trim() ?? '';
    const startEpoch = values.start_time?.value?.selected_date_time as number | undefined;
    const participantIds: string[] = values.participants?.value?.selected_users ?? [];

    const errors: Record<string, string> = {};
    if (!title) errors.title = 'Title is required';
    if (!documentUrl.match(/\/pages\/\d+/)) errors.document_url = 'URL must contain /pages/<id>';
    if (!startEpoch || startEpoch * 1000 <= Date.now()) errors.start_time = 'Start time must be in the future';
    if (participantIds.length === 0) errors.participants = 'Pick at least one participant';

    if (Object.keys(errors).length > 0) {
      await ack({ response_action: 'errors', errors });
      return;
    }
    await ack();

    const operatorSlackId = body.user.id;
    const operator = await meetingService.autoSeedFromSlack(operatorSlackId, client as any);

    let documentTitle = title;
    try {
      documentTitle = await confluenceService.getPageTitle(documentUrl);
    } catch (err: any) {
      console.error('[modal] getPageTitle failed, falling back to meeting title:', err?.message);
    }

    const meeting = await meetingService.createMeeting({
      title,
      start_time: new Date(startEpoch! * 1000).toISOString(),
      organizer_user_id: operator.id,
      purpose,
      document_url: documentUrl,
      document_title: documentTitle,
      document_action: action,
    });
    await meetingService.updateStatus(meeting.id, 'active');

    for (const slackId of participantIds) {
      const u = await meetingService.autoSeedFromSlack(slackId, client as any);
      await meetingService.addParticipant(meeting.id, u.id, 'participant');
    }

    const dm = await client.conversations.open({ users: operatorSlackId });
    const channelId = (dm.channel as any)?.id;
    if (channelId) {
      const refreshed = (await meetingService.getById(meeting.id))!;
      await postControlCard(client as any, meetingService, refreshed, channelId);
    }
  });

  app.view('change_action_modal', async ({ ack, view, client }) => {
    await ack();
    const meetingId = view.private_metadata;
    const action = view.state.values.action?.value?.selected_option?.value;
    if (!meetingId || !action) return;
    await meetingService.updateAction(meetingId, action);
    const meeting = await meetingService.getById(meetingId);
    if (meeting) {
      await updateControlCard(client as any, meetingService, meeting);
    }
  });
}
```

- [ ] **Step 2: Run all tests to verify no regressions**

Run: `npm test -- --run`
Expected: PASS (these handlers aren't wired yet but compile).

- [ ] **Step 3: Commit**

```bash
git add src/bot/modals.ts
git commit -m "feat: add modal submission handlers"
```

---

## Task 7: Per-meeting button action handlers

**Files:**
- Create: `src/bot/control-actions.ts`

- [ ] **Step 1: Implement the four button handlers**

Create `src/bot/control-actions.ts`:

```typescript
import { app } from './app';
import type { MeetingService } from '../services/meeting';
import type { NudgeService } from '../services/nudge';
import { buildChangeActionModal } from './modals';
import { updateControlCard } from './control-card';
import { humaniseStatus, relativeTime } from '../services/dashboard';

export function registerControlActions(
  meetingService: MeetingService,
  nudgeService: NudgeService,
): void {
  app.action('meeting_view_status', async ({ ack, body, action, client, respond }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const meeting = await meetingService.getById(meetingId);
    if (!meeting) {
      await respond({ response_type: 'ephemeral', text: 'Meeting not found.' });
      return;
    }
    const participants = await meetingService.getParticipantsWithUsers(meetingId);
    const lines = participants.length === 0
      ? ['_No participants._']
      : participants.map(p => {
          const updated = (p as any).completed_at ? relativeTime(new Date((p as any).completed_at)) : '—';
          return `• <@${p.slack_user_id}> — ${humaniseStatus(p.status)} (${updated})`;
        });
    await respond({
      response_type: 'ephemeral',
      text: `*${meeting.title}* — status\n${lines.join('\n')}`,
    });
  });

  app.action('meeting_change_action', async ({ ack, body, action, client }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const meeting = await meetingService.getById(meetingId);
    if (!meeting) return;
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: buildChangeActionModal(meetingId, meeting.document_action),
    });
  });

  app.action('meeting_send_reminder', async ({ ack, action, respond, client }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const meeting = await meetingService.getById(meetingId);
    if (!meeting) return;
    const participants = await meetingService.getParticipantsWithUsers(meetingId);
    const targets = participants.filter(p => p.status !== 'completed');
    let sent = 0;
    for (const p of targets) {
      try {
        await nudgeService.sendNudge(meeting, p as any);
        sent++;
      } catch (err: any) {
        console.error('[reminder] send failed:', err?.message);
      }
    }
    await respond({
      response_type: 'ephemeral',
      text: `Reminders sent to ${sent} participant(s).`,
    });
    await updateControlCard(client as any, meetingService, meeting);
  });

  app.action('meeting_cancel', async ({ ack, action, client }) => {
    await ack();
    const meetingId = (action as any).value as string;
    await meetingService.updateStatus(meetingId, 'cancelled');
    const meeting = await meetingService.getById(meetingId);
    if (meeting) {
      await updateControlCard(client as any, meetingService, meeting);
    }
  });
}
```

> **Note for implementer:** verify `nudgeService.sendNudge(meeting, participant)` exists with that signature. If the existing API differs (e.g. `sendNudges(meetingId)` for batch), use whichever single-participant method is available, or adapt to call the batch method.

- [ ] **Step 2: Run all tests**

Run: `npm test -- --run`
Expected: PASS (compiles, no behavior change yet).

- [ ] **Step 3: Commit**

```bash
git add src/bot/control-actions.ts
git commit -m "feat: add per-meeting control card button handlers"
```

---

## Task 8: DM bootstrap — persistent "➕ Create meeting" message

**Files:**
- Create: `src/bot/dm-bootstrap.ts`

- [ ] **Step 1: Implement `bootstrapOperatorDms`**

Create `src/bot/dm-bootstrap.ts`:

```typescript
import type { WebClient } from '@slack/web-api';
import type { Pool } from 'pg';
import type { MeetingService } from '../services/meeting';

const PROMPT_BLOCKS = [
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*Meetassist*\nClick below to create a meeting. You can also still use `/ma` slash commands.',
    },
  },
  {
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: 'open_create_modal',
        text: { type: 'plain_text', text: '➕ Create meeting' },
        style: 'primary',
      },
    ],
  },
];

export async function bootstrapOperatorDms(
  pool: Pool,
  meetingService: MeetingService,
  client: WebClient,
  operatorSlackIds: string[],
): Promise<void> {
  for (const slackId of operatorSlackIds) {
    try {
      const dm = await client.conversations.open({ users: slackId });
      const channelId = (dm.channel as any)?.id;
      if (!channelId) continue;

      const user = await meetingService.getUserBySlackId(slackId);
      const existingTs = (user as any)?.operator_dm_message_ts;
      const existingChannel = (user as any)?.operator_dm_channel_id;

      // If we have a stored ts, try updating to confirm it's still alive.
      if (existingTs && existingChannel === channelId) {
        try {
          await client.chat.update({ channel: channelId, ts: existingTs, blocks: PROMPT_BLOCKS, text: 'Meetassist' });
          continue;
        } catch (err: any) {
          // fall through to repost
        }
      }

      const result = await client.chat.postMessage({
        channel: channelId,
        blocks: PROMPT_BLOCKS,
        text: 'Meetassist — create a meeting',
      });
      if (result.ts && user) {
        await pool.query(
          `UPDATE users SET operator_dm_channel_id = $1, operator_dm_message_ts = $2 WHERE id = $3`,
          [channelId, result.ts, user.id],
        );
      }
    } catch (err: any) {
      console.error(`[dm-bootstrap] failed for ${slackId}:`, err?.message ?? err);
    }
  }
}
```

- [ ] **Step 2: Run all tests**

Run: `npm test -- --run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/bot/dm-bootstrap.ts
git commit -m "feat: add operator DM bootstrap"
```

---

## Task 9: Wire everything into `index.ts` + register handlers

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Wire registrations and bootstrap call**

Modify `src/index.ts` — add imports near the top:

```typescript
import { registerModalHandlers } from './bot/modals';
import { registerControlActions } from './bot/control-actions';
import { bootstrapOperatorDms } from './bot/dm-bootstrap';
```

After the existing `registerActions(...)` call:

```typescript
registerModalHandlers(meetingService, confluenceService);
registerControlActions(meetingService, nudgeService);
```

After the existing operator-seed loop, add:

```typescript
await bootstrapOperatorDms(pool, meetingService, app.client, operatorIds);
```

- [ ] **Step 2: Run all tests**

Run: `npm test -- --run`
Expected: PASS.

- [ ] **Step 3: Build to confirm no TypeScript errors**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire modal + control card handlers into bootstrap"
```

---

## Task 10: Scheduler — refresh stale control cards + archive old ones

**Files:**
- Modify: `src/scheduler/cron.ts`
- Modify: `src/index.ts` (pass `app.client` into scheduler)

- [ ] **Step 1: Extend `startScheduler` signature**

Modify `src/scheduler/cron.ts`:

```typescript
import cron from 'node-cron';
import type { WebClient } from '@slack/web-api';
import type { MeetingService } from '../services/meeting';
import type { RelayService } from '../bot/relay';
import { updateControlCard } from '../bot/control-card';

export function startScheduler(
  meetingService: MeetingService,
  relayService: RelayService,
  client: WebClient,
): void {
  // ... existing two cron jobs unchanged ...

  cron.schedule('*/5 * * * *', async () => {
    try {
      const stale = await meetingService.getMeetingsWithStaleCard();
      for (const m of stale) {
        await updateControlCard(client, meetingService, m as any);
      }
    } catch (err: any) {
      console.error('[scheduler] card refresh failed:', err?.message ?? err);
    }
  });
}
```

(Keep the existing `cron.schedule('0 * * * *', ...)` and `cron.schedule('0 8 * * *', ...)` blocks intact — only add the new 5-minute job.)

- [ ] **Step 2: Update `index.ts` call site**

Change the existing line:

```typescript
startScheduler(meetingService, relayService);
```

to:

```typescript
startScheduler(meetingService, relayService, app.client);
```

- [ ] **Step 3: Run all tests + typecheck**

Run: `npm test -- --run && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/scheduler/cron.ts src/index.ts
git commit -m "feat: scheduler refreshes stale control cards"
```

---

## Task 11: Existing button actions also refresh the card

**Files:**
- Modify: `src/bot/actions.ts`

- [ ] **Step 1: Add card update to mark_done / clarification / blocked handlers**

Modify `src/bot/actions.ts` — add import:

```typescript
import { updateControlCard } from './control-card';
```

In `mark_done`, `need_clarification`, `cannot_complete` handlers, after the `await publishDashboard()` line, add:

```typescript
const refreshed = await meetingService.getById(meetingId);
if (refreshed) {
  await updateControlCard(app.client, meetingService, refreshed);
}
```

- [ ] **Step 2: Run all tests + typecheck**

Run: `npm test -- --run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/bot/actions.ts
git commit -m "feat: refresh control card on participant status changes"
```

---

## Task 12: `/ma create` hint

**Files:**
- Modify: `src/bot/commands.ts`

- [ ] **Step 1: Add hint at start of `/ma create` flow**

In `src/bot/commands.ts`, find the start of the `/ma create` handler (the message that begins the wizard) and prepend a hint message:

```typescript
await say('💡 Tip: you can also use the *➕ Create meeting* button in this DM for a faster form-based flow. Continuing with text wizard…');
```

(Place it immediately before the existing first wizard prompt — find the first `await say(` call inside the `case 'create'` or equivalent block.)

- [ ] **Step 2: Run all tests**

Run: `npm test -- --run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands.ts
git commit -m "feat: hint at form-based flow at /ma create start"
```

---

## Task 13: End-to-end smoke (manual)

Since the bot is socket-mode and Slack-driven, end-to-end behavior must be verified against a live Slack workspace.

- [ ] **Step 1: Push, redeploy on Railway, run smoke checklist**

Smoke checklist (perform in Slack against the deployed bot):

1. DM the bot. Confirm a "➕ Create meeting" message appears (posted by `bootstrapOperatorDms`).
2. Click the button. Confirm the modal opens with all six fields.
3. Submit with empty title — confirm inline validation error on the title field.
4. Submit with a malformed URL (no `/pages/`) — confirm inline error on `document_url`.
5. Submit with a past datetime — confirm inline error on `start_time`.
6. Submit with no participants — confirm inline error.
7. Submit a valid form. Confirm:
   - A new meeting appears in `/ma list`.
   - A control card is posted to the operator DM with all four buttons.
   - All picked participants receive their first nudge DM (existing nudge flow).
8. Click "View status" on the card → ephemeral with participant list.
9. Click "Change action" → modal opens with current action preselected. Change → card updates in place.
10. Click "Send reminder" → ephemeral confirmation, participants get a fresh nudge.
11. Have a participant click "I've done it" → control card updates progress (1/N done) within 5 minutes.
12. Click "Cancel" → confirmation dialog → confirm → card updates to strikethrough state, no buttons.
13. Type `/ma create` → confirm the new hint message appears, wizard still works.

- [ ] **Step 2: Note any failures, dispatch fix subagents per failure**

If any of the above fails, file the failure as a follow-up task and dispatch a fix.

---

## Out of scope (re-stated for clarity)

- External (non-Slack) participants
- App Home tab
- NLP/conversational intent
- Removing slash commands
- Backfilling control cards onto already-active meetings (only newly created ones get one)
