import type { MeetingService } from '../services/meeting';
import type { NudgeService } from '../services/nudge';
import type { ConfluenceService } from '../services/confluence';
import type { RelayService } from './relay';
import { postControlCard, updateControlCard } from './control-card';

const ACTION_OPTIONS = [
  { value: 'read', label: 'Read' },
  { value: 'comment', label: 'Comment' },
  { value: 'approve', label: 'Approve' },
  { value: 'provide_input', label: 'Provide input' },
  { value: 'confirm_decision', label: 'Confirm decision' },
];

function actionOptions() {
  return ACTION_OPTIONS.map((o) => ({
    text: { type: 'plain_text', text: o.label },
    value: o.value,
  }));
}

export function buildCreateMeetingModal(): any {
  return {
    type: 'modal',
    callback_id: 'create_meeting_modal',
    title: { type: 'plain_text', text: 'Create meeting' },
    submit: { type: 'plain_text', text: 'Create' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'title',
        label: { type: 'plain_text', text: 'Title' },
        element: { type: 'plain_text_input', action_id: 'value', max_length: 200 },
      },
      {
        type: 'input',
        block_id: 'document_url',
        label: { type: 'plain_text', text: 'Document URL' },
        element: { type: 'plain_text_input', action_id: 'value' },
        hint: { type: 'plain_text', text: 'Confluence page URL containing /pages/<id>' },
      },
      {
        type: 'input',
        block_id: 'action',
        label: { type: 'plain_text', text: 'Action' },
        element: { type: 'static_select', action_id: 'value', options: actionOptions() },
      },
      {
        type: 'input',
        block_id: 'purpose',
        optional: true,
        label: { type: 'plain_text', text: 'Context note' },
        hint: { type: 'plain_text', text: "Tip: don't repeat the meeting name or action — add context that helps participants act." },
        element: { type: 'plain_text_input', action_id: 'value', multiline: true },
      },
      {
        type: 'input',
        block_id: 'start_time',
        label: { type: 'plain_text', text: 'Start time' },
        element: { type: 'datetimepicker', action_id: 'value' },
      },
      {
        type: 'input',
        block_id: 'participants',
        label: { type: 'plain_text', text: 'Participants' },
        element: { type: 'multi_users_select', action_id: 'value' },
      },
    ],
  };
}

export function buildMessageOrganiserModal(meetingTitle: string, meetingId: string): any {
  return {
    type: 'modal',
    callback_id: 'message_organiser_modal',
    private_metadata: meetingId,
    title: { type: 'plain_text', text: 'Message organiser' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `Re: *${meetingTitle}*\nYour message will be forwarded to the meeting organiser.` },
      },
      {
        type: 'input',
        block_id: 'message',
        label: { type: 'plain_text', text: 'Your message' },
        element: { type: 'plain_text_input', action_id: 'value', multiline: true },
      },
    ],
  };
}

export function buildChangeActionModal(meetingId: string, currentAction: string): any {
  const initial = actionOptions().find((o) => o.value === currentAction);
  return {
    type: 'modal',
    callback_id: 'change_action_modal',
    private_metadata: meetingId,
    title: { type: 'plain_text', text: 'Change action' },
    submit: { type: 'plain_text', text: 'Update' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'action',
        label: { type: 'plain_text', text: 'Action' },
        element: {
          type: 'static_select',
          action_id: 'value',
          options: actionOptions(),
          ...(initial ? { initial_option: initial } : {}),
        },
      },
    ],
  };
}

