/**
 * Determines whether Ask LexiBite should present an answer as a manager brief.
 *
 * Broad synthesis requests get the executive/card presentation; focused
 * questions remain normal conversational answers so the UI does not turn
 * every response into a management report.
 */
export function shouldRenderManagerBrief(message: string): boolean {
  const value = message.trim().toLowerCase();
  if (!value) return false;

  return (
    /\bmanager(?:'s)?\s+(?:brief|summary|overview)\b/.test(value) ||
    /\bexecutive\s+(?:brief|summary|overview)\b/.test(value) ||
    /\bwhat\s+(?:should|needs? to)\s+(?:the\s+)?manager\s+(?:pay attention to|focus on|know)\b/.test(value) ||
    /\bwhat\s+(?:needs?|requires?)\s+(?:my|the manager(?:'s)?)\s+attention\b/.test(value) ||
    /\b(?:top|main|key)\s+priorit(?:y|ies)\b/.test(value) ||
    /\bwhat\s+should\s+i\s+focus\s+on\s+(?:right now|today|now)\b/.test(value) ||
    /\bsummar(?:ize|ise)\s+(?:what\s+)?(?:needs?|requires?)\s+attention\b/.test(value) ||
    /\bwhat\s+should\s+(?:a|the|my)\s+manager\s+(?:know|see|understand)\s+about\b/.test(value) ||
    /\bwhat\s+(?:is|has\s+been|happened)\s+with\s+(?:the\s+)?(?:kitchen|inventory|purchasing|sales|menu|food\s+cost|service)\b/.test(value)
  );
}
