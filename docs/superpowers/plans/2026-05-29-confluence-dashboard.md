# Confluence Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-updating Confluence dashboard page that mirrors every active meeting and participant status in real time, refreshed on every state mutation.

**Architecture:** A new `src/services/dashboard.ts` module owns rendering and publishing. It reads active meetings via `MeetingService.listActive()` (already supports the no-arg form), pulls the latest participant DM text via a new `NudgeService.getLatestReply()`, formats Confluence storage-format XHTML, and writes via a new `ConfluenceService.updatePage()`. Trigger points in `commands.ts`, `actions.ts`, and `relay.ts` call `publishDashboard()` after every state change. All write failures are caught and logged — they never break the underlying operation.

**Tech Stack:** TypeScript, axios (existing dependency for Confluence calls), PostgreSQL via `pg`, Vitest for tests. No new runtime dependencies.

---

## Pre-flight: Verify environment

Before starting, the engineer should ensure:

```bash
cd /Users/i525473/ClaudeCode/slackbot
npm install
npm test
```

All existing tests must pass (currently 11 tests across `tests/services/` and `tests/db/`). If any fail, stop and investigate before starting tasks.

The branch should be `feat/confluence-dashboard`, branched off latest `main`:

```bash
git checkout main
git pull
git checkout -b feat/confluence-dashboard
```

---

## Task 1: Add `getLatestReply` to NudgeService

**Files:**
- Modify: `src/services/nudge.ts` — add new method
- Test: `tests/services/nudge.test.ts` — create (does not yet exist)

- [ ] **Step 1: Create the test file**

Create `tests/services/nudge.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { NudgeService } from '../../src/services/nudge';

function makePool(rows: any[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as any;
}

describe('NudgeService.getLatestReply', () => {
  it('returns the most recent participant message text', async () => {
    const pool = makePool([{ raw_text: 'looks good' }]);
    const service = new NudgeService(pool);

    const reply = await service.getLatestReply('mtg-1', 'user-1');

    expect(reply).toBe('looks good');
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('participant_messages');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).toContain('LIMIT 1');
    expect(pool.query.mock.calls[0][1]).toEqual(['mtg-1', 'user-1']);
  });

  it('returns null when no messages exist', async () => {
    const pool = makePool([]);
    const service = new NudgeService(pool);

    const reply = await service.getLatestReply('mtg-1', 'user-1');

    expect(reply).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/services/nudge.test.ts`
Expected: FAIL with "service.getLatestReply is not a function"

- [ ] **Step 3: Add the method to `src/services/nudge.ts`**

In `src/services/nudge.ts`, locate the `NudgeService` class. Place this new method directly after `recordParticipantMessage`:

```typescript
  async getLatestReply(meetingId: string, userId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT raw_text FROM participant_messages
       WHERE meeting_id = $1 AND user_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [meetingId, userId]
    );
    return rows[0]?.raw_text ?? null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/services/nudge.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Run full suite to ensure no regressions**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add tests/services/nudge.test.ts src/services/nudge.ts
git commit -m "feat: add NudgeService.getLatestReply for dashboard reply preview"
```

---

## Task 2: Add `updatePage` and `getPageVersion` to ConfluenceService

**Files:**
- Modify: `src/services/confluence.ts` — add two new methods
- Test: `tests/services/confluence.test.ts` — create (does not yet exist)

- [ ] **Step 1: Create the test file**

