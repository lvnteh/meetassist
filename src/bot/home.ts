import { app } from './app';
import type { MeetingService } from '../services/meeting';
import type { NudgeService } from '../services/nudge';
import type { RelayService } from './relay';
import type { ConfluenceService } from '../services/confluence';
import { buildOperatorView, buildParticipantView } from './home-views';
import { isOperator } from './roles';

let meetingServiceRef: MeetingService;

export async function publishHomeView(slackUserId: string): Promise<void> {
  try {
    const user = await meetingServiceRef.getUserBySlackId(slackUserId);
    if (!user) return;

    if (isOperator(slackUserId)) {
      const meetings = await meetingServiceRef.listActive(user.id);
      const summaries = await Promise.all(
        meetings.map(async (m) => ({
          meeting: m,
          participants: await meetingServiceRef.getParticipantsWithUsers(m.id),
        }))
      );
      const view = buildOperatorView({ meetings: summaries });
      await app.client.views.publish({ user_id: slackUserId, view: view as any });
    } else {
      const meetings = await meetingServiceRef.listOpenForParticipant(user.id);
      const view = buildParticipantView({ meetings });
      await app.client.views.publish({ user_id: slackUserId, view: view as any });
    }
  } catch (err: any) {
    console.error(`[home] publish failed for ${slackUserId}:`, err?.data ?? err?.message ?? err);
  }
}

export async function publishHomeViews(slackUserIds: string[]): Promise<void> {
  const unique = Array.from(new Set(slackUserIds.filter(Boolean)));
  await Promise.allSettled(unique.map((id) => publishHomeView(id)));
}

