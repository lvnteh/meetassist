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
        label: { type: 'plain_text', text: 'Purpose / context' },
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
