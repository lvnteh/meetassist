import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isOperator, getOperatorIds } from '../../src/bot/roles';

describe('roles', () => {
  const originalIds = process.env.OPERATOR_SLACK_IDS;
  const originalLegacy = process.env.OPERATOR_SLACK_ID;

  beforeEach(() => {
    delete process.env.OPERATOR_SLACK_IDS;
    delete process.env.OPERATOR_SLACK_ID;
  });

  afterEach(() => {
    if (originalIds === undefined) delete process.env.OPERATOR_SLACK_IDS;
    else process.env.OPERATOR_SLACK_IDS = originalIds;
    if (originalLegacy === undefined) delete process.env.OPERATOR_SLACK_ID;
    else process.env.OPERATOR_SLACK_ID = originalLegacy;
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

  it('getOperatorIds falls back to OPERATOR_SLACK_ID when primary is empty', () => {
    process.env.OPERATOR_SLACK_IDS = '';
    process.env.OPERATOR_SLACK_ID = 'U_LEGACY';
    expect(getOperatorIds()).toEqual(['U_LEGACY']);
  });

  it('getOperatorIds falls back to OPERATOR_SLACK_ID when primary is whitespace', () => {
    process.env.OPERATOR_SLACK_IDS = '   ';
    process.env.OPERATOR_SLACK_ID = 'U_LEGACY';
    expect(getOperatorIds()).toEqual(['U_LEGACY']);
  });
});
