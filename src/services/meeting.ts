import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type { WebClient } from '@slack/web-api';
import type { Meeting, MeetingParticipant, User, DocumentAction, ParticipantRole, ParticipantStatus } from '../types';

function parseConfluencePageId(url: string): string {
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
  constructor(private pool: Pool) {}

  async createMeeting(input: CreateMeetingInput): Promise<Meeting> {
    const id = uuidv4();
    const now = new Date().toISOString();
    const confluence_page_id = parseConfluencePageId(input.document_url);

    await this.pool.query(
      `INSERT INTO meetings
        (id, title, start_time, organizer_user_id, purpose,
         document_url, document_title, document_action,
         confluence_page_id, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)`,
      [id, input.title, input.start_time, input.organizer_user_id, input.purpose,
       input.document_url, input.document_title, input.document_action,
       confluence_page_id, now]
    );

    return (await this.getById(id))!;
  }

  async getById(id: string): Promise<Meeting | null> {
    const { rows } = await this.pool.query(`SELECT * FROM meetings WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async listActive(organizerUserId?: string): Promise<Meeting[]> {
    if (organizerUserId) {
      const { rows } = await this.pool.query(
        `SELECT * FROM meetings WHERE status IN ('draft','active') AND organizer_user_id = $1 ORDER BY start_time ASC`,
        [organizerUserId]
      );
      return rows;
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM meetings WHERE status IN ('draft','active') ORDER BY start_time ASC`
    );
    return rows;
  }

  async updateStatus(id: string, status: Meeting['status']): Promise<void> {
    await this.pool.query(`UPDATE meetings SET status = $1 WHERE id = $2`, [status, id]);
  }

  async updateAction(id: string, action: string): Promise<void> {
    await this.pool.query(`UPDATE meetings SET document_action = $1 WHERE id = $2`, [action, id]);
  }

  async addParticipant(meetingId: string, userId: string, role: ParticipantRole): Promise<void> {
    await this.pool.query(
      `INSERT INTO meeting_participants (meeting_id, user_id, role, status, reminder_count)
       VALUES ($1,$2,$3,'pending',0)
       ON CONFLICT (meeting_id, user_id) DO NOTHING`,
      [meetingId, userId, role]
    );
  }

  async getParticipants(meetingId: string): Promise<MeetingParticipant[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM meeting_participants WHERE meeting_id = $1`, [meetingId]
    );
    return rows;
  }

  async getParticipantsWithUsers(meetingId: string): Promise<(MeetingParticipant & User)[]> {
    const { rows } = await this.pool.query(
      `SELECT mp.*, u.slack_user_id, u.display_name, u.email
       FROM meeting_participants mp
       JOIN users u ON u.id = mp.user_id
       WHERE mp.meeting_id = $1`,
      [meetingId]
    );
    return rows;
  }

  async updateParticipantStatus(
    meetingId: string,
    userId: string,
    status: ParticipantStatus,
    completedAt?: string
  ): Promise<void> {
    if (status === 'completed') {
      await this.pool.query(
        `UPDATE meeting_participants SET status = $1, completed_at = $2 WHERE meeting_id = $3 AND user_id = $4`,
        [status, completedAt ?? new Date().toISOString(), meetingId, userId]
      );
    } else {
      await this.pool.query(
        `UPDATE meeting_participants SET status = $1 WHERE meeting_id = $2 AND user_id = $3`,
        [status, meetingId, userId]
      );
    }
  }

  async incrementReminderCount(meetingId: string, userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE meeting_participants SET reminder_count = reminder_count + 1 WHERE meeting_id = $1 AND user_id = $2`,
      [meetingId, userId]
    );
  }

  async getUserBySlackId(slackUserId: string): Promise<User | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM users WHERE slack_user_id = $1`, [slackUserId]
    );
    return rows[0] ?? null;
  }

  async getUserById(id: string): Promise<User | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM users WHERE id = $1`, [id]
    );
    return rows[0] ?? null;
  }

  async upsertUser(user: Omit<User, 'id'> & { id?: string }): Promise<User> {
    const id = user.id ?? uuidv4();
    await this.pool.query(
      `INSERT INTO users (id, email, slack_user_id, display_name)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (slack_user_id) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = EXCLUDED.display_name`,
      [id, user.email, user.slack_user_id, user.display_name]
    );
    return (await this.getUserBySlackId(user.slack_user_id))!;
  }

  async getMeetingForParticipant(slackUserId: string): Promise<Meeting | null> {
    const { rows } = await this.pool.query(
      `SELECT m.* FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id
       JOIN users u ON u.id = mp.user_id
       WHERE u.slack_user_id = $1
         AND m.status IN ('draft','active')
       ORDER BY m.start_time ASC
       LIMIT 1`,
      [slackUserId]
    );
    return rows[0] ?? null;
  }

  async recordDocCheck(meetingId: string, confluenceVersion: number, commentCount: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO doc_checks (id, meeting_id, checked_at, confluence_version, comment_count)
       VALUES ($1,$2,$3,$4,$5)`,
      [uuidv4(), meetingId, new Date().toISOString(), confluenceVersion, commentCount]
    );
  }

  async autoSeedFromSlack(slackUserId: string, client: WebClient): Promise<User> {
    const existing = await this.getUserBySlackId(slackUserId);
    if (existing) return existing;

    const result = await client.users.info({ user: slackUserId });
    const profile = (result.user as any)?.profile;
    const displayName: string = profile?.real_name || profile?.display_name || slackUserId;
    const confluenceEmail: string = profile?.email ?? '';

    return this.upsertUser({ slack_user_id: slackUserId, email: confluenceEmail, display_name: displayName });
  }
}
