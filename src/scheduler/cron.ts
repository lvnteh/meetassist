import cron from 'node-cron';
import type { WebClient } from '@slack/web-api';
import type { MeetingService } from '../services/meeting';
import type { RelayService } from '../bot/relay';
import { updateControlCard } from '../bot/control-card';

export function startScheduler(
  meetingService: MeetingService,
  relayService: RelayService,
  client: WebClient,
): void {
  cron.schedule('0 * * * *', async () => {
    const now = new Date().toISOString();
    const meetings = await meetingService.listActive();

    for (const meeting of meetings) {
      if (meeting.start_time > now) continue;

      const participants = await meetingService.getParticipantsWithUsers(meeting.id);
      const overdue = participants.filter(
        (p) => p.status === 'nudge_sent' || p.status === 'pending'
      );

      if (overdue.length === 0) continue;

      for (const p of overdue) {
        await meetingService.updateParticipantStatus(meeting.id, p.user_id, 'overdue');
      }

      const names = overdue.map((p) => `<@${p.slack_user_id}>`).join(', ');
      await relayService.notifyOperator(
        `[Meetassist] Overdue: ${names} have not completed their action for *${meeting.title}*.`
      );
    }
  });

  cron.schedule('0 8 * * *', async () => {
    const meetings = await meetingService.listActive();
    if (meetings.length === 0) return;

    const lines: string[] = ['*Meetassist Daily Digest*'];
    for (const meeting of meetings) {
      const participants = await meetingService.getParticipantsWithUsers(meeting.id);
      const completed = participants.filter((p) => p.status === 'completed').length;
      const total = participants.length;
      const blocked = participants.filter((p) => p.status === 'blocked').length;
      lines.push(
        `• *${meeting.title}* — ${completed}/${total} done${blocked > 0 ? `, ${blocked} blocked` : ''} — <${meeting.document_url}|doc>`
      );
    }

    await relayService.notifyOperator(lines.join('\n'));
  });

  cron.schedule('*/5 * * * *', async () => {
    try {
      const stale = await meetingService.getMeetingsWithStaleCard();
      for (const m of stale) {
        await updateControlCard(client, meetingService, m as any);
      }
    } catch (err: any) {
      console.error('[scheduler] card refresh failed:', err?.message ?? err);
    }
  });
}
