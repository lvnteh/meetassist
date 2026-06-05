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

  it('getUserById returns the user row when found', async () => {
    const user = { id: 'u1', slack_user_id: 'U001', email: 'a@b.com', display_name: 'Alice' };
    const pool = makePool([user]);
    const service = new MeetingService(pool);
    const result = await service.getUserById('u1');
    expect(result).not.toBeNull();
    expect(result!.slack_user_id).toBe('U001');
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('users');
    expect(call[0]).toContain('id = $1');
    expect(call[1]).toEqual(['u1']);
  });

  it('getUserById returns null when no row', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    const result = await service.getUserById('missing');
    expect(result).toBeNull();
  });

  it('updateAction without purpose updates only the action column', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    await service.updateAction('m1', 'comment');
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('UPDATE meetings SET document_action');
    expect(call[0]).not.toContain('purpose');
    expect(call[1]).toEqual(['comment', 'm1']);
  });

  it('updateAction with purpose updates both columns in one statement', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    await service.updateAction('m1', 'comment', 'Please review the migration plan');
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('document_action = $1');
    expect(call[0]).toContain('purpose = $2');
    expect(call[1]).toEqual(['comment', 'Please review the migration plan', 'm1']);
  });

  it('updateAction with empty-string purpose still updates the column', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    await service.updateAction('m1', 'comment', '');
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('purpose = $2');
    expect(call[1]).toEqual(['comment', '', 'm1']);
  });

  it('setControlMessage updates control_channel_id and control_message_ts', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    await service.setControlMessage('m1', 'C123', '1700000000.000100');
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('UPDATE meetings');
    expect(call[0]).toContain('control_channel_id');
    expect(call[0]).toContain('control_message_ts');
    expect(call[1]).toEqual(['C123', '1700000000.000100', 'm1']);
  });

  it('setLastCardProgress updates last_card_progress', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    await service.setLastCardProgress('m1', '2/5/1');
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('UPDATE meetings');
    expect(call[0]).toContain('last_card_progress');
    expect(call[1]).toEqual(['2/5/1', 'm1']);
  });

  it('getMeetingsWithStaleCard SQL filters by control_message_ts and joins meeting_participants', async () => {
    const pool = makePool([]);
    const service = new MeetingService(pool);
    await service.getMeetingsWithStaleCard();
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('control_message_ts IS NOT NULL');
    expect(call[0]).toContain('meeting_participants');
    expect(call[0]).toContain('progress_signature');
  });

  it('getMeetingsWithStaleCard filters out rows with matching signature', async () => {
    const rows = [
      { id: 'm1', last_card_progress: '1/3/0', progress_signature: '1/3/0' },
      { id: 'm2', last_card_progress: '0/3/0', progress_signature: '1/3/0' },
      { id: 'm3', last_card_progress: null, progress_signature: '0/2/0' },
    ];
    const pool = makePool(rows);
    const service = new MeetingService(pool);
    const result = await service.getMeetingsWithStaleCard();
    expect(result.map((r) => r.id)).toEqual(['m2', 'm3']);
  });

  it('getMeetingsWithStaleCard returns empty when all signatures match', async () => {
    const rows = [
      { id: 'm1', last_card_progress: '1/3/0', progress_signature: '1/3/0' },
      { id: 'm2', last_card_progress: '2/4/1', progress_signature: '2/4/1' },
    ];
    const pool = makePool(rows);
    const service = new MeetingService(pool);
    const result = await service.getMeetingsWithStaleCard();
    expect(result).toEqual([]);
  });
});

describe('MeetingService.getActiveMeetingsForParticipant', () => {
  it('returns all active meetings for a participant', async () => {
    const rows = [
      { id: 'mtg-1', title: 'Meeting 1', status: 'active', participant_status: 'nudge_sent' },
      { id: 'mtg-2', title: 'Meeting 2', status: 'active', participant_status: 'replied' },
    ];
    const mockPool = { query: vi.fn().mockResolvedValue({ rows }) } as any;
    const svc = new MeetingService(mockPool);
    const result = await svc.getActiveMeetingsForParticipant('U123');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('mtg-1');
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('slack_user_id'), ['U123']);
  });
});
