import { describe, it, expect, vi } from 'vitest';
import { bootstrapOperatorDms } from '../../src/bot/dm-bootstrap';

function makeClient(opts: { updateThrows?: boolean; postTs?: string | null } = {}) {
  return {
    conversations: { open: vi.fn().mockResolvedValue({ channel: { id: 'D1' } }) },
    chat: {
      update: opts.updateThrows
        ? vi.fn().mockRejectedValue(new Error('not_found'))
        : vi.fn().mockResolvedValue({ ok: true }),
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: opts.postTs === undefined ? '1700000000.000200' : opts.postTs }),
    },
  } as any;
}

describe('bootstrapOperatorDms', () => {
  it('updates an existing message when stored channel/ts match', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    const meetingService = {
      getUserBySlackId: vi.fn().mockResolvedValue({
        id: 'u1',
        slack_user_id: 'U1',
        operator_dm_channel_id: 'D1',
        operator_dm_message_ts: '1.0',
      }),
    } as any;
    const client = makeClient();

    await bootstrapOperatorDms(pool, meetingService, client, ['U1']);

    expect(client.chat.update).toHaveBeenCalledOnce();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('reposts when chat.update throws (message deleted)', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    const meetingService = {
      getUserBySlackId: vi.fn().mockResolvedValue({
        id: 'u1',
        operator_dm_channel_id: 'D1',
        operator_dm_message_ts: '1.0',
      }),
    } as any;
    const client = makeClient({ updateThrows: true });

    await bootstrapOperatorDms(pool, meetingService, client, ['U1']);

    expect(client.chat.update).toHaveBeenCalledOnce();
    expect(client.chat.postMessage).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('UPDATE users SET operator_dm_channel_id');
    expect(params).toEqual(['D1', '1700000000.000200', 'u1']);
  });

  it('posts a new message when no stored ts exists', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    const meetingService = {
      getUserBySlackId: vi.fn().mockResolvedValue({ id: 'u1' }),
    } as any;
    const client = makeClient();

    await bootstrapOperatorDms(pool, meetingService, client, ['U1']);

    expect(client.chat.update).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledOnce();
  });

  it('skips persistence when postMessage returns no ts', async () => {
    const pool = { query: vi.fn() } as any;
    const meetingService = {
      getUserBySlackId: vi.fn().mockResolvedValue({ id: 'u1' }),
    } as any;
    const client = makeClient({ postTs: null });

    await bootstrapOperatorDms(pool, meetingService, client, ['U1']);

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('logs and continues when one operator fails', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    const meetingService = {
      getUserBySlackId: vi.fn().mockResolvedValue({ id: 'u1' }),
    } as any;
    const client = {
      conversations: {
        open: vi.fn()
          .mockRejectedValueOnce(new Error('boom'))
          .mockResolvedValueOnce({ channel: { id: 'D2' } }),
      },
      chat: {
        update: vi.fn().mockResolvedValue({ ok: true }),
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1.5' }),
      },
    } as any;

    await bootstrapOperatorDms(pool, meetingService, client, ['UFAIL', 'UOK']);

    expect(consoleErr).toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledOnce();
    consoleErr.mockRestore();
  });

  it('skips operators with no user row', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = { query: vi.fn() } as any;
    const meetingService = {
      getUserBySlackId: vi.fn().mockResolvedValue(null),
    } as any;
    const client = makeClient();

    await bootstrapOperatorDms(pool, meetingService, client, ['UNEW']);

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});
