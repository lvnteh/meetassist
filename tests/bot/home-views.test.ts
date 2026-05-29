import { describe, it, expect } from 'vitest';
import { buildOperatorView } from '../../src/bot/home-views';

describe('buildOperatorView', () => {
  it('returns empty state when no meetings', () => {
    const view = buildOperatorView({ meetings: [] });

    expect(view.type).toBe('home');
    expect(view.blocks).toBeDefined();

    const headerBlock = view.blocks.find((b: any) => b.type === 'header');
    expect(headerBlock).toBeDefined();
    expect((headerBlock as any).text.text).toBe('Meetassist');

    const sectionTexts = view.blocks
      .filter((b: any) => b.type === 'section')
      .map((b: any) => b.text?.text ?? '');
    expect(sectionTexts.some((t) => t.includes('No active meetings'))).toBe(true);

    const actions = view.blocks.find((b: any) => b.type === 'actions');
    expect(actions).toBeDefined();
    const button = (actions as any).elements[0];
    expect(button.action_id).toBe('home_create_meeting');
    expect(button.text.text).toContain('Create meeting');
  });

  it('returns one card per meeting with progress and 6 action buttons', () => {
    const meeting1 = {
      id: 'mtg-aaaaaaaaaaa1', title: 'Roadmap', start_time: '2026-06-01T09:00:00Z',
      organizer_user_id: 'op1', purpose: 'p', document_url: 'https://x/wiki/spaces/A/pages/1/r',
      document_title: 'Doc1', document_action: 'comment' as const, confluence_page_id: '1',
      status: 'active' as const, created_at: '',
    };
    const meeting2 = { ...meeting1, id: 'mtg-bbbbbbbbbbb2', title: 'Review', document_action: 'read' as const };

    const view = buildOperatorView({
      meetings: [
        {
          meeting: meeting1,
          participants: [
            { meeting_id: 'mtg-aaaaaaaaaaa1', user_id: 'u1', role: 'participant', status: 'completed', reminder_count: 0, completed_at: null, slack_user_id: 'U1', display_name: 'A', email: 'a@x', id: 'u1' } as any,
            { meeting_id: 'mtg-aaaaaaaaaaa1', user_id: 'u2', role: 'participant', status: 'completed', reminder_count: 0, completed_at: null, slack_user_id: 'U2', display_name: 'B', email: 'b@x', id: 'u2' } as any,
            { meeting_id: 'mtg-aaaaaaaaaaa1', user_id: 'u3', role: 'participant', status: 'completed', reminder_count: 0, completed_at: null, slack_user_id: 'U3', display_name: 'C', email: 'c@x', id: 'u3' } as any,
            { meeting_id: 'mtg-aaaaaaaaaaa1', user_id: 'u4', role: 'participant', status: 'pending', reminder_count: 0, completed_at: null, slack_user_id: 'U4', display_name: 'D', email: 'd@x', id: 'u4' } as any,
            { meeting_id: 'mtg-aaaaaaaaaaa1', user_id: 'u5', role: 'participant', status: 'blocked', reminder_count: 0, completed_at: null, slack_user_id: 'U5', display_name: 'E', email: 'e@x', id: 'u5' } as any,
          ],
        },
        { meeting: meeting2, participants: [] },
      ],
    });

    const sectionTexts = view.blocks
      .filter((b: any) => b.type === 'section')
      .map((b: any) => b.text?.text ?? '');

    const subtitle = sectionTexts.find((t) => t.includes('active meeting'));
    expect(subtitle).toContain('2 active');

    const card1 = sectionTexts.find((t) => t.includes('Roadmap'));
    expect(card1).toContain('mtg-aaaa');
    expect(card1).toContain('3/5 done');
    expect(card1).toContain('1 blocked');
    expect(card1).toContain('Add a comment or mark no concerns');

    const actionsBlocks = view.blocks.filter((b: any) => b.type === 'actions');
    const meetingActions = actionsBlocks.filter((b: any) =>
      b.elements.some((e: any) => e.action_id === 'home_send')
    );
    expect(meetingActions).toHaveLength(2);

    const buttons = meetingActions[0].elements.map((e: any) => e.action_id);
    expect(buttons).toEqual([
      'home_send', 'home_remind', 'home_status', 'home_check_doc', 'home_set_action', 'home_followup',
    ]);
    expect(meetingActions[0].elements[0].value).toBe('mtg-aaaaaaaaaaa1');

    const dividers = view.blocks.filter((b: any) => b.type === 'divider');
    expect(dividers.length).toBeGreaterThanOrEqual(2);

    const footer = actionsBlocks[actionsBlocks.length - 1];
    expect(footer.elements[0].action_id).toBe('home_create_meeting');
  });
});
