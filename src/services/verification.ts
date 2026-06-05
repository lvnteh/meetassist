import type { MeetingService } from './meeting';
import type { NudgeService } from './nudge';
import type { ConfluenceService } from './confluence';
import type { RelayService } from '../bot/relay';
import type { WebClient } from '@slack/web-api';

interface VerificationDeps {
  meetingService: MeetingService;
  nudgeService: NudgeService;
  confluenceService: ConfluenceService;
  relayService: RelayService;
  slackClient: WebClient;
}

let deps: VerificationDeps | null = null;

export function configureVerification(d: VerificationDeps): void {
  deps = d;
}

export const VERIFICATION_DELAY_MS = 60_000;
const pendingVerifications = new Map<string, NodeJS.Timeout>();

export function scheduleVerification(meetingId: string, userId: string): void {
  const key = `${meetingId}:${userId}`;
  const existing = pendingVerifications.get(key);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(async () => {
    pendingVerifications.delete(key);
    await runVerification(meetingId, userId);
  }, VERIFICATION_DELAY_MS);

  pendingVerifications.set(key, handle);
}

export async function runVerification(meetingId: string, userId: string): Promise<void> {
  if (!deps) return;

  try {
    const meeting = await deps.meetingService.getById(meetingId);
    if (!meeting) return;

    const participants = await deps.meetingService.getParticipantsWithUsers(meetingId);
    const participant = (participants as any[]).find((p) => p.user_id === userId);
    if (!participant) return;

    if (meeting.document_action === 'read') return;
    if (participant.status !== 'completed') return;

    const comments = await deps.confluenceService.getComments(meeting.confluence_page_id);
    const participantEmail = (participant.email ?? '').trim().toLowerCase();
    const verified = participantEmail !== '' && comments.some((c) => {
      const ce = (c.authorEmail ?? '').trim().toLowerCase();
      return ce !== '' && ce === participantEmail;
    });

    if (verified) return;

    const organizer = await deps.meetingService.getUserById(meeting.organizer_user_id);
    if (!organizer) return;

    const actionLabel = humaniseActionForDm(meeting.document_action);
    const text =
      `Meetassist: *${escapeForSlack(participant.display_name)}* marked *${escapeForSlack(meeting.title)}* as done, ` +
      `but I don't see their ${actionLabel} on the doc yet.\n\nSend a follow-up nudge?`;
    const value = `${meeting.id}|${userId}`;

    await deps.slackClient.chat.postMessage({
      channel: organizer.slack_user_id,
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              style: 'primary',
              text: { type: 'plain_text', text: 'Yes, send nudge' },
              action_id: 'verification_nudge_yes',
              value,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Skip' },
              action_id: 'verification_nudge_skip',
              value,
            },
          ],
        },
      ],
    });
  } catch (err: any) {
    console.error('[verification] failed:', err?.response?.data ?? err?.message ?? err);
  }
}

export function escapeForSlack(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function humaniseActionForDm(action: string): string {
  switch (action) {
    case 'comment':           return 'comment';
    case 'provide_input':     return 'input';
    case 'approve':           return 'approval';
    case 'confirm_decision':  return 'decision';
    default:                  return action;
  }
}

type RespondFn = (args: { replace_original?: boolean; text?: string; blocks?: any[] }) => Promise<unknown>;

export async function handleVerificationNudgeYes(value: string, respond: RespondFn): Promise<void> {
  if (!deps) return;
  const [meetingId, userId] = value.split('|');
  if (!meetingId || !userId) return;

  try {
    const meeting = await deps.meetingService.getById(meetingId);
    if (!meeting) return;

    const participants = await deps.meetingService.getParticipantsWithUsers(meetingId);
    const participant = (participants as any[]).find((p) => p.user_id === userId);
    if (!participant) return;

    const msg = deps.nudgeService.buildVerificationNudgeMessage(meeting);

    const { channel, ts } = await deps.relayService.sendBlocksToParticipant({
      slackUserId: participant.slack_user_id,
      text: msg.text,
      blocks: msg.blocks,
    });
    await deps.nudgeService.recordNudge({
      user_id: userId,
      meeting_id: meetingId,
      slack_channel_id: channel,
      message_ts: ts,
      type: 'reminder',
    });
    await deps.meetingService.incrementReminderCount(meetingId, userId);

    await respond({
      replace_original: true,
      text: `✓ Nudge sent to ${participant.display_name}.`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `✓ Nudge sent to *${escapeForSlack(participant.display_name)}*.` } },
      ],
    });
  } catch (err: any) {
    console.error('[verification] nudge_yes failed:', err?.response?.data ?? err?.message ?? err);
  }
}

export async function handleVerificationNudgeSkip(_value: string, respond: RespondFn): Promise<void> {
  try {
    await respond({
      replace_original: true,
      text: 'Skipped.',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Skipped.' } }],
    });
  } catch (err: any) {
    console.error('[verification] nudge_skip failed:', err?.response?.data ?? err?.message ?? err);
  }
}
