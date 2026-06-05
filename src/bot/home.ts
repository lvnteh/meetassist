import { app } from './app';

export function registerHomeTab(): void {
  app.event('app_home_opened', async ({ event, client }) => {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Welcome to Meetassist* :wave:\n\nUse `/ma` commands in this DM to manage meetings and nudge participants.',
            },
          },
        ],
      },
    });
  });
}
