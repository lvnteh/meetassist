import type { Meeting, MeetingParticipant, User, MeetingWithParticipantStatus } from '../types';
import { humaniseParticipantStatus, humaniseDocumentAction } from './labels';

interface OperatorMeetingSummary {
  meeting: Meeting;
  participants: (MeetingParticipant & User)[];
}

interface OperatorViewInput {
  meetings: OperatorMeetingSummary[];
}

interface ParticipantViewInput {
  meetings: MeetingWithParticipantStatus[];
}

export interface SlackHomeView {
  type: 'home';
  blocks: any[];
}

export function buildOperatorView(input: OperatorViewInput): SlackHomeView {
  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Meetassist' } },
  ];

  if (input.meetings.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'No active meetings yet. Create your first one to get started.' },
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '+ Create meeting' },
          action_id: 'home_create_meeting',
          style: 'primary',
        },
      ],
    });
    return { type: 'home', blocks };
  }

  // (multi-meeting branch — added in Task 5)
  return { type: 'home', blocks };
}

export function buildParticipantView(_input: ParticipantViewInput): SlackHomeView {
  // Implemented in Task 6
  return { type: 'home', blocks: [] };
}
