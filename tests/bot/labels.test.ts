import { describe, it, expect } from 'vitest';
import { humaniseParticipantStatus, humaniseDocumentAction } from '../../src/bot/labels';

describe('labels', () => {
  it('humaniseParticipantStatus returns expected label for each status', () => {
    expect(humaniseParticipantStatus('pending')).toBe('waiting for nudge');
    expect(humaniseParticipantStatus('nudge_sent')).toBe('nudge sent');
    expect(humaniseParticipantStatus('replied')).toBe('you replied — awaiting follow-up');
    expect(humaniseParticipantStatus('clarification_needed')).toBe('clarification requested');
    expect(humaniseParticipantStatus('blocked')).toBe('marked as blocked');
    expect(humaniseParticipantStatus('overdue')).toBe('overdue');
    expect(humaniseParticipantStatus('completed')).toBe('completed');
  });

  it('humaniseDocumentAction returns expected label for each action', () => {
    expect(humaniseDocumentAction('read')).toBe('Read the document');
    expect(humaniseDocumentAction('comment')).toBe('Add a comment or mark no concerns');
    expect(humaniseDocumentAction('approve')).toBe('Approve the document');
    expect(humaniseDocumentAction('provide_input')).toBe('Provide your input');
    expect(humaniseDocumentAction('confirm_decision')).toBe('Confirm the decision');
  });

  it('humaniseDocumentAction falls back to the raw value for unknown action', () => {
    expect(humaniseDocumentAction('unknown_action' as any)).toBe('unknown_action');
  });
});
