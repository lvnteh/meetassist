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
    sendBlocksToParticipant: vi.fn().mockResolvedValue({ channel: 'D1', ts: '1.0' }),
    ...overrides.relayService,
  };
  const nudgeService = {
    recordNudge: vi.fn().mockResolvedValue(undefined),
    buildVerificationNudgeMessage: vi.fn().mockReturnValue({
      text: 'Just checking — your action for *Take Template Ownership* was to comment',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Just checking...' } }],
    }),
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

describe('runVerification — comment check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseMeeting = {
    id: 'm1',
    confluence_page_id: '123',
    document_action: 'comment',
    organizer_user_id: 'org-uuid',
    title: 'Take Template Ownership',
    document_url: 'https://x.example/doc',
    document_title: 'Doc',
  };

  const baseParticipant = {
    user_id: 'u1',
    status: 'completed',
    email: 'alice@example.com',
    display_name: 'Alice',
    slack_user_id: 'U_ALICE',
  };

  function depsWithMatchingComment(commentEmail: string) {
    return makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
        getUserById: vi.fn().mockResolvedValue({ id: 'org-uuid', slack_user_id: 'U_ORG', display_name: 'Op' }),
      },
      confluenceService: {
        getComments: vi.fn().mockResolvedValue([{ authorEmail: commentEmail }]),
      },
    });
  }

  it('stays silent when participant has commented on the doc', async () => {
    const deps = depsWithMatchingComment('alice@example.com');
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('comment match is case-insensitive and trimmed', async () => {
    const deps = depsWithMatchingComment('  Alice@Example.COM  ');
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('DMs the organizer when no matching comment exists', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
        getUserById: vi.fn().mockResolvedValue({ id: 'org-uuid', slack_user_id: 'U_ORG', display_name: 'Op' }),
      },
      confluenceService: {
        getComments: vi.fn().mockResolvedValue([{ authorEmail: 'someone-else@example.com' }]),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');

    expect(deps.slackClient.chat.postMessage).toHaveBeenCalledTimes(1);
    const call = deps.slackClient.chat.postMessage.mock.calls[0][0];
    expect(call.channel).toBe('U_ORG');
    expect(call.text).toContain('Alice');
    expect(call.text).toContain('Take Template Ownership');
    const blocks = JSON.stringify(call.blocks);
    expect(blocks).toContain('verification_nudge_yes');
    expect(blocks).toContain('verification_nudge_skip');
    expect(blocks).toContain('m1|u1');
  });

  it('DMs the organizer for provide_input action', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue({ ...baseMeeting, document_action: 'provide_input' }),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
        getUserById: vi.fn().mockResolvedValue({ id: 'org-uuid', slack_user_id: 'U_ORG', display_name: 'Op' }),
      },
      confluenceService: { getComments: vi.fn().mockResolvedValue([]) },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('DMs the organizer for approve action', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue({ ...baseMeeting, document_action: 'approve' }),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
        getUserById: vi.fn().mockResolvedValue({ id: 'org-uuid', slack_user_id: 'U_ORG', display_name: 'Op' }),
      },
      confluenceService: { getComments: vi.fn().mockResolvedValue([]) },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('treats empty participant email as unverified and DMs the organizer', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([{ ...baseParticipant, email: '' }]),
        getUserById: vi.fn().mockResolvedValue({ id: 'org-uuid', slack_user_id: 'U_ORG', display_name: 'Op' }),
      },
      confluenceService: {
        getComments: vi.fn().mockResolvedValue([{ authorEmail: 'someone@example.com' }]),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('catches Confluence errors, logs, and does not DM', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
        getUserById: vi.fn().mockResolvedValue({ id: 'org-uuid', slack_user_id: 'U_ORG', display_name: 'Op' }),
      },
      confluenceService: {
        getComments: vi.fn().mockRejectedValue(new Error('confluence boom')),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    const logged = (errSpy.mock.calls[0] ?? []).join(' ');
    expect(logged).toContain('[verification]');
    errSpy.mockRestore();
  });

  it('does not DM if organizer user cannot be resolved', async () => {
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
        getUserById: vi.fn().mockResolvedValue(null),
      },
      confluenceService: {
        getComments: vi.fn().mockResolvedValue([{ authorEmail: 'someone@example.com' }]),
      },
    });
    configureVerification(deps as any);
    await runVerification('m1', 'u1');
    expect(deps.slackClient.chat.postMessage).not.toHaveBeenCalled();
  });
});

