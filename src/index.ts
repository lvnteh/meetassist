import dotenv from 'dotenv';
dotenv.config();

import { pool } from './db/client';
import { createTables } from './db/schema';
import { app } from './bot/app';
import { MeetingService } from './services/meeting';
import { NudgeService } from './services/nudge';
import { ConfluenceService } from './services/confluence';
import { RelayService } from './bot/relay';
import { registerCommands } from './bot/commands';
import { registerActions } from './bot/actions';
import { startScheduler } from './scheduler/cron';
import { configureDashboard } from './services/dashboard';
import { startDashboardServer } from './services/dashboard-server';
import { configureVerification } from './services/verification';
import { registerModalHandlers } from './bot/modals';
import { registerControlActions } from './bot/control-actions';
import { registerHomeTab } from './bot/home';
import { bootstrapOperatorDms } from './bot/dm-bootstrap';

async function main() {
  await createTables(pool);

  const meetingService = new MeetingService(pool);
  const nudgeService = new NudgeService(pool);
  const confluenceService = new ConfluenceService({
    baseUrl: process.env.CONFLUENCE_BASE_URL!,
    email: process.env.CONFLUENCE_EMAIL!,
    apiToken: process.env.CONFLUENCE_API_TOKEN!,
  });
  const relayService = new RelayService(meetingService, nudgeService);

  configureDashboard({
    filePath: './dashboard.html',
    meetingService,
    nudgeService,
  });

  startDashboardServer({
    port: Number(process.env.PORT ?? 3000),
    token: process.env.DASHBOARD_TOKEN ?? null,
    meetingService,
    nudgeService,
  });

  configureVerification({
    meetingService,
    nudgeService,
    confluenceService,
    relayService,
    slackClient: app.client,
  });

  registerCommands(meetingService, nudgeService, relayService, confluenceService);
  registerActions(meetingService, nudgeService, relayService);
  registerModalHandlers(meetingService, confluenceService, nudgeService, relayService);
  registerControlActions(meetingService, nudgeService, relayService);
  registerHomeTab(meetingService);
  relayService.registerDmListener(meetingService);

  startScheduler(meetingService, relayService, app.client);

  await app.start();

  const operatorIds = (process.env.OPERATOR_SLACK_IDS ?? process.env.OPERATOR_SLACK_ID ?? '').split(',').map(s => s.trim()).filter(Boolean);
  console.log(`[boot] Seeding ${operatorIds.length} operator(s):`, operatorIds);
  for (const operatorId of operatorIds) {
    await meetingService.autoSeedFromSlack(operatorId, app.client).catch((err) => {
      console.error(`[boot] Slack lookup failed for ${operatorId}, using fallback:`, err?.message);
      return meetingService.upsertUser({
        slack_user_id: operatorId,
        email: process.env.CONFLUENCE_EMAIL!,
        display_name: process.env.OPERATOR_NAME ?? operatorId,
      });
    });
  }

  await bootstrapOperatorDms(pool, meetingService, app.client, operatorIds);

  console.log('Meetassist is running');

  const shutdown = async () => {
    await app.stop();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
