/**
 * Meeting-summary consent is per AI service and has its own list: a transcript holds other
 * people's words. The page names the service it showed; if the setting moved on since, nothing
 * is granted (the page refetches and asks again).
 */
export function grantSummaryConsent(
  shown: string,
  current: { provider: string; consent: readonly string[] },
): string[] {
  if (shown !== current.provider)
    throw new Error("The AI service changed. Check it and try again.");
  return current.consent.includes(shown)
    ? [...current.consent]
    : [...current.consent, shown];
}
