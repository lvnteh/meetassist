import { app } from './app';
import type { MeetingService } from '../services/meeting';
import type { NudgeService } from '../services/nudge';
import type { RelayService } from './relay';
import type { ConfluenceService } from '../services/confluence';
import type { DocumentAction } from '../types';

// Guided create flow: store in-progress meeting creation state per operator
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

export function registerCommands(
  meetingService: MeetingService,
  nudgeService: NudgeService,
  relayService: RelayService,
  confluenceService: ConfluenceService
): void {
  app.command('/ma', async ({ ack, command, respond }) => {
    await ack();

    const operatorId = process.env.OPERATOR_SLACK_ID!;
    if (command.user_id !== operatorId) {
      await respond({ response_type: 'ephemeral', text: 'Meetassist: Only the operator can use /ma commands.' });
      return;
    }

    const parts = command.text.trim().split(/\s+/);
    const sub = parts[0];

    switch (sub) {
      case 'create': {
        createSessions.set(command.user_id, { step: 'title' });
        await respond({ response_type: 'ephemeral', text: 'Meetassist: Let\'s create a meeting.\n\nWhat is the *meeting title*?' });
        break;
      }

      case 'seed-user': {
        // /ma seed-user <slack_id> <email> <display_name...>
        const slackId = parts[1];
        const email = parts[2];
        const displayName = parts.slice(3).join(' ');
        if (!slackId || !email || !displayName) {
          await respond({ response_type: 'ephemeral', text: 'Usage: `/ma seed-user <slack_id> <email> <display name>`' });
          return;
        }
        const user = meetingService.upsertUser({ slack_user_id: slackId, email, display_name: displayName });
        await respond({ response_type: 'ephemeral', text: `Meetassist: User seeded — ${user.display_name} (${user.slack_user_id})` });
        break;
      }

      case 'list': {
        const meetings = meetingService.listActive();
        if (meetings.length === 0) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: No active meetings.' });
          return;
        }
        const lines = meetings.map((m) => `• *${m.title}* — \`${m.id.slice(0, 8)}\` — ${m.status} — ${m.start_time}`);
        await respond({ response_type: 'ephemeral', text: `Meetassist: Active meetings:\n${lines.join('\n')}` });
        break;
      }

      case 'status': {
        const meetingId = resolveMeetingId(parts[1], meetingService);
        if (!meetingId) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: Meeting not found. Use /ma list to see IDs.' });
          return;
        }
        const meeting = meetingService.getById(meetingId)!;
        const participants = meetingService.getParticipantsWithUsers(meetingId);
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
        const meetingId = resolveMeetingId(parts[1], meetingService);
        if (!meetingId) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: Meeting not found.' });
          return;
        }
        const meeting = meetingService.getById(meetingId)!;
        const participants = meetingService.getParticipantsWithUsers(meetingId).filter(
          (p) => p.status === 'pending'
        );

        if (participants.length === 0) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: No pending participants to nudge.' });
          return;
        }

        const { text, blocks } = nudgeService.buildPreMeetingMessage(meeting);
        let sent = 0;
        for (const p of participants) {
          const { channel, ts } = await relayService.sendBlocksToParticipant({
            slackUserId: p.slack_user_id,
            text,
            blocks,
          });
          nudgeService.recordNudge({
            user_id: p.user_id,
            meeting_id: meetingId,
            slack_channel_id: channel,
            message_ts: ts,
            type: 'pre_meeting',
          });
          meetingService.updateParticipantStatus(meetingId, p.user_id, 'nudge_sent');
          sent++;
        }
        await respond({ response_type: 'ephemeral', text: `Meetassist: Pre-meeting nudge sent to ${sent} participant(s).` });
        break;
      }

      case 'remind': {
        const meetingId = resolveMeetingId(parts[1], meetingService);
        if (!meetingId) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: Meeting not found.' });
          return;
        }
        const meeting = meetingService.getById(meetingId)!;
        const participants = meetingService.getParticipantsWithUsers(meetingId).filter(
          (p) => p.status === 'nudge_sent' || p.status === 'replied'
        );

        if (participants.length === 0) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: No participants to remind.' });
          return;
        }

        const text = nudgeService.buildReminderMessage(meeting);
        let sent = 0;
        for (const p of participants) {
          const { channel, ts } = await relayService.sendToParticipant({
            slackUserId: p.slack_user_id,
            text,
          });
          nudgeService.recordNudge({
            user_id: p.user_id,
            meeting_id: meetingId,
            slack_channel_id: channel,
            message_ts: ts,
            type: 'reminder',
          });
          meetingService.incrementReminderCount(meetingId, p.user_id);
          sent++;
        }
        await respond({ response_type: 'ephemeral', text: `Meetassist: Reminder sent to ${sent} participant(s).` });
        break;
      }

      case 'followup': {
        const meetingId = resolveMeetingId(parts[1], meetingService);
        if (!meetingId) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: Meeting not found.' });
          return;
        }
        const meeting = meetingService.getById(meetingId)!;
        const participants = meetingService.getParticipantsWithUsers(meetingId).filter(
          (p) => p.status !== 'completed'
        );

        if (participants.length === 0) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: All participants have completed. Nothing to follow up on.' });
          return;
        }

        const text = nudgeService.buildFollowUpMessage(meeting);
        let sent = 0;
        for (const p of participants) {
          const { channel, ts } = await relayService.sendToParticipant({
            slackUserId: p.slack_user_id,
            text,
          });
          nudgeService.recordNudge({
            user_id: p.user_id,
            meeting_id: meetingId,
            slack_channel_id: channel,
            message_ts: ts,
            type: 'post_meeting',
          });
          sent++;
        }
        await respond({ response_type: 'ephemeral', text: `Meetassist: Follow-up sent to ${sent} participant(s).` });
        break;
      }

      case 'reply': {
        // /ma reply @handle message text here
        const handleRaw = parts[1];
        const messageText = parts.slice(2).join(' ');
        if (!handleRaw || !messageText) {
          await respond({ response_type: 'ephemeral', text: 'Usage: `/ma reply @handle message text`' });
          return;
        }
        const handle = handleRaw.replace(/^@/, '');
        // Look up by display_name or slack_user_id
        const user = meetingService.getUserBySlackId(handle) ??
          lookupByDisplayName(handle, meetingService, meetingService.listActive());
        if (!user) {
          await respond({ response_type: 'ephemeral', text: `Meetassist: Could not find user "${handle}". Check display name or Slack ID.` });
          return;
        }
        await relayService.sendToParticipant({ slackUserId: user.slack_user_id, text: `Meetassist: ${messageText}` });
        await respond({ response_type: 'ephemeral', text: `Meetassist: Message sent to ${user.display_name}.` });
        break;
      }

      case 'check-doc': {
        const meetingId = resolveMeetingId(parts[1], meetingService);
        if (!meetingId) {
          await respond({ response_type: 'ephemeral', text: 'Meetassist: Meeting not found.' });
          return;
        }
        const meeting = meetingService.getById(meetingId)!;
        await respond({ response_type: 'ephemeral', text: `Meetassist: Fetching doc for *${meeting.title}*...` });

        try {
          const page = await confluenceService.getPage(meeting.confluence_page_id);
          const comments = await confluenceService.getComments(meeting.confluence_page_id);
          const participants = meetingService.getParticipantsWithUsers(meetingId);
          const participantEmails = participants.map((p) => p.email).filter(Boolean);

          const summary = confluenceService.buildDocCheckSummary(page, comments, participantEmails);

          // Build suggested nudges with Yes/Skip buttons
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

          // Record the doc check
          meetingService.recordDocCheck(meetingId, page.version, comments.length);

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
            '`/ma check-doc [id]` — fetch and summarise Confluence doc',
            '`/ma reply @handle message` — reply to a participant as bot',
          ].join('\n'),
        });
      }
    }
  });

  // Guided create flow — listen to operator DM messages during a create session
  app.message(async ({ message, say }) => {
    const msg = message as any;
    if (!msg.user || msg.channel_type !== 'im') return;

    const operatorId = process.env.OPERATOR_SLACK_ID!;
    if (msg.user !== operatorId) return;

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
        await say('What is the meeting purpose?');
        break;
      case 'purpose':
        session.purpose = text;
        session.step = 'document_url';
        await say('Paste the Confluence page URL:');
        break;
      case 'document_url': {
          if (!text.match(/\/pages\/\d+/)) {
            await say('Could not find a Confluence page ID in that URL. Expected format: `https://org.atlassian.net/wiki/spaces/PROJ/pages/123456/Title`\n\nPlease paste the URL again:');
            return;
          }
          session.document_url = text;
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
            await say(`Invalid action. Please choose one of:\n\`read\` | \`comment\` | \`approve\` | \`provide_input\` | \`confirm_decision\``);
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

        const operatorUser = meetingService.getUserBySlackId(operatorId);
        if (!operatorUser) {
          await say('Error: Operator user not found in DB. Use `/ma seed-user` first.');
          return;
        }

        const meeting = meetingService.createMeeting({
          title: session.title!,
          start_time: session.start_time!,
          organizer_user_id: operatorUser.id,
          purpose: session.purpose!,
          document_url: session.document_url!,
          document_title: session.document_title!,
          document_action: session.document_action as DocumentAction,
        });

        const unknownIds: string[] = [];
        for (const slackId of session.participants!) {
          const user = meetingService.getUserBySlackId(slackId);
          if (user) {
            meetingService.addParticipant(meeting.id, user.id, 'participant');
          } else {
            unknownIds.push(slackId);
          }
        }

        meetingService.updateStatus(meeting.id, 'active');

        const unknownWarning = unknownIds.length > 0
          ? `\n⚠️ Unknown IDs skipped (seed them first): ${unknownIds.join(', ')}`
          : '';
        await say(
          `Meetassist: Meeting created.\n*${meeting.title}* — \`${meeting.id.slice(0, 8)}\`\nParticipants added. Use \`/ma send ${meeting.id.slice(0, 8)}\` to send nudges.${unknownWarning}`
        );
        break;
      }
    }
  });
}

function resolveMeetingId(idPrefix: string | undefined, service: MeetingService): string | null {
  if (!idPrefix) return null;
  const all = service.listActive();
  const match = all.find((m) => m.id.startsWith(idPrefix));
  return match?.id ?? null;
}

function lookupByDisplayName(
  name: string,
  service: MeetingService,
  meetings: ReturnType<MeetingService['listActive']>
): ReturnType<MeetingService['getUserBySlackId']> {
  for (const meeting of meetings) {
    const participants = service.getParticipantsWithUsers(meeting.id);
    const found = participants.find(
      (p) => p.display_name.toLowerCase().replace(/\s+/g, '.') === name.toLowerCase()
    );
    if (found) return service.getUserBySlackId(found.slack_user_id);
  }
  return null;
}
