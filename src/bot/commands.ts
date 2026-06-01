import { app } from './app';
import type { MeetingService } from '../services/meeting';
import type { NudgeService } from '../services/nudge';
import type { RelayService } from './relay';
import type { ConfluenceService } from '../services/confluence';
import type { DocumentAction } from '../types';
import { publishDashboard } from '../services/dashboard';

const createSessions = new Map<string, Partial<{
  title: string;
  start_time: string;
  purpose: string;
  document_url: string;
  document_title: string;
  document_action: string;
  participants: string[];
  step: string;
}>>();

export function unwrapSlackUrl(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^<(https?:\/\/[^|>]+)(?:\|[^>]*)?>$/);
  return match ? match[1] : trimmed;
}

export function registerCommands(
  meetingService: MeetingService,
  nudgeService: NudgeService,
  relayService: RelayService,
  confluenceService: ConfluenceService
): void {
  app.command('/ma', async ({ ack, command, respond }) => {
    await ack();

    const operatorIds = (process.env.OPERATOR_SLACK_IDS ?? process.env.OPERATOR_SLACK_ID ?? '').split(',').map(s => s.trim());
    if (!operatorIds.includes(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: 'Meetassist: Only operators can use /ma commands.' });
      return;
    }

    const parts = command.text.trim().split(/\s+/);
    const sub = parts[0];

    switch (sub) {
      case 'create': {
        createSessions.set(command.user_id, { step: 'title' });
        await app.client.chat.postMessage({
          channel: command.user_id,
          text: 'Tip: you can also use the *➕ Create meeting* button in this DM for a faster form-based flow. Continuing with text wizard…\n\nMeetassist: Let\'s create a meeting. Reply here in this DM.\n\nWhat is the *meeting title*?',
        });
        await respond({ response_type: 'ephemeral', text: 'Meetassist: Started in your DM with me.' });
        break;
      }

      case 'seed-user': {
        const slackId = parts[1];
        const email = parts[2];
        const displayName = parts.slice(3).join(' ');
        if (!slackId || !email || !displayName) {
          await respond({ response_type: 'ephemeral', text: 'Usage: `/ma seed-user <slack_id> <email> <display name>`' });
          return;
        }
        const user = await meetingService.upsertUser({ slack_user_id: slackId, email, display_name: displayName });
        await respond({ response_type: 'ephemeral', text: `Meetassist: User seeded — ${user.display_name} (${user.slack_user_id})` });
        break;
      }

      case 'list': {
        const operatorUser = await meetingService.getUserBySlackId(command.user_id);
        const meetings = await meetingService.listActive(operatorUser?.id);
        if (meetings.length === 0) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: No active meetings.' });
          return;
        }
        const lines = meetings.map((m) => `• *${m.title}* — \`${m.id.slice(0, 8)}\` — ${m.status} — ${m.start_time}`);
        await respond({ response_type: 'ephemeral', text: `Meetassist: Active meetings:\n${lines.join('\n')}` });
        break;
      }

      case 'status': {
        const meetingId = await resolveMeetingId(parts[1], command.user_id, meetingService);
        if (!meetingId) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: Meeting not found. Use /ma list to see IDs.' });
          return;
        }
        const meeting = (await meetingService.getById(meetingId))!;
        const participants = await meetingService.getParticipantsWithUsers(meetingId);
        const lines = participants.map(
          (p) => `• ${p.display_name} (<@${p.slack_user_id}>) — *${p.status}* (reminders: ${p.reminder_count})`
        );
        await respond({
          response_type: 'ephemeral',
          text: `*${meeting.title}* — ${meeting.status}\nDocument: <${meeting.document_url}|${meeting.document_title}>\n\nParticipants:\n${lines.join('\n')}`,
        });
        break;
      }

      case 'send': {
        const meetingId = await resolveMeetingId(parts[1], command.user_id, meetingService);
        if (!meetingId) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: Meeting not found.' });
          return;
        }
        const meeting = (await meetingService.getById(meetingId))!;
        const participants = (await meetingService.getParticipantsWithUsers(meetingId)).filter(
          (p) => p.status === 'pending'
        );

        if (participants.length === 0) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: No pending participants to nudge.' });
          return;
        }

        const { text, blocks } = nudgeService.buildPreMeetingMessage(meeting);
        let sent = 0;
        const errors: string[] = [];
        for (const p of participants) {
          try {
            const { channel, ts } = await relayService.sendBlocksToParticipant({
              slackUserId: p.slack_user_id,
              text,
              blocks,
            });
            await nudgeService.recordNudge({
              user_id: p.user_id,
              meeting_id: meetingId,
              slack_channel_id: channel,
              message_ts: ts,
              type: 'pre_meeting',
            });
            await meetingService.updateParticipantStatus(meetingId, p.user_id, 'nudge_sent');
            sent++;
          } catch (err: any) {
            console.error(`[send] Failed for ${p.slack_user_id}:`, err?.data ?? err?.message ?? err);
            errors.push(`<@${p.slack_user_id}> (${err?.data?.error ?? err?.message ?? 'unknown'})`);
          }
        }
        const errorNote = errors.length > 0 ? `\n⚠️ Failed to send to: ${errors.join(', ')}` : '';
        await publishDashboard();
        await respond({
          response_type: 'ephemeral',
          text: `Meetassist: Pre-meeting nudge sent to ${sent} participant(s).${errorNote}`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `*Nudge sent to ${sent} participant(s).*${errorNote}` },
            },
            { type: 'divider' },
            ...blocks,
          ],
        });
        break;
      }

      case 'remind': {
        const meetingId = await resolveMeetingId(parts[1], command.user_id, meetingService);
        if (!meetingId) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: Meeting not found.' });
          return;
        }
        const meeting = (await meetingService.getById(meetingId))!;
        const participants = (await meetingService.getParticipantsWithUsers(meetingId)).filter(
          (p) => p.status === 'nudge_sent' || p.status === 'replied'
        );

        if (participants.length === 0) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: No participants to remind.' });
          return;
        }

        const text = nudgeService.buildReminderMessage(meeting);
        let sent = 0;
        for (const p of participants) {
          const { channel, ts } = await relayService.sendToParticipant({ slackUserId: p.slack_user_id, text });
          await nudgeService.recordNudge({
            user_id: p.user_id,
            meeting_id: meetingId,
            slack_channel_id: channel,
            message_ts: ts,
            type: 'reminder',
          });
          await meetingService.incrementReminderCount(meetingId, p.user_id);
          sent++;
        }
        await publishDashboard();
        await respond({ response_type: 'ephemeral', text: `Meetassist: Reminder sent to ${sent} participant(s).` });
        break;
      }

      case 'followup': {
        const meetingId = await resolveMeetingId(parts[1], command.user_id, meetingService);
        if (!meetingId) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: Meeting not found.' });
          return;
        }
        const meeting = (await meetingService.getById(meetingId))!;
        const participants = (await meetingService.getParticipantsWithUsers(meetingId)).filter(
          (p) => p.status !== 'completed'
        );

        if (participants.length === 0) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: All participants have completed. Nothing to follow up on.' });
          return;
        }

        const text = nudgeService.buildFollowUpMessage(meeting);
        let sent = 0;
        for (const p of participants) {
          const { channel, ts } = await relayService.sendToParticipant({ slackUserId: p.slack_user_id, text });
          await nudgeService.recordNudge({
            user_id: p.user_id,
            meeting_id: meetingId,
            slack_channel_id: channel,
            message_ts: ts,
            type: 'post_meeting',
          });
          sent++;
        }
        await publishDashboard();
        await respond({ response_type: 'ephemeral', text: `Meetassist: Follow-up sent to ${sent} participant(s).` });
        break;
      }

      case 'reply': {
        const handleRaw = parts[1];
        const messageText = parts.slice(2).join(' ');
        if (!handleRaw || !messageText) {
          await respond({ response_type: 'ephemeral', text: 'Usage: `/ma reply @handle message text`' });
          return;
        }
        const handle = handleRaw.replace(/^@/, '');
        const user = await meetingService.getUserBySlackId(handle) ??
          await lookupByDisplayName(handle, command.user_id, meetingService);
        if (!user) {
          await respond({ response_type: 'ephemeral', text: `Meetassist: Could not find user "${handle}". Check display name or Slack ID.` });
          return;
        }
        await relayService.sendToParticipant({ slackUserId: user.slack_user_id, text: `Meetassist: ${messageText}` });
        await respond({ response_type: 'ephemeral', text: `Meetassist: Message sent to ${user.display_name}.` });
        break;
      }

      case 'set-action': {
        const meetingId = await resolveMeetingId(parts[1], command.user_id, meetingService);
        if (!meetingId) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: Meeting not found.' });
          return;
        }
        const validActions = ['read', 'comment', 'approve', 'provide_input', 'confirm_decision'];
        const newAction = parts[2];
        if (!newAction || !validActions.includes(newAction)) {
          await respond({ response_type: 'ephemeral', text: `Usage: \`/ma set-action <id> <action> [purpose...]\`\nValid actions: ${validActions.join(', ')}` });
          return;
        }
        const trailingPurpose = parts.slice(3).join(' ').trim();
        if (trailingPurpose.length > 280) {
          await respond({ response_type: 'ephemeral', text: `Meetassist: Purpose is longer than 280 characters (you wrote ${trailingPurpose.length}). Action not updated.` });
          return;
        }
        const purposeArg = trailingPurpose === '' ? undefined : trailingPurpose;
        await meetingService.updateAction(meetingId, newAction, purposeArg);
        const participants = await meetingService.getParticipantsWithUsers(meetingId);
        for (const p of participants) {
          await meetingService.updateParticipantStatus(meetingId, p.user_id, 'pending');
        }
        await publishDashboard();
        const purposeNote = purposeArg
          ? ` Purpose: "${purposeArg}".`
          : ' Purpose unchanged.';
        await respond({ response_type: 'ephemeral', text: `Meetassist: Action updated to \`${newAction}\`.${purposeNote} All participants reset to pending. Use \`/ma send ${parts[1]}\` to send the new nudge.` });
        break;
      }

      case 'check-doc': {
        const meetingId = await resolveMeetingId(parts[1], command.user_id, meetingService);
        if (!meetingId) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: Meeting not found.' });
          return;
        }
        const meeting = (await meetingService.getById(meetingId))!;
        await respond({ response_type: 'ephemeral', text: `Meetassist: Fetching doc for *${meeting.title}*...` });

        try {
          const page = await confluenceService.getPage(meeting.confluence_page_id);
          const comments = await confluenceService.getComments(meeting.confluence_page_id);
          const participants = await meetingService.getParticipantsWithUsers(meetingId);
          const participantEmails = participants.map((p) => p.email).filter(Boolean);

          const summary = confluenceService.buildDocCheckSummary(page, comments, participantEmails);

          const missing = participants.filter((p) => {
            const commentEmails = new Set(comments.map((c) => c.authorEmail));
            return !commentEmails.has(p.email);
          });

          const nudgeBlocks: object[] = [
            { type: 'section', text: { type: 'mrkdwn', text: summary } },
          ];

          for (let i = 0; i < missing.length; i++) {
            const p = missing[i];
            const nudgeText = `Meetassist reminder: Please review *${meeting.document_title}* before *${meeting.title}*.\n${meeting.document_url}`;
            const payload = `${meetingId}|${p.slack_user_id}|${nudgeText}`;
            nudgeBlocks.push({
              type: 'section',
              text: { type: 'mrkdwn', text: `Nudge ${i + 1}: → <@${p.slack_user_id}>: "${nudgeText.slice(0, 80)}..."` },
            });
            nudgeBlocks.push({
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Yes, send' },
                  action_id: `send_nudge_yes_${i}`,
                  style: 'primary',
                  value: payload,
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Skip' },
                  action_id: `send_nudge_skip_${i}`,
                  value: payload,
                },
              ],
            });
          }

          await app.client.chat.postMessage({
            channel: command.user_id,
            text: summary,
            blocks: nudgeBlocks as any,
          });

          await meetingService.recordDocCheck(meetingId, page.version, comments.length);

        } catch (err: any) {
          await relayService.notifyOperator(`[Meetassist] Doc check failed: ${err.message}`);
        }
        break;
      }

      default: {
        await respond({
          response_type: 'ephemeral',
          text: [
            'Meetassist commands:',
            '`/ma create` — create a new meeting',
            '`/ma seed-user <id> <email> <name>` — register a user',
            '`/ma list` — list active meetings',
            '`/ma status [id]` — participant state',
            '`/ma send [id]` — send pre-meeting nudge',
            '`/ma remind [id]` — remind non-completers',
            '`/ma followup [id]` — post-meeting follow-up',
            '`/ma set-action [id] <action> [purpose...]` — change action (and optionally purpose) and re-open for nudging',
            '`/ma check-doc [id]` — fetch and summarise Confluence doc',
            '`/ma reply @handle message` — reply to a participant as bot',
          ].join('\n'),
        });
      }
    }
  });

  app.message(async ({ message, say }) => {
    const msg = message as any;
    if (!msg.user || msg.channel_type !== 'im') return;

    const operatorIds = (process.env.OPERATOR_SLACK_IDS ?? process.env.OPERATOR_SLACK_ID ?? '').split(',').map(s => s.trim());
    if (!operatorIds.includes(msg.user)) return;

    const session = createSessions.get(msg.user);
    if (!session) return;

    const text: string = (msg.text ?? '').trim();

    switch (session.step) {
      case 'title':
        session.title = text;
        session.step = 'start_time';
        await say('Meeting date and time? (e.g. `2026-06-04T09:00:00Z`)');
        break;
      case 'start_time':
        session.start_time = text;
        session.step = 'purpose';
        await say('What\'s the ask for participants? They\'ll see this in their nudge. (Max 280 chars.)');
        break;
      case 'purpose':
        if (text.length > 280) {
          await say(`Meetassist: That's longer than 280 characters (you wrote ${text.length}). Please shorten and try again.`);
          return;
        }
        session.purpose = text;
        session.step = 'document_url';
        await say('Paste the Confluence page URL:');
        break;
      case 'document_url': {
        const cleanedUrl = unwrapSlackUrl(text);
        if (!cleanedUrl.match(/\/pages\/\d+/)) {
          await say('Could not find a Confluence page ID in that URL. Expected format: `https://org.atlassian.net/wiki/spaces/PROJ/pages/123456/Title`\n\nPlease paste the URL again:');
          return;
        }
        session.document_url = cleanedUrl;
        session.step = 'document_title';
        await say('What is the document title?');
        break;
      }
      case 'document_title':
        session.document_title = text;
        session.step = 'document_action';
        await say('What action is required from participants?\n`read` | `comment` | `approve` | `provide_input` | `confirm_decision`');
        break;
      case 'document_action': {
        const validActions = ['read', 'comment', 'approve', 'provide_input', 'confirm_decision'];
        if (!validActions.includes(text)) {
          await say('Invalid action. Please choose one of:\n`read` | `comment` | `approve` | `provide_input` | `confirm_decision`');
          return;
        }
        session.document_action = text;
        session.step = 'participants';
        await say('List participant Slack IDs, comma-separated (e.g. `U001,U002,U003`):');
        break;
      }
      case 'participants': {
        session.participants = text.split(',').map((s) => s.trim());
        createSessions.delete(msg.user);

        const operatorUser = await meetingService.getUserBySlackId(msg.user);
        if (!operatorUser) {
          await say('Error: Operator user not found in DB. Restart the bot to auto-seed.');
          return;
        }

        const meeting = await meetingService.createMeeting({
          title: session.title!,
          start_time: session.start_time!,
          organizer_user_id: operatorUser.id,
          purpose: session.purpose!,
          document_url: session.document_url!,
          document_title: session.document_title!,
          document_action: session.document_action as DocumentAction,
        });

        const failedIds: string[] = [];
        for (const slackId of session.participants!) {
          try {
            const user = await meetingService.autoSeedFromSlack(slackId, app.client);
            await meetingService.addParticipant(meeting.id, user.id, 'participant');
          } catch (err: any) {
            console.error(`[autoSeed] Failed for ${slackId}:`, err?.data ?? err?.message ?? err);
            failedIds.push(slackId);
          }
        }

        await meetingService.updateStatus(meeting.id, 'active');
        await publishDashboard();

        const failedWarning = failedIds.length > 0
          ? `\n⚠️ Could not look up these IDs (check they're valid Slack IDs): ${failedIds.join(', ')}`
          : '';
        await say(
          `Meetassist: Meeting created.\n*${meeting.title}* — \`${meeting.id.slice(0, 8)}\`\nParticipants added. Use \`/ma send ${meeting.id.slice(0, 8)}\` to send nudges.${failedWarning}`
        );
        break;
      }
    }
  });
}

async function resolveMeetingId(idPrefix: string | undefined, operatorSlackId: string, service: MeetingService): Promise<string | null> {
  if (!idPrefix) return null;
  const operatorUser = await service.getUserBySlackId(operatorSlackId);
  const all = await service.listActive(operatorUser?.id);
  const match = all.find((m) => m.id.startsWith(idPrefix));
  return match?.id ?? null;
}

async function lookupByDisplayName(
  name: string,
  operatorSlackId: string,
  service: MeetingService
): Promise<ReturnType<MeetingService['getUserBySlackId']> extends Promise<infer T> ? T : never> {
  const operatorUser = await service.getUserBySlackId(operatorSlackId);
  const meetings = await service.listActive(operatorUser?.id);
  for (const meeting of meetings) {
    const participants = await service.getParticipantsWithUsers(meeting.id);
    const found = participants.find(
      (p) => p.display_name.toLowerCase().replace(/\s+/g, '.') === name.toLowerCase()
    );
    if (found) return service.getUserBySlackId(found.slack_user_id);
  }
  return null;
}
