import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTables } from '../../src/db/schema';
import { MeetingService } from '../../src/services/meeting';

describe('MeetingService', () => {
  let db: Database.Database;
  let service: MeetingService;

  const testUser = {
    id: 'user-1',
    email: 'alice@example.com',
    slack_user_id: 'U001',
    display_name: 'Alice',
  };

  const testMeetingInput = {
    title: 'Roadmap Review',
    start_time: '2026-06-01T09:00:00Z',
    organizer_user_id: 'user-1',
    purpose: 'Align on Q3 priorities',
    document_url: 'https://org.atlassian.net/wiki/spaces/PROJ/pages/123456/Roadmap',
    document_title: 'Q3 Roadmap',
    document_action: 'read' as const,
  };

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    service = new MeetingService(db);
    db.prepare(
      `INSERT INTO users (id, email, slack_user_id, display_name) VALUES (?, ?, ?, ?)`
    ).run(testUser.id, testUser.email, testUser.slack_user_id, testUser.display_name);
  });

  afterEach(() => db.close());

  it('creates a meeting and parses the confluence page id from the url', () => {
    const meeting = service.createMeeting(testMeetingInput);
    expect(meeting.title).toBe('Roadmap Review');
    expect(meeting.status).toBe('draft');
    expect(meeting.confluence_page_id).toBe('123456');
  });

  it('getById returns the meeting', () => {
    const created = service.createMeeting(testMeetingInput);
    const found = service.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Roadmap Review');
  });

  it('listActive returns only active and draft meetings', () => {
    service.createMeeting(testMeetingInput);
    const list = service.listActive();
    expect(list.length).toBe(1);
  });

  it('addParticipant stores a participant with pending status', () => {
    const meeting = service.createMeeting(testMeetingInput);
    service.addParticipant(meeting.id, testUser.id, 'participant');
    const participants = service.getParticipants(meeting.id);
    expect(participants.length).toBe(1);
    expect(participants[0].status).toBe('pending');
  });

  it('updateParticipantStatus changes the status', () => {
    const meeting = service.createMeeting(testMeetingInput);
    service.addParticipant(meeting.id, testUser.id, 'participant');
    service.updateParticipantStatus(meeting.id, testUser.id, 'completed');
    const participants = service.getParticipants(meeting.id);
    expect(participants[0].status).toBe('completed');
  });

  it('getParticipantUser returns user by slack_user_id and meeting', () => {
    const meeting = service.createMeeting(testMeetingInput);
    service.addParticipant(meeting.id, testUser.id, 'participant');
    const result = service.getUserBySlackId('U001');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('user-1');
  });
});
