import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeetingService } from '../../src/services/meeting';

function makePool(rows: any[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as any;
}

const baseInput = {
  title: 'Roadmap Review',
  start_time: '2026-06-01T09:00:00Z',
  organizer_user_id: 'user-1',
  purpose: 'Align on Q3 priorities',
  document_url: 'https://org.atlassian.net/wiki/spaces/PROJ/pages/123456/Roadmap',
  document_title: 'Q3 Roadmap',
  document_action: 'read' as const,
};

describe('MeetingService', () => {
  it('createMeeting inserts and returns the meeting', async () => {
    const created = { ...baseInput, id: 'mtg-1', confluence_page_id: '123456', status: 'draft', created_at: '' };
    const pool = makePool([created]);
    const service = new MeetingService(pool);

    const meeting = await service.createMeeting(baseInput);
    expect(meeting.title).toBe('Roadmap Review');
    expect(meeting.confluence_page_id).toBe('123456');
    expect(pool.query).toHaveBeenCalled();
  });

  it('createMeeting throws when confluence page id cannot be parsed', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    await expect(
      service.createMeeting({ ...baseInput, document_url: 'https://org.atlassian.net/no-page-id' })
    ).rejects.toThrow('Cannot parse Confluence page ID');
  });

  it('getById returns null when no rows', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    const result = await service.getById('unknown-id');
    expect(result).toBeNull();
  });

  it('listActive filters by organizer when provided', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    await service.listActive('user-1');
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('organizer_user_id');
    expect(call[1]).toContain('user-1');
  });

  it('upsertUser inserts with ON CONFLICT update', async () => {
    const user = { id: 'u1', slack_user_id: 'U001', email: 'a@b.com', display_name: 'Alice' };
    const pool = { query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [user] }) } as any;
    const service = new MeetingService(pool);
    const result = await service.upsertUser({ slack_user_id: 'U001', email: 'a@b.com', display_name: 'Alice' });
    expect(result.slack_user_id).toBe('U001');
  });
});
