# Action Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when a participant marks an action as `done` without performing it on the Confluence document, and DM the operator with a one-click follow-up nudge.

**Architecture:** A new `verification` service exposes `scheduleVerification(meetingId, userId)` which sets a 60-second in-process `setTimeout`. When it fires, `runVerification` re-fetches the meeting + participant + Confluence comments, and if the participant's email is missing from comment authors (and the action is verifiable), DMs the meeting organizer with two buttons. Two new button handlers (`verification_nudge_yes` / `verification_nudge_skip`) handle the operator's response.

**Tech Stack:** TypeScript, Vitest (`vitest run`), `pg` Pool, `@slack/bolt` 4.x, `axios`. No DB schema changes. No new env vars.

**Spec:** `docs/superpowers/specs/2026-05-29-action-verification-design.md`

---

### Task 1: Add `getUserById` to MeetingService

**Files:**
- Modify: `src/services/meeting.ts` (add new method)
- Test: `tests/services/meeting.test.ts` (add new test case)

**Why:** `runVerification` needs to resolve `meeting.organizer_user_id` (a UUID) to a `slack_user_id` so it can DM the operator. The existing `getUserBySlackId` only goes the other direction.

- [ ] **Step 1: Write the failing test**

In `tests/services/meeting.test.ts`, append a new test inside the existing `describe('MeetingService', ...)` block (insert before the closing `});` at the end of the file):

```typescript
  it('getUserById returns the user row when found', async () => {
    const user = { id: 'u1', slack_user_id: 'U001', email: 'a@b.com', display_name: 'Alice' };
    const pool = makePool([user]);
    const service = new MeetingService(pool);
    const result = await service.getUserById('u1');
    expect(result).not.toBeNull();
    expect(result!.slack_user_id).toBe('U001');
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('users');
    expect(call[0]).toContain('id = $1');
    expect(call[1]).toEqual(['u1']);
  });

  it('getUserById returns null when no row', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    const result = await service.getUserById('missing');
    expect(result).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --run tests/services/meeting.test.ts`
Expected: FAIL — `service.getUserById is not a function`.

- [ ] **Step 3: Implement `getUserById`**

In `src/services/meeting.ts`, add the method to the `MeetingService` class. Place it directly after the existing `getUserBySlackId` method (search for `async getUserBySlackId` and insert after its closing `}`):

```typescript
  async getUserById(id: string): Promise<User | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM users WHERE id = $1`, [id]
    );
    return rows[0] ?? null;
  }
```

- [ ] **Step 4: Run tests to verify passing**

Run: `npm test -- --run tests/services/meeting.test.ts`
Expected: PASS — all tests in `MeetingService` pass, including the two new ones.

- [ ] **Step 5: Run full test suite**

Run: `npm test -- --run`
Expected: PASS — all 35+ existing tests still pass; 2 new tests added.

- [ ] **Step 6: Commit**

```bash
git add src/services/meeting.ts tests/services/meeting.test.ts
git commit -m "feat: add MeetingService.getUserById for organizer lookup"
```

---

### Task 2: Verification module skeleton + `runVerification` for irrelevant cases

**Files:**
- Create: `src/services/verification.ts`
- Create: `tests/services/verification.test.ts`

**Why:** Establish the module structure, the singleton config pattern, and cover the four "silent skip" cases (meeting deleted, participant removed, action is `read`, status is not `completed`) before adding the real verification logic. This locks in the test pattern and makes later tasks additive.

- [ ] **Step 1: Write the failing tests**

Create `tests/services/verification.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureVerification, runVerification } from '../../src/services/verification';

function makeDeps(overrides: any = {}) {
  const meetingService = {
    getById: vi.fn().mockResolvedValue(null),
    getParticipantsWithUsers: vi.fn().mockResolvedValue([]),
    getUserById: vi.fn().mockResolvedValue(null),
    incrementReminderCount: vi.fn().mockResolvedValue(undefined),
    ...overrides.meetingService,
  };
  const confluenceService = {
    getComments: vi.fn().mockResolvedValue([]),
    ...overrides.confluenceService,
  };
  const relayService = {
    sendToParticipant: vi.fn().mockResolvedValue({ channel: 'D1', ts: '1.0' }),
    ...overrides.relayService,
  };
  const nudgeService = {
    recordNudge: vi.fn().mockResolvedValue(undefined),
    ...overrides.nudgeService,
  };
  const slackClient = {
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, channel: 'D1', ts: '1.0' }) },
    ...overrides.slackClient,
  };
  return { meetingService, confluenceService, relayService, nudgeService, slackClient };
}

