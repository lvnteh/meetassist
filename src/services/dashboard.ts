import type { ParticipantStatus, DocumentAction } from '../types';

export function relativeTime(from: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - from.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  return `${wk}w ago`;
}

export function escapeXml(value: string | null | undefined): string {
  if (value == null) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const STATUS_LABELS: Record<ParticipantStatus, string> = {
  pending: 'waiting for nudge',
  nudge_sent: 'nudge sent',
  replied: 'replied',
  clarification_needed: 'clarification asked',
  blocked: 'blocked',
  overdue: 'overdue',
  completed: 'done',
};

export function humaniseStatus(status: ParticipantStatus): string {
  return STATUS_LABELS[status] ?? (status as string);
}

const ACTION_LABELS: Record<DocumentAction, string> = {
  read: 'read',
  comment: 'comment',
  approve: 'approve',
  provide_input: 'provide input',
  confirm_decision: 'confirm decision',
};

export function humaniseAction(action: DocumentAction): string {
  return ACTION_LABELS[action] ?? (action as string);
}

export interface DashboardMeeting {
  id: string;
  title: string;
  start_time: string;
  document_url: string;
  document_title: string;
  document_action: DocumentAction;
  participants: DashboardParticipant[];
}

export interface DashboardParticipant {
  slack_user_id: string;
  display_name: string;
  status: ParticipantStatus;
  updated_at: string | null;
  latest_reply: string | null;
}

export interface DashboardInput {
  meetings: DashboardMeeting[];
  now: Date;
}

function renderHeader(now: Date): string {
  const stamp = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return [
    '<ac:structured-macro ac:name="info">',
    '  <ac:rich-text-body>',
    `    <p>Last updated: ${escapeXml(stamp)}</p>`,
    '  </ac:rich-text-body>',
    '</ac:structured-macro>',
  ].join('\n');
}

export function renderDashboardBody(input: DashboardInput): string {
  const header = renderHeader(input.now);
  if (input.meetings.length === 0) {
    return [header, '', '<p><em>No active meetings.</em></p>'].join('\n');
  }
  return header;
}
