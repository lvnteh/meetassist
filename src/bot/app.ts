import { App } from '@slack/bolt';

export const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  appToken: process.env.SLACK_APP_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  socketMode: true,
});

app.error(async (error) => {
  console.error('[Bolt error]', error);
});
