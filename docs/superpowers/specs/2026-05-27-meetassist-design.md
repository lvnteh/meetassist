# Meetassist — MVP Design Spec
**Date:** 2026-05-27
**Status:** Approved for implementation

---

## 1. Purpose

Meetassist is a Slack bot that tests whether a neutral system actor improves async meeting preparation and follow-up by turning participant actions into structured organizational memory.

The core thesis: messages are disposable, memory is the product. Meetassist tracks what participants committed to, what the shared document says, and what happened before/after each meeting — so that accountability doesn't rely on the meeting owner chasing people manually.

The MVP tests one question: **Can a neutral bot actor externalize meeting accountability and turn preparation/follow-up into structured memory?**

---

## 2. Scope

### In MVP
- Single Slack workspace, manually installed
- Socket Mode (no public URL required)
- Human operator (researcher) sits behind the bot
- Operator works entirely within Slack (DM with the bot)
- One Confluence document per meeting as the central knowledge object
- Claude as operator assistant for doc analysis and reply drafting (phase 2, wired but inactive in phase 1)
- SQLite for local persistence (no hosted DB)

### Out of scope
- Web dashboard
- Multi-workspace / SaaS
- Calendar integration
- Autonomous AI behavior
- Slack Marketplace
- Teams integration
- Multi-document meetings
- Complex permissioning

---

## 3. Architecture

Single TypeScript Node.js process. Three logical layers inside one runtime:

```
meetassist process
├── Slack Bolt (Socket Mode)     — inbound/outbound Slack events
├── Core services                — meeting, nudge, relay, confluence, claude
├── SQLite (better-sqlite3)      — all persistent state
└── node-cron                    — overdue detection, scheduled checks
```

No HTTP server. No deployment required. `npm start` runs the bot locally.

---

## 4. Project Structure

```
meetassist/
├── src/
│   ├── index.ts                  — entry point
│   ├── bot/
│   │   ├── app.ts                — Slack Bolt app instance
│   │   ├── commands.ts           — /ma slash command handlers
│   │   ├── actions.ts            — button action handlers
│   │   └── relay.ts              — operator↔participant message relay
│   ├── services/
│   │   ├── meeting.ts            — meeting CRUD, participant management
│   │   ├── nudge.ts              — send nudges, track state
│   │   ├── confluence.ts         — Confluence REST API integration
│   │   └── claude.ts             — Claude API (wired, inactive in phase 1)
│   ├── db/
│   │   ├── client.ts             — better-sqlite3 singleton
│   │   ├── schema.ts             — CREATE TABLE, runs on startup
│   │   └── migrations/           — versioned schema changes
│   ├── scheduler/
│   │   └── cron.ts               — overdue detection, daily digest
│   └── types.ts                  — shared TypeScript interfaces
├── .env
├── package.json
├── tsconfig.json
└── docs/
    └── superpowers/specs/
        └── 2026-05-27-meetassist-design.md
```

---

## 5. Data Model (SQLite)

### users
| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| email | TEXT | |
| slack_user_id | TEXT UNIQUE | |
| display_name | TEXT | |

Populated manually or via Slack `users.list` on first run.

### meetings
| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| title | TEXT | |
| start_time | TEXT | ISO 8601 |
| organizer_user_id | TEXT FK | → users.id |
| purpose | TEXT | |
| document_url | TEXT | Confluence page URL |
| document_title | TEXT | |
| document_action | TEXT | read \| comment \| approve \| provide_input \| confirm_decision |
| confluence_page_id | TEXT | parsed from document_url on creation |
| status | TEXT | draft \| active \| completed |
| created_at | TEXT | ISO 8601 |

### meeting_participants
| column | type | notes |
|---|---|---|
| meeting_id | TEXT FK | → meetings.id |
| user_id | TEXT FK | → users.id |
| role | TEXT | participant \| organizer |
| status | TEXT | pending \| nudge_sent \| replied \| completed \| blocked \| clarification_needed \| overdue |
| reminder_count | INTEGER | default 0 |
| completed_at | TEXT | nullable |

### nudges
| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| user_id | TEXT FK | → users.id |
| meeting_id | TEXT FK | → meetings.id |
| slack_channel_id | TEXT | DM channel ID |
| message_ts | TEXT | Slack message timestamp |
| type | TEXT | pre_meeting \| reminder \| post_meeting \| doc_check |
| sent_at | TEXT | ISO 8601 |

