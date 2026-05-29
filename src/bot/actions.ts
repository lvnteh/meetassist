import { app } from './app';
import type { MeetingService } from '../services/meeting';
import type { RelayService } from './relay';
import { publishDashboard } from '../services/dashboard';
import { handleVerificationNudgeYes, handleVerificationNudgeSkip, scheduleVerification } from '../services/verification';

export function registerActions(
  meetingService: MeetingService,
  relayService: RelayService
): void {
  app.action('mark_done', async ({ ack, body, action }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    const user = await meetingService.getUserBySlackId(slackUserId);
    if (!user) return;

    await meetingService.updateParticipantStatus(meetingId, user.id, 'completed');

    await app.client.chat.postMessage({
      channel: slackUserId,
      text: 'Meetassist: Noted — marked as done. Thank you.',
    });

    const meeting = await meetingService.getById(meetingId);
    if (meeting) {
      await relayService.notifyOperator(
        `[Meetassist] <@${slackUserId}> marked *${meeting.title}* as done.`
      );
    }
    await publishDashboard();
    scheduleVerification(meetingId, user.id);
  });

  app.action('need_clarification', async ({ ack, body, action }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    const user = await meetingService.getUserBySlackId(slackUserId);
    if (!user) return;

    await meetingService.updateParticipantStatus(meetingId, user.id, 'clarification_needed');

    await app.client.chat.postMessage({
      channel: slackUserId,
      text: 'Meetassist: Got it — flagged as needing clarification. Someone will follow up.',
    });

    const meeting = await meetingService.getById(meetingId);
    if (meeting) {
      await relayService.notifyOperator(
        `[Meetassist] <@${slackUserId}> needs clarification on *${meeting.title}*.\n\nReply: \`/ma reply @${slackUserId} <your message>\``
      );
    }
    await publishDashboard();
  });

  app.action('cannot_complete', async ({ ack, body, action }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    const user = await meetingService.getUserBySlackId(slackUserId);
    if (!user) return;

    await meetingService.updateParticipantStatus(meetingId, user.id, 'blocked');

    await app.client.chat.postMessage({
      channel: slackUserId,
      text: 'Meetassist: Understood — marked as blocked. Someone will follow up.',
    });

    const meeting = await meetingService.getById(meetingId);
    if (meeting) {
      await relayService.notifyOperator(
        `[Meetassist] <@${slackUserId}> cannot complete *${meeting.title}*.\n\nReply: \`/ma reply @${slackUserId} <your message>\``
      );
    }
    await publishDashboard();
  });

  app.action('open_document', async ({ ack }) => {
    await ack();
  });

  app.action(/^send_nudge_yes_(.+)$/, async ({ ack, body, action }) => {
    await ack();
    const payload = (action as any).value as string;
    const [meetingId, slackUserId, ...rest] = payload.split('|');
    const nudgeText = rest.join('|');

    await app.client.chat.postMessage({ channel: slackUserId, text: nudgeText });
    await relayService.notifyOperator(`[Meetassist] Nudge sent to <@${slackUserId}>.`);
  });

  app.action(/^send_nudge_skip_(.+)$/, async ({ ack }) => {
    await ack();
  });

  app.action('verification_nudge_yes', async ({ ack, action, respond }) => {
    await ack();
    const value = (action as any).value as string;
    await handleVerificationNudgeYes(value, respond as any);
  });

  app.action('verification_nudge_skip', async ({ ack, action, respond }) => {
    await ack();
    const value = (action as any).value as string;
    await handleVerificationNudgeSkip(value, respond as any);
  });
}
