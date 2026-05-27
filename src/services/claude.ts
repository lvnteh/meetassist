import type { Meeting, ConfluencePage, ConfluenceComment } from '../types';

export interface DocAnalysis {
  summary: string;
  suggestedNudges: string[];
}

export interface ReplyClassification {
  intent: 'completed' | 'blocked' | 'needs_clarification' | 'disagrees' | 'unavailable' | 'asks_question' | 'unknown';
  confidence: number;
}

// Phase 2: set CLAUDE_ENABLED=true in .env to activate
const ENABLED = process.env.CLAUDE_ENABLED === 'true';

export class ClaudeService {
  async analyzeDocState(
    _meeting: Meeting,
    _page: ConfluencePage,
    _comments: ConfluenceComment[]
  ): Promise<DocAnalysis> {
    if (!ENABLED) {
      return { summary: '', suggestedNudges: [] };
    }
    // Phase 2 implementation goes here
    throw new Error('Claude integration not yet implemented');
  }

  async classifyReply(
    _message: string,
    _meetingTitle: string
  ): Promise<ReplyClassification> {
    if (!ENABLED) {
      return { intent: 'unknown', confidence: 0 };
    }
    throw new Error('Claude integration not yet implemented');
  }

  async draftReply(_incomingMessage: string, _meetingTitle: string): Promise<string> {
    if (!ENABLED) {
      return '';
    }
    throw new Error('Claude integration not yet implemented');
  }
}
