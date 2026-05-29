import type { ParticipantStatus, DocumentAction } from '../types';
import type { MeetingService } from './meeting';
import type { NudgeService } from './nudge';
import type { ConfluenceService } from './confluence';

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

function formatStartTime(iso: string): string {
  const d = new Date(iso);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${wd} ${mo} ${day} · ${hh}:${mm}`;
}

function renderMeeting(m: DashboardMeeting, now: Date): string {
  const idPrefix = m.id.slice(0, 8);
  const done = m.participants.filter((p) => p.status === 'completed').length;
  const total = m.participants.length;
  const blocked = m.participants.filter((p) => p.status === 'blocked').length;

  const progress = blocked > 0
    ? `Progress: ${done}/${total} done · ${blocked} blocked`
    : `Progress: ${done}/${total} done`;

  const rows = m.participants.map((p) => {
    const updated = p.updated_at ? relativeTime(new Date(p.updated_at), now) : '—';
    return [
      '    <tr>',
      `      <td>@${escapeXml(p.display_name)}</td>`,
      `      <td>${escapeXml(humaniseStatus(p.status))}</td>`,
      `      <td>${escapeXml(updated)}</td>`,
      `      <td>${escapeXml(p.latest_reply ?? '')}</td>`,
      '    </tr>',
    ].join('\n');
  }).join('\n');

  return [
    `<h2>${escapeXml(m.title)}</h2>`,
    `<p>${escapeXml(formatStartTime(m.start_time))} · ${escapeXml(idPrefix)}</p>`,
    `<p>Document: <a href="${escapeXml(m.document_url)}">${escapeXml(m.document_title)}</a></p>`,
    `<p>Action requested: ${escapeXml(humaniseAction(m.document_action))}</p>`,
    `<p>${escapeXml(progress)}</p>`,
    '<table>',
    '  <tbody>',
    '    <tr>',
    '      <th>Participant</th>',
    '      <th>Status</th>',
    '      <th>Last updated</th>',
    '      <th>Reply</th>',
    '    </tr>',
    rows,
    '  </tbody>',
    '</table>',
  ].join('\n');
}

export function renderDashboardBody(input: DashboardInput): string {
  const header = renderHeader(input.now);
  if (input.meetings.length === 0) {
    return [header, '', '<p><em>No active meetings.</em></p>'].join('\n');
  }
  const sections = input.meetings.map((m) => renderMeeting(m, input.now)).join('\n\n');
  return [header, '', sections].join('\n');
}

interface DashboardConfig {
  pageId: string;
  meetingService: MeetingService;
  nudgeService: NudgeService;
  confluenceService: ConfluenceService;
}

let config: DashboardConfig | null = null;

export function configureDashboard(c: DashboardConfig): void {
  config = c;
}

export async function publishDashboard(): Promise<void> {
  if (!config || !config.pageId) return;

  try {
    const meetings = await config.meetingService.listActive();
    const dashboardMeetings: DashboardMeeting[] = [];

    for (const m of meetings) {
      const participantsRaw = await config.meetingService.getParticipantsWithUsers(m.id);
      const participants: DashboardParticipant[] = [];
      for (const p of participantsRaw as any[]) {
        const reply = await config.nudgeService.getLatestReply(m.id, p.user_id);
        participants.push({
          slack_user_id: p.slack_user_id,
          display_name: p.display_name,
          status: p.status,
          updated_at: p.updated_at ?? null,
          latest_reply: reply,
        });
      }
      dashboardMeetings.push({
        id: m.id,
        title: m.title,
        start_time: m.start_time,
        document_url: m.document_url,
        document_title: m.document_title,
        document_action: m.document_action as DocumentAction,
        participants,
      });
    }

    const body = renderDashboardBody({ meetings: dashboardMeetings, now: new Date() });
    await config.confluenceService.updatePage(config.pageId, 'Meetassist dashboard', body);
  } catch (err: any) {
    console.error('[dashboard] publish failed:', err?.response?.data ?? err?.message ?? err);
  }
}
