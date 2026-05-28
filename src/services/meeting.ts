import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { WebClient } from '@slack/web-api';
import type { Meeting, MeetingParticipant, User, DocumentAction, ParticipantRole, ParticipantStatus } from '../types';

function parseConfluencePageId(url: string): string {
  // Handles URLs like: https://org.atlassian.net/wiki/spaces/PROJ/pages/123456/Title
  const match = url.match(/\/pages\/(\d+)/);
  if (!match) {
    throw new Error(`Cannot parse Confluence page ID from URL: ${url}. Expected format: .../pages/123456/...`);
  }
  return match[1];
}

interface CreateMeetingInput {
  title: string;
  start_time: string;
  organizer_user_id: string;
  purpose: string;
  document_url: string;
  document_title: string;
  document_action: DocumentAction | string;
}

export class MeetingService {
  constructor(private db: Database.Database) {}

  createMeeting(input: CreateMeetingInput): Meeting {
    const id = uuidv4();
    const now = new Date().toISOString();
    const confluence_page_id = parseConfluencePageId(input.document_url);

    this.db
      .prepare(
        `INSERT INTO meetings
          (id, title, start_time, organizer_user_id, purpose,
           document_url, document_title, document_action,
           confluence_page_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
      )
      .run(
        id,
        input.title,
        input.start_time,
        input.organizer_user_id,
        input.purpose,
        input.document_url,
        input.document_title,
        input.document_action,
        confluence_page_id,
        now
      );

    return this.getById(id)!;
  }

  getById(id: string): Meeting | null {
    return (
      (this.db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as Meeting | undefined) ??
      null
    );
  }

  listActive(): Meeting[] {
    return this.db
      .prepare(`SELECT * FROM meetings WHERE status IN ('draft', 'active') ORDER BY start_time ASC`)
      .all() as Meeting[];
  }

  updateStatus(id: string, status: Meeting['status']): void {
    this.db.prepare(`UPDATE meetings SET status = ? WHERE id = ?`).run(status, id);
  }

  addParticipant(meetingId: string, userId: string, role: ParticipantRole): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO meeting_participants
          (meeting_id, user_id, role, status, reminder_count)
         VALUES (?, ?, ?, 'pending', 0)`
      )
      .run(meetingId, userId, role);
  }

  getParticipants(meetingId: string): MeetingParticipant[] {
    return this.db
      .prepare(`SELECT * FROM meeting_participants WHERE meeting_id = ?`)
      .all(meetingId) as MeetingParticipant[];
  }

  getParticipantsWithUsers(meetingId: string): (MeetingParticipant & User)[] {
    return this.db
      .prepare(
        `SELECT mp.*, u.slack_user_id, u.display_name, u.email
         FROM meeting_participants mp
         JOIN users u ON u.id = mp.user_id
         WHERE mp.meeting_id = ?`
      )
      .all(meetingId) as (MeetingParticipant & User)[];
  }

  updateParticipantStatus(
    meetingId: string,
    userId: string,
    status: ParticipantStatus,
    completedAt?: string
  ): void {
    if (status === 'completed') {
      this.db
        .prepare(
          `UPDATE meeting_participants SET status = ?, completed_at = ? WHERE meeting_id = ? AND user_id = ?`
        )
        .run(status, completedAt ?? new Date().toISOString(), meetingId, userId);
    } else {
      this.db
        .prepare(
          `UPDATE meeting_participants SET status = ? WHERE meeting_id = ? AND user_id = ?`
        )
        .run(status, meetingId, userId);
    }
  }

  incrementReminderCount(meetingId: string, userId: string): void {
    this.db
      .prepare(
        `UPDATE meeting_participants SET reminder_count = reminder_count + 1 WHERE meeting_id = ? AND user_id = ?`
      )
      .run(meetingId, userId);
  }

  getUserBySlackId(slackUserId: string): User | null {
    return (
      (this.db
        .prepare(`SELECT * FROM users WHERE slack_user_id = ?`)
        .get(slackUserId) as User | undefined) ?? null
    );
  }

  upsertUser(user: Omit<User, 'id'> & { id?: string }): User {
    const id = user.id ?? uuidv4();
    this.db
      .prepare(
        `INSERT INTO users (id, email, slack_user_id, display_name)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(slack_user_id) DO UPDATE SET
           email = excluded.email,
           display_name = excluded.display_name`
      )
      .run(id, user.email, user.slack_user_id, user.display_name);
    return this.getUserBySlackId(user.slack_user_id)!;
  }

  getMeetingForParticipant(slackUserId: string): Meeting | null {
    return (
      (this.db
        .prepare(
          `SELECT m.* FROM meetings m
           JOIN meeting_participants mp ON mp.meeting_id = m.id
           JOIN users u ON u.id = mp.user_id
           WHERE u.slack_user_id = ?
             AND m.status IN ('draft', 'active')
           ORDER BY m.start_time ASC
           LIMIT 1`
        )
        .get(slackUserId) as Meeting | undefined) ?? null
    );
  }

  recordDocCheck(meetingId: string, confluenceVersion: number, commentCount: number): void {
    this.db
      .prepare(
        `INSERT INTO doc_checks (id, meeting_id, checked_at, confluence_version, comment_count)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(uuidv4(), meetingId, new Date().toISOString(), confluenceVersion, commentCount);
  }

  async autoSeedFromSlack(slackUserId: string, client: WebClient): Promise<User> {
    const existing = this.getUserBySlackId(slackUserId);
    if (existing) return existing;

    const result = await client.users.info({ user: slackUserId });
    const profile = (result.user as any)?.profile;
    const displayName: string = profile?.real_name || profile?.display_name || slackUserId;
    const confluenceEmail: string = profile?.email ?? '';

    return this.upsertUser({ slack_user_id: slackUserId, email: confluenceEmail, display_name: displayName });
  }
}
