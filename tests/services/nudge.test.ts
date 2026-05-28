import { describe, it, expect } from 'vitest';
import { NudgeService } from '../../src/services/nudge';

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