describe('runVerification — irrelevant cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns silently when meeting not found', async () => {
    const deps = makeDeps();
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.confluenceService.getComments).not.toHaveBeenCalled();
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('returns silently when participant not found on the meeting', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue({
          id: 'm1', confluence_page_id: '123', document_action: 'comment',
          organizer_user_id: 'org', title: 'T',
        }),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([
          { user_id: 'someone-else', status: 'completed', email: 'x@y.com' },
        ]),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.confluenceService.getComments).not.toHaveBeenCalled();
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('returns silently when document_action is read', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue({
          id: 'm1', confluence_page_id: '123', document_action: 'read',
          organizer_user_id: 'org', title: 'T',
        }),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([
          { user_id: 'u1', status: 'completed', email: 'a@b.com' },
        ]),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.confluenceService.getComments).not.toHaveBeenCalled();
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('returns silently when participant status is no longer completed', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue({
          id: 'm1', confluence_page_id: '123', document_action: 'comment',
          organizer_user_id: 'org', title: 'T',
        }),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([
          { user_id: 'u1', status: 'pending', email: 'a@b.com' },
        ]),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.confluenceService.getComments).not.toHaveBeenCalled();
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --run tests/services/verification.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/verification'`.

- [ ] **Step 3: Create `src/services/verification.ts` skeleton**

```typescript
import type { MeetingService } from './meeting';
import type { NudgeService } from './nudge';
import type { ConfluenceService } from './confluence';
import type { RelayService } from '../bot/relay';
import type { WebClient } from '@slack/web-api';

interface VerificationDeps {
  meetingService: MeetingService;
  nudgeService: NudgeService;
  confluenceService: ConfluenceService;
  relayService: RelayService;
  slackClient: WebClient;
}

let deps: VerificationDeps | null = null;

export function configureVerification(d: VerificationDeps): void {
  deps = d;
}

export const VERIFICATION_DELAY_MS = 60_000;
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

export async function runVerification(meetingId: string, userId: string): Promise<void> {
  if (!deps) return;

  try {
    const meeting = await deps.meetingService.getById(meetingId);
    if (!meeting) return;

    const participants = await deps.meetingService.getParticipantsWithUsers(meetingId);
    const participant = (participants as any[]).find((p) => p.user_id === userId);
    if (!participant) return;

    if (meeting.document_action === 'read') return;
    if (participant.status !== 'completed') return;

    // Verification logic (Tasks 3+) goes here.
  } catch (err: any) {
    console.error('[verification] failed:', err?.response?.data ?? err?.message ?? err);
  }
}
```

- [ ] **Step 4: Run tests to verify passing**

Run: `npm test -- --run tests/services/verification.test.ts`
Expected: PASS — all 4 tests pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test -- --run`
Expected: PASS — full suite still green.

- [ ] **Step 6: Commit**

```bash
git add src/services/verification.ts tests/services/verification.test.ts
git commit -m "feat: scaffold verification service with skip-cases"
```

---

### Task 3: Verification — comment-found and comment-missing logic

**Files:**
- Modify: `src/services/verification.ts` (extend `runVerification`)
- Modify: `tests/services/verification.test.ts` (add new tests)

**Why:** Now we add the actual decision: did the participant comment on the doc? If yes, silent. If no, post a DM to the organizer with the two buttons.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block at the bottom of `tests/services/verification.test.ts`, before the file ends:

```typescript
describe('runVerification — comment check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseMeeting = {
    id: 'm1',
    confluence_page_id: '123',
    document_action: 'comment',
    organizer_user_id: 'org-uuid',
    title: 'Take Template Ownership',
    document_url: 'https://x.example/doc',
    document_title: 'Doc',
  };

  const baseParticipant = {
    user_id: 'u1',
    status: 'completed',
    email: 'alice@example.com',
    display_name: 'Alice',
    slack_user_id: 'U_ALICE',
  };

  function depsWithMatchingComment(commentEmail: string) {
    return makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
        getUserById: vi.fn().mockResolvedValue({ id: 'org-uuid', slack_user_id: 'U_ORG', display_name: 'Op' }),
      },
      confluenceService: {
        getComments: vi.fn().mockResolvedValue([{ authorEmail: commentEmail }]),
      },
    });
  }

  it('stays silent when participant has commented on the doc', async () => {
    const deps = depsWithMatchingComment('alice@example.com');
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('comment match is case-insensitive and trimmed', async () => {
    const deps = depsWithMatchingComment('  Alice@Example.COM  ');
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('DMs the organizer when no matching comment exists', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
        getUserById: vi.fn().mockResolvedValue({ id: 'org-uuid', slack_user_id: 'U_ORG', display_name: 'Op' }),
      },
      confluenceService: {
        getComments: vi.fn().mockResolvedValue([{ authorEmail: 'someone-else@example.com' }]),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');

    expect(deps.slackClient.chat.postMessage).toHaveBeenCalledTimes(1);
    const call = deps.slackClient.chat.postMessage.mock.calls[0][0];
    expect(call.channel).toBe('U_ORG');
    expect(call.text).toContain('Alice');
    expect(call.text).toContain('Take Template Ownership');
    const blocks = JSON.stringify(call.blocks);
    expect(blocks).toContain('verification_nudge_yes');
    expect(blocks).toContain('verification_nudge_skip');
    expect(blocks).toContain('m1|u1');
  });

  it('DMs the organizer for provide_input action', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue({ ...baseMeeting, document_action: 'provide_input' }),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
        getUserById: vi.fn().mockResolvedValue({ id: 'org-uuid', slack_user_id: 'U_ORG', display_name: 'Op' }),
      },
      confluenceService: { getComments: vi.fn().mockResolvedValue([]) },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('DMs the organizer for approve action', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue({ ...baseMeeting, document_action: 'approve' }),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
        getUserById: vi.fn().mockResolvedValue({ id: 'org-uuid', slack_user_id: 'U_ORG', display_name: 'Op' }),
      },
      confluenceService: { getComments: vi.fn().mockResolvedValue([]) },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('treats empty participant email as unverified and DMs the organizer', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([{ ...baseParticipant, email: '' }]),
        getUserById: vi.fn().mockResolvedValue({ id: 'org-uuid', slack_user_id: 'U_ORG', display_name: 'Op' }),
      },
      confluenceService: {
        getComments: vi.fn().mockResolvedValue([{ authorEmail: 'someone@example.com' }]),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('catches Confluence errors, logs, and does not DM', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
        getUserById: vi.fn().mockResolvedValue({ id: 'org-uuid', slack_user_id: 'U_ORG', display_name: 'Op' }),
      },
      confluenceService: {
        getComments: vi.fn().mockRejectedValue(new Error('confluence boom')),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    const logged = (errSpy.mock.calls[0] ?? []).join(' ');
    expect(logged).toContain('[verification]');
    errSpy.mockRestore();
  });

  it('does not DM if organizer user cannot be resolved', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
        getUserById: vi.fn().mockResolvedValue(null),
      },
      confluenceService: {
        getComments: vi.fn().mockResolvedValue([{ authorEmail: 'someone@example.com' }]),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --run tests/services/verification.test.ts`
Expected: FAIL — the new tests fail because the verification logic and the DM aren't implemented.

- [ ] **Step 3: Replace the body of `runVerification`**

In `src/services/verification.ts`, replace the existing `runVerification` function with:

```typescript
export async function runVerification(meetingId: string, userId: string): Promise<void> {
  if (!deps) return;

  try {
    const meeting = await deps.meetingService.getById(meetingId);
    if (!meeting) return;

    const participants = await deps.meetingService.getParticipantsWithUsers(meetingId);
    const participant = (participants as any[]).find((p) => p.user_id === userId);
    if (!participant) return;

    if (meeting.document_action === 'read') return;
    if (participant.status !== 'completed') return;

    const comments = await deps.confluenceService.getComments(meeting.confluence_page_id);
    const participantEmail = (participant.email ?? '').trim().toLowerCase();
    const verified = participantEmail !== '' && comments.some((c) => {
      const ce = (c.authorEmail ?? '').trim().toLowerCase();
      return ce !== '' && ce === participantEmail;
    });

    if (verified) return;

    const organizer = await deps.meetingService.getUserById(meeting.organizer_user_id);
    if (!organizer) return;

    const actionLabel = humaniseActionForDm(meeting.document_action);
    const text =
      `Meetassist: *${escapeForSlack(participant.display_name)}* marked *${escapeForSlack(meeting.title)}* as done, ` +
      `but I don't see their ${actionLabel} on the doc yet.\n\nSend a follow-up nudge?`;
    const value = `${meeting.id}|${userId}`;

    await deps.slackClient.chat.postMessage({
      channel: organizer.slack_user_id,
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              style: 'primary',
              text: { type: 'plain_text', text: 'Yes, send nudge' },
              action_id: 'verification_nudge_yes',
              value,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Skip' },
              action_id: 'verification_nudge_skip',
              value,
            },
          ],
        },
      ],
    });
  } catch (err: any) {
    console.error('[verification] failed:', err?.response?.data ?? err?.message ?? err);
  }
}

