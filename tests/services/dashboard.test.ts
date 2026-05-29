import { describe, it, expect } from 'vitest';
import { relativeTime, escapeXml, humaniseStatus, humaniseAction } from '../../src/services/dashboard';

describe('relativeTime', () => {
  const now = new Date('2026-05-29T10:00:00Z');

  it('returns "just now" for under 60 seconds', () => {
    expect(relativeTime(new Date('2026-05-29T09:59:30Z'), now)).toBe('just now');
  });

  it('returns "Xm ago" for minutes', () => {
    expect(relativeTime(new Date('2026-05-29T09:55:00Z'), now)).toBe('5m ago');
  });

  it('returns "Xh ago" for hours', () => {
    expect(relativeTime(new Date('2026-05-29T08:30:00Z'), now)).toBe('1h ago');
    expect(relativeTime(new Date('2026-05-29T07:00:00Z'), now)).toBe('3h ago');
  });

  it('returns "Xd ago" for days', () => {
    expect(relativeTime(new Date('2026-05-28T10:00:00Z'), now)).toBe('1d ago');
    expect(relativeTime(new Date('2026-05-26T10:00:00Z'), now)).toBe('3d ago');
  });

  it('returns "Xw ago" for weeks', () => {
    expect(relativeTime(new Date('2026-05-22T10:00:00Z'), now)).toBe('1w ago');
  });
});

describe('escapeXml', () => {
  it('escapes <, >, &, ", and \'', () => {
    expect(escapeXml(`<script>alert("x" & 'y')</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot; &amp; &apos;y&apos;)&lt;/script&gt;'
    );
  });

  it('returns empty string for null or undefined', () => {
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(undefined)).toBe('');
  });
});

describe('humaniseStatus', () => {
  it('maps every known participant status', () => {
    expect(humaniseStatus('pending')).toBe('waiting for nudge');
    expect(humaniseStatus('nudge_sent')).toBe('nudge sent');
    expect(humaniseStatus('replied')).toBe('replied');
    expect(humaniseStatus('clarification_needed')).toBe('clarification asked');
    expect(humaniseStatus('blocked')).toBe('blocked');
    expect(humaniseStatus('overdue')).toBe('overdue');
    expect(humaniseStatus('completed')).toBe('done');
  });

  it('falls back to the raw value for unknown status', () => {
    expect(humaniseStatus('weird_state' as any)).toBe('weird_state');
  });
});

describe('humaniseAction', () => {
  it('maps known document actions', () => {
    expect(humaniseAction('read')).toBe('read');
    expect(humaniseAction('comment')).toBe('comment');
    expect(humaniseAction('approve')).toBe('approve');
    expect(humaniseAction('provide_input')).toBe('provide input');
    expect(humaniseAction('confirm_decision')).toBe('confirm decision');
  });

  it('falls back to the raw value for unknown action', () => {
    expect(humaniseAction('weird_action' as any)).toBe('weird_action');
  });
});
