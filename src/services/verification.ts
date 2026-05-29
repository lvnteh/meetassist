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

    // Verification logic (Tasks 3+) goes here.
  } catch (err: any) {
    console.error('[verification] failed:', err?.response?.data ?? err?.message ?? err);
  }
}