function humaniseActionForDm(action: string): string {
  switch (action) {
    case 'comment':           return 'comment';
    case 'provide_input':     return 'input';
    case 'approve':           return 'approval';
    case 'confirm_decision':  return 'decision';
    default:                  return action;
  }
}

function escapeForSlack(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 4: Run tests to verify passing**

Run: `npm test -- --run tests/services/verification.test.ts`
Expected: PASS — all tests in verification.test.ts pass (the 4 from Task 2 + the 8 new ones).

- [ ] **Step 5: Run full test suite**

Run: `npm test -- --run`
Expected: PASS — full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/services/verification.ts tests/services/verification.test.ts
git commit -m "feat: detect missing comments and DM organizer with nudge prompt"
```

---

### Task 4: Wire button handlers — `verification_nudge_yes` and `verification_nudge_skip`

**Files:**
- Modify: `src/bot/actions.ts` (add two new button handlers)
- Modify: `tests/services/verification.test.ts` (add tests for handler behavior — call the registered handlers indirectly is overkill; instead extract the handler logic into exported functions on the verification service for testability)
- Modify: `src/services/verification.ts` (export `handleVerificationNudgeYes` and `handleVerificationNudgeSkip` for testing; the action handlers in `actions.ts` thin-wrap these)

**Why:** Operator clicks "Yes, send nudge" or "Skip". We extract the handler logic into the verification service (testable in isolation), then wire two thin Bolt action handlers in `actions.ts` that delegate to it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/services/verification.test.ts` (before the final closing brace of the file — i.e. after the last `describe` block, before EOF):

```typescript
import { handleVerificationNudgeYes, handleVerificationNudgeSkip } from '../../src/services/verification';

describe('verification button handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseMeeting = {
    id: 'm1',
    title: 'Take Template Ownership',
    document_url: 'https://x.example/doc',
    document_action: 'comment',
  };
  const baseParticipant = {
    user_id: 'u1',
    display_name: 'Alice',
    slack_user_id: 'U_ALICE',
    email: 'a@b.com',
    status: 'completed',
  };

  it('handleVerificationNudgeYes sends DM to participant, records nudge, increments reminder, replaces original', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
      },
    });
    configureVerification(deps as any);

    await handleVerificationNudgeYes('m1|u1', respond);

    expect(deps.relayService.sendToParticipant).toHaveBeenCalledTimes(1);
    const sendArgs = deps.relayService.sendToParticipant.mock.calls[0][0];
    expect(sendArgs.slackUserId).toBe('U_ALICE');
    expect(sendArgs.text).toContain('Take Template Ownership');
    expect(sendArgs.text).toContain('https://x.example/doc');

    expect(deps.nudgeService.recordNudge).toHaveBeenCalledTimes(1);
    const recordArgs = deps.nudgeService.recordNudge.mock.calls[0][0];
    expect(recordArgs.user_id).toBe('u1');
    expect(recordArgs.meeting_id).toBe('m1');
    expect(recordArgs.type).toBe('reminder');

    expect(deps.meetingService.incrementReminderCount).toHaveBeenCalledWith('m1', 'u1');

    expect(respond).toHaveBeenCalledTimes(1);
    const respondArgs = respond.mock.calls[0][0];
    expect(respondArgs.replace_original).toBe(true);
    expect(respondArgs.text).toContain('Nudge sent');
    expect(respondArgs.text).toContain('Alice');
  });

  it('handleVerificationNudgeYes returns silently if meeting deleted', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(null),
        getParticipantsWithUsers: vi.fn(),
      },
    });
    configureVerification(deps as any);
    await handleVerificationNudgeYes('m1|u1', respond);
    expect(deps.relayService.sendToParticipant).not.toHaveBeenCalled();
    expect(deps.nudgeService.recordNudge).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('handleVerificationNudgeYes returns silently if participant removed', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([]),
      },
    });
    configureVerification(deps as any);
    await handleVerificationNudgeYes('m1|u1', respond);
    expect(deps.relayService.sendToParticipant).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('handleVerificationNudgeSkip replaces original DM with Skipped', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    configureVerification(makeDeps() as any);
    await handleVerificationNudgeSkip('m1|u1', respond);
    expect(respond).toHaveBeenCalledTimes(1);
    const args = respond.mock.calls[0][0];
    expect(args.replace_original).toBe(true);
    expect(args.text).toContain('Skipped');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --run tests/services/verification.test.ts`
Expected: FAIL — `handleVerificationNudgeYes` / `handleVerificationNudgeSkip` are not exported.

- [ ] **Step 3: Implement and export both handlers in `src/services/verification.ts`**

Append to the end of `src/services/verification.ts`:

```typescript
type RespondFn = (args: { replace_original?: boolean; text?: string; blocks?: any[] }) => Promise<unknown>;

export async function handleVerificationNudgeYes(value: string, respond: RespondFn): Promise<void> {
  if (!deps) return;
  const [meetingId, userId] = value.split('|');
  if (!meetingId || !userId) return;

  try {
    const meeting = await deps.meetingService.getById(meetingId);
    if (!meeting) return;

    const participants = await deps.meetingService.getParticipantsWithUsers(meetingId);
    const participant = (participants as any[]).find((p) => p.user_id === userId);
    if (!participant) return;

    const actionLabel = humaniseActionForDm(meeting.document_action);
    const text =
      `Meetassist: Just checking — your action for *${meeting.title}* was to ${actionLabel}, ` +
      `but I don't see it on the doc yet. Could you take a moment to follow up?\n${meeting.document_url}`;

    const { channel, ts } = await deps.relayService.sendToParticipant({
      slackUserId: participant.slack_user_id,
      text,
    });
    await deps.nudgeService.recordNudge({
      user_id: userId,
      meeting_id: meetingId,
      slack_channel_id: channel,
      message_ts: ts,
      type: 'reminder',
    });
    await deps.meetingService.incrementReminderCount(meetingId, userId);

    await respond({
      replace_original: true,
      text: `✓ Nudge sent to ${participant.display_name}.`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `✓ Nudge sent to *${escapeForSlack(participant.display_name)}*.` } },
      ],
    });
  } catch (err: any) {
    console.error('[verification] nudge_yes failed:', err?.response?.data ?? err?.message ?? err);
  }
}

