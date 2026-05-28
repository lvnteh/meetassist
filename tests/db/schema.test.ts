import { describe, it, expect, vi } from 'vitest';
import { createTables } from '../../src/db/schema';

describe('createTables', () => {
  it('runs CREATE TABLE statements without throwing', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    await expect(createTables(pool)).resolves.not.toThrow();
    expect(pool.query).toHaveBeenCalledOnce();
  });
});
