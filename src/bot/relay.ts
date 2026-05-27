import { app } from './app';
import type { MeetingService } from '../services/meeting';
import type { NudgeService } from '../services/nudge';

export class RelayService {
  constructor(
    private meetingService: MeetingService,
    private nudgeService: NudgeService
  ) {}

  async forwardToOperator(params: {
    senderSlackId: string;
    text: string;
    meetingTitle: string;
  }): Promise<void> {
    const operatorId = process.env.OPERATOR_SLACK_ID!;
    await app.client.chat.postMessage({
      channel: operatorId,
      text: `[Meetassist] Incoming from <@${params.senderSlackId}> (${params.meetingTitle})\n> "${params.text}"\n\nReply: \`/ma reply @${params.senderSlackId} <your message>\``,
    });
  }

  async sendToParticipant(params: {
    slackUserId: string;
    text: string;
  }): Promise<{ channel: string; ts: string }> {
    const result = await app.client.chat.postMessage({
      channel: params.slackUserId,
      text: params.text,
    });
    return { channel: result.channel as string, ts: result.ts as string };
  }

  async sendBlocksToParticipant(params: {
    slackUserId: string;
    text: string;
    blocks: object[];
  }): Promise<{ channel: string; ts: string }> {
    const result = await app.client.chat.postMessage({
      channel: params.slackUserId,
      text: params.text,
      blocks: params.blocks as any,
    });
    return { channel: result.channel as string, ts: result.ts as string };
  }

  async notifyOperator(text: string): Promise<void> {
    const operatorId = process.env.OPERATOR_SLACK_ID!;
    await app.client.chat.postMessage({ channel: operatorId, text });
  }

  registerDmListener(meetingService: MeetingService, nudgeService: NudgeService): void {
    const operatorId = process.env.OPERATOR_SLACK_ID!;

    app.message(async ({ message }) => {
      const msg = message as any;
      // Only handle DMs, not from operator, not from the bot itself
      if (!msg.user || msg.channel_type !== 'im' || msg.user === operatorId || msg.bot_id) return;

      const slackUserId: string = msg.user;
      const text: string = msg.text ?? '';

      const user = meetingService.getUserBySlackId(slackUserId);
      if (!user) return;

      const meeting = meetingService.getMeetingForParticipant(slackUserId);
      if (!meeting) return;

      nudgeService.recordParticipantMessage({
        user_id: user.id,
        meeting_id: meeting.id,
        nudge_id: null,
        raw_text: text,
      });

      meetingService.updateParticipantStatus(meeting.id, user.id, 'replied');

      await this.forwardToOperator({
        senderSlackId: slackUserId,
        text,
        meetingTitle: meeting.title,
      });
    });
  }
}