export async function handleVerificationNudgeSkip(_value: string, respond: RespondFn): Promise<void> {
  await respond({
    replace_original: true,
    text: 'Skipped.',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Skipped.' } }],
  });
}
```

- [ ] **Step 4: Run tests to verify passing**

Run: `npm test -- --run tests/services/verification.test.ts`
Expected: PASS — all verification tests pass.

- [ ] **Step 5: Wire Bolt action handlers in `src/bot/actions.ts`**

Add the import at the top of `src/bot/actions.ts` (after the existing imports):

```typescript
import { handleVerificationNudgeYes, handleVerificationNudgeSkip } from '../services/verification';
```

Then add two new action handlers inside `registerActions`, immediately before the closing `}` of the `registerActions` function (i.e. after the `app.action(/^send_nudge_skip_(.+)$/, ...)` block):

```typescript
  app.action('verification_nudge_yes', async ({ ack, action, respond }) => {
    await ack();
    const value = (action as any).value as string;
    await handleVerificationNudgeYes(value, respond as any);
  });

  app.action('verification_nudge_skip', async ({ ack, action, respond }) => {
    await ack();
    const value = (action as any).value as string;
    await handleVerificationNudgeSkip(value, respond as any);
  });
```

- [ ] **Step 6: Run full test suite + build**

Run: `npm test -- --run && npm run build`
Expected: PASS — tests green, TypeScript build clean.

- [ ] **Step 7: Commit**

```bash
git add src/services/verification.ts src/bot/actions.ts tests/services/verification.test.ts
git commit -m "feat: handle operator's verification nudge response"
```

---

### Task 5: Trigger `scheduleVerification` from the `mark_done` button click

**Files:**
- Modify: `src/bot/actions.ts:10-31` (extend the `mark_done` handler to call `scheduleVerification`)

**Why:** Wire the trigger. After a participant marks done and the dashboard publishes, schedule the 60-second verification timer.

- [ ] **Step 1: Add the import**

In `src/bot/actions.ts`, extend the existing import line for verification (added in Task 4) so it also imports `scheduleVerification`. Replace:

```typescript
import { handleVerificationNudgeYes, handleVerificationNudgeSkip } from '../services/verification';
```

with:

```typescript
import { handleVerificationNudgeYes, handleVerificationNudgeSkip, scheduleVerification } from '../services/verification';
```

- [ ] **Step 2: Add the schedule call to the `mark_done` handler**

In `src/bot/actions.ts`, find the existing `mark_done` handler (currently at lines 10–31). After the `await publishDashboard();` line (currently line 30), add a new line:

```typescript
    scheduleVerification(meetingId, user.id);
