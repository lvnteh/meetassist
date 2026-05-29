import type { Meeting, MeetingParticipant, User, MeetingWithParticipantStatus } from '../types';
import { humaniseParticipantStatus, humaniseDocumentAction } from './labels';

interface OperatorMeetingSummary {
  meeting: Meeting;
  participants: (MeetingParticipant & User)[];
}

interface OperatorViewInput {
  meetings: OperatorMeetingSummary[];
}

interface ParticipantViewInput {
  meetings: MeetingWithParticipantStatus[];
}

export interface SlackHomeView {
  type: 'home';
  blocks: any[];
}

export function buildOperatorView(input: OperatorViewInput): SlackHomeView {
  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Meetassist' } },
  ];

  if (input.meetings.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'No active meetings yet. Create your first one to get started.' },
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '+ Create meeting' },
          action_id: 'home_create_meeting',
          style: 'primary',
        },
      ],
    });
    return { type: 'home', blocks };
  }

  const totalPending = input.meetings.reduce(
    (sum, m) => sum + m.participants.filter((p) => p.status !== 'completed').length,
    0
  );
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${input.meetings.length} active meeting${input.meetings.length === 1 ? '' : 's'} · ${totalPending} pending replies`,
    },
  });
  blocks.push({ type: 'divider' });

  for (const { meeting, participants } of input.meetings) {
    const done = participants.filter((p) => p.status === 'completed').length;
    const total = participants.length;
    const blocked = participants.filter((p) => p.status === 'blocked').length;

    const date = new Date(meeting.start_time);
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const idPrefix = meeting.id.slice(0, 8);
    const actionLabel = humaniseDocumentAction(meeting.document_action);

    const progressLine = blocked > 0
      ? `Progress: ${done}/${total} done · ${blocked} blocked`
      : `Progress: ${done}/${total} done`;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${meeting.title}*`,
          `${dateStr} · ${timeStr} · \`${idPrefix}\``,
          `Action: ${actionLabel}`,
          progressLine,
          `Doc: <${meeting.document_url}|${meeting.document_title}>`,
        ].join('\n'),
      },
    });
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Send' },       action_id: 'home_send',        value: meeting.id, style: 'primary' },
        { type: 'button', text: { type: 'plain_text', text: 'Remind' },     action_id: 'home_remind',      value: meeting.id },
        { type: 'button', text: { type: 'plain_text', text: 'Status' },     action_id: 'home_status',      value: meeting.id },
        { type: 'button', text: { type: 'plain_text', text: 'Check doc' },  action_id: 'home_check_doc',   value: meeting.id },
        { type: 'button', text: { type: 'plain_text', text: 'Set action' }, action_id: 'home_set_action',  value: meeting.id },
        { type: 'button', text: { type: 'plain_text', text: 'Followup' },   action_id: 'home_followup',    value: meeting.id },
      ],
    });
    blocks.push({ type: 'divider' });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '+ Create meeting' },
        action_id: 'home_create_meeting',
        style: 'primary',
      },
    ],
  });

  return { type: 'home', blocks };
}

export function buildParticipantView(input: ParticipantViewInput): SlackHomeView {
  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Meetassist' } },
  ];

  if (input.meetings.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: "You're all caught up. No actions needed right now." },
    });
    return { type: 'home', blocks };
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${input.meetings.length} action${input.meetings.length === 1 ? '' : 's'} waiting for you`,
    },
  });
  blocks.push({ type: 'divider' });

  for (const meeting of input.meetings) {
    const date = new Date(meeting.start_time);
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const actionLabel = humaniseDocumentAction(meeting.document_action);
    const statusLabel = humaniseParticipantStatus(meeting.participant_status);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${meeting.title}*`,
          `${dateStr} · ${timeStr}`,
          `Action requested: ${actionLabel}`,
          `Document: <${meeting.document_url}|${meeting.document_title}>`,
          `Status: ${statusLabel}`,
        ].join('\n'),
      },
    });
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Mark done' },          action_id: 'mark_done',            value: meeting.id, style: 'primary' },
        { type: 'button', text: { type: 'plain_text', text: 'Need clarification' }, action_id: 'need_clarification',   value: meeting.id },
        { type: 'button', text: { type: 'plain_text', text: 'Cannot complete' },    action_id: 'cannot_complete',      value: meeting.id, style: 'danger' },
      ],
    });
    blocks.push({ type: 'divider' });
  }

  return { type: 'home', blocks };
}
