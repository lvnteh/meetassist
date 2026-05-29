export function getOperatorIds(): string[] {
  const primary = process.env.OPERATOR_SLACK_IDS ?? '';
  const raw = primary.trim() !== '' ? primary : (process.env.OPERATOR_SLACK_ID ?? '');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function isOperator(slackUserId: string): boolean {
  return getOperatorIds().includes(slackUserId);
}
