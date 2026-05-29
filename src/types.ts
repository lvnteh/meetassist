export type MeetingStatus = 'draft' | 'active' | 'completed' | 'cancelled';
export type DocumentAction = 'read' | 'comment' | 'approve' | 'provide_input' | 'confirm_decision';
export type ParticipantStatus =
  | 'pending'
  | 'nudge_sent'
  | 'replied'
  | 'completed'
  | 'blocked'
  | 'clarification_needed'
  | 'overdue';
export type NudgeType = 'pre_meeting' | 'reminder' | 'post_meeting' | 'doc_check';
export type ParticipantRole = 'participant' | 'organizer';

export interface User {
  id: string;
  email: string;
  slack_user_id: string;
  display_name: string;
}

export interface Meeting {
  id: string;
  title: string;
  start_time: string;
  organizer_user_id: string;
  purpose: string;
  document_url: string;
  document_title: string;
  document_action: DocumentAction;
  confluence_page_id: string;
  status: MeetingStatus;
  created_at: string;
}

export interface MeetingParticipant {
  meeting_id: string;
  user_id: string;
  role: ParticipantRole;
  status: ParticipantStatus;
  reminder_count: number;
  completed_at: string | null;
}

export interface Nudge {
  id: string;
  user_id: string;
  meeting_id: string;
  slack_channel_id: string;
  message_ts: string;
  type: NudgeType;
  sent_at: string;
}

export interface ParticipantMessage {
  id: string;
  user_id: string;
  meeting_id: string;
  nudge_id: string | null;
  raw_text: string;
  ai_classification: string | null;
  created_at: string;
}

export interface OperatorReply {
  id: string;
  participant_message_id: string;
  raw_text: string;
  sent_at: string;
}

export interface DocCheck {
  id: string;
  meeting_id: string;
  checked_at: string;
  confluence_version: number;
  comment_count: number;
  summary: string | null;
  suggested_nudges: string | null;
}

export interface ConfluenceComment {
  authorDisplayName: string;
  authorEmail: string | null;
  bodyText: string;
  created: string;
}

export interface ConfluencePage {
  id: string;
  title: string;
  version: number;
  lastModifiedBy: string;
  lastModifiedAt: string;
  bodyText: string;
}
