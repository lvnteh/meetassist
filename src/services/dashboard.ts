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

export function escapeHtml(value: string | null | undefined): string {
  if (value == null) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function cleanUrl(url: string | null | undefined): string {
  if (!url) return '';
  const trimmed = url.trim();
  const match = trimmed.match(/^<(https?:\/\/[^|>]+)(?:\|[^>]*)?>$/);
  return match ? match[1] : trimmed;
}

function statusClass(status: ParticipantStatus): string {
  switch (status) {
    case 'completed': return 'status-done';
    case 'blocked': return 'status-blocked';
    case 'clarification_needed': return 'status-clarify';
    case 'overdue': return 'status-overdue';
    case 'replied': return 'status-replied';
    case 'nudge_sent': return 'status-sent';
    case 'pending': return 'status-pending';
    default: return 'status-pending';
  }
}

function renderMeeting(m: DashboardMeeting, now: Date): string {
  const idPrefix = m.id.slice(0, 8);
  const done = m.participants.filter((p) => p.status === 'completed').length;
  const total = m.participants.length;
  const blocked = m.participants.filter((p) => p.status === 'blocked').length;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
  const progressText = blocked > 0
    ? `${done}/${total} done · ${blocked} blocked`
    : `${done}/${total} done`;

  const purposeRow = m.purpose && m.purpose.trim() !== ''
    ? `      <div class="meta-row"><span class="meta-label">Purpose</span><span class="meta-value">${escapeHtml(m.purpose)}</span></div>\n`
    : '';

  const rows = m.participants.length === 0
    ? `      <tr><td colspan="4" class="empty">No participants.</td></tr>`
    : m.participants.map((p) => {
        const updated = p.updated_at ? relativeTime(new Date(p.updated_at), now) : '—';
        const reply = p.latest_reply && p.latest_reply.trim() !== ''
          ? escapeHtml(p.latest_reply)
          : '<span class="muted">—</span>';
        return `      <tr>
        <td class="participant">@${escapeHtml(p.display_name)}</td>
        <td><span class="badge ${statusClass(p.status)}">${escapeHtml(humaniseStatus(p.status))}</span></td>
        <td class="muted">${escapeHtml(updated)}</td>
        <td class="reply">${reply}</td>
      </tr>`;
      }).join('\n');

  return `  <section class="meeting">
    <header class="meeting-header">
      <h2>${escapeHtml(m.title)}</h2>
      <code class="id">${escapeHtml(idPrefix)}</code>
    </header>
    <div class="meta">
      <div class="meta-row"><span class="meta-label">Starts</span><span class="meta-value">${escapeHtml(formatStartTime(m.start_time))}</span></div>
      <div class="meta-row"><span class="meta-label">Document</span><span class="meta-value"><a href="${escapeHtml(cleanUrl(m.document_url))}" target="_blank" rel="noopener">${escapeHtml(m.document_title)}</a></span></div>
      <div class="meta-row"><span class="meta-label">Action</span><span class="meta-value">${escapeHtml(humaniseAction(m.document_action))}</span></div>
${purposeRow}      <div class="meta-row"><span class="meta-label">Progress</span><span class="meta-value">${escapeHtml(progressText)}</span></div>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width: ${progressPct}%"></div></div>
    <table class="participants">
      <thead>
        <tr><th>Participant</th><th>Status</th><th>Last updated</th><th>Reply</th></tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>`;
}

const STYLES = `
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f5f6f8;
    color: #1f2329;
    margin: 0;
    padding: 32px 24px;
    line-height: 1.5;
  }
  .container { max-width: 960px; margin: 0 auto; }
  header.page-header {
    margin-bottom: 32px;
    padding-bottom: 16px;
    border-bottom: 1px solid #e1e4e8;
  }
  h1 { margin: 0 0 4px; font-size: 28px; font-weight: 600; }
  .updated { color: #6a737d; font-size: 13px; }
  .empty-state {
    text-align: center;
    padding: 64px 24px;
    color: #6a737d;
    background: #fff;
    border-radius: 8px;
    border: 1px solid #e1e4e8;
  }
  .meeting {
    background: #fff;
    border-radius: 8px;
    border: 1px solid #e1e4e8;
    padding: 20px 24px;
    margin-bottom: 20px;
  }
  .meeting-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .meeting-header h2 { margin: 0; font-size: 20px; font-weight: 600; }
  .id {
    font-family: 'SF Mono', Menlo, monospace;
    font-size: 12px;
    background: #f5f6f8;
    padding: 2px 8px;
    border-radius: 4px;
    color: #6a737d;
  }
  .meta { margin-bottom: 12px; }
  .meta-row {
    display: flex;
    gap: 12px;
    padding: 4px 0;
    font-size: 14px;
  }
  .meta-label {
    color: #6a737d;
    min-width: 80px;
    font-weight: 500;
  }
  .meta-value a { color: #0366d6; text-decoration: none; }
  .meta-value a:hover { text-decoration: underline; }
  .progress-bar {
    height: 6px;
    background: #e1e4e8;
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 16px;
  }
  .progress-fill {
    height: 100%;
    background: #28a745;
    transition: width 0.3s ease;
  }
  table.participants {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  table.participants th {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid #e1e4e8;
    font-weight: 600;
    color: #6a737d;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  table.participants td {
    padding: 10px 12px;
    border-bottom: 1px solid #f1f2f4;
    vertical-align: top;
  }
  table.participants tr:last-child td { border-bottom: none; }
  .participant { font-weight: 500; }
  .muted { color: #6a737d; }
  .empty { text-align: center; color: #6a737d; padding: 24px; }
  .reply { max-width: 360px; word-wrap: break-word; }
  .badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
  }
  .status-done { background: #d4edda; color: #155724; }
  .status-blocked { background: #f8d7da; color: #721c24; }
  .status-clarify { background: #fff3cd; color: #856404; }
  .status-overdue { background: #f8d7da; color: #721c24; }
  .status-replied { background: #d1ecf1; color: #0c5460; }
  .status-sent { background: #e2e3e5; color: #383d41; }
  .status-pending { background: #f5f6f8; color: #6a737d; }
`;

export function renderDashboardBody(input: DashboardInput): string {
  const stamp = input.now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const body = input.meetings.length === 0
    ? '  <div class="empty-state">No active meetings.</div>'
    : input.meetings.map((m) => renderMeeting(m, input.now)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Meetassist dashboard</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="container">
    <header class="page-header">
      <h1>Meetassist dashboard</h1>
      <div class="updated">Last updated: ${escapeHtml(stamp)}</div>
    </header>
${body}
  </div>
</body>
</html>
`;
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

export async function fetchDashboardData(
  meetingService: MeetingService,
  nudgeService: NudgeService,
): Promise<DashboardMeeting[]> {
  const meetings = await meetingService.listActive();
  const dashboardMeetings: DashboardMeeting[] = [];

  for (const m of meetings) {
    const participantsRaw = await meetingService.getParticipantsWithUsers(m.id);
    const participants: DashboardParticipant[] = [];
    for (const p of participantsRaw as any[]) {
      const reply = await nudgeService.getLatestReply(m.id, p.user_id);
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

  return dashboardMeetings;
}

export async function publishDashboard(): Promise<void> {
  if (!config || !config.filePath) return;

  try {
    const meetings = await fetchDashboardData(config.meetingService, config.nudgeService);
    const body = renderDashboardBody({ meetings, now: new Date() });
    await fs.writeFile(config.filePath, body, 'utf8');
  } catch (err: any) {
    console.error('[dashboard] publish failed:', err?.message ?? err);
  }
}
