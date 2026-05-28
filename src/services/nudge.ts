import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Meeting, Nudge, NudgeType, ParticipantMessage } from '../types';

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
  constructor(private db: Database.Database) {}

  recordNudge(input: NudgeInput): Nudge {
    const id = uuidv4();
    const sent_at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO nudges (id, user_id, meeting_id, slack_channel_id, message_ts, type, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.user_id, input.meeting_id, input.slack_channel_id, input.message_ts, input.type, sent_at);
    return this.db.prepare(`SELECT * FROM nudges WHERE id = ?`).get(id) as Nudge;
  }

  buildPreMeetingMessage(meeting: Meeting): SlackMessage {
    const meetingDate = new Date(meeting.start_time);
    const dateStr = meetingDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const timeStr = meetingDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const actionLabel = ACTION_LABELS[meeting.document_action] ?? meeting.document_action;

    const text = `Meetassist: ${meeting.title} needs your async input before ${dateStr} ${timeStr}.\n\nRequested:\n☐ ${actionLabel}\n☐ Confirm when done\n\nDocument: ${meeting.document_title}\n${meeting.document_url}`;

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Meetassist:* ${meeting.title} needs your async input before *${dateStr} ${timeStr}*.\n\nRequested:\n☐ ${actionLabel}\n☐ Confirm when done\n\n*Document:* <${meeting.document_url}|${meeting.document_title}>`,
        },
      },
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
    return `Meetassist reminder: ${meeting.title} is coming up. Please ${actionLabel.toLowerCase()} and confirm.\n\nDocument: ${meeting.document_title}\n${meeting.document_url}`;
  }

  buildFollowUpMessage(meeting: Meeting): string {
    const actionLabel = ACTION_LABELS[meeting.document_action] ?? meeting.document_action;
    return `Meetassist follow-up: ${meeting.title} has passed. Your action is still open: ${actionLabel.toLowerCase()}.\n\nDocument: ${meeting.document_title}\n${meeting.document_url}`;
  }

  recordParticipantMessage(input: ParticipantMessageInput): ParticipantMessage {
    const id = uuidv4();
    const created_at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO participant_messages (id, user_id, meeting_id, nudge_id, raw_text, ai_classification, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(id, input.user_id, input.meeting_id, input.nudge_id, input.raw_text, created_at);
    return this.db.prepare(`SELECT * FROM participant_messages WHERE id = ?`).get(id) as ParticipantMessage;
  }

  recordOperatorReply(participantMessageId: string, rawText: string): void {
    const id = uuidv4();
    const sent_at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO operator_replies (id, participant_message_id, raw_text, sent_at) VALUES (?, ?, ?, ?)`
      )
      .run(id, participantMessageId, rawText, sent_at);
  }
}
