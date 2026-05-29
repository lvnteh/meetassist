import type { ParticipantStatus, DocumentAction } from '../types';

const PARTICIPANT_STATUS_LABELS: Record<ParticipantStatus, string> = {
  pending: 'waiting for nudge',
  nudge_sent: 'nudge sent',
  replied: 'you replied — awaiting follow-up',
  clarification_needed: 'clarification requested',
  blocked: 'marked as blocked',
  overdue: 'overdue',
  completed: 'completed',
};

const DOCUMENT_ACTION_LABELS: Record<DocumentAction, string> = {
  read: 'Read the document',
  comment: 'Add a comment or mark no concerns',
  approve: 'Approve the document',
  provide_input: 'Provide your input',
  confirm_decision: 'Confirm the decision',
};

export function humaniseParticipantStatus(status: ParticipantStatus): string {
  return PARTICIPANT_STATUS_LABELS[status] ?? status;
}

export function humaniseDocumentAction(action: DocumentAction): string {
  return DOCUMENT_ACTION_LABELS[action] ?? action;
}
