// Browser-side client for Serper (Google SERP API), called through the Vite
// middleware at /api/serper/search so the API key stays server-side (.env.local).

export type SerperOrganicResult = {
  title: string;
  link: string;
  snippet: string;
  date?: string;
  position: number;
};

export type SerperSearchResponse = {
  searchParameters: { q: string; num?: number; tbs?: string };
  organic: SerperOrganicResult[];
  credits?: number;
};

export type SerperSearchOptions = {
  query: string;
  numResults?: number;
  timeRange?: "day" | "week" | "month" | "year";
  country?: string;
  language?: string;
};

export type SerperResult =
  | { ok: true; data: SerperSearchResponse }
  | { ok: false; error: string };

const TIME_RANGE_TO_TBS: Record<NonNullable<SerperSearchOptions["timeRange"]>, string> = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y"
};

export async function serperSearch(opts: SerperSearchOptions): Promise<SerperResult> {
  try {
    const body: Record<string, unknown> = {
      q: opts.query,
      num: opts.numResults ?? 8
    };
    if (opts.timeRange) body.tbs = TIME_RANGE_TO_TBS[opts.timeRange];
    if (opts.country) body.gl = opts.country;
    if (opts.language) body.hl = opts.language;
    const res = await fetch("/api/serper/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Serper HTTP ${res.status}: ${text.slice(0, 300)}` };
    }
    const data = (await res.json()) as SerperSearchResponse;
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${message}` };
  }
}

export function searchSerperReddit(
  query: string,
  opts?: { subreddit?: string; numResults?: number; timeRange?: SerperSearchOptions["timeRange"] }
): Promise<SerperResult> {
  const site = opts?.subreddit ? `site:reddit.com/r/${opts.subreddit}` : "site:reddit.com";
  return serperSearch({
    query: `${site} ${query}`,
    numResults: opts?.numResults ?? 8,
    timeRange: opts?.timeRange ?? "month"
  });
}
