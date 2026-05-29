import type { Meeting, MeetingParticipant, ParticipantStatus } from '../types';
import { humaniseAction } from '../services/dashboard';

type ParticipantLike = MeetingParticipant & {
  slack_user_id?: string;
  display_name?: string;
};

function cleanUrl(url: string | null | undefined): string {
  if (!url) return '';
  const trimmed = url.trim();
  const match = trimmed.match(/^<(https?:\/\/[^|>]+)(?:\|[^>]*)?>$/);
  return match ? match[1] : trimmed;
}

function formatStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${wd} ${mo} ${day} · ${hh}:${mm} UTC`;
}

function countByStatus(participants: ParticipantLike[]): {
  total: number;
  done: number;
  blocked: number;
} {
  let done = 0;
  let blocked = 0;
  for (const p of participants) {
    if ((p.status as ParticipantStatus) === 'completed') done += 1;
    if ((p.status as ParticipantStatus) === 'blocked') blocked += 1;
  }
  return { total: participants.length, done, blocked };
}

export function progressSignature(participants: ParticipantLike[]): string {
  const { total, done, blocked } = countByStatus(participants);
  return `${done}/${total}/${blocked}`;
}

export function buildControlCardBlocks(
  meeting: Meeting,
  participants: ParticipantLike[]
): any[] {
  const isCancelled = meeting.status === 'cancelled';
  const { total, done, blocked } = countByStatus(participants);

  const docUrl = cleanUrl(meeting.document_url);
  const startStr = formatStart(meeting.start_time);
  const actionLabel = humaniseAction(meeting.document_action);

  const titleText = isCancelled
    ? `*~${meeting.title}~* _(Cancelled)_`
    : `*${meeting.title}*`;

  const blocks: any[] = [];

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: titleText,
    },
  });

  const metaLines: string[] = [];
  metaLines.push(`*Starts:* ${startStr}`);
  if (docUrl) {
    const linkLabel = meeting.document_title || 'Document';
    metaLines.push(`*Doc:* ${linkLabel} — ${docUrl}`);
  }
  metaLines.push(`*Action:* ${actionLabel}`);
  if (meeting.purpose && meeting.purpose.trim().length > 0) {
    metaLines.push(`*Purpose:* ${meeting.purpose}`);
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: metaLines.join('\n'),
    },
  });

  const progressText = isCancelled
    ? `_${done}/${total} done · ${blocked} blocked at cancellation_`
    : `*Progress:* ${done}/${total} done · ${blocked} blocked`;

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: progressText,
      },
    ],
  });

  if (!isCancelled) {
    blocks.push({
      type: 'actions',
      block_id: `meeting_actions_${meeting.id}`,
      elements: [
        {
          type: 'button',
          action_id: 'meeting_view_status',
          text: { type: 'plain_text', text: 'View status' },
          value: meeting.id,
        },
        {
          type: 'button',
          action_id: 'meeting_change_action',
          text: { type: 'plain_text', text: 'Change action' },
          value: meeting.id,
        },
        {
          type: 'button',
          action_id: 'meeting_send_reminder',
          text: { type: 'plain_text', text: 'Send reminder' },
          value: meeting.id,
        },
        {
          type: 'button',
          action_id: 'meeting_cancel',
          text: { type: 'plain_text', text: 'Cancel meeting' },
          value: meeting.id,
          style: 'danger',
          confirm: {
            title: { type: 'plain_text', text: 'Cancel this meeting?' },
            text: {
              type: 'mrkdwn',
              text: `This will cancel *${meeting.title}* and notify participants. This cannot be undone.`,
            },
            confirm: { type: 'plain_text', text: 'Yes, cancel' },
            deny: { type: 'plain_text', text: 'Keep it' },
          },
        },
      ],
    });
  }

  return blocks;
}
