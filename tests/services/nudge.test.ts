import { describe, it, expect, vi } from 'vitest';
import { NudgeService } from '../../src/services/nudge';
import type { Meeting } from '../../src/types';

function makePool(rows: any[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as any;
}

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

describe('NudgeService.buildPreMeetingMessage', () => {
  it('leads with action label and document link, not purpose', () => {
    const service = new NudgeService(makePool());
    const msg = service.buildPreMeetingMessage(baseMeeting);
    const blockText = (msg.blocks[0] as any).text.text;

    expect(blockText).toContain('Add a comment or mark no concerns');
    expect(blockText).toContain('Q3 Roadmap');
    expect(blockText).toContain('Meeting: Q3 Planning');
    expect(blockText).not.toContain(baseMeeting.purpose);
    expect(blockText).not.toContain('Requested:');
    expect(blockText).not.toContain('Meetassist:');
    expect(blockText).not.toContain('Confirm when done');
    expect(blockText).toContain('<https://example.atlassian.net/wiki/spaces/X/pages/12345/Page|Q3 Roadmap>');
  });

  it('includes deadline in block text', () => {
    const service = new NudgeService(makePool());
    const msg = service.buildPreMeetingMessage(baseMeeting);
    const blockText = (msg.blocks[0] as any).text.text;
    expect(blockText).toMatch(/ACTION NEEDED BY/i);
    expect(blockText).toContain('Jun');
  });

  it('fallback text contains action, document title, meeting title, and deadline', () => {
    const service = new NudgeService(makePool());
    const msg = service.buildPreMeetingMessage(baseMeeting);
    expect(msg.text).toContain('Add a comment or mark no concerns');
    expect(msg.text).toContain('Q3 Roadmap');
    expect(msg.text).toContain('Q3 Planning');
    expect(msg.text).toContain('Jun');
  });

  it('has three blocks when purpose is set: section, context, actions', () => {
    const service = new NudgeService(makePool());
    const msg = service.buildPreMeetingMessage(baseMeeting);
    expect(msg.blocks).toHaveLength(3);
    expect((msg.blocks[0] as any).type).toBe('section');
    expect((msg.blocks[1] as any).type).toBe('section');
    expect((msg.blocks[1] as any).text.text).toContain(baseMeeting.purpose);
    expect((msg.blocks[2] as any).type).toBe('actions');
  });

  it('has two blocks when purpose is empty: section and actions', () => {
    const service = new NudgeService(makePool());
    const msg = service.buildPreMeetingMessage({ ...baseMeeting, purpose: '' });
    expect(msg.blocks).toHaveLength(2);
    expect((msg.blocks[0] as any).type).toBe('section');
    expect((msg.blocks[1] as any).type).toBe('actions');
  });
});

describe('NudgeService.buildReminderMessage', () => {
  it('contains action label, document title, url, and meeting label', () => {
    const service = new NudgeService(makePool());
    const text = service.buildReminderMessage(baseMeeting);
    expect(text).toContain('Add a comment or mark no concerns');
    expect(text).toContain('Q3 Roadmap');
    expect(text).toContain('https://example.atlassian.net/wiki/spaces/X/pages/12345/Page');
    expect(text).toContain('Meeting: Q3 Planning');
  });

  it('does not include purpose', () => {
    const service = new NudgeService(makePool());
    const text = service.buildReminderMessage(baseMeeting);
    expect(text).not.toContain(baseMeeting.purpose);
  });
});

describe('NudgeService.buildFollowUpMessage', () => {
  it('contains still open, action label, document title, url, and meeting label', () => {
    const service = new NudgeService(makePool());
    const text = service.buildFollowUpMessage(baseMeeting);
    expect(text).toContain('still open');
    expect(text).toContain('Add a comment or mark no concerns');
    expect(text).toContain('Q3 Roadmap');
    expect(text).toContain('https://example.atlassian.net/wiki/spaces/X/pages/12345/Page');
    expect(text).toContain('Meeting: Q3 Planning');
  });

  it('does not include purpose', () => {
    const service = new NudgeService(makePool());
    const text = service.buildFollowUpMessage(baseMeeting);
    expect(text).not.toContain(baseMeeting.purpose);
  });
});

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
