import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from '../../src/db/schema';
import { NudgeService } from '../../src/services/nudge';
import { MeetingService } from '../../src/services/meeting';

describe('NudgeService', () => {
  let db: Database.Database;
  let nudgeService: NudgeService;
  let meetingService: MeetingService;

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    meetingService = new MeetingService(db);
    nudgeService = new NudgeService(db);

    db.prepare(
      `INSERT INTO users (id, email, slack_user_id, display_name) VALUES (?, ?, ?, ?)`
    ).run('user-1', 'bob@example.com', 'U001', 'Bob');
  });

  afterEach(() => db.close());

  it('recordNudge stores the nudge and returns it', () => {
    const meeting = meetingService.createMeeting({
      title: 'Test',
      start_time: '2026-06-01T09:00:00Z',
      organizer_user_id: 'user-1',
      purpose: 'Test',
      document_url: 'https://org.atlassian.net/wiki/spaces/P/pages/1/Doc',
      document_title: 'Doc',
      document_action: 'read',
    });

    const nudge = nudgeService.recordNudge({
      user_id: 'user-1',
      meeting_id: meeting.id,
      slack_channel_id: 'C001',
      message_ts: '1234567890.123',
      type: 'pre_meeting',
    });

    expect(nudge.type).toBe('pre_meeting');
    expect(nudge.user_id).toBe('user-1');
  });

  it('buildPreMeetingMessage includes document url and action', () => {
    const meeting = meetingService.createMeeting({
      title: 'Roadmap Review',
      start_time: '2026-06-01T09:00:00Z',
      organizer_user_id: 'user-1',
      purpose: 'Align Q3',
      document_url: 'https://org.atlassian.net/wiki/spaces/P/pages/1/Doc',
      document_title: 'Q3 Roadmap',
      document_action: 'comment',
    });

    const { text, blocks } = nudgeService.buildPreMeetingMessage(meeting);

    expect(text).toContain('Roadmap Review');
    expect(text).toContain('Q3 Roadmap');
    expect(blocks).toBeDefined();
  });

  it('buildReminderMessage returns plain text with document link', () => {
    const meeting = meetingService.createMeeting({
      title: 'Roadmap Review',
      start_time: '2026-06-01T09:00:00Z',
      organizer_user_id: 'user-1',
      purpose: 'Align Q3',
      document_url: 'https://org.atlassian.net/wiki/spaces/P/pages/1/Doc',
      document_title: 'Q3 Roadmap',
      document_action: 'read',
    });

    const text = nudgeService.buildReminderMessage(meeting);
    expect(text).toContain('Roadmap Review');
    expect(text).toContain('https://org.atlassian.net');
  });

  it('recordParticipantMessage stores the message', () => {
    const meeting = meetingService.createMeeting({
      title: 'Test',
      start_time: '2026-06-01T09:00:00Z',
      organizer_user_id: 'user-1',
      purpose: 'Test',
      document_url: 'https://org.atlassian.net/wiki/spaces/P/pages/1/Doc',
      document_title: 'Doc',
      document_action: 'read',
    });

    const msg = nudgeService.recordParticipantMessage({
      user_id: 'user-1',
      meeting_id: meeting.id,
      nudge_id: null,
      raw_text: 'Done reviewing',
    });

    expect(msg.raw_text).toBe('Done reviewing');
  });
});
