import { describe, it, expect, vi } from 'vitest';
import { relativeTime, escapeXml, humaniseStatus, humaniseAction, renderDashboardBody, configureDashboard, publishDashboard } from '../../src/services/dashboard';

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

describe('renderDashboardBody — empty state', () => {
  const now = new Date('2026-05-29T10:30:00Z');

  it('renders the info macro and a "No active meetings" message', () => {
    const body = renderDashboardBody({ meetings: [], now });

    expect(body).toContain('<ac:structured-macro ac:name="info">');
    expect(body).toContain('Last updated:');
    expect(body).toContain('No active meetings');
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
    expect(body).toContain('Action requested: approve');
    expect(body).toContain('Progress: 1/3 done · 1 blocked');

    expect(body).toContain('<ac:link><ri:url ri:value="https://example.atlassian.net/wiki/spaces/X/pages/12345/Page" /><ac:link-body>Take Template Ownership</ac:link-body></ac:link>');

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
