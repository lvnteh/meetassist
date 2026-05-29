import { app } from './app';
import type { MeetingService } from '../services/meeting';
import type { NudgeService } from '../services/nudge';
import type { RelayService } from './relay';
import type { ConfluenceService } from '../services/confluence';
import { buildOperatorView, buildParticipantView } from './home-views';
import { isOperator } from './roles';

let meetingServiceRef: MeetingService;

export async function publishHomeView(slackUserId: string): Promise<void> {
  try {
    const user = await meetingServiceRef.getUserBySlackId(slackUserId);
    if (!user) return;

    if (isOperator(slackUserId)) {
      const meetings = await meetingServiceRef.listActive(user.id);
      const summaries = await Promise.all(
        meetings.map(async (m) => ({
          meeting: m,
          participants: await meetingServiceRef.getParticipantsWithUsers(m.id),
        }))
      );
      const view = buildOperatorView({ meetings: summaries });
      await app.client.views.publish({ user_id: slackUserId, view: view as any });
    } else {
      const meetings = await meetingServiceRef.listOpenForParticipant(user.id);
      const view = buildParticipantView({ meetings });
      await app.client.views.publish({ user_id: slackUserId, view: view as any });
    }
  } catch (err: any) {
    console.error(`[home] publish failed for ${slackUserId}:`, err?.data ?? err?.message ?? err);
  }
}

export async function publishHomeViews(slackUserIds: string[]): Promise<void> {
  const unique = Array.from(new Set(slackUserIds.filter(Boolean)));
  await Promise.allSettled(unique.map((id) => publishHomeView(id)));
}

export function registerHome(
  meetingService: MeetingService,
  _nudgeService: NudgeService,
  _relayService: RelayService,
  _confluenceService: ConfluenceService
): void {
  meetingServiceRef = meetingService;

  app.event('app_home_opened', async ({ event }) => {
    const e = event as any;
    if (e.tab !== 'home') return;
    await publishHomeView(e.user);
  });
}
