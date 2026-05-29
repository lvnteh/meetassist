# Action Context Note — Design Spec

**Status:** Design approved 2026-05-29 (revised after spec review)
**Builds on:** `docs/specs/meetassist-v1.md` + `docs/superpowers/specs/2026-05-29-action-verification-design.md`

> **Goal:** Surface the existing `meetings.purpose` field to participants in their nudges, in the verification follow-up nudge, and on the Confluence dashboard. Allow operators to edit it via `/ma set-action`.

---

## 1. Overview

Today the participant nudge tells them *to comment* but not *what to comment on*. The participant has to open the doc and guess.

A `meetings.purpose` column already exists, is `NOT NULL`, and is captured during `/ma create` ("What is the meeting purpose?"). It's never displayed to participants and can't be edited after creation. This spec fixes that:

1. Render `purpose` in the participant nudge as a second sentence between the intro and the requested checklist.
2. Render `purpose` in the verification follow-up nudge as "The ask was: …".
3. Show `purpose` on the Confluence dashboard under each meeting heading.
4. Let the operator update `purpose` via `/ma set-action <id> <action> [purpose...]`.
5. Cap `purpose` at 280 characters at write time (existing rows are honoured as-is).

We use the existing column rather than adding a new one — the schema already says what we need.

---

## 2. Data Model

### No new column

The `meetings.purpose` column already exists (`TEXT NOT NULL`, set at insert time). No migration.

### Length cap

280 chars. Enforced at write time only:
- `/ma create`: if the operator's answer is longer, the bot replies *"Meetassist: That's longer than 280 characters. Try again."* and re-prompts. Cannot be skipped (the field is `NOT NULL` today; we keep that contract).
- `/ma set-action`: if the trailing text is longer, reject the whole command with the same error. Atomic: neither action nor purpose changes.

The DB column stays `TEXT` with no DB-level length check. The cap is a UX choice in the application layer.

Existing rows that already exceed 280 chars (unlikely — operators have been typing short purposes by hand) are read and rendered as-is. The cap only applies to new writes.

### Type

The `Meeting` interface in `src/types.ts` already has `purpose: string`. No change needed.

---

## 3. Operator Flow

### `/ma create`

The existing flow already prompts for `purpose` ("What is the meeting purpose?"). Two changes:

- **Prompt wording.** Update to *"What's the ask for participants? They'll see this in their nudge. (Max 280 chars.)"*. Today's "What is the meeting purpose?" is operator-internal; the new wording reminds the operator that participants will read it.
- **Length validation.** If the answer exceeds 280 chars, reply with the length error and re-prompt without advancing the step.

No other create-flow changes. Field remains required (NOT NULL).

### `/ma set-action`

Current syntax: `/ma set-action <id> <action>`
New syntax: `/ma set-action <id> <action> [purpose...]`

Parsing:
- Tokens 1 and 2 (`<id>` and `<action>`) parse as today.
- Everything after token 2, joined with spaces and trimmed, is the new `purpose`.
- If the joined trailing text is **empty** → keep the existing purpose unchanged. (Clearing requires explicit syntax — out of scope.)
- If the joined trailing text is > 280 chars → reject the whole command with the length error. Action is NOT updated.

Examples:
- `/ma set-action abc123 comment Please review the migration plan` → action = `comment`, purpose = `Please review the migration plan`.
- `/ma set-action abc123 approve` → action = `approve`, purpose unchanged.
- `/ma set-action abc123 comment <300-char string>` → ephemeral error; meeting unchanged.

The existing behaviour of resetting all participants to `pending` after `set-action` is preserved.

### Confirmation message

The `/ma set-action` ephemeral confirmation is updated:

- Purpose was provided: `Meetassist: Action updated to \`comment\`. Purpose: "Please review the migration plan". All participants reset to pending.`
- Purpose was omitted (kept as-is): `Meetassist: Action updated to \`comment\`. Purpose unchanged. All participants reset to pending.`

