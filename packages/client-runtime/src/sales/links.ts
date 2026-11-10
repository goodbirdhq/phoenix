/**
 * A link the engine handed over, kept only when it is a well-formed https URL. Anything else
 * (another scheme, such as `javascript:` or `data:`, or text that is not a URL) never becomes a
 * link.
 */
export const safeHttpsUrl = (value: string | null): string | null =>
  value !== null && value.startsWith("https://") && URL.canParse(value) ? value : null;
