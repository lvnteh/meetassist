import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isOperator, getOperatorIds } from '../../src/bot/roles';

describe('roles', () => {
  const original = process.env.OPERATOR_SLACK_IDS;
  afterEach(() => {
    process.env.OPERATOR_SLACK_IDS = original;
  });

  it('isOperator returns true for ID in OPERATOR_SLACK_IDS', () => {
    process.env.OPERATOR_SLACK_IDS = 'U001,U002,U003';
    expect(isOperator('U002')).toBe(true);
  });

  it('isOperator returns false for ID not in OPERATOR_SLACK_IDS', () => {
    process.env.OPERATOR_SLACK_IDS = 'U001,U002';
    expect(isOperator('U999')).toBe(false);
  });

  it('isOperator handles whitespace in env var', () => {
    process.env.OPERATOR_SLACK_IDS = ' U001 , U002 , U003 ';
    expect(isOperator('U002')).toBe(true);
  });

  it('isOperator handles empty env var', () => {
    process.env.OPERATOR_SLACK_IDS = '';
    expect(isOperator('U001')).toBe(false);
  });

  it('getOperatorIds returns trimmed array', () => {
    process.env.OPERATOR_SLACK_IDS = 'U001, U002 ,U003';
    expect(getOperatorIds()).toEqual(['U001', 'U002', 'U003']);
  });

  it('getOperatorIds falls back to OPERATOR_SLACK_ID', () => {
    process.env.OPERATOR_SLACK_IDS = '';
    process.env.OPERATOR_SLACK_ID = 'U_LEGACY';
    expect(getOperatorIds()).toEqual(['U_LEGACY']);
    delete process.env.OPERATOR_SLACK_ID;
  });
});