Create `tests/services/confluence.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { ConfluenceService } from '../../src/services/confluence';

vi.mock('axios');

const config = {
  baseUrl: 'https://example.atlassian.net',
  email: 'bot@example.com',
  apiToken: 'tok',
};

describe('ConfluenceService.getPageVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the current page version number', async () => {
    (axios.get as any).mockResolvedValue({ data: { version: { number: 7 } } });
    const service = new ConfluenceService(config);

    const version = await service.getPageVersion('123');

    expect(version).toBe(7);
    expect((axios.get as any).mock.calls[0][0]).toContain('/wiki/rest/api/content/123');
  });
});

describe('ConfluenceService.updatePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PUTs the page with version+1 and storage-format body', async () => {
    (axios.get as any).mockResolvedValue({ data: { version: { number: 4 } } });
    (axios.put as any).mockResolvedValue({ status: 200, data: {} });
    const service = new ConfluenceService(config);

    await service.updatePage('123', 'Title', '<p>body</p>');

    const [url, payload, opts] = (axios.put as any).mock.calls[0];
    expect(url).toBe('https://example.atlassian.net/wiki/rest/api/content/123');
    expect(payload).toEqual({
      id: '123',
      type: 'page',
      title: 'Title',
      version: { number: 5 },
      body: { storage: { value: '<p>body</p>', representation: 'storage' } },
    });
    expect(opts.headers.Authorization).toMatch(/^Basic /);
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('retries once on 409 conflict with refetched version', async () => {
    (axios.get as any)
      .mockResolvedValueOnce({ data: { version: { number: 4 } } })
      .mockResolvedValueOnce({ data: { version: { number: 6 } } });

    const conflict = { response: { status: 409 } };
    (axios.put as any)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ status: 200, data: {} });

    const service = new ConfluenceService(config);
    await service.updatePage('123', 'T', '<p>x</p>');

    expect((axios.put as any).mock.calls[1][1].version).toEqual({ number: 7 });
  });

  it('throws if the second attempt also conflicts', async () => {
    (axios.get as any).mockResolvedValue({ data: { version: { number: 4 } } });
    const conflict = { response: { status: 409 } };
    (axios.put as any).mockRejectedValue(conflict);

    const service = new ConfluenceService(config);
    await expect(service.updatePage('123', 'T', '<p>x</p>')).rejects.toBe(conflict);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/services/confluence.test.ts`
Expected: FAIL with "service.getPageVersion is not a function" (and the updatePage tests fail similarly).

- [ ] **Step 3: Add the methods to `src/services/confluence.ts`**

In `src/services/confluence.ts`, add these two methods on the `ConfluenceService` class. Place them after `getComments` and before `buildDocCheckSummary`:

```typescript
  async getPageVersion(pageId: string): Promise<number> {
    const response = await axios.get(
      `${this.baseUrl}/wiki/rest/api/content/${pageId}?expand=version`,
      { headers: { Authorization: this.authHeader, Accept: 'application/json' } }
    );
    return response.data.version.number;
  }

  async updatePage(pageId: string, title: string, body: string): Promise<void> {
    const attempt = async (version: number) => {
      await axios.put(
        `${this.baseUrl}/wiki/rest/api/content/${pageId}`,
        {
          id: pageId,
          type: 'page',
          title,
          version: { number: version + 1 },
          body: { storage: { value: body, representation: 'storage' } },
        },
        {
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );
    };

    const initialVersion = await this.getPageVersion(pageId);
    try {
      await attempt(initialVersion);
    } catch (err: any) {
      if (err?.response?.status === 409) {
        const refreshed = await this.getPageVersion(pageId);
        await attempt(refreshed);
      } else {
        throw err;
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/services/confluence.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add tests/services/confluence.test.ts src/services/confluence.ts
git commit -m "feat: add Confluence updatePage with conflict retry"
```

---

## Task 3: Create `relativeTime` helper

**Files:**
- Create: `src/services/dashboard.ts` — start the file with this helper
- Create: `tests/services/dashboard.test.ts`

- [ ] **Step 1: Create the failing test**

Create `tests/services/dashboard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { relativeTime } from '../../src/services/dashboard';

describe('relativeTime', () => {
  const now = new Date('2026-05-29T10:00:00Z');

  it('returns "just now" for under 60 seconds', () => {
    expect(relativeTime(new Date('2026-05-29T09:59:30Z'), now)).toBe('just now');
  });

  it('returns "Xm ago" for minutes', () => {
    expect(relativeTime(new Date('2026-05-29T09:55:00Z'), now)).toBe('5m ago');
  });

  it('returns "Xh ago" for hours', () => {
    expect(relativeTime(new Date('2026-05-29T08:30:00Z'), now)).toBe('1h ago');
    expect(relativeTime(new Date('2026-05-29T07:00:00Z'), now)).toBe('3h ago');
  });

  it('returns "Xd ago" for days', () => {
    expect(relativeTime(new Date('2026-05-28T10:00:00Z'), now)).toBe('1d ago');
    expect(relativeTime(new Date('2026-05-26T10:00:00Z'), now)).toBe('3d ago');
  });

  it('returns "Xw ago" for weeks', () => {
    expect(relativeTime(new Date('2026-05-22T10:00:00Z'), now)).toBe('1w ago');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/services/dashboard.test.ts`
