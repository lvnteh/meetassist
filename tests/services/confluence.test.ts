import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfluenceService } from '../../src/services/confluence';

vi.mock('axios');
import axios from 'axios';
const mockedAxios = vi.mocked(axios, true);

describe('ConfluenceService', () => {
  let service: ConfluenceService;

  beforeEach(() => {
    service = new ConfluenceService({
      baseUrl: 'https://test.atlassian.net',
      email: 'test@example.com',
      apiToken: 'token123',
    });
    vi.clearAllMocks();
  });

  it('getPage returns structured page data', async () => {
    (mockedAxios.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: '123456',
        title: 'Q3 Roadmap',
        version: { number: 5 },
        history: {
          lastUpdated: {
            by: { displayName: 'Tom H' },
            when: '2026-05-27T10:00:00Z',
          },
        },
        body: {
          storage: { value: '<p>Doc content here</p>' },
        },
      },
    });

    const page = await service.getPage('123456');
    expect(page.title).toBe('Q3 Roadmap');
    expect(page.version).toBe(5);
    expect(page.lastModifiedBy).toBe('Tom H');
  });

  it('getComments returns array of comments', async () => {
    (mockedAxios.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        results: [
          {
            body: { storage: { value: '<p>Looks good</p>' } },
            author: { displayName: 'Sarah J', email: 'sarah@example.com' },
            created: '2026-05-27T11:00:00Z',
          },
        ],
      },
    });

    const comments = await service.getComments('123456');
    expect(comments.length).toBe(1);
    expect(comments[0].authorDisplayName).toBe('Sarah J');
    expect(comments[0].bodyText).toBe('Looks good');
  });
});
