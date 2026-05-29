import { describe, it, expect, vi } from 'vitest';
import { createTables } from '../../src/db/schema';

describe('createTables', () => {
  it('runs CREATE TABLE statements without throwing', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    await expect(createTables(pool)).resolves.not.toThrow();
    expect(pool.query).toHaveBeenCalledOnce();
  });

  it('includes idempotent ALTER TABLE statements for new control card and DM bootstrap columns', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    await createTables(pool);

    const sql = pool.query.mock.calls[0][0] as string;

    // meetings table additions
    expect(sql).toContain('ALTER TABLE meetings ADD COLUMN IF NOT EXISTS control_channel_id TEXT');
    expect(sql).toContain('ALTER TABLE meetings ADD COLUMN IF NOT EXISTS control_message_ts TEXT');
    expect(sql).toContain('ALTER TABLE meetings ADD COLUMN IF NOT EXISTS last_card_progress TEXT');

    // users table additions
    expect(sql).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS operator_dm_channel_id TEXT');
    expect(sql).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS operator_dm_message_ts TEXT');
  });
});
