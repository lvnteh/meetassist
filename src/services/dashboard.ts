import { promises as fs } from 'fs';
import type { ParticipantStatus, DocumentAction } from '../types';
import type { MeetingService } from './meeting';
import type { NudgeService } from './nudge';

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
  purpose: string;
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

function escapeMd(value: string | null | undefined): string {
  if (value == null) return '';
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/\r/g, '');
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
    ? `${done}/${total} done · ${blocked} blocked`
    : `${done}/${total} done`;

  const lines: string[] = [];
  lines.push(`## ${m.title}`);
  lines.push('');
  lines.push(`- **Starts:** ${formatStartTime(m.start_time)} · \`${idPrefix}\``);
  lines.push(`- **Document:** [${escapeMd(m.document_title)}](${m.document_url})`);
  lines.push(`- **Action requested:** ${humaniseAction(m.document_action)}`);
  if (m.purpose && m.purpose.trim() !== '') {
    lines.push(`- **Purpose:** ${escapeMd(m.purpose)}`);
  }
  lines.push(`- **Progress:** ${progress}`);
  lines.push('');

  if (m.participants.length === 0) {
    lines.push('_No participants._');
  } else {
    lines.push('| Participant | Status | Last updated | Reply |');
    lines.push('|---|---|---|---|');
    for (const p of m.participants) {
      const updated = p.updated_at ? relativeTime(new Date(p.updated_at), now) : '—';
      lines.push(
        `| @${escapeMd(p.display_name)} | ${escapeMd(humaniseStatus(p.status))} | ${escapeMd(updated)} | ${escapeMd(p.latest_reply ?? '')} |`
      );
    }
  }

  return lines.join('\n');
}

export function renderDashboardBody(input: DashboardInput): string {
  const stamp = input.now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const header = [
    '# Meetassist dashboard',
    '',
    `_Last updated: ${stamp}_`,
    '',
  ].join('\n');

  if (input.meetings.length === 0) {
    return `${header}\n_No active meetings._\n`;
  }

  const sections = input.meetings.map((m) => renderMeeting(m, input.now)).join('\n\n---\n\n');
  return `${header}\n${sections}\n`;
}

interface DashboardConfig {
  filePath: string;
  meetingService: MeetingService;
  nudgeService: NudgeService;
}

let config: DashboardConfig | null = null;

export function configureDashboard(c: DashboardConfig): void {
  config = c;
}

export async function publishDashboard(): Promise<void> {
  if (!config || !config.filePath) return;

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
        purpose: m.purpose,
        participants,
      });
    }

    const body = renderDashboardBody({ meetings: dashboardMeetings, now: new Date() });
    await fs.writeFile(config.filePath, body, 'utf8');
  } catch (err: any) {
    console.error('[dashboard] publish failed:', err?.message ?? err);
  }
}
