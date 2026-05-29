import { describe, it, expect, vi } from 'vitest';
import { NudgeService } from '../../src/services/nudge';
import type { Meeting } from '../../src/types';

function makePool(rows: any[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as any;
}

// NudgeService message builders are pure functions — test them without a DB
const mockMeeting = {
  id: 'meeting-1',
  title: 'Roadmap Review',
  start_time: '2026-06-01T09:00:00Z',
  organizer_user_id: 'user-1',
  purpose: 'Align Q3',
  document_url: 'https://org.atlassian.net/wiki/spaces/P/pages/1/Doc',
  document_title: 'Q3 Roadmap',
  document_action: 'comment',
  confluence_page_id: '1',
  status: 'active',
  created_at: '2026-05-01T00:00:00Z',
} as any;

const nudgeService = new NudgeService(null as any);

describe('NudgeService message builders', () => {
  it('buildPreMeetingMessage includes title and document', () => {
    const { text, blocks } = nudgeService.buildPreMeetingMessage(mockMeeting);
    expect(text).toContain('Roadmap Review');
    expect(text).toContain('Q3 Roadmap');
    expect(blocks).toBeDefined();
  });

  it('buildReminderMessage returns plain text with document link', () => {
    const text = nudgeService.buildReminderMessage(mockMeeting);
    expect(text).toContain('Roadmap Review');
    expect(text).toContain('https://org.atlassian.net');
  });

  it('buildFollowUpMessage references the document action', () => {
    const text = nudgeService.buildFollowUpMessage(mockMeeting);
    expect(text).toContain('Roadmap Review');
    expect(text).toContain('comment');
  });
});

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