```

So the handler ends like this:

```typescript
    const meeting = await meetingService.getById(meetingId);
    if (meeting) {
      await relayService.notifyOperator(
        `[Meetassist] <@${slackUserId}> marked *${meeting.title}* as done.`
      );
    }
    await publishDashboard();
    scheduleVerification(meetingId, user.id);
  });
```

- [ ] **Step 3: Build to verify TypeScript types**

Run: `npm run build`
Expected: PASS — clean build.

- [ ] **Step 4: Run full test suite**

Run: `npm test -- --run`
Expected: PASS — all existing tests still pass. (No new test for `scheduleVerification` — it's a 4-line `setTimeout` wrapper; covered indirectly via the `runVerification` tests.)

- [ ] **Step 5: Commit**

```bash
git add src/bot/actions.ts
git commit -m "feat: schedule verification 60s after mark_done click"
```

---

### Task 6: Boot wiring in `src/index.ts`

**Files:**
- Modify: `src/index.ts` (add `configureVerification` call in `main`)

**Why:** Without this, the verification module's `deps` is never set, and every call to `runVerification` returns silently. This is the wire-up that activates the feature.

- [ ] **Step 1: Add the import**

In `src/index.ts`, add a new import line after the existing `configureDashboard` import (currently line 14):

```typescript
import { configureVerification } from './services/verification';
```

- [ ] **Step 2: Call `configureVerification` after services are constructed**

In `src/index.ts`, after the existing `configureDashboard({ ... });` block (currently lines 32–37), add:

```typescript
  configureVerification({
    meetingService,
    nudgeService,
    confluenceService,
    relayService,
    slackClient: app.client,
  });
