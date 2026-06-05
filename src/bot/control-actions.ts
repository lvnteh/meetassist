import type { MeetingService } from '../services/meeting';
import type { NudgeService } from '../services/nudge';
import type { RelayService } from './relay';
import { buildChangeActionModal } from './modals';
import { updateControlCard } from './control-card';
import { humaniseStatus, relativeTime } from '../services/dashboard';

export function registerControlActions(
  meetingService: MeetingService,
  nudgeService: NudgeService,
  relayService: RelayService,
): void {
  // Lazy-load to avoid eagerly constructing the Bolt App singleton at module load
  const { app } = require('./app') as typeof import('./app');

  app.action('meeting_view_status', async ({ ack, action, client }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const meeting = await meetingService.getById(meetingId);
    if (!meeting) return;
    const controlChannel = (meeting as any).control_channel_id as string | undefined;
    if (!controlChannel) return;
    const participants = await meetingService.getParticipantsWithUsers(meetingId);
    const lines = participants.length === 0
      ? ['_No participants._']
      : participants.map((p) => {
          const updated = (p as any).completed_at ? relativeTime(new Date((p as any).completed_at)) : '—';
          return `• <@${p.slack_user_id}> — ${humaniseStatus(p.status)} (${updated})`;
        });
    await client.chat.postMessage({
      channel: controlChannel,
      text: `*${meeting.title}* — status\n${lines.join('\n')}`,
    });
  });

  app.action('meeting_change_action', async ({ ack, body, action, client }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const meeting = await meetingService.getById(meetingId);
    if (!meeting) return;
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: buildChangeActionModal(meetingId, meeting.document_action),
    });
  });

  app.action('meeting_send_reminder', async ({ ack, action, client }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const meeting = await meetingService.getById(meetingId);
    if (!meeting) return;
    const controlChannel = (meeting as any).control_channel_id as string | undefined;
    const participants = await meetingService.getParticipantsWithUsers(meetingId);
    const targets = participants.filter((p) => p.status !== 'completed');
    const text = nudgeService.buildReminderMessage(meeting);
    let sent = 0;
    for (const p of targets) {
      try {
        const { channel, ts } = await relayService.sendToParticipant({
          slackUserId: p.slack_user_id,
          text,
        });
        await nudgeService.recordNudge({
          user_id: p.user_id,
          meeting_id: meetingId,
          slack_channel_id: channel,
          message_ts: ts,
          type: 'reminder',
        });
        await meetingService.incrementReminderCount(meetingId, p.user_id);
        sent++;
      } catch (err: any) {
        console.error('[reminder] send failed:', err?.message ?? err);
      }
    }
    if (controlChannel) {
      await client.chat.postMessage({
        channel: controlChannel,
        text: `Reminders sent to ${sent} of ${targets.length} participant(s).`,
      });
    }
    await updateControlCard(client as any, meetingService, meeting);
  });

  app.action('meeting_cancel', async ({ ack, action, client }) => {
    await ack();
    const meetingId = (action as any).value as string;
    await meetingService.updateStatus(meetingId, 'cancelled');
    const meeting = await meetingService.getById(meetingId);
    if (meeting) {
      await updateControlCard(client as any, meetingService, meeting);
    }
  });
}
