/**
 * Replaces anything that looks like an API key (even partly masked, as some providers echo it in
 * error messages) with "[redacted]". Applied before a provider error is stored in History, and
 * again before display.
 */
export function redactSecrets(text: string): string {
  return (
    text
      .replace(
        /\b(?:sk|gsk|pk|rk|xai|key)[-_][A-Za-z0-9_\-*.]{6,}/gi,
        "[redacted]",
      )
      // Google keys: "AIza…" (API keys) and "AQ.…" (Gemini keys).
      .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
      .replace(/\bAQ\.[0-9A-Za-z_-]{20,}/g, "[redacted]")
      // Authorization headers echoed back ("Token …" for Deepgram, "Bearer …").
      .replace(/\b(Token|Bearer)\s+[A-Za-z0-9._\-*]{16,}/gi, "$1 [redacted]")
      // Deepgram keys are 40 hexadecimal characters with no prefix.
      .replace(/\b[a-f0-9]{40}\b/gi, "[redacted]")
  );
}