```

- [ ] **Step 3: Build to verify TypeScript types**

Run: `npm run build`
Expected: PASS — clean build.

- [ ] **Step 4: Run full test suite**

Run: `npm test -- --run`
Expected: PASS — full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire verification service at boot"
```

---

### Task 7: Final integration check + push

**Files:** None — verification step.

**Why:** Confirm full suite + build + nothing left uncommitted before deploy.

- [ ] **Step 1: Run full test suite**

Run: `npm test -- --run`
Expected: PASS — all tests green.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS — clean TypeScript build.

- [ ] **Step 3: Verify no leftover changes**

Run: `git status`
Expected: working tree clean.

- [ ] **Step 4: Push to origin**

Run: `git push`
Expected: pushes new commits to `origin/main`. Railway redeploys automatically.

- [ ] **Step 5: Manual smoke test (after Railway redeploy completes)**

1. In Slack: confirm an active meeting with `document_action: comment` (or create one via `/ma create`).
2. `/ma send <id>` — send the pre-meeting nudge to a test participant.
3. As the test participant: click "Mark done" without commenting on the Confluence doc.
4. Wait 60 seconds.
5. Confirm the meeting organizer receives a DM from Meetassist:
   - Mentions the participant's name
   - Mentions the meeting title
   - Has two buttons: "Yes, send nudge" and "Skip"