Expected: FAIL — "Cannot find module '../../src/services/dashboard'".

- [ ] **Step 3: Create `src/services/dashboard.ts` with the helper**

Create `src/services/dashboard.ts`:

```typescript
export function relativeTime(from: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - from.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  return `${wk}w ago`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/services/dashboard.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/services/dashboard.test.ts src/services/dashboard.ts
git commit -m "feat: add relativeTime helper for dashboard"
```

---

## Task 4: Add HTML-escape helper and humanisation lookups

**Files:**
- Modify: `src/services/dashboard.ts`
- Modify: `tests/services/dashboard.test.ts`

- [ ] **Step 1: Append failing tests for escape + humanisation**

Append to `tests/services/dashboard.test.ts`:

```typescript
import { escapeXml, humaniseStatus, humaniseAction } from '../../src/services/dashboard';

describe('escapeXml', () => {
  it('escapes <, >, &, ", and \'', () => {
    expect(escapeXml(`<script>alert("x" & 'y')</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot; &amp; &apos;y&apos;)&lt;/script&gt;'
    );
  });

  it('returns empty string for null or undefined', () => {
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(undefined)).toBe('');
  });
});

describe('humaniseStatus', () => {
  it('maps every known participant status', () => {
    expect(humaniseStatus('pending')).toBe('waiting for nudge');
    expect(humaniseStatus('nudge_sent')).toBe('nudge sent');
    expect(humaniseStatus('replied')).toBe('replied');
    expect(humaniseStatus('clarification_needed')).toBe('clarification asked');
    expect(humaniseStatus('blocked')).toBe('blocked');
    expect(humaniseStatus('overdue')).toBe('overdue');
    expect(humaniseStatus('completed')).toBe('done');
  });

  it('falls back to the raw value for unknown status', () => {
    expect(humaniseStatus('weird_state' as any)).toBe('weird_state');
  });
});

