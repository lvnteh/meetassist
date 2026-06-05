import { app } from './app';
import type { MeetingService } from '../services/meeting';
import type { Meeting, ParticipantStatus } from '../types';
import { humaniseStatus, humaniseAction } from '../services/dashboard';

function formatStart(iso: string): string {
  const d = new Date(iso);
  const wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  return `${wd} ${mo} ${d.getUTCDate()} · ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
}

export function buildWelcomeBlocks(): any[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Meetassist* helps you coordinate pre-meeting document actions — read, comment, or approve — and tracks who has responded.',
      },
      accessory: {
        type: 'button',
        action_id: 'open_create_modal',
        text: { type: 'plain_text', text: '➕ Create meeting' },
        style: 'primary',
      },
    },
  ];
}

export function buildParticipantBlocks(
  meetings: (Meeting & { participant_status: ParticipantStatus })[]
): any[] {
  const blocks: any[] = [
    { type: 'divider' },
    {
      type: 'header',
      text: { type: 'plain_text', text: '📋 Your pending actions' },
    },
  ];

  if (meetings.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_You have no pending actions right now._' },
    });
    return blocks;
  }

  for (const m of meetings) {
    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${m.document_url}|${m.title}>*`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Action*\n${humaniseAction(m.document_action)} on <${m.document_url}|${m.document_title}>` },
          { type: 'mrkdwn', text: `*Status*\n${humaniseStatus(m.participant_status)}` },
          { type: 'mrkdwn', text: `*Meeting starts*\n${formatStart(m.start_time)}` },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Mark done' },
            action_id: 'mark_done',
            style: 'primary',
            value: m.id,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❓ Need clarification' },
            action_id: 'need_clarification',
            value: m.id,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '🚫 Cannot complete' },
            action_id: 'cannot_complete',
            style: 'danger',
            value: m.id,
          },
        ],
      },
      { type: 'divider' }
    );
  }

  return blocks;
}

interface OperatorMeeting extends Meeting {
  participants: { display_name: string; slack_user_id: string; status: ParticipantStatus }[];
}

export function buildOperatorBlocks(meetings: OperatorMeeting[]): any[] {
  const blocks: any[] = [
    { type: 'divider' },
    {
      type: 'header',
      text: { type: 'plain_text', text: '🗂 Active meetings' },
    },
  ];

  if (meetings.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No active meetings._' },
    });
    return blocks;
  }

  for (const m of meetings) {
    const done = m.participants.filter((p) => p.status === 'completed').length;
    const total = m.participants.length;
    const blocked = m.participants.filter((p) => p.status === 'blocked').length;
    const progressNote = blocked > 0 ? `${done}/${total} done · ${blocked} blocked` : `${done}/${total} done`;
    const participantLines = m.participants.length === 0
      ? '_No participants_'
      : m.participants.map((p) => `• <@${p.slack_user_id}> — ${humaniseStatus(p.status)}`).join('\n');

    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${m.title}*`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Action*\n${humaniseAction(m.document_action)}` },
          { type: 'mrkdwn', text: `*Progress*\n${progressNote}` },
          { type: 'mrkdwn', text: `*Starts*\n${formatStart(m.start_time)}` },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: participantLines }],
      },
      { type: 'divider' }
    );
  }

  return blocks;
}

export function registerHomeTab(meetingService: MeetingService): void {
  const operatorIds = (process.env.OPERATOR_SLACK_IDS ?? process.env.OPERATOR_SLACK_ID ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  app.event('app_home_opened', async ({ event, client }) => {
    const userId = event.user;

    const participantMeetings = await meetingService.getActiveMeetingsForParticipant(userId);
    const blocks: any[] = [
      ...buildWelcomeBlocks(),
      ...buildParticipantBlocks(participantMeetings),
    ];

    if (operatorIds.includes(userId)) {
      const activeMeetings = await meetingService.listActive();
      const operatorMeetings: OperatorMeeting[] = [];
      for (const m of activeMeetings) {
        const participants = await meetingService.getParticipantsWithUsers(m.id);
        operatorMeetings.push({
          ...m,
          participants: participants.map((p) => ({
            display_name: p.display_name,
            slack_user_id: p.slack_user_id,
            status: p.status,
          })),
        });
      }
      blocks.push(...buildOperatorBlocks(operatorMeetings));
    }

    await client.views.publish({
      user_id: userId,
      view: { type: 'home', blocks },
    });
  });
}
