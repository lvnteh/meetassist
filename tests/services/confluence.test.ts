import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { ConfluenceService } from '../../src/services/confluence';

vi.mock('axios');

const config = {
  baseUrl: 'https://example.atlassian.net',
  email: 'bot@example.com',
  apiToken: 'tok',
};

describe('ConfluenceService.getPageVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the current page version number', async () => {
    (axios.get as any).mockResolvedValue({ data: { version: { number: 7 } } });
    const service = new ConfluenceService(config);

    const version = await service.getPageVersion('123');

    expect(version).toBe(7);
    expect((axios.get as any).mock.calls[0][0]).toContain('/wiki/rest/api/content/123');
  });
});

describe('ConfluenceService.updatePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PUTs the page with version+1 and storage-format body', async () => {
    (axios.get as any).mockResolvedValue({ data: { version: { number: 4 } } });
    (axios.put as any).mockResolvedValue({ status: 200, data: {} });
    const service = new ConfluenceService(config);

    await service.updatePage('123', 'Title', '<p>body</p>');

    const [url, payload, opts] = (axios.put as any).mock.calls[0];
    expect(url).toBe('https://example.atlassian.net/wiki/rest/api/content/123');
    expect(payload).toEqual({
      id: '123',
      type: 'page',
      title: 'Title',
      version: { number: 5 },
      body: { storage: { value: '<p>body</p>', representation: 'storage' } },
    });
    expect(opts.headers.Authorization).toMatch(/^Basic /);
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('retries once on 409 conflict with refetched version', async () => {
    (axios.get as any)
      .mockResolvedValueOnce({ data: { version: { number: 4 } } })
      .mockResolvedValueOnce({ data: { version: { number: 6 } } });

    const conflict = { response: { status: 409 } };
    (axios.put as any)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ status: 200, data: {} });

    const service = new ConfluenceService(config);
    await service.updatePage('123', 'T', '<p>x</p>');

    expect((axios.put as any).mock.calls[1][1].version).toEqual({ number: 7 });
  });

  it('throws if the second attempt also conflicts', async () => {
    (axios.get as any).mockResolvedValue({ data: { version: { number: 4 } } });
    const conflict = { response: { status: 409 } };
    (axios.put as any).mockRejectedValue(conflict);

    const service = new ConfluenceService(config);
    await expect(service.updatePage('123', 'T', '<p>x</p>')).rejects.toBe(conflict);
  });
});