describe('humaniseAction', () => {
  it('maps known document actions', () => {
    expect(humaniseAction('read')).toBe('read');
    expect(humaniseAction('comment')).toBe('comment');
    expect(humaniseAction('approve')).toBe('approve');
    expect(humaniseAction('provide_input')).toBe('provide input');
    expect(humaniseAction('confirm_decision')).toBe('confirm decision');
  });

  it('falls back to the raw value for unknown action', () => {
    expect(humaniseAction('weird_action' as any)).toBe('weird_action');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/services/dashboard.test.ts`
Expected: FAIL — `escapeXml`, `humaniseStatus`, `humaniseAction` are not exported.

- [ ] **Step 3: Append exports to `src/services/dashboard.ts`**

Append to `src/services/dashboard.ts`:

```typescript
import type { ParticipantStatus, DocumentAction } from '../types';

export function escapeXml(value: string | null | undefined): string {
  if (value == null) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const STATUS_LABELS: Record<ParticipantStatus, string> = {
  pending: 'waiting for nudge',
  nudge_sent: 'nudge sent',
  replied: 'replied',
  clarification_needed: 'clarification asked',
  blocked: 'blocked',
  overdue: 'overdue',
  completed: 'done',
};

export function humaniseStatus(status: ParticipantStatus): string {
  return STATUS_LABELS[status] ?? (status as string);
}

const ACTION_LABELS: Record<DocumentAction, string> = {
  read: 'read',
  comment: 'comment',
  approve: 'approve',
  provide_input: 'provide input',
  confirm_decision: 'confirm decision',
};

export function humaniseAction(action: DocumentAction): string {
  return ACTION_LABELS[action] ?? (action as string);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/services/dashboard.test.ts`
Expected: all tests pass (5 from Task 3 + new ones from this task).

- [ ] **Step 5: Run full suite + build**

Run: `npm test && npm run build`
Expected: all tests green, TypeScript clean.

- [ ] **Step 6: Commit**

```bash
git add tests/services/dashboard.test.ts src/services/dashboard.ts
git commit -m "feat: add escapeXml + humanisation helpers for dashboard"
```

---

## Task 5: Build `renderDashboardBody` (empty state)

**Files:**
- Modify: `src/services/dashboard.ts`
- Modify: `tests/services/dashboard.test.ts`

- [ ] **Step 1: Append failing test**

Append to `tests/services/dashboard.test.ts`:

```typescript
import { renderDashboardBody } from '../../src/services/dashboard';

describe('renderDashboardBody — empty state', () => {
  const now = new Date('2026-05-29T10:30:00Z');

  it('renders the info macro and a "No active meetings" message', () => {
    const body = renderDashboardBody({ meetings: [], now });

    expect(body).toContain('<ac:structured-macro ac:name="info">');
    expect(body).toContain('Last updated:');
    expect(body).toContain('No active meetings');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/services/dashboard.test.ts`
Expected: FAIL — `renderDashboardBody` not exported.

- [ ] **Step 3: Add `renderDashboardBody` (empty case only) to `src/services/dashboard.ts`**

Append to `src/services/dashboard.ts`:

```typescript
export interface DashboardMeeting {
  id: string;
  title: string;
  start_time: string;
  document_url: string;
  document_title: string;
  document_action: DocumentAction;
  participants: DashboardParticipant[];
}

export interface DashboardParticipant {
  slack_user_id: string;
  display_name: string;
  status: ParticipantStatus;
  updated_at: string | null;
  latest_reply: string | null;
}

export interface DashboardInput {
  meetings: DashboardMeeting[];
  now: Date;
}

function renderHeader(now: Date): string {
  const stamp = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return [
    '<ac:structured-macro ac:name="info">',
    '  <ac:rich-text-body>',
    `    <p>Last updated: ${escapeXml(stamp)}</p>`,
    '  </ac:rich-text-body>',
    '</ac:structured-macro>',
  ].join('\n');
}

export function renderDashboardBody(input: DashboardInput): string {
  const header = renderHeader(input.now);
  if (input.meetings.length === 0) {
    return [header, '', '<p><em>No active meetings.</em></p>'].join('\n');
  }
  return header;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/services/dashboard.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/services/dashboard.test.ts src/services/dashboard.ts
git commit -m "feat: render dashboard empty state"
```

---

## Task 6: Build `renderDashboardBody` (populated)

**Files:**
- Modify: `src/services/dashboard.ts`
- Modify: `tests/services/dashboard.test.ts`

- [ ] **Step 1: Append failing test**

Append to `tests/services/dashboard.test.ts`:

```typescript
describe('renderDashboardBody — populated', () => {
  const now = new Date('2026-05-29T10:00:00Z');

  const meeting: any = {
    id: 'mtg-1',
    title: 'Take Template Ownership',
    start_time: '2026-06-04T09:00:00Z',
    document_url: 'https://example.atlassian.net/wiki/spaces/X/pages/12345/Page',
    document_title: 'Take Template Ownership',
    document_action: 'approve' as const,
    participants: [
      {
        slack_user_id: 'U1',
        display_name: 'alice',
        status: 'completed',
        updated_at: '2026-05-29T08:00:00Z',
        latest_reply: 'approved, looks good',
      },
      {
        slack_user_id: 'U2',
        display_name: 'bob',
        status: 'nudge_sent',
        updated_at: '2026-05-28T10:00:00Z',
        latest_reply: null,
      },
      {
        slack_user_id: 'U3',
        display_name: 'carol',
        status: 'blocked',
        updated_at: '2026-05-29T09:30:00Z',
        latest_reply: 'waiting on legal',
      },
    ],
  };

  it('renders meeting heading, metadata, progress, and a participant table', () => {
    const body = renderDashboardBody({ meetings: [meeting], now });

    expect(body).toContain('<h2>Take Template Ownership</h2>');
    expect(body).toContain('Action requested: approve');
    expect(body).toContain('Progress: 1/3 done · 1 blocked');

    expect(body).toContain('<a href="https://example.atlassian.net/wiki/spaces/X/pages/12345/Page">Take Template Ownership</a>');

    expect(body).toContain('<th>Participant</th>');
    expect(body).toContain('<th>Status</th>');
    expect(body).toContain('<th>Last updated</th>');
    expect(body).toContain('<th>Reply</th>');

    expect(body).toContain('@alice');
    expect(body).toContain('done');
    expect(body).toContain('2h ago');
    expect(body).toContain('approved, looks good');

    expect(body).toContain('@bob');
    expect(body).toContain('nudge sent');

    expect(body).toContain('@carol');
    expect(body).toContain('blocked');
    expect(body).toContain('waiting on legal');
  });

  it('omits the blocked count from the progress line when there are no blocked participants', () => {
    const noBlocked = {
      ...meeting,
      participants: meeting.participants.filter((p: any) => p.status !== 'blocked'),
    };

    const body = renderDashboardBody({ meetings: [noBlocked], now });

    expect(body).toContain('Progress: 1/2 done');
    expect(body).not.toContain('blocked');
  });

  it('escapes user-supplied text to prevent storage-format injection', () => {
    const malicious = {
      ...meeting,
      title: '<script>alert(1)</script>',
      participants: [
        { ...meeting.participants[0], display_name: 'x<y', latest_reply: 'a & b' },
      ],
    };

    const body = renderDashboardBody({ meetings: [malicious], now });

    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).toContain('@x&lt;y');
    expect(body).toContain('a &amp; b');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/services/dashboard.test.ts`
Expected: FAIL — populated rendering not implemented.

- [ ] **Step 3: Replace `renderDashboardBody` in `src/services/dashboard.ts` with the full implementation**

Replace the existing `renderDashboardBody` function in `src/services/dashboard.ts` with:

```typescript
function formatStartTime(iso: string): string {
  const d = new Date(iso);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${wd} ${mo} ${day} · ${hh}:${mm}`;
}

function renderMeeting(m: DashboardMeeting, now: Date): string {
  const idPrefix = m.id.slice(0, 8);
  const done = m.participants.filter((p) => p.status === 'completed').length;
  const total = m.participants.length;
  const blocked = m.participants.filter((p) => p.status === 'blocked').length;

  const progress = blocked > 0
    ? `Progress: ${done}/${total} done · ${blocked} blocked`
    : `Progress: ${done}/${total} done`;

  const rows = m.participants.map((p) => {
    const updated = p.updated_at ? relativeTime(new Date(p.updated_at), now) : '—';
    return [
      '    <tr>',
      `      <td>@${escapeXml(p.display_name)}</td>`,
      `      <td>${escapeXml(humaniseStatus(p.status))}</td>`,
      `      <td>${escapeXml(updated)}</td>`,
      `      <td>${escapeXml(p.latest_reply ?? '')}</td>`,
      '    </tr>',
    ].join('\n');
  }).join('\n');

  return [
    `<h2>${escapeXml(m.title)}</h2>`,
    `<p>${escapeXml(formatStartTime(m.start_time))} · ${escapeXml(idPrefix)}</p>`,
    `<p>Document: <a href="${escapeXml(m.document_url)}">${escapeXml(m.document_title)}</a></p>`,
    `<p>Action requested: ${escapeXml(humaniseAction(m.document_action))}</p>`,
    `<p>${escapeXml(progress)}</p>`,
    '<table>',
    '  <tbody>',
    '    <tr>',
    '      <th>Participant</th>',
    '      <th>Status</th>',
    '      <th>Last updated</th>',
    '      <th>Reply</th>',
    '    </tr>',
    rows,
    '  </tbody>',
    '</table>',
  ].join('\n');
}

export function renderDashboardBody(input: DashboardInput): string {
  const header = renderHeader(input.now);
  if (input.meetings.length === 0) {
    return [header, '', '<p><em>No active meetings.</em></p>'].join('\n');
  }
  const sections = input.meetings.map((m) => renderMeeting(m, input.now)).join('\n\n');
  return [header, '', sections].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/services/dashboard.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Run full suite + build**

Run: `npm test && npm run build`
Expected: all tests green, TypeScript clean.

- [ ] **Step 6: Commit**

```bash
git add tests/services/dashboard.test.ts src/services/dashboard.ts
git commit -m "feat: render populated dashboard with per-meeting tables"
```

---

## Task 7: Implement `publishDashboard` orchestrator

**Files:**
- Modify: `src/services/dashboard.ts`
- Modify: `tests/services/dashboard.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `tests/services/dashboard.test.ts`:

```typescript
import { configureDashboard, publishDashboard } from '../../src/services/dashboard';

describe('publishDashboard', () => {
  it('is a no-op when page id is empty', async () => {
    const meetingService = { listActive: vi.fn() } as any;
    const nudgeService = { getLatestReply: vi.fn() } as any;
    const confluenceService = { updatePage: vi.fn() } as any;

    configureDashboard({ pageId: '', meetingService, nudgeService, confluenceService });
    await publishDashboard();

    expect(meetingService.listActive).not.toHaveBeenCalled();
    expect(confluenceService.updatePage).not.toHaveBeenCalled();
  });

  it('fetches meetings + participants + replies, renders, and updates the page', async () => {
    const meeting = {
      id: 'mtg-1',
      title: 'M',
      start_time: '2026-06-04T09:00:00Z',
      document_url: 'https://example/p',
      document_title: 'Doc',
      document_action: 'read',
    };
    const participant = {
      slack_user_id: 'U1',
      display_name: 'alice',
      user_id: 'user-1',
      status: 'replied',
    };

    const meetingService = {
      listActive: vi.fn().mockResolvedValue([meeting]),
      getParticipantsWithUsers: vi.fn().mockResolvedValue([participant]),
    } as any;
    const nudgeService = {
      getLatestReply: vi.fn().mockResolvedValue('hello'),
    } as any;
    const confluenceService = {
      updatePage: vi.fn().mockResolvedValue(undefined),
    } as any;

    configureDashboard({
      pageId: '12345',
      meetingService,
      nudgeService,
      confluenceService,
    });

    await publishDashboard();

    expect(meetingService.listActive).toHaveBeenCalledWith();
    expect(meetingService.getParticipantsWithUsers).toHaveBeenCalledWith('mtg-1');
    expect(nudgeService.getLatestReply).toHaveBeenCalledWith('mtg-1', 'user-1');

    expect(confluenceService.updatePage).toHaveBeenCalledTimes(1);
    const [pageId, title, body] = confluenceService.updatePage.mock.calls[0];
    expect(pageId).toBe('12345');
    expect(title).toBe('Meetassist dashboard');
    expect(body).toContain('@alice');
    expect(body).toContain('hello');
  });

  it('catches and logs errors from updatePage without throwing', async () => {
    const meetingService = {
      listActive: vi.fn().mockResolvedValue([]),
      getParticipantsWithUsers: vi.fn(),
    } as any;
    const nudgeService = { getLatestReply: vi.fn() } as any;
    const confluenceService = {
      updatePage: vi.fn().mockRejectedValue(new Error('boom')),
    } as any;

    configureDashboard({
      pageId: '12345',
      meetingService,
      nudgeService,
      confluenceService,
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(publishDashboard()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/services/dashboard.test.ts`
Expected: FAIL — `configureDashboard`, `publishDashboard` not exported.

- [ ] **Step 3: Append the orchestrator to `src/services/dashboard.ts`**

Append to `src/services/dashboard.ts`:

```typescript
import type { MeetingService } from './meeting';
import type { NudgeService } from './nudge';
import type { ConfluenceService } from './confluence';

interface DashboardConfig {
  pageId: string;
  meetingService: MeetingService;
  nudgeService: NudgeService;
  confluenceService: ConfluenceService;
}

let config: DashboardConfig | null = null;

export function configureDashboard(c: DashboardConfig): void {
  config = c;
}

export async function publishDashboard(): Promise<void> {
  if (!config || !config.pageId) return;

  try {
    const meetings = await config.meetingService.listActive();
    const dashboardMeetings: DashboardMeeting[] = [];

    for (const m of meetings) {
      const participantsRaw = await config.meetingService.getParticipantsWithUsers(m.id);
      const participants: DashboardParticipant[] = [];
      for (const p of participantsRaw as any[]) {
        const reply = await config.nudgeService.getLatestReply(m.id, p.user_id);
        participants.push({
          slack_user_id: p.slack_user_id,
          display_name: p.display_name,
          status: p.status,
          updated_at: p.updated_at ?? null,
          latest_reply: reply,
        });
      }
      dashboardMeetings.push({
        id: m.id,
        title: m.title,
        start_time: m.start_time,
        document_url: m.document_url,
        document_title: m.document_title,
        document_action: m.document_action as DocumentAction,
        participants,
      });
    }

    const body = renderDashboardBody({ meetings: dashboardMeetings, now: new Date() });
    await config.confluenceService.updatePage(config.pageId, 'Meetassist dashboard', body);
  } catch (err: any) {
    console.error('[dashboard] publish failed:', err?.response?.data ?? err?.message ?? err);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/services/dashboard.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Run full suite + build**

Run: `npm test && npm run build`
Expected: all green, TypeScript clean.

- [ ] **Step 6: Commit**

```bash
git add tests/services/dashboard.test.ts src/services/dashboard.ts
git commit -m "feat: orchestrate dashboard publish from services"
```

---

## Task 8: Wire `configureDashboard` into boot in `src/index.ts`

**Files:**
- Modify: `src/index.ts`
- Modify: `.env.example` (or create if missing)

- [ ] **Step 1: Check for `.env.example`**

Run: `ls /Users/i525473/ClaudeCode/slackbot/.env.example 2>/dev/null || echo MISSING`

If `MISSING`, create one with the following content. If it exists, append the new line to the file.

```
# Page ID of the Confluence dashboard page the bot updates.
# If unset, dashboard publishing is disabled (warning logged at boot).
MEETASSIST_DASHBOARD_PAGE_ID=
```

- [ ] **Step 2: Update `src/index.ts`**

Open `src/index.ts`. After the existing `import` lines at the top (lines 1–13 today), add:

```typescript
import { configureDashboard, publishDashboard } from './services/dashboard';
```

Inside `main()`, after `const relayService = new RelayService(meetingService, nudgeService);` and before `registerCommands(...)`, add:

```typescript
  const dashboardPageId = process.env.MEETASSIST_DASHBOARD_PAGE_ID ?? '';
  if (!dashboardPageId) {
    console.warn('[boot] MEETASSIST_DASHBOARD_PAGE_ID not set — dashboard publishing disabled.');
  }
  configureDashboard({
    pageId: dashboardPageId,
    meetingService,
    nudgeService,
    confluenceService,
  });
```

- [ ] **Step 3: Build and run tests**

Run: `npm run build && npm test`
Expected: TypeScript clean, all tests still pass.

- [ ] **Step 4: Commit**

```bash
git add .env.example src/index.ts
git commit -m "feat: wire dashboard configuration into boot"
```

---

## Task 9: Trigger `publishDashboard` from slash commands

**Files:**
- Modify: `src/bot/commands.ts`

- [ ] **Step 1: Add the import**

Open `src/bot/commands.ts`. Add to the existing imports near the top:

```typescript
import { publishDashboard } from '../services/dashboard';
```

- [ ] **Step 2: Refresh after `/ma send`**

Locate `case 'send':` (around line 91). Inside that case, find the line that ends the participant loop (the last statement before the `await respond(...)` reporting back to the operator). Just before that `respond` call, add:

```typescript
        await publishDashboard();
```

If there are multiple `respond` calls inside the case (e.g. an early-return error path and a final success path), add `await publishDashboard();` only on the success path — the path that runs after the participant loop has actually mutated state.

- [ ] **Step 3: Refresh after `/ma remind`**

Locate `case 'remind':` (around line 136). Same pattern — before the success-path `respond(...)`:

```typescript
        await publishDashboard();
```

- [ ] **Step 4: Refresh after `/ma followup`**

Locate `case 'followup':` (around line 170). Same pattern:

```typescript
        await publishDashboard();
```

- [ ] **Step 5: Refresh after `/ma set-action`**

Locate `case 'set-action':` (around line 222). Find the participant reset loop, then before the success-path `respond(...)`:

```typescript
        await publishDashboard();
```

- [ ] **Step 6: Refresh after the create-wizard finalises**

Locate `case 'participants':` inside the DM-message handler (around line 386). Find the existing `await meetingService.updateStatus(meeting.id, 'active');` call. Immediately after that line, before the `await say(...)` that reports back to the operator, add:

```typescript
        await publishDashboard();
```

- [ ] **Step 7: Build and run tests**

Run: `npm run build && npm test`
Expected: TypeScript clean, all tests pass (no test changes needed for this task — the existing tests don't exercise the `publishDashboard` integration directly).

- [ ] **Step 8: Commit**

```bash
git add src/bot/commands.ts
git commit -m "feat: refresh dashboard after slash command state changes"
```

---

## Task 10: Trigger `publishDashboard` from button actions

**Files:**
- Modify: `src/bot/actions.ts`

- [ ] **Step 1: Add the import**

Open `src/bot/actions.ts`. Add near the existing imports at the top:

```typescript
import { publishDashboard } from '../services/dashboard';
```

- [ ] **Step 2: Refresh after `mark_done`**

Locate the `app.action('mark_done', ...)` handler. Find the last `await` inside the success path (typically a `relayService.notifyOperator(...)` or equivalent). Right after that line and before the handler body ends, add:

```typescript
    await publishDashboard();
```

- [ ] **Step 3: Refresh after `need_clarification`**

Same pattern in the `need_clarification` handler:

```typescript
    await publishDashboard();
```

- [ ] **Step 4: Refresh after `cannot_complete`**

Same pattern in the `cannot_complete` handler:

```typescript
    await publishDashboard();
```

- [ ] **Step 5: Build and run tests**

Run: `npm run build && npm test`
Expected: TypeScript clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/bot/actions.ts
git commit -m "feat: refresh dashboard after participant button actions"
```

---

## Task 11: Trigger `publishDashboard` from DM relay

**Files:**
- Modify: `src/bot/relay.ts`

- [ ] **Step 1: Add the import**

Open `src/bot/relay.ts`. Add near the existing imports at the top:

```typescript
import { publishDashboard } from '../services/dashboard';
```

- [ ] **Step 2: Refresh after the DM forward**

Locate `registerDmListener(meetingService: MeetingService)` (around line 52). Inside the `app.message(async ({ message }) => { ... })` body, find the existing `await this.forwardToOperator({ ... });` call (around line 77). Immediately after that call, add:

```typescript
      await publishDashboard();
```

- [ ] **Step 3: Build and run tests**

Run: `npm run build && npm test`
Expected: TypeScript clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/bot/relay.ts
git commit -m "feat: refresh dashboard after participant DM relay"
```

---

## Task 12: Final integration check & deployment

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (existing 11 + new ones from Tasks 1, 2, 3-7).

- [ ] **Step 2: Run a clean build**

Run: `npm run build`
Expected: TypeScript compiles cleanly to `dist/`.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/confluence-dashboard
```

- [ ] **Step 4: Set the env var on Railway**

In the Railway dashboard for the Meetassist service:
1. Open **Variables**
2. Add `MEETASSIST_DASHBOARD_PAGE_ID` with value `6460702733`
3. Save (Railway redeploys automatically)

- [ ] **Step 5: Verify Confluence credentials have edit permission**

Open the dashboard page (`https://emarsys.jira.com/wiki/spaces/~607278290/pages/6460702733/Meetassist+dashboard`) in a browser as the user behind `CONFLUENCE_API_TOKEN`. Confirm you can edit it manually. If not, request edit permission from the page owner.

- [ ] **Step 6: Smoke test — empty state**

If the system has no active meetings at the moment, simply running the bot once should publish the empty-state body. Trigger any state mutation (e.g. `/ma send` on a closed meeting won't trigger; `/ma list` is read-only). The simplest forced trigger: trigger `publishDashboard()` indirectly via an active mutation. If no active meetings exist, manually create one (`/ma create`) — that finalisation triggers `publishDashboard()`.

After triggering, refresh the Confluence page in the browser. Expected: info macro at top with last-updated timestamp, plus either "No active meetings" or the rendered meeting list.

- [ ] **Step 7: Smoke test — populated**

With at least one active meeting:
1. Trigger `/ma send` on the meeting
2. Refresh the Confluence page → see the meeting heading, metadata, and participant table
3. As a participant, click `Mark done` on the DM nudge
4. Refresh the Confluence page → that participant's row now shows status `done` and a fresh "just now" / "Xm ago" timestamp

- [ ] **Step 8: Open a PR (or merge to main per the team's process)**

Use `gh pr create` if you have collaborator access, otherwise visit the URL GitHub returns from `git push` and open the PR manually.

---

## Self-Review Notes

- Spec coverage: every section of the spec maps to at least one task (Sections 1–10 → Tasks 1–12).
- Placeholder scan: no TBDs, no "similar to Task N", every code step has complete code.
- Type consistency: `DashboardMeeting`, `DashboardParticipant`, `DashboardInput` are defined once in Task 5 and reused in Tasks 6–7. `humaniseStatus` / `humaniseAction` / `escapeXml` / `relativeTime` are defined in Tasks 3–4 and used in Tasks 5–6.
- The reply column comes from `getLatestReply(meetingId, userId)` (Task 1) which queries `participant_messages.raw_text` — the actual column name in the schema. The spec section 5 said `message_text`; corrected here to match the real schema.
- `MeetingService.listActive()` already supports the no-arg "all meetings" form, so the spec's proposed `listAllActive()` is unnecessary — the plan calls `listActive()` with no args instead.
- `getLatestReply` is placed on `NudgeService` (where `recordParticipantMessage` already lives), not on `MeetingService` as the spec originally proposed — keeping participant-message queries co-located with the writer.