import { handleVerificationNudgeYes, handleVerificationNudgeSkip } from '../../src/services/verification';

describe('verification button handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseMeeting = {
    id: 'm1',
    title: 'Take Template Ownership',
    document_url: 'https://x.example/doc',
    document_action: 'comment',
  };
  const baseParticipant = {
    user_id: 'u1',
    display_name: 'Alice',
    slack_user_id: 'U_ALICE',
    email: 'a@b.com',
    status: 'completed',
  };

  it('handleVerificationNudgeYes sends DM to participant, records nudge, increments reminder, replaces original', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
      },
    });
    configureVerification(deps as any);

    await handleVerificationNudgeYes('m1|u1', respond);

    expect(deps.relayService.sendBlocksToParticipant).toHaveBeenCalledTimes(1);
    const sendArgs = deps.relayService.sendBlocksToParticipant.mock.calls[0][0];
    expect(sendArgs.slackUserId).toBe('U_ALICE');
    expect(sendArgs.text).toContain('Take Template Ownership');

    expect(deps.nudgeService.recordNudge).toHaveBeenCalledTimes(1);
    const recordArgs = deps.nudgeService.recordNudge.mock.calls[0][0];
    expect(recordArgs.user_id).toBe('u1');
    expect(recordArgs.meeting_id).toBe('m1');
    expect(recordArgs.type).toBe('reminder');

    expect(deps.meetingService.incrementReminderCount).toHaveBeenCalledWith('m1', 'u1');

    expect(respond).toHaveBeenCalledTimes(1);
    const respondArgs = respond.mock.calls[0][0];
    expect(respondArgs.replace_original).toBe(true);
    expect(respondArgs.text).toContain('Nudge sent');
    expect(respondArgs.text).toContain('Alice');
  });

  it('handleVerificationNudgeYes returns silently if meeting deleted', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(null),
        getParticipantsWithUsers: vi.fn(),
      },
    });
    configureVerification(deps as any);
    await handleVerificationNudgeYes('m1|u1', respond);
    expect(deps.relayService.sendBlocksToParticipant).not.toHaveBeenCalled();
    expect(deps.nudgeService.recordNudge).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('handleVerificationNudgeYes returns silently if participant removed', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(baseMeeting),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([]),
      },
    });
    configureVerification(deps as any);
    await handleVerificationNudgeYes('m1|u1', respond);
    expect(deps.relayService.sendBlocksToParticipant).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('handleVerificationNudgeSkip replaces original DM with Skipped', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    configureVerification(makeDeps() as any);
    await handleVerificationNudgeSkip('m1|u1', respond);
    expect(respond).toHaveBeenCalledTimes(1);
    const args = respond.mock.calls[0][0];
    expect(args.replace_original).toBe(true);
    expect(args.text).toContain('Skipped');
  });

  it('handleVerificationNudgeYes includes meeting purpose in the follow-up DM', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const meetingWithPurpose = {
      ...baseMeeting,
      purpose: 'Review the proposed roadmap before Friday',
    };
    const deps = makeDeps({
      meetingService: {
        getById: vi.fn().mockResolvedValue(meetingWithPurpose),
        getParticipantsWithUsers: vi.fn().mockResolvedValue([baseParticipant]),
      },
    });
    configureVerification(deps as any);

    await handleVerificationNudgeYes('m1|u1', respond);

    expect(deps.nudgeService.buildVerificationNudgeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'Review the proposed roadmap before Friday' })
    );
  });
});
