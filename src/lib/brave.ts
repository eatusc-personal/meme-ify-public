// Browser-side client for Brave Search API, called through the Vite
// middleware at /api/brave/search so the API key stays server-side
// (.env.local, BRAVE_API_KEY). Brave is the first-tier search provider for
// both the Reddit thread finder and the meme-coin social chatter check
// because its free tier (2000/month) is double Tavily's and the per-call
// cost on the paid tier is significantly lower. Tavily and Serper stay as
// the cascading fallbacks; see checkSocialChatter in src/lib/markets.ts
// and findAndDraft in src/App.tsx for the three-tier chain.

export type BraveOrganicResult = {
  title: string;
  url: string;
  description: string;
  age?: string;
  page_age?: string;
};

export type BraveSearchResponse = {
  query?: { original?: string };
  web?: {
    results?: BraveOrganicResult[];
  };
};

export type BraveSearchOptions = {
  query: string;
  // Number of web results. Brave caps at 20 for web search on free tier.
  count?: number;
  // freshness: "pd" (past day), "pw" (past week), "pm" (past month),
  // "py" (past year). Brave's free tier supports these; we translate the
  // generic timeRange the rest of the code uses into this format.
  timeRange?: "day" | "week" | "month" | "year";
  // ISO 3166-1 alpha-2 country code (e.g. "us"). Optional.
  country?: string;
};

export type BraveResult =
  | { ok: true; data: BraveSearchResponse }
  | { ok: false; error: string };

const TIME_RANGE_TO_FRESHNESS: Record<NonNullable<BraveSearchOptions["timeRange"]>, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py"
};

export async function braveSearch(opts: BraveSearchOptions): Promise<BraveResult> {
  try {
    const body: Record<string, unknown> = {
      q: opts.query,
      count: opts.count ?? 10
    };
    if (opts.timeRange) body.freshness = TIME_RANGE_TO_FRESHNESS[opts.timeRange];
    if (opts.country) body.country = opts.country;
    const res = await fetch("/api/brave/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Brave HTTP ${res.status}: ${text.slice(0, 300)}` };
    }
    const data = (await res.json()) as BraveSearchResponse;
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${message}` };
  }
}

// Reddit-scoped search via the `site:` operator. Brave honors this operator
// just like Google does. Mirrors searchSerperReddit's interface so callers
// can swap providers without re-keying option names.
export function searchBraveReddit(
  query: string,
  opts?: { subreddit?: string; numResults?: number; timeRange?: BraveSearchOptions["timeRange"] }
): Promise<BraveResult> {
  const site = opts?.subreddit ? `site:reddit.com/r/${opts.subreddit}` : "site:reddit.com";
  return braveSearch({
    query: `${site} ${query}`,
    count: opts?.numResults ?? 10,
    timeRange: opts?.timeRange ?? "month"
  });
}
