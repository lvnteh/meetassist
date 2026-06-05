import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type { Meeting, Nudge, NudgeType, ParticipantMessage } from '../types';
import { escapeForSlack } from './verification';

interface NudgeInput {
  user_id: string;
  meeting_id: string;
  slack_channel_id: string;
  message_ts: string;
  type: NudgeType;
}

interface ParticipantMessageInput {
  user_id: string;
  meeting_id: string;
  nudge_id: string | null;
  raw_text: string;
}

interface SlackMessage {
  text: string;
  blocks: object[];
}

const ACTION_LABELS: Record<string, string> = {
  read: 'Read the document',
  comment: 'Add a comment or mark no concerns',
  approve: 'Approve the document',
  provide_input: 'Provide your input',
  confirm_decision: 'Confirm the decision',
};

export class NudgeService {
  constructor(private pool: Pool) {}

  async recordNudge(input: NudgeInput): Promise<Nudge> {
    const id = uuidv4();
    const sent_at = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO nudges (id, user_id, meeting_id, slack_channel_id, message_ts, type, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, input.user_id, input.meeting_id, input.slack_channel_id, input.message_ts, input.type, sent_at]
    );
    const { rows } = await this.pool.query(`SELECT * FROM nudges WHERE id = $1`, [id]);
    return rows[0];
  }

  buildPreMeetingMessage(meeting: Meeting): SlackMessage {
    const meetingDate = new Date(meeting.start_time);
    const dateStr = meetingDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = meetingDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const actionLabel = ACTION_LABELS[meeting.document_action] ?? meeting.document_action;

    const text = `${actionLabel} on ${meeting.document_title} — ${meeting.title}. Due ${dateStr} ${timeStr}.`;

    const blocks: object[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_ACTION NEEDED BY ${dateStr} · ${timeStr}_\n*${actionLabel}* on <${meeting.document_url}|${escapeForSlack(meeting.document_title)}>\nMeeting: ${escapeForSlack(meeting.title)}`,
        },
      },
      ...(meeting.purpose ? [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `> ${escapeForSlack(meeting.purpose)}`,
        },
      }] : []),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Mark done' },
            action_id: 'mark_done',
            style: 'primary',
            value: meeting.id,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Need clarification' },
            action_id: 'need_clarification',
            value: meeting.id,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Cannot complete' },
            action_id: 'cannot_complete',
            style: 'danger',
            value: meeting.id,
          },
        ],
      },
    ];

    return { text, blocks };
  }

  buildReminderMessage(meeting: Meeting): string {
    const actionLabel = ACTION_LABELS[meeting.document_action] ?? meeting.document_action;
    return `Reminder: ${actionLabel} on ${escapeForSlack(meeting.document_title)}.\nMeeting: ${escapeForSlack(meeting.title)}\n${meeting.document_url}`;
  }

  buildFollowUpMessage(meeting: Meeting): string {
    const actionLabel = ACTION_LABELS[meeting.document_action] ?? meeting.document_action;
    return `Your action is still open: ${actionLabel} on ${escapeForSlack(meeting.document_title)}.\nMeeting: ${escapeForSlack(meeting.title)}\n${meeting.document_url}`;
  }

  async recordParticipantMessage(input: ParticipantMessageInput): Promise<ParticipantMessage> {
    const id = uuidv4();
    const created_at = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO participant_messages (id, user_id, meeting_id, nudge_id, raw_text, ai_classification, created_at)
       VALUES ($1,$2,$3,$4,$5,NULL,$6)`,
      [id, input.user_id, input.meeting_id, input.nudge_id, input.raw_text, created_at]
    );
    const { rows } = await this.pool.query(`SELECT * FROM participant_messages WHERE id = $1`, [id]);
    return rows[0];
  }

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

  async recordOperatorReply(participantMessageId: string, rawText: string): Promise<void> {
    const id = uuidv4();
    const sent_at = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO operator_replies (id, participant_message_id, raw_text, sent_at) VALUES ($1,$2,$3,$4)`,
      [id, participantMessageId, rawText, sent_at]
    );
  }
}
