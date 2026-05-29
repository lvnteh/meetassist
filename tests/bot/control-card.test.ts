import { describe, it, expect } from 'vitest';
import { buildControlCardBlocks, progressSignature } from '../../src/bot/control-card';

const baseMeeting = {
  id: 'abcd1234-5678-90ef',
  title: 'Take Template Ownership',
  start_time: '2026-06-02T14:00:00Z',
  document_url: 'https://emarsys.jira.com/wiki/spaces/ACS/pages/6426755229/Take',
  document_title: 'Take Template Ownership',
  document_action: 'provide_input',
  purpose: 'Resolve who owns the template',
  status: 'active',
  organizer_user_id: 'u-op',
  confluence_page_id: '6426755229',
  created_at: '2026-05-29T00:00:00Z',
} as any;

const participants = [
  { user_id: 'u1', slack_user_id: 'U1', display_name: 'Alice', status: 'completed', meeting_id: 'm', role: 'participant', reminder_count: 0, completed_at: null, email: 'a@x' },
  { user_id: 'u2', slack_user_id: 'U2', display_name: 'Bob', status: 'blocked', meeting_id: 'm', role: 'participant', reminder_count: 0, completed_at: null, email: 'b@x' },
  { user_id: 'u3', slack_user_id: 'U3', display_name: 'Carol', status: 'pending', meeting_id: 'm', role: 'participant', reminder_count: 0, completed_at: null, email: 'c@x' },
] as any[];

describe('buildControlCardBlocks', () => {
  it('renders summary + 4 buttons for an active meeting', () => {
    const blocks = buildControlCardBlocks(baseMeeting, participants);
    const json = JSON.stringify(blocks);
    expect(json).toContain('Take Template Ownership');
    expect(json).toContain('1/3 done');
    expect(json).toContain('1 blocked');
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    expect(actions).toBeDefined();
    expect(actions.elements).toHaveLength(4);
    expect(actions.elements.map((e: any) => e.action_id)).toEqual([
      'meeting_view_status',
      'meeting_change_action',
      'meeting_send_reminder',
      'meeting_cancel',
    ]);
    // cancel button must use danger style + confirm dialog
    const cancelBtn = actions.elements[3];
    expect(cancelBtn.style).toBe('danger');
    expect(cancelBtn.confirm).toBeDefined();
  });

  it('uses meeting id as button value for routing', () => {
    const blocks = buildControlCardBlocks(baseMeeting, participants);
    const actions = blocks.find((b: any) => b.type === 'actions') as any;
    for (const el of actions.elements) {
      expect(el.value).toBe(baseMeeting.id);
    }
  });

  it('renders cancelled state without action buttons', () => {
    const cancelled = { ...baseMeeting, status: 'cancelled' };
    const blocks = buildControlCardBlocks(cancelled, participants);
    expect(JSON.stringify(blocks)).toContain('Cancelled');
    expect(blocks.find((b: any) => b.type === 'actions')).toBeUndefined();
  });

  it('omits purpose row when purpose is empty', () => {
    const noPurpose = { ...baseMeeting, purpose: '' };
    const blocks = buildControlCardBlocks(noPurpose, participants);
    expect(JSON.stringify(blocks)).not.toContain('Purpose:');
  });

  it('cleans Slack-wrapped URLs', () => {
    const wrapped = { ...baseMeeting, document_url: '<https://example.com/pages/123|Doc>' };
    const blocks = buildControlCardBlocks(wrapped, participants);
    const json = JSON.stringify(blocks);
    expect(json).toContain('https://example.com/pages/123');
    expect(json).not.toContain('|Doc>');
  });

  it('renders document as a clickable mrkdwn link', () => {
    const blocks = buildControlCardBlocks(baseMeeting, participants);
    const json = JSON.stringify(blocks);
    expect(json).toContain('<https://emarsys.jira.com/wiki/spaces/ACS/pages/6426755229/Take|Take Template Ownership>');
  });
});

describe('progressSignature', () => {
  it('produces done/total/blocked string', () => {
    expect(progressSignature(participants)).toBe('1/3/1');
  });

  it('handles empty participants', () => {
    expect(progressSignature([])).toBe('0/0/0');
  });
});