export function registerModalHandlers(
  meetingService: MeetingService,
  confluenceService: ConfluenceService,
  nudgeService: NudgeService,
  relayService: RelayService,
): void {
  // Lazy-load modules whose own imports eagerly construct the Bolt App
  // singleton — keeps this module importable from tests that exercise only
  // the pure builder functions without env-var setup.
  const { app } = require('./app') as typeof import('./app');
  const { unwrapSlackUrl } = require('./commands') as typeof import('./commands');

  // Open the create modal from the persistent DM button
  app.action('open_create_modal', async ({ ack, body, client }) => {
    await ack();
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: buildCreateMeetingModal(),
    });
  });

  // Handle the create-meeting modal submission
  app.view('create_meeting_modal', async ({ ack, body, view, client }) => {
    const values: any = view.state.values;
    const title: string = values.title?.value?.value?.trim() ?? '';
    const rawUrl: string = values.document_url?.value?.value?.trim() ?? '';
    const documentUrl = unwrapSlackUrl(rawUrl);
    const action: string = values.action?.value?.selected_option?.value ?? '';
    const purpose: string = values.purpose?.value?.value?.trim() ?? '';
    const startEpoch: number | undefined = values.start_time?.value?.selected_date_time;
    const participantIds: string[] = values.participants?.value?.selected_users ?? [];

    const errors: Record<string, string> = {};
    if (!title) errors.title = 'Title is required';
    const pageMatch = documentUrl.match(/\/pages\/(\d+)/);
    if (!pageMatch) errors.document_url = 'URL must contain /pages/<id>';
    if (!startEpoch || startEpoch * 1000 <= Date.now()) errors.start_time = 'Start time must be in the future';
    if (participantIds.length === 0) errors.participants = 'Pick at least one participant';
    if (!action) errors.action = 'Pick an action';

    if (Object.keys(errors).length > 0) {
      await ack({ response_action: 'errors', errors } as any);
      return;
    }
    await ack();

    try {
      const operatorSlackId = body.user.id;
      const operator = await meetingService.autoSeedFromSlack(operatorSlackId, client as any);

      // Best-effort fetch of the document title from Confluence; fall back to the modal title
      let documentTitle = title;
      const pageId = pageMatch![1];
      try {
        const page = await confluenceService.getPage(pageId);
        if (page?.title) documentTitle = page.title;
      } catch (err: any) {
        console.error('[modal] confluenceService.getPage failed, falling back to meeting title:', err?.message ?? err);
      }

      const meeting = await meetingService.createMeeting({
        title,
        start_time: new Date(startEpoch! * 1000).toISOString(),
        organizer_user_id: operator.id,
        purpose,
        document_url: documentUrl,
        document_title: documentTitle,
        document_action: action,
      });
      await meetingService.updateStatus(meeting.id, 'active');

      for (const slackId of participantIds) {
        const u = await meetingService.autoSeedFromSlack(slackId, client as any);
        await meetingService.addParticipant(meeting.id, u.id, 'participant');
      }

      // Post control card into the operator DM
      const dm = await client.conversations.open({ users: operatorSlackId });
      const channelId = (dm.channel as any)?.id;
      if (channelId) {
        const refreshed = (await meetingService.getById(meeting.id))!;
        await postControlCard(client as any, meetingService, refreshed, channelId);
      }
    } catch (err: any) {
      console.error('[modal] create_meeting_modal handler failed:', err?.message ?? err);
    }
  });

  // Handle the change-action modal submission
  app.view('change_action_modal', async ({ ack, view, client }) => {
    await ack();
    const meetingId = view.private_metadata;
    const action = (view.state.values as any).action?.value?.selected_option?.value;
    if (!meetingId || !action) return;
    try {
      await meetingService.updateAction(meetingId, action);
      const meeting = await meetingService.getById(meetingId);
      if (meeting) {
        await updateControlCard(client as any, meetingService, meeting);
      }
    } catch (err: any) {
      console.error('[modal] change_action_modal handler failed:', err?.message ?? err);
    }
  });

  // Handle message-organiser modal submission
  app.view('message_organiser_modal', async ({ ack, body, view }) => {
    await ack();
    const meetingId = view.private_metadata;
    const text: string = (view.state.values as any).message?.value?.value?.trim() ?? '';
    const slackUserId = body.user.id;
    if (!meetingId || !text) return;

    try {
      const meeting = await meetingService.getById(meetingId);
      if (!meeting) return;

      const user = await meetingService.getUserBySlackId(slackUserId);
      if (!user) return;

      const msg = await nudgeService.recordParticipantMessage({
        user_id: user.id,
        meeting_id: meetingId,
        nudge_id: null,
        raw_text: text,
      });

      await meetingService.updateParticipantStatus(meetingId, user.id, 'replied');

      await relayService.forwardToOrganiser({
        senderSlackId: slackUserId,
        text,
        meetingTitle: meeting.title,
        participantMessageId: msg.id,
      });
    } catch (err: any) {
      console.error('[modal] message_organiser_modal handler failed:', err?.message ?? err);
    }
  });
}
