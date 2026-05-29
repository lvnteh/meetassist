import type { WebClient } from '@slack/web-api';
import type { Pool } from 'pg';
import type { MeetingService } from '../services/meeting';

const PROMPT_BLOCKS = [
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*Meetassist*\nClick below to create a meeting. You can also still use `/ma` slash commands.',
    },
  },
  {
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: 'open_create_modal',
        text: { type: 'plain_text', text: '➕ Create meeting' },
        style: 'primary',
      },
    ],
  },
];

export async function bootstrapOperatorDms(
  pool: Pool,
  meetingService: MeetingService,
  client: WebClient,
  operatorSlackIds: string[],
): Promise<void> {
  for (const slackId of operatorSlackIds) {
    try {
      const dm = await client.conversations.open({ users: slackId });
      const channelId = (dm.channel as any)?.id;
      if (!channelId) continue;

      const user = await meetingService.getUserBySlackId(slackId);
      if (!user) {
        console.error(`[dm-bootstrap] no user row for ${slackId} — skipping`);
        continue;
      }
      const existingTs = (user as any).operator_dm_message_ts;
      const existingChannel = (user as any).operator_dm_channel_id;

      if (existingTs && existingChannel === channelId) {
        try {
          await client.chat.update({
            channel: channelId,
            ts: existingTs,
            blocks: PROMPT_BLOCKS,
            text: 'Meetassist',
          });
          continue;
        } catch (err: any) {
          // fall through to repost
        }
      }

      const result = await client.chat.postMessage({
        channel: channelId,
        blocks: PROMPT_BLOCKS,
        text: 'Meetassist — create a meeting',
      });
      if (result.ts) {
        await pool.query(
          `UPDATE users SET operator_dm_channel_id = $1, operator_dm_message_ts = $2 WHERE id = $3`,
          [channelId, result.ts, user.id],
        );
      }
    } catch (err: any) {
      console.error(`[dm-bootstrap] failed for ${slackId}:`, err?.message ?? err);
    }
  }
}
