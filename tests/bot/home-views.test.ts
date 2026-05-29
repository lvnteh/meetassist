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
});
