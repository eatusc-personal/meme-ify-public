// Browser-side client for the optional local Claude CLI risk review. The
// bridge is disabled by default and must be enabled explicitly in .env.local.

export type GenerateResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

const MEMECOIN_REVIEW_SYSTEM_PROMPT = `You are a blunt risk reviewer for a Solana memecoin paper-trading bot. The user is preparing to trade real money and wants their rules and recent results audited.

Assume these base rates: most newly launched tokens fail or are manipulated. The bot's stop-loss is sampled periodically, not continuously, so a realized loss can exceed the configured stop percent.

Review the configuration and performance you are given. Flag rules that are unsafe, internally contradictory, or likely to lose money. Be specific: reference the actual numbers. Lead with the most important issues. Do not hedge, do not pad, no preamble, no closing remarks. Use a short tight list. No emojis.`;

export async function aiReview(prompt: string): Promise<GenerateResult> {
  try {
    const res = await fetch("/api/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, systemPrompt: MEMECOIN_REVIEW_SYSTEM_PROMPT })
    });
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.error ?? "Unknown error" };
    return { ok: true, text: data.text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${message}` };
  }
}