### participant_messages
| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| user_id | TEXT FK | → users.id |
| meeting_id | TEXT FK | → meetings.id |
| nudge_id | TEXT FK | nullable — which nudge triggered this reply |
| raw_text | TEXT | |
| ai_classification | TEXT | nullable — populated in phase 2 |
| created_at | TEXT | ISO 8601 |

### operator_replies
| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| participant_message_id | TEXT FK | → participant_messages.id |
| raw_text | TEXT | |
| sent_at | TEXT | ISO 8601 |

### doc_checks
| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| meeting_id | TEXT FK | → meetings.id |
| checked_at | TEXT | ISO 8601 |
| confluence_version | INTEGER | page version at check time |
| comment_count | INTEGER | |
| summary | TEXT | Claude-generated summary (phase 2) |
| suggested_nudges | TEXT | JSON string — array of suggested messages (phase 2) |

---

## 6. Slack Interaction Layer

### Participant experience

Participants receive DMs from `@Meetassist`. All interaction is DM-only. Example nudge:

```
Meetassist: Tomorrow's Roadmap Review needs your input.

Requested before Thursday 09:00:
☐ Review the proposal
☐ Confirm when done

Document: [Architecture Decision — Q3 Priorities]

[Mark done]  [Need clarification]  [Cannot complete]  [Open document]
```

Button actions:
- **Mark done** → sets participant status to `completed`
- **Need clarification** → sets status to `clarification_needed`, forwards to operator
- **Cannot complete** → sets status to `blocked`, forwards to operator
- **Open document** → sends Confluence URL as a follow-up DM message

Plain text replies are forwarded to the operator's DM.

### Operator experience

Operator interacts with Meetassist via their own DM with the bot. All participant messages are forwarded here:

```
[Meetassist] Incoming from @sarah.jones (Roadmap Review)
> "I've reviewed it but have a question about section 3"

Reply: /ma reply sarah.jones <your message>
```

Doc check result (after `/ma check-doc [id]`):

```
[Meetassist] Doc check: Roadmap Review
Last updated: 2h ago by @tom.h
Comments: 3 total
  ✅ @sarah.jones — "Looks good, approved"
  ❓ @mike.r — "What's the timeline for item 4?" (unanswered)
  ⬜ @anna.k — no comment yet

Participant coverage: 2/5 have engaged with the doc

Suggested nudges:
1. → @mike.r: "Your question about item 4 is noted — [answer or clarify]"
2. → @anna.k: "Reminder to review before Thursday 09:00"

Send nudge 1? [Yes] [Edit] [Skip]
Send nudge 2? [Yes] [Edit] [Skip]
```

---

## 7. Operator Commands

All commands use the `/ma` prefix (shorthand for Meetassist).

| Command | Description |
|---|---|
| `/ma create` | Start a new meeting (guided prompt flow in DM — bot asks for title, date/time, purpose, Confluence URL, participants, document action; each as a separate message) |
| `/ma status [id]` | Show participant completion state for a meeting |
| `/ma send [id]` | Send pre-meeting nudge to all pending participants |
| `/ma remind [id]` | Send reminder to non-completers only |
| `/ma followup [id]` | Send post-meeting follow-up to participants with open items |
| `/ma check-doc [id]` | Fetch Confluence page, surface doc state + suggested nudges |
| `/ma reply [slack-handle] [message]` | Send a message to a participant as the bot |
| `/ma list` | List all active meetings |

---

## 8. Workflow Engine

### Pre-meeting workflow

1. Operator runs `/ma send [id]`
2. Bot fetches all participants with status `pending`
3. Sends nudge DM to each with document link and buttons
4. Records nudge in DB, updates participant status to `nudge_sent`
5. Confirms to operator: "Nudge sent to 7 participants"

Operator runs `/ma remind [id]` for non-completers:
1. Bot fetches participants with status `nudge_sent` or `replied` (not `completed`)
2. Sends reminder DM (shorter, no buttons — plain text reminder with doc link)
3. Increments `reminder_count`, records nudge

### Post-meeting workflow

