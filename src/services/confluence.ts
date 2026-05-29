import axios from 'axios';
import type { ConfluencePage, ConfluenceComment } from '../types';

interface ConfluenceConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export class ConfluenceService {
  private authHeader: string;
  private baseUrl: string;

  constructor(private config: ConfluenceConfig) {
    this.baseUrl = config.baseUrl;
    this.authHeader =
      'Basic ' + Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
  }

  async getPage(pageId: string): Promise<ConfluencePage> {
    const response = await axios.get(
      `${this.baseUrl}/wiki/rest/api/content/${pageId}?expand=body.storage,version,history`,
      { headers: { Authorization: this.authHeader, Accept: 'application/json' } }
    );
    const data = response.data;
    return {
      id: data.id,
      title: data.title,
      version: data.version.number,
      lastModifiedBy: data.history.lastUpdated.by.displayName,
      lastModifiedAt: data.history.lastUpdated.when,
      bodyText: stripHtml(data.body.storage.value),
    };
  }

  async getComments(pageId: string): Promise<ConfluenceComment[]> {
    const response = await axios.get(
      `${this.baseUrl}/wiki/rest/api/content/${pageId}/child/comment?expand=body.storage,author`,
      { headers: { Authorization: this.authHeader, Accept: 'application/json' } }
    );
    return response.data.results.map((c: any) => ({
      authorDisplayName: c.author.displayName,
      authorEmail: c.author.email ?? null,
      bodyText: stripHtml(c.body.storage.value),
      created: c.created,
    }));
  }

  async getPageVersion(pageId: string): Promise<number> {
    const response = await axios.get(
      `${this.baseUrl}/wiki/rest/api/content/${pageId}?expand=version`,
      { headers: { Authorization: this.authHeader, Accept: 'application/json' } }
    );
    return response.data.version.number;
  }

  async updatePage(pageId: string, title: string, body: string): Promise<void> {
    const attempt = async (version: number) => {
      await axios.put(
        `${this.baseUrl}/wiki/rest/api/content/${pageId}`,
        {
          id: pageId,
          type: 'page',
          title,
          version: { number: version + 1 },
          body: { storage: { value: body, representation: 'storage' } },
        },
        {
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );
    };

    const initialVersion = await this.getPageVersion(pageId);
    try {
      await attempt(initialVersion);
    } catch (err: any) {
      if (err?.response?.status === 409) {
        const refreshed = await this.getPageVersion(pageId);
        await attempt(refreshed);
      } else {
        throw err;
      }
    }
  }

  buildDocCheckSummary(
    page: ConfluencePage,
    comments: ConfluenceComment[],
    participantEmails: string[]
  ): string {
    const lastUpdated = new Date(page.lastModifiedAt);
    const diffMs = Date.now() - lastUpdated.getTime();
    const diffH = Math.round(diffMs / 3600000);
    const timeAgo = diffH < 1 ? 'recently' : `${diffH}h ago`;

    const commenterEmails = new Set(comments.map((c) => c.authorEmail).filter(Boolean));
    const commentLines = comments
      .map((c) => `  ✅ ${c.authorDisplayName} — "${c.bodyText.slice(0, 80)}"`)
      .join('\n');

    const missing = participantEmails.filter((e) => !commenterEmails.has(e));
    const missingLines = missing.map((e) => `  ⬜ ${e} — no comment yet`).join('\n');

    const coverage = comments.length;
    const total = participantEmails.length;

    return [
      `*Doc check: ${page.title}*`,
      `Last updated: ${timeAgo} by ${page.lastModifiedBy}`,
      `Comments: ${comments.length} total`,
      commentLines,
      missingLines,
      `\nParticipant coverage: ${coverage}/${total} have engaged with the doc`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  buildSuggestedNudges(
    comments: ConfluenceComment[],
    participantEmails: string[],
    meeting: { title: string; document_url: string }
  ): string[] {
    const commenterEmails = new Set(comments.map((c) => c.authorEmail).filter(Boolean));
    const nudges: string[] = [];

    // Participants who haven't commented at all
    for (const email of participantEmails) {
      if (!commenterEmails.has(email)) {
        nudges.push(`Reminder to review "${meeting.title}" before the meeting: ${meeting.document_url}`);
        break; // one generic nudge for all missing, individualised at send time
      }
    }

    return nudges;
  }
}
