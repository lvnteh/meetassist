import dotenv from 'dotenv';
dotenv.config();

import { db } from './db/client';
import { createTables } from './db/schema';
import { app } from './bot/app';
import { MeetingService } from './services/meeting';
import { NudgeService } from './services/nudge';
import { ConfluenceService } from './services/confluence';
import { RelayService } from './bot/relay';
import { registerCommands } from './bot/commands';
import { registerActions } from './bot/actions';
import { startScheduler } from './scheduler/cron';

async function main() {
  createTables(db);

  const meetingService = new MeetingService(db);
  const nudgeService = new NudgeService(db);
  const confluenceService = new ConfluenceService({
    baseUrl: process.env.CONFLUENCE_BASE_URL!,
    email: process.env.CONFLUENCE_EMAIL!,
    apiToken: process.env.CONFLUENCE_API_TOKEN!,
  });
  const relayService = new RelayService(meetingService, nudgeService);

  registerCommands(meetingService, nudgeService, relayService, confluenceService);
  registerActions(meetingService, relayService);
  relayService.registerDmListener(meetingService);

  startScheduler(meetingService, relayService);

  await app.start();
  console.log('Meetassist is running');

  const shutdown = async () => {
    await app.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
