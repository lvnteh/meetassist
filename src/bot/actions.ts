import { app } from './app';
import type { MeetingService } from '../services/meeting';
import type { RelayService } from './relay';

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
}
