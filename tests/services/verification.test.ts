import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureVerification, runVerification } from '../../src/services/verification';

function makeDeps(overrides: any = {}) {
  const meetingService = {
    getById: vi.fn().mockResolvedValue(null),
    getParticipantsWithUsers: vi.fn().mockResolvedValue([]),
    getUserById: vi.fn().mockResolvedValue(null),
    incrementReminderCount: vi.fn().mockResolvedValue(undefined),
    ...overrides.meetingService,
  };
  const confluenceService = {
    getComments: vi.fn().mockResolvedValue([]),
    ...overrides.confluenceService,
  };
  const relayService = {
    sendToParticipant: vi.fn().mockResolvedValue({ channel: 'D1', ts: '1.0' }),
    ...overrides.relayService,
  };
  const nudgeService = {
    recordNudge: vi.fn().mockResolvedValue(undefined),
    ...overrides.nudgeService,
  };
  const slackClient = {
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, channel: 'D1', ts: '1.0' }) },
    ...overrides.slackClient,
  };
  return { meetingService, confluenceService, relayService, nudgeService, slackClient };
}

describe('runVerification — irrelevant cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns silently when meeting not found', async () => {
    const deps = makeDeps();
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.confluenceService.getComments).not.toHaveBeenCalled();
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('returns silently when participant not found on the meeting', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue({
          id: 'm1', confluence_page_id: '123', document_action: 'comment',
          organizer_user_id: 'org', title: 'T',
        }),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([
          { user_id: 'someone-else', status: 'completed', email: 'x@y.com' },
        ]),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.confluenceService.getComments).not.toHaveBeenCalled();
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('returns silently when document_action is read', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue({
          id: 'm1', confluence_page_id: '123', document_action: 'read',
          organizer_user_id: 'org', title: 'T',
        }),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([
          { user_id: 'u1', status: 'completed', email: 'a@b.com' },
        ]),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.confluenceService.getComments).not.toHaveBeenCalled();
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('returns silently when participant status is no longer completed', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue({
          id: 'm1', confluence_page_id: '123', document_action: 'comment',
          organizer_user_id: 'org', title: 'T',
        }),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([
          { user_id: 'u1', status: 'pending', email: 'a@b.com' },
        ]),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.confluenceService.getComments).not.toHaveBeenCalled();
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });
});