export function registerHome(
  meetingService: MeetingService,
  nudgeService: NudgeService,
  relayService: RelayService,
  confluenceService: ConfluenceService
): void {
  meetingServiceRef = meetingService;

  app.event('app_home_opened', async ({ event }) => {
    const e = event as any;
    if (e.tab !== 'home') return;
    await publishHomeView(e.user);
  });

  app.action('home_send', async ({ ack, body, action }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    if (!isOperator(slackUserId)) return;

    try {
      const meeting = await meetingService.getById(meetingId);
      if (!meeting) {
        await app.client.chat.postEphemeral({ channel: slackUserId, user: slackUserId, text: 'Meeting not found.' });
        return;
      }
      const participants = (await meetingService.getParticipantsWithUsers(meetingId)).filter(
        (p) => p.status === 'pending'
      );
      const { text, blocks } = nudgeService.buildPreMeetingMessage(meeting);
      const targetSlackIds: string[] = [slackUserId];
      for (const p of participants) {
        try {
          const { channel, ts } = await relayService.sendBlocksToParticipant({
            slackUserId: p.slack_user_id, text, blocks,
          });
          await nudgeService.recordNudge({
            user_id: p.user_id, meeting_id: meetingId,
            slack_channel_id: channel, message_ts: ts, type: 'pre_meeting',
          });
          await meetingService.updateParticipantStatus(meetingId, p.user_id, 'nudge_sent');
          targetSlackIds.push(p.slack_user_id);
        } catch (err: any) {
          console.error(`[home_send] Failed for ${p.slack_user_id}:`, err?.data ?? err?.message ?? err);
        }
      }
      await publishHomeViews(targetSlackIds);
      await app.client.chat.postEphemeral({
        channel: slackUserId, user: slackUserId,
        text: `Meetassist: Pre-meeting nudge sent to ${participants.length} participant(s).`,
      });
    } catch (err: any) {
      console.error('[home_send] error:', err);
    }
  });

  app.action('home_remind', async ({ ack, body, action }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    if (!isOperator(slackUserId)) return;

    try {
      const meeting = await meetingService.getById(meetingId);
      if (!meeting) return;
      const participants = (await meetingService.getParticipantsWithUsers(meetingId)).filter(
        (p) => p.status === 'nudge_sent' || p.status === 'replied'
      );
      const text = nudgeService.buildReminderMessage(meeting);
      const targetSlackIds: string[] = [slackUserId];
      for (const p of participants) {
        const { channel, ts } = await relayService.sendToParticipant({ slackUserId: p.slack_user_id, text });
        await nudgeService.recordNudge({
          user_id: p.user_id, meeting_id: meetingId,
          slack_channel_id: channel, message_ts: ts, type: 'reminder',
        });
        await meetingService.incrementReminderCount(meetingId, p.user_id);
        targetSlackIds.push(p.slack_user_id);
      }
      await publishHomeViews(targetSlackIds);
      await app.client.chat.postEphemeral({
        channel: slackUserId, user: slackUserId,
        text: `Meetassist: Reminder sent to ${participants.length} participant(s).`,
      });
    } catch (err: any) {
      console.error('[home_remind] error:', err);
    }
  });

  app.action('home_followup', async ({ ack, body, action }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    if (!isOperator(slackUserId)) return;

    try {
      const meeting = await meetingService.getById(meetingId);
      if (!meeting) return;
      const participants = (await meetingService.getParticipantsWithUsers(meetingId)).filter(
        (p) => p.status !== 'completed'
      );
      const text = nudgeService.buildFollowUpMessage(meeting);
      const targetSlackIds: string[] = [slackUserId];
      for (const p of participants) {
        const { channel, ts } = await relayService.sendToParticipant({ slackUserId: p.slack_user_id, text });
        await nudgeService.recordNudge({
          user_id: p.user_id, meeting_id: meetingId,
          slack_channel_id: channel, message_ts: ts, type: 'post_meeting',
        });
        targetSlackIds.push(p.slack_user_id);
      }
      await publishHomeViews(targetSlackIds);
      await app.client.chat.postEphemeral({
        channel: slackUserId, user: slackUserId,
        text: `Meetassist: Follow-up sent to ${participants.length} participant(s).`,
      });
    } catch (err: any) {
      console.error('[home_followup] error:', err);
    }
  });

  app.action('home_status', async ({ ack, body, action, client }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    if (!isOperator(slackUserId)) return;

    try {
      const meeting = await meetingService.getById(meetingId);
      if (!meeting) return;
      const participants = await meetingService.getParticipantsWithUsers(meetingId);
      const lines = participants.map(
        (p) => `• ${p.display_name} (<@${p.slack_user_id}>) — *${p.status}* (reminders: ${p.reminder_count})`
      );
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Meeting status' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*${meeting.title}* — ${meeting.status}\nDocument: <${meeting.document_url}|${meeting.document_title}>\n\nParticipants:\n${lines.join('\n')}`,
              },
            },
          ],
        },
      });
    } catch (err: any) {
      console.error('[home_status] error:', err);
    }
  });

  app.action('home_check_doc', async ({ ack, body, action }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    if (!isOperator(slackUserId)) return;

    try {
      const meeting = await meetingService.getById(meetingId);
      if (!meeting) return;
      const page = await confluenceService.getPage(meeting.confluence_page_id);
      const comments = await confluenceService.getComments(meeting.confluence_page_id);
      const participants = await meetingService.getParticipantsWithUsers(meetingId);
      const participantEmails = participants.map((p) => p.email).filter((e): e is string => Boolean(e));
      const summary = confluenceService.buildDocCheckSummary(page, comments, participantEmails);

      await app.client.chat.postMessage({ channel: slackUserId, text: summary });
      await meetingService.recordDocCheck(meetingId, page.version, comments.length);
    } catch (err: any) {
      await relayService.notifyOperator(`[Meetassist] Doc check failed: ${err.message}`);
    }
  });

  app.action('home_set_action', async ({ ack, body, action, client }) => {
    await ack();
    const meetingId = (action as any).value as string;
    const slackUserId = body.user.id;
    if (!isOperator(slackUserId)) return;

    try {
      const meeting = await meetingService.getById(meetingId);
      if (!meeting) return;

      const options = ['read', 'comment', 'approve', 'provide_input', 'confirm_decision'].map((a) => ({
        text: { type: 'plain_text', text: a },
        value: a,
      }));

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'home_set_action_submit',
          private_metadata: meetingId,
          title: { type: 'plain_text', text: 'Change action' },
          submit: { type: 'plain_text', text: 'Change' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `*${meeting.title}*\nCurrent action: \`${meeting.document_action}\`` },
            },
            {
              type: 'input',
              block_id: 'action_block',
              label: { type: 'plain_text', text: 'New action' },
              element: {
                type: 'static_select',
                action_id: 'new_action',
                options: options as any,
                initial_option: { text: { type: 'plain_text', text: meeting.document_action }, value: meeting.document_action },
              },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '_All participants will be reset to pending. You\'ll need to send a new nudge afterwards._' },
            },
          ],
        },
      });
    } catch (err: any) {
      console.error('[home_set_action] open error:', err);
    }
  });

  app.view('home_set_action_submit', async ({ ack, view, body }) => {
    await ack();
    const meetingId = view.private_metadata;
    const newAction = (view.state.values as any).action_block.new_action.selected_option.value;
    const slackUserId = body.user.id;

    try {
      await meetingService.updateAction(meetingId, newAction);
      const participants = await meetingService.getParticipantsWithUsers(meetingId);
      for (const p of participants) {
        await meetingService.updateParticipantStatus(meetingId, p.user_id, 'pending');
      }
      const targetIds = [slackUserId, ...participants.map((p) => p.slack_user_id)];
      await publishHomeViews(targetIds);
      await app.client.chat.postEphemeral({
        channel: slackUserId, user: slackUserId,
        text: `Meetassist: Action updated to \`${newAction}\`. All participants reset to pending.`,
      });
    } catch (err: any) {
      console.error('[home_set_action_submit] error:', err);
    }
  });
}
