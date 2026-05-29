import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { relativeTime, humaniseStatus, humaniseAction, escapeHtml, renderDashboardBody, configureDashboard, publishDashboard } from '../../src/services/dashboard';

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

describe('escapeHtml', () => {
  it('escapes the five XML/HTML special characters', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('renderDashboardBody — empty state', () => {
  const now = new Date('2026-05-29T10:30:00Z');

  it('renders a valid HTML doc with header and no-meetings message', () => {
    const body = renderDashboardBody({ meetings: [], now });

    expect(body).toMatch(/^<!DOCTYPE html>/);
    expect(body).toContain('<title>Meetassist dashboard</title>');
    expect(body).toContain('<h1>Meetassist dashboard</h1>');
    expect(body).toContain('Last updated:');
    expect(body).toContain('No active meetings.');
  });
});

describe('renderDashboardBody — populated', () => {
  const now = new Date('2026-05-29T10:00:00Z');

  const meeting: any = {
    id: 'mtg-1',
    title: 'Take Template Ownership',
    start_time: '2026-06-04T09:00:00Z',
    document_url: 'https://example.atlassian.net/wiki/spaces/X/pages/12345/Page',
    document_title: 'Take Template Ownership',
    document_action: 'approve' as const,
    purpose: 'Decide on the new template format',
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
    expect(body).toContain('approve');
    expect(body).toContain('1/3 done · 1 blocked');

    expect(body).toContain('href="https://example.atlassian.net/wiki/spaces/X/pages/12345/Page"');
    expect(body).toContain('>Take Template Ownership</a>');

    expect(body).toContain('<th>Participant</th>');
    expect(body).toContain('<th>Status</th>');
    expect(body).toContain('@alice');
    expect(body).toContain('status-done');
    expect(body).toContain('2h ago');
    expect(body).toContain('approved, looks good');

    expect(body).toContain('@bob');
    expect(body).toContain('status-sent');

    expect(body).toContain('@carol');
    expect(body).toContain('status-blocked');
    expect(body).toContain('waiting on legal');
  });

  it('omits the blocked count from the progress text when there are no blocked participants', () => {
    const noBlocked = {
      ...meeting,
      participants: meeting.participants.filter((p: any) => p.status !== 'blocked'),
    };

    const body = renderDashboardBody({ meetings: [noBlocked], now });

    expect(body).toContain('1/2 done');
    expect(body).not.toContain('1 blocked');
  });

  it('escapes HTML in user-supplied text to prevent XSS', () => {
    const m = {
      ...meeting,
      title: '<script>alert(1)</script>',
      participants: [
        { ...meeting.participants[0], display_name: 'a&b', latest_reply: '"bad" <tag>' },
      ],
    };

    const body = renderDashboardBody({ meetings: [m], now });

    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('@a&amp;b');
    expect(body).toContain('&quot;bad&quot; &lt;tag&gt;');
  });

  it('renders the meeting purpose row when present', () => {
    const body = renderDashboardBody({ meetings: [meeting], now });

    expect(body).toContain('Purpose');
    expect(body).toContain('Decide on the new template format');
  });

  it('omits the purpose row when purpose is empty', () => {
    const m = { ...meeting, purpose: '' };
    const body = renderDashboardBody({ meetings: [m], now });

    expect(body).not.toContain('>Purpose<');
  });

  it('renders multiple meetings as separate sections', () => {
    const second = { ...meeting, id: 'mtg-2', title: 'Second Meeting' };
    const body = renderDashboardBody({ meetings: [meeting, second], now });

    expect(body).toContain('<h2>Take Template Ownership</h2>');
    expect(body).toContain('<h2>Second Meeting</h2>');
    const sectionCount = (body.match(/<section class="meeting">/g) ?? []).length;
    expect(sectionCount).toBe(2);
  });

  it('embeds CSS in a <style> block', () => {
    const body = renderDashboardBody({ meetings: [meeting], now });
    expect(body).toContain('<style>');
    expect(body).toContain('</style>');
    expect(body).toContain('.status-done');
  });
});

describe('publishDashboard', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-test-'));
    tmpFile = path.join(tmpDir, 'dashboard.html');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('is a no-op when filePath is empty', async () => {
    const meetingService = { listActive: vi.fn() } as any;
    const nudgeService = { getLatestReply: vi.fn() } as any;

    configureDashboard({ filePath: '', meetingService, nudgeService });
    await publishDashboard();

    expect(meetingService.listActive).not.toHaveBeenCalled();
  });

  it('fetches meetings + participants + replies and writes the HTML file', async () => {
    const meeting = {
      id: 'mtg-1',
      title: 'M',
      start_time: '2026-06-04T09:00:00Z',
      document_url: 'https://example/p',
      document_title: 'Doc',
      document_action: 'read',
      purpose: 'do the thing',
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

    configureDashboard({ filePath: tmpFile, meetingService, nudgeService });

    await publishDashboard();

    expect(meetingService.listActive).toHaveBeenCalledWith();
    expect(meetingService.getParticipantsWithUsers).toHaveBeenCalledWith('mtg-1');
    expect(nudgeService.getLatestReply).toHaveBeenCalledWith('mtg-1', 'user-1');

    const written = await fs.readFile(tmpFile, 'utf8');
    expect(written).toMatch(/^<!DOCTYPE html>/);
    expect(written).toContain('<h1>Meetassist dashboard</h1>');
    expect(written).toContain('@alice');
    expect(written).toContain('hello');
    expect(written).toContain('do the thing');
  });

  it('catches and logs errors from the underlying calls without throwing', async () => {
    const meetingService = {
      listActive: vi.fn().mockRejectedValue(new Error('boom')),
      getParticipantsWithUsers: vi.fn(),
    } as any;
    const nudgeService = { getLatestReply: vi.fn() } as any;

    configureDashboard({ filePath: tmpFile, meetingService, nudgeService });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(publishDashboard()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