1. Operator runs `/ma followup [id]`
2. Bot fetches participants with open items (not `completed`)
3. Sends follow-up DM with action requested
4. Records nudge of type `post_meeting`

### Participant state machine

```
pending
  → nudge_sent      (after /ma send)
    → replied        (after any DM reply or button press)
      → completed    (Mark done button or operator marks)
      → blocked      (Cannot complete button)
      → clarification_needed  (Need clarification button)
    → overdue        (cron job, deadline passed without reply)
```

---

## 9. Confluence Integration

**Auth:** Basic auth via Atlassian API token.
```
CONFLUENCE_BASE_URL=https://your-org.atlassian.net
CONFLUENCE_EMAIL=you@org.com
CONFLUENCE_API_TOKEN=your-token
```

**Page ID resolution:** On `/ma create`, operator pastes the full Confluence URL. Bot parses `pageId` from the URL and stores it in `meetings.confluence_page_id`.

**On `/ma check-doc [id]`:**
1. `GET /wiki/rest/api/content/{pageId}?expand=body.storage,version,history` — fetch page content and version
2. `GET /wiki/rest/api/content/{pageId}/child/comment?expand=body.storage,author` — fetch comments
3. Cross-reference commenters against `meeting_participants` to determine who has/hasn't engaged
4. Format and send summary to operator DM
5. Present suggested nudges as interactive buttons (`[Yes] [Edit] [Skip]`)
6. Record check in `doc_checks` table

**Phase 1:** Summary and suggested nudges are formatted by the service layer (rule-based: unanswered comments, participants without comments).
**Phase 2:** Claude generates the summary and drafts the suggested nudge messages.

---

## 10. Claude Integration (Phase 2)

Wired in `src/services/claude.ts` but inactive in phase 1. The service exposes:

```typescript
analyzeDocState(meeting: Meeting, pageContent: string, comments: Comment[]): Promise<DocAnalysis>
classifyReply(message: string, context: MeetingContext): Promise<ReplyClassification>
draftReply(incomingMessage: string, context: MeetingContext): Promise<string>
```

Uses `@anthropic-ai/sdk` with the local Claude CLI credentials. Activated by setting `CLAUDE_ENABLED=true` in `.env`.

---

## 11. Scheduler

`node-cron` runs two jobs:

- **Overdue check** (every hour): finds `nudge_sent` participants past the meeting `start_time`, marks them `overdue`, forwards list to operator DM
- **Daily digest** (08:00 daily): sends operator a summary of all active meetings and their participant completion states

---

## 12. Environment Variables

```
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
OPERATOR_SLACK_ID=U...       # Your Slack user ID

# Confluence
CONFLUENCE_BASE_URL=https://your-org.atlassian.net
CONFLUENCE_EMAIL=you@org.com
CONFLUENCE_API_TOKEN=...

# Claude (phase 2)
CLAUDE_ENABLED=false
ANTHROPIC_API_KEY=...        # Optional if using local CLI auth

# DB
DB_PATH=./meetassist.db
```

---

## 13. Participant State Tracking

The system tracks per participant per meeting:
- `nudge_sent` — bot has messaged them
- `replied` — they have sent any message or pressed a button
- `completed` — they confirmed done
- `blocked` — they cannot complete
- `clarification_needed` — they need more info
- `overdue` — deadline passed with no completion

The operator sees this via `/ma status [id]`.

---

## 14. Success Metrics (Research)

- Preparation completion rate (% `completed` before meeting start)
- Time-to-completion from first nudge
- Reminder count before completion
- Number of unresolved blockers at meeting time
- Operator effort per meeting (messages sent, doc checks run)
- Participant sentiment (qualitative, from replies)

---

## 15. Phase Roadmap

**Phase 1 (this build):**
- Slack bot with Socket Mode
- SQLite persistence
- Operator DM relay
- `/ma` command set
- Pre/post-meeting nudge workflows
- Confluence REST integration (rule-based summary)
- Participant state machine

**Phase 2:**
- Claude doc analysis and reply classification
- Claude-drafted nudge suggestions
- `/ma suggest` — Claude drafts a reply to a participant message

**Phase 3 (future):**
- Calendar polling (Google/Microsoft)
- Multi-document meetings
- Confluence comment writing via API
- Recurring meeting memory
- Aggregate insights across meetings