6. Click "Yes, send nudge".
7. Confirm:
   - The original DM is replaced with "✓ Nudge sent to <name>."
   - The participant receives a follow-up DM with the doc URL.
8. Repeat the test with a participant who DOES comment on the doc before clicking "Mark done": no DM should arrive after 60s.
9. Repeat with a meeting whose `document_action` is `read`: no DM should arrive (verification is skipped).

---

## Self-Review Notes

After writing the plan, I checked it against the spec:

**Spec coverage:**
- §1 Overview → Tasks 2 + 3 implement the skip-cases and the comment-check.
- §2 File Structure → Task 1 adds `getUserById`; Task 2 creates `verification.ts` + tests; Task 5 modifies `actions.ts`; Task 6 modifies `index.ts`. All covered.
- §3 Verification Logic → Task 2 covers steps 1–4 (skip cases); Task 3 covers steps 5–8 (comment check + DM).
- §3 Edge cases (meeting deleted, participant removed, action=read, status≠completed, empty email, Confluence error, organizer not found) → all explicit tests in Tasks 2 + 3.
- §4 Operator DM format → Task 3 builds the blocks with `verification_nudge_yes` / `verification_nudge_skip` action_ids and `<meetingId>|<userId>` value.
- §4 Button handlers → Task 4 implements both handlers + tests; Task 4 also wires the Bolt action registrations.
- §4 Idempotency via `replace_original: true` → Task 4 uses it.
- §4 No participant status change → confirmed; no `updateParticipantStatus` call in handler code.
- §5 Module-level timer Map and `VERIFICATION_DELAY_MS` → Task 2 implements verbatim.
- §5 No cancel-on-status-change (status check at step 4 catches stale timers) → confirmed in Task 2 logic.
- §6 Testing → Tasks 1 (2 tests for getUserById), 2 (4 tests for skip cases), 3 (8 tests for comment-check), 4 (4 tests for handlers). Plus the smoke test in Task 7.
- §7 Out of scope items (no DB change, no continuous sweep, no keyword detection, no auto-nudge, no dashboard markers) → none of these are in any task. Good.
- §8 Migration & rollout → Task 7 covers the deploy + smoke test.

**Type/name consistency:** `runVerification`, `scheduleVerification`, `configureVerification`, `handleVerificationNudgeYes`, `handleVerificationNudgeSkip` — used identically in every task. `VerificationDeps` interface props (`meetingService`, `nudgeService`, `confluenceService`, `relayService`, `slackClient`) — consistent across Task 2 (definition), Task 3 (usage), Task 4 (handler usage), Task 6 (boot wiring). Action IDs `verification_nudge_yes` / `verification_nudge_skip` — consistent in Task 3 (DM blocks), Task 4 (Bolt handler registration + tests). Value format `<meetingId>|<userId>` — consistent in Task 3 (DM payload), Task 4 (handler parses).

**No placeholders:** Every step has concrete code, file paths, run commands, and expected outputs.