(Today's wording — without the purpose phrase — is replaced.)

---

## 4. Participant-facing Rendering

### Pre-meeting nudge (`src/services/nudge.ts`)

Current block layout:
```
*Meetassist:* <Title> needs your async input before *<Date>*.

Requested:
☐ <action>
☐ Confirm when done

*Document:* <link>
```

New layout — `purpose` is required (NOT NULL) so it always renders:
```
*Meetassist:* <Title> needs your async input before *<Date>*.

<purpose>

Requested:
☐ <action>
☐ Confirm when done

*Document:* <link>
```

The purpose goes in its own `section` block between the intro and the requested checklist. Plain mrkdwn, no label — the operator's words speak for themselves.

The fallback `text` field gets the same insertion: `\n\n<purpose>` between the intro and the `Requested:` line.

### Verification follow-up nudge (`src/services/verification.ts`)

`handleVerificationNudgeYes` currently posts:

```
Meetassist: Just checking — your action for *<Title>* was to <action>, but I don't see it on the doc yet. Could you take a moment to follow up?
<URL>
```

New layout — insert the purpose as a labelled second paragraph:

```
Meetassist: Just checking — your action for *<Title>* was to <action>, but I don't see it on the doc yet. Could you take a moment to follow up?

The ask was: <purpose>

<URL>
```

### Other nudges

`/ma remind` and `/ma follow-up` reuse the `nudge.ts` template, so they inherit the change automatically. No separate work.

### Escaping

Pass `purpose` through `escapeForSlack` (existing helper in `verification.ts`) before interpolating into mrkdwn. To use it from `nudge.ts`, either export `escapeForSlack` from `verification.ts` or inline the same three-character replacement (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`). Prefer exporting; one source of truth.

---

## 5. Dashboard Rendering (`src/services/dashboard.ts`)

The current per-meeting heading:
```html
<h2><Title></h2>
<p><Start time> · <id prefix></p>
<p>Document: <link></p>
<p>Action requested: <action></p>
<p>Progress: X/Y done</p>
```

New layout — add a `Purpose` line between `Action requested` and `Progress`:
```html
<h2><Title></h2>
<p><Start time> · <id prefix></p>
<p>Document: <link></p>
<p>Action requested: <action></p>
<p>Purpose: <purpose></p>
<p>Progress: X/Y done</p>
```

Pass `purpose` through `escapeXml` (existing helper) before inserting. Truncate to 200 chars with `…` on the dashboard only — the participant DM still gets the full text. Truncation: `value.length > 200 ? value.slice(0, 199) + '…' : value`.

The `DashboardMeeting` interface in `dashboard.ts` gains:
```typescript
purpose: string;
```

`publishDashboard` populates it from the meeting object (already loaded by `listActive`).

---

## 6. Service Layer Changes

### `src/services/meeting.ts`

- New method signature: `updateAction(id: string, action: DocumentAction, purpose?: string): Promise<void>`. Today the signature is `updateAction(id, action)`. If `purpose === undefined`, only update the action column. If `purpose` is a string, update both columns in one statement. The caller (`/ma set-action`) passes `undefined` when the operator omitted trailing text, a string otherwise.

  Implementation:
  ```typescript
  async updateAction(id: string, action: DocumentAction, purpose?: string): Promise<void> {
    if (purpose === undefined) {
      await this.pool.query(
        `UPDATE meetings SET document_action = $1 WHERE id = $2`,
        [action, id]
      );
    } else {
      await this.pool.query(
        `UPDATE meetings SET document_action = $1, purpose = $2 WHERE id = $3`,
        [action, purpose, id]
      );
    }
  }
  ```

- `createMeeting` is unchanged. Existing signature already accepts `purpose`.
- `getById`, `listActive`, `getParticipantsWithUsers` already `SELECT *`, so `purpose` flows through automatically.

### `src/services/nudge.ts`

In the function that builds the initial nudge, read `meeting.purpose`, pass through escape, splice into both the `text` fallback and the `blocks` array as described in §4.

### `src/services/verification.ts`

In `handleVerificationNudgeYes`, after fetching the meeting, splice in the "The ask was: …" paragraph using `escapeForSlack(meeting.purpose)`.

Export `escapeForSlack` so `nudge.ts` can use it. (Today it's a private helper.)

---

## 7. Testing

All tests live in `tests/` mirroring the source layout. Use Vitest (`npm test -- --run`).

### `tests/services/meeting.test.ts`

- `updateAction(id, action)` (no purpose) → only action column changes; purpose untouched.
- `updateAction(id, action, 'new purpose')` → both updated.
- `updateAction(id, action, '')` → action updated, purpose set to empty string. (We never call this in the new code path, but the method should behave predictably.)

### `tests/services/nudge.test.ts` (extend; create file if missing)

- The rendered nudge `text` and `blocks` both contain the meeting's `purpose` between intro and requested checklist.
- Special characters (`&`, `<`, `>`) in purpose are escaped.

### `tests/services/verification.test.ts`

Extend `handleVerificationNudgeYes` tests:
- The follow-up DM text contains `The ask was: <purpose>`.
- Special characters in purpose are escaped.

### `tests/services/dashboard.test.ts`

- `renderDashboardBody` output contains `<p>Purpose: <purpose></p>` under each meeting.
- Long purpose (>200 chars) is truncated with `…` on the dashboard.
- HTML/XML special chars escaped.

### `tests/bot/commands.test.ts` (create or extend)

- `/ma set-action <id> <action>` (no trailing text) → action updated, purpose kept.
- `/ma set-action <id> <action> some purpose here` → action and purpose both updated.
- `/ma set-action <id> <action> <300-char string>` → ephemeral error, no DB write.

### Manual smoke

1. `/ma create`, answer all prompts. Type a purpose like *"Decide whether to adopt the new template format"*.
2. `/ma send <id>` to a test participant.
3. Verify the DM contains the purpose as a second paragraph between the intro and the requested checklist.
4. Verify the Confluence dashboard shows `Purpose: …` under the meeting heading.
5. `/ma set-action <id> approve` (no trailing text) → purpose unchanged on the dashboard.
6. `/ma set-action <id> approve New purpose for the approval round` → purpose updated, all participants reset to pending.
7. Trigger the verification flow (mark done without commenting) → verify the verification follow-up DM includes `The ask was: New purpose for the approval round`.

---

## 8. Out of Scope

- **Per-participant purpose.** Same purpose for everyone on the meeting.
- **Markdown formatting in purpose.** Plain text only. Slack auto-links URLs; we don't escape those. Markdown pasted by the operator renders raw.
- **Editing purpose without changing action.** `/ma set-action` is the only edit path. A future `/ma set-purpose <id> <text>` could be cleaner, but for now reuse the existing command.
- **Clearing purpose to empty.** No syntax for clearing once set. Operators can overwrite with new text.
- **Localisation.** All strings in English.

---

## 9. Migration & Rollout

- **No DB migration.** The column already exists.
- No new env vars.
- Existing meetings already have a `purpose` value (NOT NULL since day one) — they will start showing it in nudges and on the dashboard immediately on deploy. Spot-check a few existing meetings before rollout to confirm none have garbage / placeholder purposes that would embarrass us when surfaced to participants.
- Deploy: code-only.
