import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/bot/app', () => ({
  app: { event: vi.fn() },
}));

import { buildWelcomeBlocks, buildParticipantBlocks, buildOperatorBlocks } from '../../src/bot/home';

describe('buildWelcomeBlocks', () => {
  it('returns a section block', () => {
    const blocks = buildWelcomeBlocks();
    expect(blocks.some((b: any) => b.type === 'section')).toBe(true);
  });

  it('section accessory contains open_create_modal button', () => {
    const blocks = buildWelcomeBlocks();
    const section = blocks.find((b: any) => b.type === 'section') as any;
    expect(section.accessory?.action_id).toBe('open_create_modal');
  });
});

describe('buildParticipantBlocks', () => {
  it('returns empty state block when no meetings', () => {
    const blocks = buildParticipantBlocks([]);
    expect(blocks.some((b: any) => b.text?.text?.includes('no pending'))).toBe(true);
  });

  it('returns one card per meeting', () => {
    const meetings = [
      {
        id: 'mtg-1',
        title: 'Test Meeting',
        document_title: 'Doc',
        document_url: 'https://example.com',
        document_action: 'comment' as const,
        start_time: '2026-06-10T10:00:00Z',
        participant_status: 'nudge_sent' as const,
      },
    ];
    const blocks = buildParticipantBlocks(meetings as any);
    const sections = blocks.filter((b: any) => b.type === 'section');
    expect(sections.length).toBeGreaterThanOrEqual(1);
  });
});

describe('buildOperatorBlocks', () => {
  it('returns empty state when no meetings', () => {
    const blocks = buildOperatorBlocks([]);
    expect(blocks.some((b: any) => b.text?.text?.includes('No active meetings'))).toBe(true);
  });

  it('returns a card per meeting with participant count', () => {
    const meetings = [
      {
        id: 'mtg-1',
        title: 'Sprint Review',
        start_time: '2026-06-10T10:00:00Z',
        document_title: 'Doc',
        document_url: 'https://example.com',
        document_action: 'approve' as const,
        purpose: '',
        participants: [
          { display_name: 'Alice', slack_user_id: 'U1', status: 'completed' as const },
          { display_name: 'Bob', slack_user_id: 'U2', status: 'nudge_sent' as const },
        ],
      },
    ];
    const blocks = buildOperatorBlocks(meetings as any);
    const text = blocks.map((b: any) => b.text?.text ?? b.fields?.map((f: any) => f.text).join('') ?? '').join('');
    expect(text).toContain('Sprint Review');
    expect(text).toContain('1/2');
  });
});
