// Browser-side client for Tavily web search, called through the Vite middleware
// at /api/tavily/* so the API key stays server-side (.env.local, TAVILY_API_KEY).

export type TavilyResult = {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string;
};

export type TavilySearchResponse = {
  query: string;
  answer: string | null;
  results: TavilyResult[];
  response_time: number;
  request_id: string;
  usage?: { credits: number };
};

export type SearchOptions = {
  query: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  topic?: "general" | "news";
  timeRange?: "day" | "week" | "month" | "year";
  startDate?: string;
  endDate?: string;
  includeAnswer?: boolean;
};

export type SearchResult =
  | { ok: true; data: TavilySearchResponse }
  | { ok: false; error: string };

export async function tavilySearch(opts: SearchOptions): Promise<SearchResult> {
  try {
    const res = await fetch("/api/tavily/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: opts.query,
        include_domains: opts.includeDomains ?? [],
        exclude_domains: opts.excludeDomains ?? [],
        max_results: opts.maxResults ?? 8,
        search_depth: opts.searchDepth ?? "basic",
        topic: opts.topic ?? "general",
        time_range: opts.timeRange,
        start_date: opts.startDate,
        end_date: opts.endDate,
        include_answer: opts.includeAnswer ?? false,
        include_usage: true
      })
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Tavily HTTP ${res.status}: ${text.slice(0, 300)}` };
    }
    const data = (await res.json()) as TavilySearchResponse;
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${message}` };
  }
}

export function searchReddit(
  query: string,
  opts?: Partial<Omit<SearchOptions, "query" | "includeDomains">> & { subreddit?: string }
): Promise<SearchResult> {
  const domain = opts?.subreddit ? `reddit.com/r/${opts.subreddit}` : "reddit.com";
  return tavilySearch({
    query,
    includeDomains: [domain],
    maxResults: opts?.maxResults ?? 8,
    searchDepth: opts?.searchDepth ?? "basic",
    timeRange: opts?.timeRange ?? "year",
    includeAnswer: opts?.includeAnswer ?? false
  });
}

export type ExtractResult =
  | {
      ok: true;
      data: {
        url: string;
        title?: string;
        raw_content: string;
      };
    }
  | { ok: false; error: string };

export async function tavilyExtract(url: string): Promise<ExtractResult> {
  try {
    const res = await fetch("/api/tavily/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urls: [url],
        format: "markdown",
        extract_depth: "advanced"
      })
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Tavily extract HTTP ${res.status}: ${text.slice(0, 300)}` };
    }
    const data = await res.json();
    const first = data.results?.[0];
    if (!first) {
      const fail = data.failed_results?.[0];
      return { ok: false, error: fail?.error ?? "No content extracted" };
    }
    return { ok: true, data: first };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${message}` };
  }
}
