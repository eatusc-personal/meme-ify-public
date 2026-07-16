import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import WebSocket from "ws";
// Pure decision functions, isomorphic (only type imports across modules) so
// they're safe to import into the Node-side vite config alongside the browser
// bundle. Used by positionWatchSchedulerPlugin to evaluate watch ticks server-
// side without any React state.
import { evaluatePositionWatch, decideSellIntents, watchAdvisoryAlerts } from "./src/lib/paper";
import { liveWatchAlerts } from "./src/lib/live";
// scanMemecoins is DexScreener-only (the paid brave/serper/tavily calls live in
// checkSocialChatter, which it never calls), so it's safe and free to run on a
// server timer. setMarketsApiBase points its relative /api/* fetches at the dev
// server's own loopback so they reuse the existing proxy middleware.
import { scanMemecoins, setMarketsApiBase } from "./src/lib/markets";
import type { ScanResult } from "./src/lib/markets";
// RugCheck-only screen (free, keyless) to keep shady/rug-pull coins out of the
// new-coin alerts. Runs per qualifying candidate; see scanSchedulerPlugin.
import { screenRugCheck, setSafetyApiBase } from "./src/lib/safety";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// API usage logger. Module-level singleton pool, lazily initialized on first
// call. Plugins for metered upstreams (Tavily, Serper) call logApiUsage()
// after each request to populate the m_api_usage table; the in-app rate-limit
// banner reads from there. Failures inside the logger are swallowed — we
// never want a logging hiccup to break the actual proxied request.
// ---------------------------------------------------------------------------
let usagePool: InstanceType<typeof Pool> | undefined;
function getUsagePool(databaseUrl: string): InstanceType<typeof Pool> {
  if (!usagePool) usagePool = new Pool({ connectionString: databaseUrl });
  return usagePool;
}
async function logApiUsage(
  databaseUrl: string | undefined,
  provider: string,
  endpoint: string,
  statusCode: number,
  ok: boolean
): Promise<void> {
  if (!databaseUrl) return;
  try {
    await getUsagePool(databaseUrl).query(
      `insert into m_api_usage (provider, endpoint, status_code, ok) values ($1,$2,$3,$4)`,
      [provider, endpoint, statusCode, ok]
    );
  } catch {
    /* logging is best-effort; never fail the real request because logging broke */
  }
}

// Free-tier monthly caps for the in-app rate-limit banner. Update these if
// you upgrade to a paid tier. Used by the /api/usage/summary endpoint and
// nowhere else in the build; the proxies themselves don't enforce a cap.
const API_MONTHLY_CAPS: Record<string, number> = {
  brave: 2000,
  tavily: 1000,
  serper: 2500
};

// Every backend capability in this project is intended for a single-user,
// loopback-only process. This guard also runs under `vite preview`.
function localOnlyPlugin(): Plugin {
  return {
    name: "loopback-only-guard",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const host = (req.headers.host ?? "").toLowerCase();
        const loopbackHost =
          host === "localhost" ||
          host.startsWith("localhost:") ||
          host === "127.0.0.1" ||
          host.startsWith("127.0.0.1:") ||
          host === "[::1]" ||
          host.startsWith("[::1]:");
        if (!loopbackHost) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "meme-ify is loopback-only" }));
          return;
        }
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Frame-Options", "DENY");
        next();
      });
    }
  };
}

// The local API is Vite middleware. Reuse each middleware hook for preview so
// a built app exercises the API instead of receiving index.html for /api/*.
function withPreviewSupport(plugin: Plugin): Plugin {
  if (typeof plugin.configureServer !== "function") return plugin;
  return {
    ...plugin,
    configurePreviewServer: plugin.configureServer as Plugin["configurePreviewServer"]
  };
}

function claudeCliPlugin(enabled: boolean): Plugin {
  return {
    name: "claude-cli-bridge",
    configureServer(server) {
      server.middlewares.use("/api/claude", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        if (!enabled) {
          res.statusCode = 403;
          res.end(
            JSON.stringify({
              ok: false,
              error: "Local Claude review is disabled. Set ENABLE_LOCAL_CLAUDE=true to opt in."
            })
          );
          return;
        }
        let body = "";
        let bodyBytes = 0;
        let tooLarge = false;
        req.on("data", (chunk) => {
          if (tooLarge) return;
          bodyBytes += Buffer.byteLength(chunk);
          if (bodyBytes > 128 * 1024) {
            tooLarge = true;
            res.statusCode = 413;
            res.end(JSON.stringify({ ok: false, error: "Request body exceeds 128 KiB" }));
            return;
          }
          body += chunk;
        });
        req.on("end", () => {
          if (tooLarge) return;
          let payload: { prompt?: string; systemPrompt?: string };
          try {
            payload = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
            return;
          }
          if (!payload.prompt) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "Missing 'prompt' field" }));
            return;
          }
          const args = ["--print"];
          if (payload.systemPrompt) {
            args.push("--append-system-prompt", payload.systemPrompt);
          }
          args.push(payload.prompt);
          let stdout = "";
          let stderr = "";
          const proc = spawn("claude", args, {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"]
          });
          proc.stdout.on("data", (d: Buffer) => {
            stdout += d.toString();
          });
          proc.stderr.on("data", (d: Buffer) => {
            stderr += d.toString();
          });
          // Kill a hung CLI so the request cannot hang open forever. The kill
          // surfaces as a non-zero close code, i.e. a normal error response.
          const killer = setTimeout(() => proc.kill("SIGKILL"), 120000);
          proc.on("close", (code) => {
            clearTimeout(killer);
            if (code !== 0) {
              res.statusCode = 500;
              res.end(
                JSON.stringify({
                  ok: false,
                  error: `claude CLI exited with code ${code}: ${stderr.slice(0, 600) || "no stderr"}`
                })
              );
              return;
            }
            res.end(JSON.stringify({ ok: true, text: stdout.trim() }));
          });
          proc.on("error", (err) => {
            clearTimeout(killer);
            res.statusCode = 500;
            res.end(
              JSON.stringify({
                ok: false,
                error: `Failed to spawn claude CLI: ${err.message}. Is the 'claude' binary on PATH?`
              })
            );
          });
        });
      });
    }
  };
}

function tavilyPlugin(apiKey: string | undefined, databaseUrl: string | undefined): Plugin {
  return {
    name: "tavily-bridge",
    configureServer(server) {
      const handle = (path: string, upstream: string) =>
        server.middlewares.use(path, (req, res, next) => {
          if (req.method !== "POST") {
            next();
            return;
          }
          res.setHeader("Content-Type", "application/json");
          if (!apiKey) {
            res.statusCode = 500;
            res.end(
              JSON.stringify({
                ok: false,
                error: "TAVILY_API_KEY is not set in .env.local. Restart dev server after adding it."
              })
            );
            return;
          }
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", async () => {
            try {
              const upstreamRes = await fetch(upstream, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${apiKey}`
                },
                body
              });
              const text = await upstreamRes.text();
              res.statusCode = upstreamRes.status;
              res.end(text);
              // Log usage. Status 200 = ok; 4xx/5xx = ok=false. The 432 rate-
              // limit response shows up here as ok=false, which is what the
              // banner uses to know we're at our cap.
              void logApiUsage(databaseUrl, "tavily", path, upstreamRes.status, upstreamRes.ok);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              res.statusCode = 502;
              res.end(JSON.stringify({ ok: false, error: `Tavily request failed: ${message}` }));
              void logApiUsage(databaseUrl, "tavily", path, 502, false);
            }
          });
        });
      handle("/api/tavily/search", "https://api.tavily.com/search");
      handle("/api/tavily/extract", "https://api.tavily.com/extract");
    }
  };
}

// Brave Search proxy. Browser POSTs a JSON body like {q, count, freshness};
// this middleware converts that to a GET against api.search.brave.com (Brave
// is GET-only) so the API key stays server-side. POST-in / GET-out keeps the
// browser-side interface symmetric with the Tavily and Serper clients.
function bravePlugin(apiKey: string | undefined, databaseUrl: string | undefined): Plugin {
  return {
    name: "brave-bridge",
    configureServer(server) {
      server.middlewares.use("/api/brave/search", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        if (!apiKey) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              ok: false,
              error: "BRAVE_API_KEY is not set in .env.local. Restart dev server after adding it."
            })
          );
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", async () => {
          try {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: "Brave proxy: invalid JSON body" }));
              return;
            }
            // Whitelist the parameters we forward. Anything else is dropped
            // so the browser can't smuggle through Brave parameters we haven't
            // reviewed (e.g. safesearch off, paid-only fields).
            const allowed = ["q", "count", "freshness", "country", "search_lang", "spellcheck", "offset"] as const;
            const params = new URLSearchParams();
            for (const k of allowed) {
              const v = parsed[k];
              if (v === undefined || v === null) continue;
              params.set(k, String(v));
            }
            if (!params.get("q")) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: "Brave proxy: q is required" }));
              return;
            }
            const url = `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;
            const upstreamRes = await fetch(url, {
              method: "GET",
              headers: {
                "X-Subscription-Token": apiKey,
                Accept: "application/json",
                "Accept-Encoding": "gzip"
              }
            });
            const text = await upstreamRes.text();
            res.statusCode = upstreamRes.status;
            res.end(text);
            void logApiUsage(databaseUrl, "brave", "/api/brave/search", upstreamRes.status, upstreamRes.ok);
            // Push live health to the Integrations panel registry so the
            // panel's coloured dot reflects whether Brave is actually
            // reachable, not just whether the env var is present. Matches
            // the pattern coingeckoPlugin / pumpPortalCollectorPlugin use.
            if (upstreamRes.ok) {
              setIntegrationStatus("brave", { healthy: true, lastOkAt: new Date().toISOString() });
            } else {
              setIntegrationStatus("brave", {
                healthy: false,
                lastErrorAt: new Date().toISOString(),
                lastError: `upstream ${upstreamRes.status}: ${text.slice(0, 120)}`
              });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.statusCode = 502;
            res.end(JSON.stringify({ ok: false, error: `Brave request failed: ${message}` }));
            void logApiUsage(databaseUrl, "brave", "/api/brave/search", 502, false);
            setIntegrationStatus("brave", {
              healthy: false,
              lastErrorAt: new Date().toISOString(),
              lastError: message
            });
          }
        });
      });
    }
  };
}

function serperPlugin(apiKey: string | undefined, databaseUrl: string | undefined): Plugin {
  return {
    name: "serper-bridge",
    configureServer(server) {
      server.middlewares.use("/api/serper/search", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        if (!apiKey) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              ok: false,
              error: "SERPER_API_KEY is not set in .env.local. Restart dev server after adding it."
            })
          );
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", async () => {
          try {
            const upstreamRes = await fetch("https://google.serper.dev/search", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-API-KEY": apiKey
              },
              body
            });
            const text = await upstreamRes.text();
            res.statusCode = upstreamRes.status;
            res.end(text);
            void logApiUsage(databaseUrl, "serper", "/api/serper/search", upstreamRes.status, upstreamRes.ok);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.statusCode = 502;
            res.end(JSON.stringify({ ok: false, error: `Serper request failed: ${message}` }));
            void logApiUsage(databaseUrl, "serper", "/api/serper/search", 502, false);
          }
        });
      });
    }
  };
}

// Read-only proxy for meme coin market data. Forwards GET requests to
// DexScreener and pump.fun server-side so the browser is not blocked by CORS
// or ad-blockers. No API key needed for either upstream. Used by the Meme Coin
// research tab (see docs/ARCHITECTURE.md).
function marketDataPlugin(): Plugin {
  return {
    name: "market-data-bridge",
    configureServer(server) {
      const proxy = (
        mount: string,
        toUpstream: (rest: string) => string,
        extraHeaders: Record<string, string> = {}
      ) =>
        server.middlewares.use(mount, (req, res, next) => {
          if (req.method !== "GET") {
            next();
            return;
          }
          res.setHeader("Content-Type", "application/json");
          // connect strips the mount prefix, but strip again defensively.
          const rest = (req.url || "/").replace(new RegExp(`^${mount}`), "") || "/";
          fetch(toUpstream(rest), {
            headers: { Accept: "application/json", ...extraHeaders }
          })
            .then(async (upstreamRes) => {
              const text = await upstreamRes.text();
              res.statusCode = upstreamRes.status;
              res.end(text);
            })
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              res.statusCode = 502;
              res.end(JSON.stringify({ ok: false, error: `Upstream request failed: ${message}` }));
            });
        });

      proxy("/api/dexscreener", (rest) => `https://api.dexscreener.com${rest}`);
      proxy("/api/pumpfun", (rest) => `https://frontend-api-v3.pump.fun${rest}`, {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Origin: "https://pump.fun",
        Referer: "https://pump.fun/"
      });
    }
  };
}

// Solana JSON-RPC proxy. Forwards /api/solana-rpc POSTs to a Solana RPC node
// so the endpoint URL (and any provider key) stays server-side, and the
// browser is not blocked by CORS or rate limits. Read-only use in Phase A
// (balance reads). See docs/ARCHITECTURE.md "Real trading".
function solanaRpcPlugin(rpcUrl: string | undefined): Plugin {
  const upstream = rpcUrl || "https://api.mainnet-beta.solana.com";
  return {
    name: "solana-rpc-bridge",
    configureServer(server) {
      server.middlewares.use("/api/solana-rpc", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", async () => {
          try {
            const upstreamRes = await fetch(upstream, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body
            });
            const text = await upstreamRes.text();
            res.statusCode = upstreamRes.status;
            res.end(text);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.statusCode = 502;
            res.end(JSON.stringify({ error: { message: `Solana RPC request failed: ${message}` } }));
          }
        });
      });
    }
  };
}

// Jupiter swap API proxy. Forwards /api/jupiter/* to Jupiter's free lite API
// so the browser is not blocked by CORS. GET for quotes, POST for the swap
// transaction. No API key needed. See docs/ARCHITECTURE.md "Real trading".
function jupiterPlugin(): Plugin {
  return {
    name: "jupiter-bridge",
    configureServer(server) {
      server.middlewares.use("/api/jupiter", (req, res, next) => {
        if (req.method !== "GET" && req.method !== "POST") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        const rest = (req.url || "/").replace(/^\/api\/jupiter/, "") || "/";
        const upstream = `https://lite-api.jup.ag${rest}`;
        const forward = (body?: string) => {
          fetch(upstream, {
            method: req.method,
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body
          })
            .then(async (r) => {
              const text = await r.text();
              res.statusCode = r.status;
              res.end(text);
            })
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              res.statusCode = 502;
              res.end(JSON.stringify({ error: `Jupiter request failed: ${message}` }));
            });
        };
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => forward(body));
        } else {
          forward();
        }
      });
    }
  };
}

// GeckoTerminal proxy. Forwards /api/geckoterminal/* to GeckoTerminal's free
// public API (no key) so the browser is not blocked by CORS. Used by the scan
// for new and trending Solana pools. See docs/ARCHITECTURE.md.
function geckoTerminalPlugin(): Plugin {
  return {
    name: "geckoterminal-bridge",
    configureServer(server) {
      server.middlewares.use("/api/geckoterminal", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        const rest = (req.url || "/").replace(/^\/api\/geckoterminal/, "") || "/";
        fetch(`https://api.geckoterminal.com/api/v2${rest}`, {
          headers: { Accept: "application/json" }
        })
          .then(async (r) => {
            const text = await r.text();
            res.statusCode = r.status;
            res.end(text);
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            res.statusCode = 502;
            res.end(JSON.stringify({ error: `GeckoTerminal request failed: ${message}` }));
          });
      });
    }
  };
}

// RugCheck proxy. Forwards /api/rugcheck/* to the public RugCheck API
// (no key) so the browser is not blocked by CORS. Used by the pre-buy
// safety gate to read honeypot / mint-authority / LP-lock status before
// a live swap. See docs/ARCHITECTURE.md "Live trading, safety gate".
function rugcheckPlugin(): Plugin {
  return {
    name: "rugcheck-bridge",
    configureServer(server) {
      server.middlewares.use("/api/rugcheck", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        const rest = (req.url || "/").replace(/^\/api\/rugcheck/, "") || "/";
        fetch(`https://api.rugcheck.xyz/v1${rest}`, {
          headers: { Accept: "application/json" }
        })
          .then(async (r) => {
            const text = await r.text();
            res.statusCode = r.status;
            res.end(text);
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            res.statusCode = 502;
            res.end(JSON.stringify({ error: `RugCheck request failed: ${message}` }));
          });
      });
    }
  };
}

// Postgres storage for the Meme Coin sub-project. See docs/ARCHITECTURE.md
// "Storage". The browser reaches this at /api/memecoin/state; Postgres is the
// source of truth when configured, while localStorage is a startup cache.
function memecoinDbPlugin(
  databaseUrl: string | undefined,
  serverSchedulerWatch: boolean,
  serverSchedulerScan: boolean
): Plugin {
  return {
    name: "memecoin-db-bridge",
    configureServer(server) {
      if (!databaseUrl) {
        server.middlewares.use("/api/memecoin/state", (_req, res) => {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              ok: false,
              error: "DATABASE_URL is not set in .env.local. Restart the dev server after adding it."
            })
          );
        });
        return;
      }
      const pool = new Pool({ connectionString: databaseUrl });

      // Apply the schema on startup. Every statement is IF NOT EXISTS.
      pool
        .query(readFileSync(join(process.cwd(), "db", "schema.sql"), "utf-8"))
        .then(() => server.config.logger.info("[memecoin-db] schema ready"))
        .catch((err) =>
          server.config.logger.error(`[memecoin-db] schema apply failed: ${err.message}`)
        );

      server.middlewares.use("/api/memecoin/state", (req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (req.method === "GET") {
          loadMemecoinDbState(pool, serverSchedulerWatch, serverSchedulerScan)
            .then((state) => res.end(JSON.stringify({ ok: true, state })))
            .catch((err) => {
              res.statusCode = 500;
              res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
            });
          return;
        }
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(body);
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
              return;
            }
            saveMemecoinDbState(pool, parsed)
              .then(() => res.end(JSON.stringify({ ok: true })))
              .catch((err) => {
                res.statusCode = 500;
                res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
              });
          });
          return;
        }
        res.statusCode = 405;
        res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
      });

      // Dedicated alerts endpoint. The full-state POST is ~1 MB (pumpEvents
      // alone is ~999 KB), which exceeds sendBeacon's 64 KB ceiling — so
      // Hide / Clear / purge calls that race a Cmd-R can never reliably use
      // beacon for delivery, and any in-flight fetch is aborted by page
      // unload. A tiny endpoint that accepts only { alerts } keeps the
      // beacon body around 2 KB and makes those click-then-refresh races
      // delivery-guaranteed. Same delete+insert pattern as the full-state
      // save so behavior matches: the browser is the source of truth for
      // alert mutations, last-write-wins against any server-scheduler row
      // (same risk as the full-state path).
      server.middlewares.use("/api/memecoin/alerts", (req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          let parsed: any;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
            return;
          }
          const alerts = Array.isArray(parsed?.alerts) ? parsed.alerts : null;
          if (!alerts) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "Body must be { alerts: PanelAlert[] }" }));
            return;
          }
          (async () => {
            const client = await pool.connect();
            try {
              await client.query("begin");
              // Upsert + sweep instead of delete-then-insert. The watch
              // scheduler also inserts into m_paper_alerts directly
              // (sell-intent / execute-mode / watchlist-trigger paths),
              // and two browser tabs can both POST here concurrently.
              // Either combination can collide on id with a delete-then-
              // insert sequence under READ COMMITTED.
              const alertIds: string[] = [];
              for (const a of alerts) {
                alertIds.push(a.id);
                await client.query(
                  `insert into m_paper_alerts (id, at, kind, text, scroll_to_id, dismissed)
                   values ($1, $2, $3, $4, $5, $6)
                   on conflict (id) do update set
                     at = excluded.at,
                     kind = excluded.kind,
                     text = excluded.text,
                     scroll_to_id = excluded.scroll_to_id,
                     dismissed = excluded.dismissed`,
                  [a.id, a.at, a.kind, a.text, a.scrollToId ?? null, a.dismissed === true]
                );
              }
              // Sweep alerts the browser no longer asserts (it dismissed/purged
              // them) — but DON'T delete scheduler-inserted rows the browser has
              // not loaded yet. The watch scheduler inserts directly into
              // m_paper_alerts between a tab's GET and its next POST; a naive
              // "delete everything not in the posted set" wipes those before the
              // tab ever displays them (the bug that left m_paper_alerts empty
              // despite emitted alerts). So keep a non-posted row only when it is
              // BOTH newer than the newest alert the browser knows about AND
              // recent (< grace window) — i.e. almost certainly an in-flight
              // insert. Everything older the browser has had a chance to load, so
              // its absence from the posted set is a genuine dismissal.
              const SWEEP_GRACE = "10 minutes";
              if (alertIds.length === 0) {
                // Empty assertion: the browser holds no alerts. Still must not
                // wipe a just-inserted scheduler row, so spare anything inside
                // the grace window.
                await client.query(
                  `delete from m_paper_alerts where at < now() - interval '${SWEEP_GRACE}'`
                );
              } else {
                await client.query(
                  `delete from m_paper_alerts
                     where id <> all($1::text[])
                       and not (
                         at > (select max(at) from m_paper_alerts where id = any($1::text[]))
                         and at > now() - interval '${SWEEP_GRACE}'
                       )`,
                  [alertIds]
                );
              }
              await client.query("commit");
              res.end(JSON.stringify({ ok: true }));
            } catch (err: any) {
              await client.query("rollback").catch(() => {});
              res.statusCode = 500;
              res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
            } finally {
              client.release();
            }
          })();
        });
      });

      // Dedicated pump-events endpoint. Each pump event is ~5 KB (the
      // chatter blob from Serper/Tavily dominates), and the 200-row cap
      // means the table grows to ~1 MB. Including all 200 rows in the
      // full-state save payload pushed the round-trip well over
      // sendBeacon's 64 KB ceiling, so any beforeunload save was silently
      // failing.
      //
      // The browser appends one event at a time via this endpoint (~5 KB
      // body, safely under the beacon ceiling). The full-state POST no
      // longer touches m_pump_events at all (pumpEvents arrives as null
      // when stripped from the payload — see saveMemecoinDbState).
      //
      // Insert is idempotent on id; pump events are immutable after
      // creation so on_conflict_do_nothing is correct. After insert we
      // trim to 200 most recent rows, matching the browser-side
      // .slice(0, 200) in logPumps.
      server.middlewares.use("/api/memecoin/pump-events", (req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          let parsed: any;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
            return;
          }
          const e = parsed?.event;
          if (!e || typeof e !== "object" || !e.id || !e.address) {
            res.statusCode = 400;
            res.end(
              JSON.stringify({
                ok: false,
                error: "Body must be { event: PumpEvent } with id and address"
              })
            );
            return;
          }
          (async () => {
            const client = await pool.connect();
            try {
              await client.query("begin");
              await client.query(
                `insert into m_pump_events
                   (id, address, symbol, name, detected_at, trigger, run_up_pct, chatter, chatter_error)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 on conflict (id) do nothing`,
                [
                  e.id,
                  e.address,
                  e.symbol,
                  e.name,
                  e.detectedAt,
                  e.trigger,
                  e.runUpPct,
                  e.chatter ? JSON.stringify(e.chatter) : null,
                  e.chatterError ?? null
                ]
              );
              // Trim to 200 most recent. Matches browser-side cap so the
              // table doesn't grow unbounded after we stopped doing
              // delete+insert on the full-state path.
              await client.query(
                `delete from m_pump_events
                 where id not in (
                   select id from m_pump_events
                   order by detected_at desc
                   limit 200
                 )`
              );
              await client.query("commit");
              res.end(JSON.stringify({ ok: true }));
            } catch (err: any) {
              await client.query("rollback").catch(() => {});
              res.statusCode = 500;
              res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
            } finally {
              client.release();
            }
          })();
        });
      });

      // Dedicated scan-cache endpoint. The scan result is ~47 KB and was
      // previously written via the full-state POST. After 0060d04 stripped
      // it from the beforeunload beacon body (to get the body under
      // sendBeacon's 64 KB ceiling), a fast refresh during the brief
      // window between a scan-cycle finishing and the next persist
      // round-trip could leave the tradeQueue in DB referencing coins
      // that weren't in the persisted scan — buys then failed with "no
      // fresh price, buy skipped" because applyQueuedIntents looks up
      // the coin's current price from the scan tokens list.
      //
      // This endpoint lets the browser write scan independently, so
      // scan-cycle results land in DB without depending on the full-
      // state save. Idempotent upsert on the singleton row.
      server.middlewares.use("/api/memecoin/scan", (req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          let parsed: any;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
            return;
          }
          const scan = parsed?.scan;
          if (!scan || typeof scan !== "object") {
            res.statusCode = 400;
            res.end(
              JSON.stringify({ ok: false, error: "Body must be { scan: ScanResult }" })
            );
            return;
          }
          (async () => {
            try {
              await pool.query(
                `insert into m_scan_cache (id, data, scanned_at) values (1, $1, $2)
                 on conflict (id) do update set data = $1, scanned_at = $2`,
                [JSON.stringify(scan), scan.scannedAt || new Date().toISOString()]
              );
              res.end(JSON.stringify({ ok: true }));
            } catch (err: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
            }
          })();
        });
      });
    }
  };
}

function isoOrNull(d: unknown): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

async function loadMemecoinDbState(
  pool: InstanceType<typeof Pool>,
  serverSchedulerWatch: boolean,
  serverSchedulerScan = false
) {
  const account = (await pool.query("select * from m_paper_account where id = 1")).rows[0];
  // Order by entry_at desc so the open-positions table renders newest-first
  // on reload, matching what the user just saw before the refresh.
  const positionRows = (await pool.query("select * from m_paper_positions order by entry_at desc"))
    .rows;
  const livePositionRows = (
    await pool.query("select * from m_live_positions order by entry_at desc")
  ).rows;
  const alertRows = (await pool.query("select * from m_paper_alerts order by at desc")).rows;
  const priceRows = (await pool.query("select * from m_price_snapshots")).rows;
  const scanRow = (await pool.query("select data from m_scan_cache where id = 1")).rows[0];
  const pumpEventRows = (
    await pool.query("select * from m_pump_events order by detected_at desc")
  ).rows;
  const dismissedRows = (
    await pool.query("select * from m_dismissed_buy_intents order by dismissed_at desc")
  ).rows;
  // Watchlist rows: active entries first (triggered_at null), then triggered
  // history. Ordered newest-first within each bucket so the UI shows recent
  // user activity at the top.
  const watchlistRows = (
    await pool.query(
      "select * from m_watchlist order by triggered_at nulls first, created_at desc"
    )
  ).rows;

  const paper = account
    ? {
        startingCashUsd: account.starting_cash,
        cashUsd: account.cash,
        positions: positionRows.map((r) => ({
          id: r.id,
          address: r.address,
          symbol: r.symbol,
          name: r.name,
          status: r.status,
          entryAt: isoOrNull(r.entry_at),
          entryPriceUsd: r.entry_price_usd,
          costUsd: r.cost_usd,
          tokenAmount: r.token_amount,
          entryExitScore: r.entry_exit_score,
          alertedSpike: r.alerted_spike,
          tookHalfProfit: r.took_half_profit,
          partialProceedsUsd: r.partial_proceeds_usd ?? undefined,
          partialRealizedUsd: r.partial_realized_usd ?? undefined,
          dangerAlerted: r.danger_alerted,
          lastPriceUsd: r.last_price_usd ?? undefined,
          lastLiquidityUsd: r.last_liquidity_usd ?? undefined,
          exitAt: isoOrNull(r.exit_at) ?? undefined,
          exitPriceUsd: r.exit_price_usd ?? undefined,
          exitReason: r.exit_reason ?? undefined,
          proceedsUsd: r.proceeds_usd ?? undefined,
          pnlUsd: r.pnl_usd ?? undefined,
          rearmPrice: r.rearm_price ?? undefined,
          rearmDir: r.rearm_dir ?? undefined,
          partials: Array.isArray(r.partials) ? r.partials : [],
          peakPriceUsd: r.peak_price_usd ?? undefined,
          entryLiquidityUsd: r.entry_liquidity_usd ?? undefined,
          entryVolume24h: r.entry_volume_24h ?? undefined,
          entryMarketCap: r.entry_market_cap ?? undefined,
          entryAgeHours: r.entry_age_hours ?? undefined,
          entryPriceChange24h: r.entry_price_change_24h ?? undefined,
          entryBuys24h: r.entry_buys_24h ?? undefined,
          entrySells24h: r.entry_sells_24h ?? undefined,
          entryBuyRatio: r.entry_buy_ratio ?? undefined,
          entryTop10HoldersPct: r.entry_top10_holders_pct ?? undefined,
          entryBotRatio: r.entry_bot_ratio ?? undefined,
          entryHolderCount: r.entry_holder_count ?? undefined,
          entryOrganicLabel: r.entry_organic_label ?? undefined,
          entryRating: r.entry_rating ?? undefined,
          entryRatingBand: r.entry_rating_band ?? undefined,
          entryVerdict: r.entry_verdict ?? undefined,
          entrySources: Array.isArray(r.entry_sources) ? r.entry_sources : undefined,
          entryRiskFlags: Array.isArray(r.entry_risk_flags) ? r.entry_risk_flags : undefined,
          entrySocialsCount: r.entry_socials_count ?? undefined,
          entryJupiterEnrichedAt: r.entry_jupiter_enriched_at
            ? isoOrNull(r.entry_jupiter_enriched_at) ?? undefined
            : undefined,
          algoVersion: r.algo_version ?? undefined,
          entrySettingsSnapshot:
            r.entry_settings_snapshot && typeof r.entry_settings_snapshot === "object"
              ? r.entry_settings_snapshot
              : undefined
        })),
        settings: {
          autoTrade: account.auto_trade,
          tradeSizeUsd: account.trade_size_usd,
          maxOpenPositions: account.max_open_positions,
          minExitScore: account.min_exit_score,
          minLiquidityUsd: account.min_liquidity_usd,
          minAgeHours: account.min_age_hours ?? 24,
          minHolderCount:
            typeof account.min_holder_count === "number" ? account.min_holder_count : 500,
          takeProfitPct: account.take_profit_pct,
          stopLossPct: account.stop_loss_pct,
          maxHoldHours: account.max_hold_hours,
          reentryCooldownHours:
            typeof account.reentry_cooldown_hours === "number"
              ? account.reentry_cooldown_hours
              : 6,
          dailyLossLimitPct:
            typeof account.daily_loss_limit_pct === "number"
              ? account.daily_loss_limit_pct
              : 20,
          maxTopHoldersPct:
            typeof account.max_top_holders_pct === "number"
              ? account.max_top_holders_pct
              : 35,
          trailingStopPct:
            typeof account.trailing_stop_pct === "number" ? account.trailing_stop_pct : 35,
          trailingActivationPct:
            typeof account.trailing_activation_pct === "number"
              ? account.trailing_activation_pct
              : 25,
          liveDailyLossLimitUsd:
            typeof account.live_daily_loss_limit_usd === "number"
              ? account.live_daily_loss_limit_usd
              : 0,
          // Default 10 matches the in-memory PaperSettings default. Persisted
          // from this commit onward; before the fix it lived only in JS state
          // and got zeroed to undefined on every reload, which silently
          // disabled the buy-dismissal gate (NaN comparisons fail open).
          buyDismissalImprovementPoints:
            typeof account.buy_dismissal_improvement_points === "number"
              ? account.buy_dismissal_improvement_points
              : 10
        },
        updatedAt: isoOrNull(account.updated_at)
      }
    : null;

  const live = {
    positions: livePositionRows.map((r) => ({
      id: r.id,
      mint: r.mint,
      symbol: r.symbol,
      name: r.name,
      status: r.status,
      baseMint: r.base_mint,
      entryAt: isoOrNull(r.entry_at),
      entrySignature: r.entry_signature,
      entryBaseAmount: r.entry_base_amount,
      entryTokenAmount: r.entry_token_amount,
      entryPriceUsd: r.entry_price_usd,
      slippageBps: r.slippage_bps,
      buyPriceImpactPct: r.buy_price_impact_pct ?? undefined,
      routeSummary: r.route_summary ?? undefined,
      alertedSpike: r.alerted_spike,
      tookHalfProfit: r.took_half_profit,
      partialProceedsBase: r.partial_proceeds_base ?? undefined,
      partialRealizedBase: r.partial_realized_base ?? undefined,
      dangerAlerted: r.danger_alerted,
      lastPriceUsd: r.last_price_usd ?? undefined,
      lastLiquidityUsd: r.last_liquidity_usd ?? undefined,
      peakPriceUsd: r.peak_price_usd ?? undefined,
      entryExitScore: r.entry_exit_score ?? undefined,
      entryLiquidityUsd: r.entry_liquidity_usd ?? undefined,
      entryVolume24h: r.entry_volume_24h ?? undefined,
      entryMarketCap: r.entry_market_cap ?? undefined,
      entryAgeHours: r.entry_age_hours ?? undefined,
      entryPriceChange24h: r.entry_price_change_24h ?? undefined,
      entryBuys24h: r.entry_buys_24h ?? undefined,
      entrySells24h: r.entry_sells_24h ?? undefined,
      entryBuyRatio: r.entry_buy_ratio ?? undefined,
      entryTop10HoldersPct: r.entry_top10_holders_pct ?? undefined,
      entryBotRatio: r.entry_bot_ratio ?? undefined,
      entryHolderCount: r.entry_holder_count ?? undefined,
      entryOrganicLabel: r.entry_organic_label ?? undefined,
      entryRating: r.entry_rating ?? undefined,
      entryRatingBand: r.entry_rating_band ?? undefined,
      entryVerdict: r.entry_verdict ?? undefined,
      entrySources: Array.isArray(r.entry_sources) ? r.entry_sources : undefined,
      entryRiskFlags: Array.isArray(r.entry_risk_flags) ? r.entry_risk_flags : undefined,
      entrySocialsCount: r.entry_socials_count ?? undefined,
      entryJupiterEnrichedAt: r.entry_jupiter_enriched_at
        ? isoOrNull(r.entry_jupiter_enriched_at) ?? undefined
        : undefined,
      algoVersion: r.algo_version ?? undefined,
      entrySettingsSnapshot:
        r.entry_settings_snapshot && typeof r.entry_settings_snapshot === "object"
          ? r.entry_settings_snapshot
          : undefined,
      exitAt: isoOrNull(r.exit_at) ?? undefined,
      exitSignature: r.exit_signature ?? undefined,
      exitPriceUsd: r.exit_price_usd ?? undefined,
      exitBaseAmount: r.exit_base_amount ?? undefined,
      exitReason: r.exit_reason ?? undefined,
      pnlBase: r.pnl_base ?? undefined,
      pnlUsd: r.pnl_usd ?? undefined
    })),
    updatedAt: new Date().toISOString()
  };

  return {
    paper,
    live,
    alerts: alertRows.map((r) => ({
      id: r.id,
      at: isoOrNull(r.at),
      kind: r.kind,
      text: r.text,
      scrollToId: r.scroll_to_id ?? undefined,
      // dismissed: persisted from 2026-05-25 forward. Older rows from before
      // the column existed default to false (the DB default), matching the
      // "show in toast stack" behavior they had under React-state-only.
      dismissed: r.dismissed === true
    })),
    prices: Object.fromEntries(
      priceRows.map((r) => [
        r.address,
        {
          priceUsd: r.price_usd,
          liquidityUsd: r.liquidity_usd,
          volume24h: r.volume24h ?? undefined
        }
      ])
    ),
    scan: scanRow ? scanRow.data : null,
    autoRun: account ? account.auto_run === true : false,
    watchOn: account ? account.watch_on === true : false,
    queueMode: account ? account.queue_mode === true : false,
    tradeQueue: account && Array.isArray(account.trade_queue) ? account.trade_queue : [],
    feePct: account && typeof account.fee_pct === "number" ? account.fee_pct : 1,
    tradingMode: account && account.trading_mode === "real" ? "real" : "paper",
    pumpEvents: pumpEventRows.map((r) => ({
      id: r.id,
      address: r.address,
      symbol: r.symbol,
      name: r.name,
      detectedAt: isoOrNull(r.detected_at),
      trigger: r.trigger,
      runUpPct: r.run_up_pct,
      chatter: r.chatter ?? null,
      chatterError: r.chatter_error ?? undefined
    })),
    dismissedBuyIntents: dismissedRows.map((r) => ({
      address: r.address,
      symbol: r.symbol ?? "",
      name: r.name ?? "",
      account: r.account === "live" ? "live" : "paper",
      dismissedAt: isoOrNull(r.dismissed_at),
      dismissedRating: r.dismissed_rating ?? undefined,
      dismissedExitScore: r.dismissed_exit_score ?? undefined,
      dismissedLiquidityUsd: r.dismissed_liquidity_usd ?? undefined,
      source: r.source ?? undefined,
      reason: r.reason ?? undefined,
      algoVersion: r.algo_version ?? undefined
    })),
    // User-preference bundle: scan sort, hidden coins list, panel collapse
    // state, hide-tab. All previously per-browser localStorage; persisted
    // server-side from 2026-05-24 forward. Defensive defaults match the
    // DB column defaults so a missing account row still hydrates sanely.
    userPrefs: {
      sortBy: account && typeof account.sort_by === "string" ? account.sort_by : "rating",
      sortDir:
        account && account.sort_dir === "asc" ? "asc" : "desc",
      hideView:
        account && account.hide_view === "hidden" ? "hidden" : "visible",
      hiddenMints: Array.isArray(account?.hidden_mints)
        ? (account.hidden_mints as unknown[]).filter((m): m is string => typeof m === "string")
        : [],
      closedExpanded: account ? account.closed_expanded === true : false,
      collapsedSections: Array.isArray(account?.collapsed_sections)
        ? (account.collapsed_sections as unknown[]).filter((s): s is string => typeof s === "string")
        : []
    },
    watchlist: watchlistRows.map((r) => ({
      id: r.id,
      mint: r.mint,
      symbol: r.symbol ?? null,
      name: r.name ?? null,
      targetPriceUsd: Number(r.target_price_usd),
      direction: r.direction === "above" ? "above" : "below",
      note: r.note ?? null,
      createdAt: isoOrNull(r.created_at) ?? new Date().toISOString(),
      triggeredAt: isoOrNull(r.triggered_at),
      triggeredPrice: r.triggered_price != null ? Number(r.triggered_price) : null
    })),
    // Surface which cycles are owned by the server scheduler so the browser
    // can skip its own setIntervals and avoid 2× burn. The flag is sourced
    // from vite's loadEnv() at config time and threaded through this function
    // as a parameter — process.env doesn't carry .env.local values (loadEnv
    // returns a local object, doesn't mutate process.env), so reading
    // process.env.SERVER_SCHEDULER_WATCH here returns undefined and the
    // server scheduler appears disabled to the browser even when it isn't.
    serverScheduler: {
      watch: serverSchedulerWatch,
      scan: serverSchedulerScan
    }
  };
}

async function saveMemecoinDbState(pool: InstanceType<typeof Pool>, body: any) {
  const paper = body?.paper;
  const live = body?.live;
  const alerts = Array.isArray(body?.alerts) ? body.alerts : [];
  const prices = body?.prices && typeof body.prices === "object" ? body.prices : {};
  const scan = body?.scan ?? null;
  // pumpEvents intentionally distinguishes undefined ("don't touch this table",
  // used by the beforeunload beacon path that strips heavy fields) from an
  // empty array ("explicitly clear all events"). The dedicated
  // /api/memecoin/pump-events endpoint is the normal write path now; this
  // branch only fires when something POSTs the legacy full state with a
  // pumpEvents array present.
  const pumpEvents = Array.isArray(body?.pumpEvents) ? body.pumpEvents : null;
  const dismissedBuyIntents = Array.isArray(body?.dismissedBuyIntents)
    ? body.dismissedBuyIntents
    : [];

  const client = await pool.connect();
  try {
    await client.query("begin");

    if (paper) {
      const s = paper.settings || {};
      await client.query(
        `insert into m_paper_account
           (id, starting_cash, cash, auto_trade, trade_size_usd, max_open_positions,
            min_exit_score, min_liquidity_usd, take_profit_pct, stop_loss_pct, max_hold_hours,
            min_age_hours, auto_run, watch_on, queue_mode, trade_queue, fee_pct,
            reentry_cooldown_hours, daily_loss_limit_pct, trading_mode,
            max_top_holders_pct, trailing_stop_pct, trailing_activation_pct,
            live_daily_loss_limit_usd, min_holder_count,
            buy_dismissal_improvement_points,
            sort_by, sort_dir, hide_view, hidden_mints,
            closed_expanded, collapsed_sections,
            updated_at)
         values (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, now())
         on conflict (id) do update set
           starting_cash = $1, cash = $2, auto_trade = $3, trade_size_usd = $4,
           max_open_positions = $5, min_exit_score = $6, min_liquidity_usd = $7,
           take_profit_pct = $8, stop_loss_pct = $9, max_hold_hours = $10,
           min_age_hours = $11, auto_run = $12, watch_on = $13, queue_mode = $14,
           trade_queue = $15, fee_pct = $16, reentry_cooldown_hours = $17,
           daily_loss_limit_pct = $18, trading_mode = $19,
           max_top_holders_pct = $20, trailing_stop_pct = $21,
           trailing_activation_pct = $22, live_daily_loss_limit_usd = $23,
           min_holder_count = $24,
           buy_dismissal_improvement_points = $25,
           sort_by = $26, sort_dir = $27, hide_view = $28, hidden_mints = $29,
           closed_expanded = $30, collapsed_sections = $31,
           updated_at = now()`,
        [
          paper.startingCashUsd,
          paper.cashUsd,
          !!s.autoTrade,
          s.tradeSizeUsd,
          Math.round(s.maxOpenPositions ?? 0),
          s.minExitScore,
          s.minLiquidityUsd,
          s.takeProfitPct,
          s.stopLossPct,
          s.maxHoldHours,
          s.minAgeHours ?? 24,
          !!body.autoRun,
          !!body.watchOn,
          !!body.queueMode,
          JSON.stringify(Array.isArray(body.tradeQueue) ? body.tradeQueue : []),
          typeof body.feePct === "number" && body.feePct >= 0 ? body.feePct : 1,
          typeof s.reentryCooldownHours === "number" && s.reentryCooldownHours >= 0
            ? s.reentryCooldownHours
            : 6,
          typeof s.dailyLossLimitPct === "number" && s.dailyLossLimitPct >= 0
            ? s.dailyLossLimitPct
            : 20,
          body.tradingMode === "real" ? "real" : "paper",
          typeof s.maxTopHoldersPct === "number" && s.maxTopHoldersPct >= 0
            ? s.maxTopHoldersPct
            : 35,
          typeof s.trailingStopPct === "number" && s.trailingStopPct >= 0
            ? s.trailingStopPct
            : 35,
          typeof s.trailingActivationPct === "number" && s.trailingActivationPct >= 0
            ? s.trailingActivationPct
            : 25,
          typeof s.liveDailyLossLimitUsd === "number" && s.liveDailyLossLimitUsd >= 0
            ? s.liveDailyLossLimitUsd
            : 0,
          // minHolderCount: algo2 holder floor. Falls back to 500 (algo2 default)
          // when the field is absent from the payload, matching the DB default.
          typeof s.minHolderCount === "number" && s.minHolderCount >= 0
            ? Math.round(s.minHolderCount)
            : 500,
          // buyDismissalImprovementPoints: rating-point threshold a dismissed
          // coin must climb before re-proposal. Falls back to 10 (default)
          // when missing. Persisted from the bug-fix forward; before that it
          // lived only in JS and silently zeroed on every reload, breaking
          // the dismissal gate. See buyDismissalBlocks in src/lib/paper.ts.
          typeof s.buyDismissalImprovementPoints === "number" &&
          s.buyDismissalImprovementPoints >= 0
            ? s.buyDismissalImprovementPoints
            : 10,
          // User-preference bundle. Was per-browser localStorage until the
          // 2026-05-24 "no-localStorage-for-settings" migration. Defensive
          // defaults match the DB column defaults so a malformed payload
          // hydrates back to the same sane state.
          typeof body.userPrefs?.sortBy === "string" ? body.userPrefs.sortBy : "rating",
          body.userPrefs?.sortDir === "asc" ? "asc" : "desc",
          body.userPrefs?.hideView === "hidden" ? "hidden" : "visible",
          JSON.stringify(
            Array.isArray(body.userPrefs?.hiddenMints)
              ? body.userPrefs.hiddenMints.filter((m: unknown) => typeof m === "string")
              : []
          ),
          !!body.userPrefs?.closedExpanded,
          JSON.stringify(
            Array.isArray(body.userPrefs?.collapsedSections)
              ? body.userPrefs.collapsedSections.filter((s: unknown) => typeof s === "string")
              : []
          )
        ]
      );
      // UPSERT by id, then delete rows no longer in the payload. The old
      // bulk delete-then-reinsert churned every row each save; this matches
      // the m_live_positions pattern. An empty payload (a paper reset) deletes
      // every row, since `id = any('{}')` is false for all of them.
      const paperPositionIds = (paper.positions || []).map((p: any) => p.id);
      for (const p of paper.positions || []) {
        await client.query(
          `insert into m_paper_positions
             (id, address, symbol, name, status, entry_at, entry_price_usd, cost_usd,
              token_amount, entry_exit_score, alerted_spike, took_half_profit,
              partial_proceeds_usd, partial_realized_usd, danger_alerted, last_price_usd,
              last_liquidity_usd, exit_at, exit_price_usd, exit_reason, proceeds_usd, pnl_usd,
              rearm_price, rearm_dir, partials, peak_price_usd,
              entry_liquidity_usd, entry_volume_24h, entry_market_cap, entry_age_hours,
              entry_price_change_24h, entry_buys_24h, entry_sells_24h, entry_buy_ratio,
              entry_top10_holders_pct, entry_bot_ratio, entry_holder_count, entry_organic_label,
              entry_rating, entry_rating_band, entry_verdict, entry_sources, entry_risk_flags,
              entry_socials_count, entry_jupiter_enriched_at,
              algo_version, entry_settings_snapshot)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47)
           on conflict (id) do update set
             address = excluded.address, symbol = excluded.symbol,
             name = excluded.name, status = excluded.status,
             entry_at = excluded.entry_at, entry_price_usd = excluded.entry_price_usd,
             cost_usd = excluded.cost_usd, token_amount = excluded.token_amount,
             entry_exit_score = excluded.entry_exit_score,
             alerted_spike = excluded.alerted_spike,
             took_half_profit = excluded.took_half_profit,
             partial_proceeds_usd = excluded.partial_proceeds_usd,
             partial_realized_usd = excluded.partial_realized_usd,
             danger_alerted = excluded.danger_alerted,
             last_price_usd = excluded.last_price_usd,
             last_liquidity_usd = excluded.last_liquidity_usd,
             exit_at = excluded.exit_at, exit_price_usd = excluded.exit_price_usd,
             exit_reason = excluded.exit_reason, proceeds_usd = excluded.proceeds_usd,
             pnl_usd = excluded.pnl_usd,
             rearm_price = excluded.rearm_price, rearm_dir = excluded.rearm_dir,
             partials = excluded.partials,
             peak_price_usd = excluded.peak_price_usd,
             entry_liquidity_usd = excluded.entry_liquidity_usd,
             entry_volume_24h = excluded.entry_volume_24h,
             entry_market_cap = excluded.entry_market_cap,
             entry_age_hours = excluded.entry_age_hours,
             entry_price_change_24h = excluded.entry_price_change_24h,
             entry_buys_24h = excluded.entry_buys_24h,
             entry_sells_24h = excluded.entry_sells_24h,
             entry_buy_ratio = excluded.entry_buy_ratio,
             entry_top10_holders_pct = excluded.entry_top10_holders_pct,
             entry_bot_ratio = excluded.entry_bot_ratio,
             entry_holder_count = excluded.entry_holder_count,
             entry_organic_label = excluded.entry_organic_label,
             entry_rating = excluded.entry_rating,
             entry_rating_band = excluded.entry_rating_band,
             entry_verdict = excluded.entry_verdict,
             entry_sources = excluded.entry_sources,
             entry_risk_flags = excluded.entry_risk_flags,
             entry_socials_count = excluded.entry_socials_count,
             entry_jupiter_enriched_at = excluded.entry_jupiter_enriched_at,
             algo_version = excluded.algo_version,
             entry_settings_snapshot = excluded.entry_settings_snapshot`,
          [
            p.id,
            p.address,
            p.symbol,
            p.name,
            p.status,
            p.entryAt,
            p.entryPriceUsd,
            p.costUsd,
            p.tokenAmount,
            p.entryExitScore,
            !!p.alertedSpike,
            !!p.tookHalfProfit,
            p.partialProceedsUsd ?? null,
            p.partialRealizedUsd ?? null,
            !!p.dangerAlerted,
            p.lastPriceUsd ?? null,
            p.lastLiquidityUsd ?? null,
            p.exitAt ?? null,
            p.exitPriceUsd ?? null,
            p.exitReason ?? null,
            p.proceedsUsd ?? null,
            p.pnlUsd ?? null,
            p.rearmPrice ?? null,
            p.rearmDir ?? null,
            JSON.stringify(Array.isArray(p.partials) ? p.partials : []),
            p.peakPriceUsd ?? null,
            p.entryLiquidityUsd ?? null,
            p.entryVolume24h ?? null,
            p.entryMarketCap ?? null,
            p.entryAgeHours ?? null,
            p.entryPriceChange24h ?? null,
            p.entryBuys24h ?? null,
            p.entrySells24h ?? null,
            p.entryBuyRatio ?? null,
            p.entryTop10HoldersPct ?? null,
            p.entryBotRatio ?? null,
            p.entryHolderCount ?? null,
            p.entryOrganicLabel ?? null,
            p.entryRating ?? null,
            p.entryRatingBand ?? null,
            p.entryVerdict ?? null,
            p.entrySources ? JSON.stringify(p.entrySources) : null,
            p.entryRiskFlags ? JSON.stringify(p.entryRiskFlags) : null,
            p.entrySocialsCount ?? null,
            p.entryJupiterEnrichedAt ?? null,
            // algo2 tag + full settings regime at entry. If the position
            // pre-dates these fields, fall back to algo1 / null so existing
            // rows aren't accidentally re-stamped on an upsert.
            p.algoVersion ?? "algo1",
            p.entrySettingsSnapshot ? JSON.stringify(p.entrySettingsSnapshot) : null
          ]
        );
      }
      // Drop any rows whose position is no longer in the payload (a reset, or
      // a position dropped from state). On an empty payload this deletes all.
      await client.query(`delete from m_paper_positions where not (id = any($1::text[]))`, [
        paperPositionIds
      ]);

      // Append every closed trade to the permanent, append-only m_trade_log.
      // ON CONFLICT DO NOTHING: a closed trade is immutable, logged exactly
      // once. Nothing ever deletes from m_trade_log, so history survives resets.
      for (const p of paper.positions || []) {
        if (p.status !== "closed") continue;
        await client.query(
          `insert into m_trade_log
             (id, address, symbol, name, entry_at, exit_at, entry_price_usd, exit_price_usd,
              cost_usd, proceeds_usd, pnl_usd, entry_exit_score, exit_reason,
              took_half_profit, partial_realized_usd,
              entry_liquidity_usd, entry_volume_24h, entry_market_cap, entry_age_hours,
              entry_price_change_24h, entry_buys_24h, entry_sells_24h, entry_buy_ratio,
              entry_top10_holders_pct, entry_bot_ratio, entry_holder_count, entry_organic_label,
              entry_rating, entry_rating_band, entry_verdict, entry_sources, entry_risk_flags,
              entry_socials_count, entry_jupiter_enriched_at,
              algo_version, entry_settings_snapshot)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)
           on conflict (id) do nothing`,
          [
            p.id,
            p.address,
            p.symbol,
            p.name,
            p.entryAt,
            p.exitAt ?? null,
            p.entryPriceUsd,
            p.exitPriceUsd ?? null,
            p.costUsd,
            p.proceedsUsd ?? null,
            p.pnlUsd ?? null,
            p.entryExitScore ?? null,
            p.exitReason ?? null,
            !!p.tookHalfProfit,
            p.partialRealizedUsd ?? null,
            p.entryLiquidityUsd ?? null,
            p.entryVolume24h ?? null,
            p.entryMarketCap ?? null,
            p.entryAgeHours ?? null,
            p.entryPriceChange24h ?? null,
            p.entryBuys24h ?? null,
            p.entrySells24h ?? null,
            p.entryBuyRatio ?? null,
            p.entryTop10HoldersPct ?? null,
            p.entryBotRatio ?? null,
            p.entryHolderCount ?? null,
            p.entryOrganicLabel ?? null,
            p.entryRating ?? null,
            p.entryRatingBand ?? null,
            p.entryVerdict ?? null,
            p.entrySources ? JSON.stringify(p.entrySources) : null,
            p.entryRiskFlags ? JSON.stringify(p.entryRiskFlags) : null,
            p.entrySocialsCount ?? null,
            p.entryJupiterEnrichedAt ?? null,
            // Carry the position's algo + settings tags into the immutable
            // trade log on close. Fall back to algo1 so historical closes
            // without the tag don't crash the NOT NULL column.
            p.algoVersion ?? "algo1",
            p.entrySettingsSnapshot ? JSON.stringify(p.entrySettingsSnapshot) : null
          ]
        );
      }
    }

    if (live) {
      // UPSERT per row, no bulk delete. Two browser tabs can have divergent
      // local state (Tab A just opened position X; Tab B doesn't know about
      // X yet). A wholesale delete-and-reinsert from Tab B would erase X.
      // UPSERT-by-id only touches rows in the writer's payload, leaving
      // the other tab's positions in place.
      //
      // The status guard refuses any update to a row that is already
      // closed, so a stale-cache writer cannot re-open a position the
      // other tab just exited. Open->open (in-place mutations) and
      // open->closed (the exit) are both allowed.
      //
      // entry_base_amount / entry_token_amount are mutable too: a partial sell
      // shrinks the open remainder (see sellLivePosition). So the old premise
      // that entry amounts never change no longer holds, and a stale second
      // tab still holding the pre-shrink amounts could revert a shrink on its
      // next save. Concurrent live trading across two tabs is out of scope;
      // the design already tolerates tab divergence and the live tab's next
      // save re-corrects it.
      for (const p of live.positions || []) {
        await client.query(
          `insert into m_live_positions
             (id, mint, symbol, name, status, base_mint, entry_at, entry_signature,
              entry_base_amount, entry_token_amount, entry_price_usd, slippage_bps,
              buy_price_impact_pct, route_summary, alerted_spike, took_half_profit,
              partial_proceeds_base, partial_realized_base, danger_alerted,
              last_price_usd, last_liquidity_usd, exit_at, exit_signature,
              exit_price_usd, exit_base_amount, exit_reason, pnl_base, pnl_usd,
              peak_price_usd,
              entry_exit_score, entry_liquidity_usd, entry_volume_24h, entry_market_cap,
              entry_age_hours, entry_price_change_24h, entry_buys_24h, entry_sells_24h,
              entry_buy_ratio, entry_top10_holders_pct, entry_bot_ratio, entry_holder_count,
              entry_organic_label, entry_rating, entry_rating_band, entry_verdict,
              entry_sources, entry_risk_flags, entry_socials_count, entry_jupiter_enriched_at,
              algo_version, entry_settings_snapshot)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51)
           on conflict (id) do update set
             status = excluded.status,
             -- entry amounts shrink when a position is partially sold (the
             -- sold slice splits off as its own closed row); keep them in sync.
             entry_base_amount = excluded.entry_base_amount,
             entry_token_amount = excluded.entry_token_amount,
             alerted_spike = excluded.alerted_spike,
             took_half_profit = excluded.took_half_profit,
             partial_proceeds_base = excluded.partial_proceeds_base,
             partial_realized_base = excluded.partial_realized_base,
             danger_alerted = excluded.danger_alerted,
             last_price_usd = excluded.last_price_usd,
             last_liquidity_usd = excluded.last_liquidity_usd,
             peak_price_usd = excluded.peak_price_usd,
             exit_at = excluded.exit_at,
             exit_signature = excluded.exit_signature,
             exit_price_usd = excluded.exit_price_usd,
             exit_base_amount = excluded.exit_base_amount,
             exit_reason = excluded.exit_reason,
             pnl_base = excluded.pnl_base,
             pnl_usd = excluded.pnl_usd
             -- entry_* snapshot columns are write-once at the initial insert;
             -- never overwrite them on an UPDATE so a stale-cache writer cannot
             -- erase the snapshot. They are NULL only if the position predates
             -- this feature.
           where m_live_positions.status = 'open'`,
          [
            p.id,
            p.mint,
            p.symbol,
            p.name,
            p.status,
            p.baseMint,
            p.entryAt,
            p.entrySignature,
            p.entryBaseAmount,
            p.entryTokenAmount,
            p.entryPriceUsd,
            Math.round(p.slippageBps ?? 0),
            p.buyPriceImpactPct ?? null,
            p.routeSummary ?? null,
            !!p.alertedSpike,
            !!p.tookHalfProfit,
            p.partialProceedsBase ?? null,
            p.partialRealizedBase ?? null,
            !!p.dangerAlerted,
            p.lastPriceUsd ?? null,
            p.lastLiquidityUsd ?? null,
            p.exitAt ?? null,
            p.exitSignature ?? null,
            p.exitPriceUsd ?? null,
            p.exitBaseAmount ?? null,
            p.exitReason ?? null,
            p.pnlBase ?? null,
            p.pnlUsd ?? null,
            p.peakPriceUsd ?? null,
            p.entryExitScore ?? null,
            p.entryLiquidityUsd ?? null,
            p.entryVolume24h ?? null,
            p.entryMarketCap ?? null,
            p.entryAgeHours ?? null,
            p.entryPriceChange24h ?? null,
            p.entryBuys24h ?? null,
            p.entrySells24h ?? null,
            p.entryBuyRatio ?? null,
            p.entryTop10HoldersPct ?? null,
            p.entryBotRatio ?? null,
            p.entryHolderCount ?? null,
            p.entryOrganicLabel ?? null,
            p.entryRating ?? null,
            p.entryRatingBand ?? null,
            p.entryVerdict ?? null,
            p.entrySources ? JSON.stringify(p.entrySources) : null,
            p.entryRiskFlags ? JSON.stringify(p.entryRiskFlags) : null,
            p.entrySocialsCount ?? null,
            p.entryJupiterEnrichedAt ?? null,
            p.algoVersion ?? "algo1",
            p.entrySettingsSnapshot ? JSON.stringify(p.entrySettingsSnapshot) : null
          ]
        );
      }

      // Append every closed live trade to the permanent log. Same contract
      // as paper.m_trade_log: insert once, never updated, never deleted.
      for (const p of live.positions || []) {
        if (p.status !== "closed") continue;
        await client.query(
          `insert into m_live_trade_log
             (id, mint, symbol, name, base_mint, entry_at, exit_at, entry_signature,
              exit_signature, entry_base_amount, entry_token_amount, entry_price_usd,
              exit_price_usd, exit_base_amount, pnl_base, pnl_usd, exit_reason,
              slippage_bps, buy_price_impact_pct,
              entry_exit_score, entry_liquidity_usd, entry_volume_24h, entry_market_cap,
              entry_age_hours, entry_price_change_24h, entry_buys_24h, entry_sells_24h,
              entry_buy_ratio, entry_top10_holders_pct, entry_bot_ratio, entry_holder_count,
              entry_organic_label, entry_rating, entry_rating_band, entry_verdict,
              entry_sources, entry_risk_flags, entry_socials_count, entry_jupiter_enriched_at,
              algo_version, entry_settings_snapshot)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41)
           on conflict (id) do nothing`,
          [
            p.id,
            p.mint,
            p.symbol,
            p.name,
            p.baseMint,
            p.entryAt,
            p.exitAt ?? null,
            p.entrySignature,
            p.exitSignature ?? null,
            p.entryBaseAmount,
            p.entryTokenAmount,
            p.entryPriceUsd,
            p.exitPriceUsd ?? null,
            p.exitBaseAmount ?? null,
            p.pnlBase ?? null,
            p.pnlUsd ?? null,
            p.exitReason ?? null,
            Math.round(p.slippageBps ?? 0),
            p.buyPriceImpactPct ?? null,
            p.entryExitScore ?? null,
            p.entryLiquidityUsd ?? null,
            p.entryVolume24h ?? null,
            p.entryMarketCap ?? null,
            p.entryAgeHours ?? null,
            p.entryPriceChange24h ?? null,
            p.entryBuys24h ?? null,
            p.entrySells24h ?? null,
            p.entryBuyRatio ?? null,
            p.entryTop10HoldersPct ?? null,
            p.entryBotRatio ?? null,
            p.entryHolderCount ?? null,
            p.entryOrganicLabel ?? null,
            p.entryRating ?? null,
            p.entryRatingBand ?? null,
            p.entryVerdict ?? null,
            p.entrySources ? JSON.stringify(p.entrySources) : null,
            p.entryRiskFlags ? JSON.stringify(p.entryRiskFlags) : null,
            p.entrySocialsCount ?? null,
            p.entryJupiterEnrichedAt ?? null,
            p.algoVersion ?? "algo1",
            p.entrySettingsSnapshot ? JSON.stringify(p.entrySettingsSnapshot) : null
          ]
        );
      }
    }

    // Full-state saves are allowed to add/update browser-created alerts, but
    // they must not delete rows missing from the browser payload. A stale tab
    // with alerts=[] can full-save seconds after the server scheduler inserts
    // a row, and sweeping here erases the alert before the polling tab can see
    // it. User-driven hide / purge actions use the dedicated
    // /api/memecoin/alerts endpoint below; that endpoint remains the only path
    // that intentionally sweeps m_paper_alerts.
    for (const a of alerts) {
      await client.query(
        `insert into m_paper_alerts (id, at, kind, text, scroll_to_id, dismissed)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (id) do update set
           at = excluded.at,
           kind = excluded.kind,
           text = excluded.text,
           scroll_to_id = excluded.scroll_to_id,
           dismissed = excluded.dismissed`,
        [a.id, a.at, a.kind, a.text, a.scrollToId ?? null, a.dismissed === true]
      );
    }

    // pumpEvents == null means the caller stripped them (typical now: the
    // beforeunload beacon, and saveMemecoinState which routes pump events
    // through the dedicated endpoint). Leave the table alone in that case.
    if (pumpEvents !== null) {
      // Upsert + sweep instead of delete-then-insert so this legacy path
      // can't collide on id with the dedicated POST /api/memecoin/pump-events
      // endpoint (which inserts one row at a time as logPumps runs). Pump
      // events are immutable after creation; ON CONFLICT DO NOTHING matches
      // the dedicated endpoint's behavior. The trailing sweep preserves
      // this path's "send the full set, wipe what's not in it" semantic.
      const pumpIds: string[] = [];
      for (const e of pumpEvents) {
        pumpIds.push(e.id);
        await client.query(
          `insert into m_pump_events
             (id, address, symbol, name, detected_at, trigger, run_up_pct, chatter, chatter_error)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (id) do nothing`,
          [
            e.id,
            e.address,
            e.symbol,
            e.name,
            e.detectedAt,
            e.trigger,
            e.runUpPct,
            e.chatter ? JSON.stringify(e.chatter) : null,
            e.chatterError ?? null
          ]
        );
      }
      if (pumpIds.length === 0) {
        await client.query("delete from m_pump_events");
      } else {
        await client.query(
          "delete from m_pump_events where id <> all($1::text[])",
          [pumpIds]
        );
      }
    }

    // Dismissed buy intents: replace wholesale, the payload is the full set.
    // Upsert + sweep instead of delete-then-insert so a concurrent full-
    // state save can't collide on the address pkey. The pkey is address
    // (one dismissal record per coin); a re-dismissal of the same coin
    // overwrites the prior record's metadata, which matches the prior
    // "delete-then-insert" semantic.
    const dismissedAddrs: string[] = [];
    for (const d of dismissedBuyIntents) {
      dismissedAddrs.push(d.address);
      await client.query(
        `insert into m_dismissed_buy_intents
           (address, symbol, name, account, dismissed_at,
            dismissed_rating, dismissed_exit_score, dismissed_liquidity_usd,
            source, reason, algo_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (address) do update set
           symbol = excluded.symbol,
           name = excluded.name,
           account = excluded.account,
           dismissed_at = excluded.dismissed_at,
           dismissed_rating = excluded.dismissed_rating,
           dismissed_exit_score = excluded.dismissed_exit_score,
           dismissed_liquidity_usd = excluded.dismissed_liquidity_usd,
           source = excluded.source,
           reason = excluded.reason,
           algo_version = excluded.algo_version`,
        [
          d.address,
          d.symbol ?? null,
          d.name ?? null,
          d.account === "live" ? "live" : "paper",
          d.dismissedAt ?? new Date().toISOString(),
          d.dismissedRating ?? null,
          d.dismissedExitScore ?? null,
          d.dismissedLiquidityUsd ?? null,
          // source / reason / algo_version added 2026-05-23 with the
          // auto-dismiss-on-safety-block + algo2 changes. Old records without
          // these fields fall through to NULL / 'algo1' (column default).
          d.source ?? null,
          d.reason ?? null,
          d.algoVersion ?? "algo1"
        ]
      );
    }
    if (dismissedAddrs.length === 0) {
      await client.query("delete from m_dismissed_buy_intents");
    } else {
      await client.query(
        "delete from m_dismissed_buy_intents where address <> all($1::text[])",
        [dismissedAddrs]
      );
    }

    // Watchlist: UPSERT by id so triggered_at / triggered_price updates
    // from the watch tick land cleanly, then delete rows not in the
    // payload (handles user deletions). Same pattern as m_paper_positions.
    const m_watchlist = Array.isArray(body?.m_watchlist) ? body.m_watchlist : [];
    const watchIds = m_watchlist.map((w: any) => w.id);
    for (const w of m_watchlist) {
      await client.query(
        `insert into m_watchlist
           (id, mint, symbol, name, target_price_usd, direction, note,
            created_at, triggered_at, triggered_price)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (id) do update set
           mint = $2,
           symbol = $3,
           name = $4,
           target_price_usd = $5,
           direction = $6,
           note = $7,
           triggered_at = $9,
           triggered_price = $10`,
        [
          w.id,
          w.mint,
          w.symbol ?? null,
          w.name ?? null,
          Number(w.targetPriceUsd),
          w.direction === "above" ? "above" : "below",
          w.note ?? null,
          w.createdAt ?? new Date().toISOString(),
          w.triggeredAt ?? null,
          w.triggeredPrice ?? null
        ]
      );
    }
    if (watchIds.length === 0) {
      await client.query("delete from m_watchlist");
    } else {
      await client.query("delete from m_watchlist where id <> all($1::text[])", [watchIds]);
    }

    // Upsert + sweep instead of delete-then-insert. Two writers update
    // m_price_snapshots (this full-state save and the position-watch
    // scheduler in vite.config.ts), and READ COMMITTED isolation allows
    // their concurrent delete+insert sequences to collide on the address
    // pkey ("duplicate key value violates unique constraint
    // m_price_snapshots_pkey" in the err log). ON CONFLICT makes the
    // insert conflict-free; the trailing sweep preserves the previous
    // "wipe and replace" semantic for addresses not in the new payload.
    const priceAddrs: string[] = [];
    for (const [address, info] of Object.entries(prices as Record<string, any>)) {
      priceAddrs.push(address);
      await client.query(
        `insert into m_price_snapshots (address, price_usd, liquidity_usd, volume24h, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (address) do update set
           price_usd = excluded.price_usd,
           liquidity_usd = excluded.liquidity_usd,
           volume24h = excluded.volume24h,
           updated_at = now()`,
        [address, info.priceUsd, info.liquidityUsd, info.volume24h ?? null]
      );
    }
    if (priceAddrs.length === 0) {
      await client.query("delete from m_price_snapshots");
    } else {
      await client.query(
        "delete from m_price_snapshots where address <> all($1::text[])",
        [priceAddrs]
      );
    }

    if (scan) {
      await client.query(
        `insert into m_scan_cache (id, data, scanned_at) values (1, $1, $2)
         on conflict (id) do update set data = $1, scanned_at = $2`,
        [JSON.stringify(scan), scan.scannedAt || new Date().toISOString()]
      );
    }

    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Shared integration-status registry.
//
// Each external-service plugin (PumpPortal collector, CoinGecko proxy, Helius
// webhook receiver, etc.) writes its current health into this object. The
// integrationsStatusPlugin reads it and exposes /api/integrations, which the
// Meme Coin "Integrations" panel renders. One source of truth per service,
// no prop drilling, lives in the same module that owns the plugins.
//
// Status shape per service:
//   - configured: env var (or equivalent) is present
//   - healthy: last upstream contact succeeded (null = unknown / not attempted)
//   - lastOkAt / lastErrorAt: ISO timestamps for the last success / failure
//   - lastError: short error string for the most recent failure
//   - extras: service-specific counters (e.g. messages-received, last-mint)
// ---------------------------------------------------------------------------
type IntegrationHealth = {
  configured: boolean;
  healthy: boolean | null;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  extras?: Record<string, unknown>;
};
const integrationStatus: Record<string, IntegrationHealth> = {};
function setIntegrationStatus(key: string, patch: Partial<IntegrationHealth>) {
  const cur = integrationStatus[key] ?? { configured: false, healthy: null };
  integrationStatus[key] = { ...cur, ...patch, extras: { ...(cur.extras ?? {}), ...(patch.extras ?? {}) } };
}

// ---------------------------------------------------------------------------
// PumpPortal WebSocket collector.
//
// Holds ONE WebSocket to wss://pumpportal.fun/api/data for the lifetime of
// the dev server, subscribes to subscribeNewToken + subscribeMigration, and
// upserts every event into the m_pump_candidates Postgres table. Replaces the
// gated frontend-api-v3.pump.fun polling.
//
// PumpPortal explicitly bans IPs that open multiple WebSockets, so the
// connection is module-scoped (one per Node process) and re-uses on HMR.
// Reconnect-with-backoff on any disconnect; exponential up to 60s.
// ---------------------------------------------------------------------------
let pumpPortalWs: WebSocket | null = null;
let pumpPortalReconnectTimer: NodeJS.Timeout | null = null;
let pumpPortalBackoffMs = 5_000;
let pumpPortalMessageCount = 0;
let pumpPortalLastMint: string | null = null;

function pumpPortalCollectorPlugin(databaseUrl: string | undefined): Plugin {
  return {
    name: "pumpportal-collector",
    async configureServer(server) {
      if (!databaseUrl) {
        setIntegrationStatus("pumpportal", {
          configured: false,
          healthy: false,
          lastError: "DATABASE_URL not set; PumpPortal collector disabled (data has nowhere to land)"
        });
        return;
      }
      setIntegrationStatus("pumpportal", { configured: true, healthy: null });
      const pool = new Pool({ connectionString: databaseUrl });

      // Retention sweep: m_pump_candidates grows ~30-100k rows/day from the
      // PumpPortal firehose. Most rows are mints we never trade. Sweep
      // anything not touched in the last 7 days so the table stays small
      // enough to comfortably live in a hosted Postgres / Supabase free
      // tier (500 MB DB cap). Runs once on startup and hourly thereafter.
      // Active candidates keep their last_seen_at refreshed on every event
      // (the upsert below bumps it), so only genuinely stale rows are cut.
      const PUMP_RETENTION_DAYS = 7;
      const sweepPumpCandidates = async () => {
        try {
          const r = await pool.query(
            `delete from m_pump_candidates
             where last_seen_at < now() - ($1 || ' days')::interval`,
            [String(PUMP_RETENTION_DAYS)]
          );
          if (r.rowCount && r.rowCount > 0) {
            server.config.logger.info(
              `[pumpportal] retention sweep: deleted ${r.rowCount} m_pump_candidates older than ${PUMP_RETENTION_DAYS}d`
            );
          }
        } catch (e) {
          server.config.logger.warn(
            `[pumpportal] retention sweep failed: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      };
      void sweepPumpCandidates();
      setInterval(sweepPumpCandidates, 60 * 60 * 1000);

      // Read endpoint: the most recent N mints for the scan pipeline to merge.
      // Filter excludes mints we've already enriched (handled client-side via
      // the existing dedupe in scanMemecoins).
      server.middlewares.use("/api/pumpcandidates/recent", async (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        try {
          const url = new URL(req.url ?? "/", "http://x");
          const minutes = Math.max(1, Math.min(120, Number(url.searchParams.get("minutes") ?? "30")));
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? "60")));
          const r = await pool.query(
            `select mint, symbol, name, uri, source_event, first_seen_at, last_seen_at, payload
             from m_pump_candidates
             where last_seen_at > now() - ($1 || ' minutes')::interval
             order by last_seen_at desc
             limit $2`,
            [String(minutes), limit]
          );
          res.end(JSON.stringify({ ok: true, candidates: r.rows }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        }
      });

      function connect() {
        if (pumpPortalWs) {
          try {
            pumpPortalWs.removeAllListeners();
            pumpPortalWs.close();
          } catch {
            /* ignore */
          }
          pumpPortalWs = null;
        }
        const ws = new WebSocket("wss://pumpportal.fun/api/data");
        pumpPortalWs = ws;
        ws.on("open", () => {
          pumpPortalBackoffMs = 5_000;
          setIntegrationStatus("pumpportal", {
            healthy: true,
            lastOkAt: new Date().toISOString(),
            extras: { state: "connected" }
          });
          // Subscribe to the two mint-lifecycle event types. `subscribeTrade`
          // would also fire here but would be a firehose; we only care about
          // new tokens and migrations for discovery.
          try {
            ws.send(JSON.stringify({ method: "subscribeNewToken" }));
            ws.send(JSON.stringify({ method: "subscribeMigration" }));
          } catch (e) {
            setIntegrationStatus("pumpportal", {
              healthy: false,
              lastErrorAt: new Date().toISOString(),
              lastError: `subscribe send failed: ${e instanceof Error ? e.message : String(e)}`
            });
          }
        });
        ws.on("message", async (data: Buffer) => {
          let msg: { mint?: string; symbol?: string; name?: string; uri?: string; txType?: string };
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }
          const mint = msg.mint;
          if (!mint) return; // ack / heartbeat messages have no mint, skip
          const sourceEvent =
            msg.txType === "create"
              ? "new-token"
              : msg.txType === "migrate"
                ? "migration"
                : msg.txType ?? "other";
          pumpPortalMessageCount += 1;
          pumpPortalLastMint = mint;
          try {
            await pool.query(
              `insert into m_pump_candidates (mint, symbol, name, uri, source_event, first_seen_at, last_seen_at, payload)
               values ($1, $2, $3, $4, $5, now(), now(), $6)
               on conflict (mint) do update set
                 symbol = coalesce(excluded.symbol, m_pump_candidates.symbol),
                 name = coalesce(excluded.name, m_pump_candidates.name),
                 uri = coalesce(excluded.uri, m_pump_candidates.uri),
                 source_event = excluded.source_event,
                 last_seen_at = now(),
                 payload = excluded.payload`,
              [mint, msg.symbol ?? null, msg.name ?? null, msg.uri ?? null, sourceEvent, JSON.stringify(msg)]
            );
            setIntegrationStatus("pumpportal", {
              healthy: true,
              lastOkAt: new Date().toISOString(),
              extras: {
                state: "connected",
                messages: pumpPortalMessageCount,
                lastMint: pumpPortalLastMint
              }
            });
          } catch (e) {
            setIntegrationStatus("pumpportal", {
              healthy: false,
              lastErrorAt: new Date().toISOString(),
              lastError: `db write failed: ${e instanceof Error ? e.message : String(e)}`
            });
          }
        });
        const fail = (reason: string) => {
          setIntegrationStatus("pumpportal", {
            healthy: false,
            lastErrorAt: new Date().toISOString(),
            lastError: reason,
            extras: { state: "disconnected", reconnectInMs: pumpPortalBackoffMs }
          });
          // Exponential backoff capped at 60s. Reconnects survive HMR because
          // pumpPortalWs / timer are module-scoped.
          if (pumpPortalReconnectTimer) clearTimeout(pumpPortalReconnectTimer);
          pumpPortalReconnectTimer = setTimeout(() => connect(), pumpPortalBackoffMs);
          pumpPortalBackoffMs = Math.min(60_000, pumpPortalBackoffMs * 2);
        };
        ws.on("close", (code, reason) => fail(`closed code=${code} reason=${reason.toString()}`));
        ws.on("error", (err: Error) => fail(`error: ${err.message}`));
      }

      // Kick off the first connection. If the dev server is restarted, the
      // module re-evaluates and connect() runs fresh; PumpPortal sees one
      // connection at a time per IP as required.
      connect();
    }
  };
}

// ---------------------------------------------------------------------------
// Server-side position watch scheduler.
//
// Replicates what the browser's runPositionWatch effect (App.tsx) does, but on
// a setInterval owned by the vite dev server so it fires whether or not anyone
// has the tab open. The user wanted "see alerts I missed when I open the
// browser without keeping a browser open at all time" — moving the watch tick
// here is the smallest refactor that delivers that.
//
// Opt-in via SERVER_SCHEDULER_WATCH=true in .env.local. When enabled, the
// /api/memecoin/state response sets serverScheduler.watch=true and the React
// app skips installing its own watch interval (avoiding 2× burn).
//
// What this plugin does each tick (5 min):
//   1. Load full state from Postgres (loadMemecoinDbState).
//   2. Bail if watch_on=false or nothing to watch.
//   3. Fetch DexScreener prices for open positions + active watchlist mints,
//      hitting DexScreener directly (we're already server-side; no proxy /
//      CORS / relative-URL gymnastics needed).
//   4. Write fresh prices into m_price_snapshots.
//   5. In paper mode + execute mode: run evaluatePositionWatch (pure), write
//      updated position rows + cash + alerts. In paper mode + queue mode: run
//      decideSellIntents, append to trade_queue, emit one summary alert. In
//      real mode: just re-price live positions for the panel display, no
//      auto-sell logic ever fires (live sells are exclusively user-clicked).
//   6. Watchlist evaluation: mark triggered rows, emit one alert per trigger.
//
// Scope intentionally excludes:
//   - Pump-event social-chatter logging on +50% spikes. That requires
//     server-side checkSocialChatter, which would pull the brave/tavily/serper
//     proxies into the server's import graph. Skipping keeps this refactor
//     bounded; the spike alert still fires, just without the chatter context.
//   - The cycleLog UI banner. Purely a browser-display concern.
//   - OS Notification API push. Browser-only. The DB-persisted alerts are the
//     canonical record; the user sees them when they open the tab.
// ---------------------------------------------------------------------------
type DexPair = {
  baseToken?: { address?: string };
  priceUsd?: string | number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
};
async function fetchPricesDirect(
  addresses: string[]
): Promise<Record<string, { priceUsd: number; liquidityUsd: number; volume24h: number }>> {
  const out: Record<string, { priceUsd: number; liquidityUsd: number; volume24h: number }> = {};
  if (addresses.length === 0) return out;
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { pairs?: DexPair[] };
      const pairs = Array.isArray(data.pairs) ? data.pairs : [];
      for (const p of pairs) {
        const addr = p?.baseToken?.address;
        if (!addr) continue;
        const liq = Number(p.liquidity?.usd ?? 0);
        const existing = out[addr];
        if (!existing || liq > existing.liquidityUsd) {
          out[addr] = {
            priceUsd: Number(p.priceUsd ?? 0),
            liquidityUsd: liq,
            volume24h: Number(p.volume?.h24 ?? 0)
          };
        }
      }
    } catch {
      // Missing prices for this batch are not treated as rugs (matches the
      // browser fetchPrices contract). The next tick will retry.
    }
  }
  return out;
}

function positionWatchSchedulerPlugin(
  databaseUrl: string | undefined,
  enabled: boolean
): Plugin {
  return {
    name: "position-watch-scheduler",
    async configureServer(server) {
      // The `enabled` flag is sourced from vite's loadEnv() at registration
      // time. We do NOT read process.env.SERVER_SCHEDULER_WATCH here because
      // loadEnv populates a local object, not process.env — reading the env
      // var directly would always come back undefined and silently disable
      // the scheduler even when .env.local has it set. (Bug from the first
      // version of this plugin, surfaced by a long-running local deployment.)
      if (!databaseUrl) return;
      if (!enabled) {
        server.config.logger.info(
          "[watch-scheduler] disabled. Set SERVER_SCHEDULER_WATCH=true in .env.local to enable server-side position watch."
        );
        return;
      }
      const pool = new Pool({ connectionString: databaseUrl });
      let busy = false;
      const TICK_MS = 5 * 60 * 1000;

      const tick = async () => {
        if (busy) return;
        busy = true;
        try {
          const state = await loadMemecoinDbState(pool, enabled);
          if (!state.paper || !state.watchOn) return;
          const openPaper = (state.paper.positions || []).filter(
            (p: any) => p.status === "open"
          );
          const openLive = (state.live?.positions || []).filter(
            (p: any) => p.status === "open"
          );
          const activeWatches = (state.watchlist || []).filter(
            (w: any) => w.triggeredAt == null
          );
          if (openPaper.length === 0 && openLive.length === 0 && activeWatches.length === 0) {
            return;
          }
          const addrs = Array.from(
            new Set<string>([
              ...openPaper.map((p: any) => p.address),
              ...openLive.map((p: any) => p.mint),
              ...activeWatches.map((w: any) => w.mint)
            ])
          );
          const priceMap = await fetchPricesDirect(addrs);
          if (Object.keys(priceMap).length === 0) {
            server.config.logger.warn(
              "[watch-scheduler] price fetch returned empty; skipping eval this tick."
            );
            return;
          }
          // Refresh m_price_snapshots so the next /api/memecoin/state read
          // surfaces the latest prices to the browser. Upsert + sweep
          // (instead of delete-then-insert) so a concurrent full-state
          // save from a browser tab can't collide on the address pkey:
          // both writers want to "wipe and replace", but their inserts
          // could land in the same transaction window and conflict.
          const client = await pool.connect();
          try {
            await client.query("begin");
            const addrsTickList: string[] = [];
            for (const [address, info] of Object.entries(priceMap)) {
              addrsTickList.push(address);
              await client.query(
                `insert into m_price_snapshots (address, price_usd, liquidity_usd, volume24h, updated_at)
                 values ($1, $2, $3, $4, now())
                 on conflict (address) do update set
                   price_usd = excluded.price_usd,
                   liquidity_usd = excluded.liquidity_usd,
                   volume24h = excluded.volume24h,
                   updated_at = now()`,
                [address, info.priceUsd, info.liquidityUsd, info.volume24h]
              );
            }
            if (addrsTickList.length === 0) {
              await client.query("delete from m_price_snapshots");
            } else {
              await client.query(
                "delete from m_price_snapshots where address <> all($1::text[])",
                [addrsTickList]
              );
            }
            // Paper evaluation paths. Bail out for real mode (live sells are
            // exclusively user-clicked) and when there are no open paper
            // positions to evaluate.
            const isPaperEval = openPaper.length > 0 && state.tradingMode !== "real";
            if (isPaperEval && state.queueMode) {
              // Queue mode: propose sells, don't execute.
              const intents = decideSellIntents(state.paper as any, priceMap as any);
              if (intents.length > 0) {
                // Dedupe against the existing queue, same logic the browser's
                // enqueueIntents uses.
                const existingQueue = Array.isArray(state.tradeQueue) ? state.tradeQueue : [];
                const has = (it: any) =>
                  existingQueue.some(
                    (q: any) =>
                      q.kind === it.kind &&
                      (it.kind === "buy"
                        ? q.address === it.address
                        : q.positionId === it.positionId)
                  );
                const fresh = intents.filter((it: any) => !has(it));
                if (fresh.length > 0) {
                  const newQueue = [...fresh, ...existingQueue].slice(0, 100);
                  await client.query(
                    "update m_paper_account set trade_queue = $1, updated_at = now() where id = 1",
                    [JSON.stringify(newQueue)]
                  );
                  await client.query(
                    `insert into m_paper_alerts (id, at, text, kind, scroll_to_id, dismissed)
                     values ($1, now(), $2, $3, $4, false)`,
                    [
                      `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                      `Position watch proposed ${fresh.length} sell${fresh.length === 1 ? "" : "s"}. Review in the Trade queue.`,
                      "spike",
                      "trade-queue"
                    ]
                  );
                  server.config.logger.info(
                    `[watch-scheduler] queue mode: enqueued ${fresh.length} sell intent(s)`
                  );
                }
              }
              // Advisory alerts (queue mode): +50% spike heads-up and danger
              // early-warnings. These sell nothing — they tell the user to check
              // the chart / Trade queue. The full evaluatePositionWatch is NOT
              // run here (it would auto-bank profit and force-exit); see
              // watchAdvisoryAlerts. Throttle flags are persisted so each signal
              // fires once per condition, not every tick.
              const advisory = watchAdvisoryAlerts(state.paper as any, priceMap as any);
              for (const a of advisory.alerts) {
                await client.query(
                  `insert into m_paper_alerts (id, at, text, kind, scroll_to_id, dismissed)
                   values ($1, now(), $2, $3, $4, false)`,
                  [
                    `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                    a.text,
                    a.kind,
                    "trade-queue"
                  ]
                );
              }
              for (const f of advisory.flagUpdates) {
                await client.query(
                  `update m_paper_positions set
                     alerted_spike = $2, danger_alerted = $3,
                     last_price_usd = $4, last_liquidity_usd = $5
                   where id = $1`,
                  [f.id, f.alertedSpike, f.dangerAlerted, f.lastPriceUsd, f.lastLiquidityUsd]
                );
              }
              if (advisory.alerts.length > 0) {
                server.config.logger.info(
                  `[watch-scheduler] queue mode: ${advisory.alerts.length} advisory alert(s) emitted`
                );
              }
            } else if (isPaperEval) {
              // Execute mode: run the pure evaluator, write changed positions
              // + cash + alerts.
              const res = evaluatePositionWatch(state.paper as any, priceMap as any);
              // Cash + positions: UPSERT every position the evaluator returned
              // (preserves status changes, partial sells, alerted flags).
              await client.query(
                "update m_paper_account set cash = $1, updated_at = now() where id = 1",
                [res.state.cashUsd]
              );
              for (const p of res.state.positions) {
                await client.query(
                  `update m_paper_positions set
                     status = $2, alerted_spike = $3, took_half_profit = $4,
                     partial_proceeds_usd = $5, partial_realized_usd = $6,
                     danger_alerted = $7, last_price_usd = $8, last_liquidity_usd = $9,
                     exit_at = $10, exit_price_usd = $11, exit_reason = $12,
                     proceeds_usd = $13, pnl_usd = $14, peak_price_usd = $15,
                     partials = $16
                   where id = $1`,
                  [
                    p.id,
                    p.status,
                    !!(p as any).alertedSpike,
                    !!(p as any).tookHalfProfit,
                    (p as any).partialProceedsUsd ?? null,
                    (p as any).partialRealizedUsd ?? null,
                    !!(p as any).dangerAlerted,
                    (p as any).lastPriceUsd ?? null,
                    (p as any).lastLiquidityUsd ?? null,
                    (p as any).exitAt ?? null,
                    (p as any).exitPriceUsd ?? null,
                    (p as any).exitReason ?? null,
                    (p as any).proceedsUsd ?? null,
                    (p as any).pnlUsd ?? null,
                    (p as any).peakPriceUsd ?? null,
                    JSON.stringify((p as any).partials ?? [])
                  ]
                );
              }
              for (const a of res.alerts) {
                await client.query(
                  `insert into m_paper_alerts (id, at, text, kind, scroll_to_id, dismissed)
                   values ($1, now(), $2, $3, null, false)`,
                  [
                    `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                    a.text,
                    a.kind
                  ]
                );
              }
              if (res.alerts.length > 0) {
                server.config.logger.info(
                  `[watch-scheduler] execute mode: ${res.alerts.length} alert(s) emitted`
                );
              }
            }
            // Live-position watch: EVERY mode. Real money is never auto-sold
            // (see live.ts liveWatchAlerts), so this runs regardless of paper
            // vs real mode and emits notification-only big-move / danger
            // alerts for open live positions. Throttle flags persist so each
            // signal fires once per condition.
            if (openLive.length > 0) {
              const live = liveWatchAlerts(openLive as any, priceMap as any);
              for (const a of live.alerts) {
                await client.query(
                  `insert into m_paper_alerts (id, at, text, kind, scroll_to_id, dismissed)
                   values ($1, now(), $2, $3, $4, false)`,
                  [
                    `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                    a.text,
                    a.kind,
                    a.address
                  ]
                );
              }
              for (const f of live.flagUpdates) {
                await client.query(
                  `update m_live_positions set
                     alerted_spike = $2, took_half_profit = $3, danger_alerted = $4,
                     last_price_usd = $5, last_liquidity_usd = $6, peak_price_usd = $7
                   where id = $1 and status = 'open'`,
                  [
                    f.id,
                    f.alertedSpike,
                    f.tookHalfProfit,
                    f.dangerAlerted,
                    f.lastPriceUsd,
                    f.lastLiquidityUsd,
                    f.peakPriceUsd ?? null
                  ]
                );
              }
              if (live.alerts.length > 0) {
                server.config.logger.info(
                  `[watch-scheduler] live watch: ${live.alerts.length} alert(s) emitted`
                );
              }
            }

            // Watchlist eval: same logic, every mode. One alert per newly
            // triggered entry; mark triggered_at + triggered_price so it
            // doesn't re-fire next tick.
            for (const w of activeWatches as any[]) {
              const info = priceMap[w.mint];
              if (!info || !(info.priceUsd > 0)) continue;
              const hit =
                w.direction === "below"
                  ? info.priceUsd <= w.targetPriceUsd
                  : info.priceUsd >= w.targetPriceUsd;
              if (!hit) continue;
              await client.query(
                "update m_watchlist set triggered_at = now(), triggered_price = $2 where id = $1 and triggered_at is null",
                [w.id, info.priceUsd]
              );
              const label = w.symbol ?? String(w.mint).slice(0, 6);
              const dir = w.direction === "below" ? "dropped to" : "rose to";
              await client.query(
                `insert into m_paper_alerts (id, at, text, kind, scroll_to_id, dismissed)
                 values ($1, now(), $2, $3, $4, false)`,
                [
                  `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                  `Watchlist: ${label} ${dir} $${info.priceUsd.toPrecision(4)} (target $${Number(w.targetPriceUsd).toPrecision(4)}). Click to look it up.`,
                  "spike",
                  "watchlist"
                ]
              );
              server.config.logger.info(
                `[watch-scheduler] watchlist triggered: ${label} ${dir} ${info.priceUsd}`
              );
            }
            await client.query("commit");
          } catch (e) {
            await client.query("rollback");
            throw e;
          } finally {
            client.release();
          }
        } catch (e) {
          server.config.logger.warn(
            `[watch-scheduler] tick failed: ${e instanceof Error ? e.message : String(e)}`
          );
        } finally {
          busy = false;
        }
      };

      // Wait 30s after startup for the dev server to settle, then fire on the
      // 5-min cadence. The 30s delay also lets the user open the browser tab
      // first (HMR'd code reloads cleanly) before the first tick lands.
      setTimeout(tick, 30_000);
      setInterval(tick, TICK_MS);
      server.config.logger.info(
        "[watch-scheduler] enabled. First tick in 30s, then every 5 min."
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Server-side new-coin scan scheduler.
//
// The browser only scans for new coins on the hourly auto-run cycle, and only
// while a tab is open. On a headless server that means no scanning at all (the
// last scan can be days stale). This plugin runs scanMemecoins on a timer so
// DexScreener is polled with no tab open: it refreshes m_scan_cache (so the UI
// shows fresh data the moment a tab opens) and emits an alert for each coin
// that is new since the last scan AND clears the quality bar. Alerts land in
// m_paper_alerts, which the open tab surfaces as toasts (and OS pop-ups if the
// user granted permission) via the existing /api/memecoin/state hydration.
//
// Free by construction: scanMemecoins hits only DexScreener / GeckoTerminal /
// Jupiter / pump.fun (keyless proxies). It never calls checkSocialChatter, so
// the exhausted Brave/Serper/Tavily credits are not touched.
//
// Opt-in via SERVER_SCHEDULER_SCAN=true. Bar + cadence are env-tunable.

// Compact, scannable money/age formatters for the alert line.
function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}
function fmtAge(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "new";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

// Build the new-coin alert line. Surfaces every decision-relevant criterion the
// scan already computed (no extra API calls) so the user can eyeball what's
// worth trading and learn which signals they care about:
//   headline rating/band + verdict/exit, the money (liq/vol/mcap), momentum
//   (24h price + vol-vs-last-scan), order-flow quality (buy %, vol/liq churn,
//   top-10 concentration, unique-wallet ratio), and context (age, # corroborating
//   sources, RugCheck score). Optional fields are omitted when the scan didn't
//   compute them (e.g. top10/uniq are only enriched for top candidates).
function formatNewCoinAlert(
  t: ScanResult["tokens"][number],
  rugScore: number | null
): string {
  const buyPct = Math.round((t.buyRatio ?? 0.5) * 100);
  const priceArrow = (t.priceChange24h ?? 0) >= 0 ? "📈" : "📉";
  const priceStr = `${(t.priceChange24h ?? 0) >= 0 ? "+" : ""}${Math.round(t.priceChange24h ?? 0)}%`;
  const volMom =
    typeof t.volMomentumPct === "number" && Number.isFinite(t.volMomentumPct)
      ? ` (${t.volMomentumPct >= 0 ? "▲" : "▼"}${Math.abs(Math.round(t.volMomentumPct))}% vs last)`
      : "";
  const top10 =
    typeof t.top10HoldersPct === "number" ? ` · top10 ${Math.round(t.top10HoldersPct)}%` : "";
  const uniq =
    typeof t.botRatio === "number" ? ` · uniq ${Math.round(t.botRatio * 100)}%` : "";
  const srcN = Array.isArray(t.sources) ? t.sources.length : 1;
  const rug = typeof rugScore === "number" ? `rug ✓ (${Math.round(rugScore)})` : "rug ✓";
  return (
    `🆕 ${t.symbol} — ${t.ratingBand} ${Math.round(t.rating)}/100, ` +
    `${t.verdict} (exit ${Math.round(t.exitScore)}) · ` +
    `liq ${fmtUsd(t.liquidityUsd)} · vol24h ${fmtUsd(t.volume24h)}${volMom} · ` +
    `mcap ${fmtUsd(t.marketCap || t.fdv)} · ${priceArrow} ${priceStr} 24h · ` +
    `${buyPct}% buys (${t.buys24h}/${t.sells24h}) · vol/liq ${(t.volToLiq ?? 0).toFixed(1)}×` +
    `${top10}${uniq} · age ${fmtAge(t.ageHours)} · ${srcN} src · ${rug}. New this scan.`
  );
}

function scanSchedulerPlugin(
  databaseUrl: string | undefined,
  enabled: boolean,
  opts: {
    intervalMin: number;
    bands: string[];
    minLiquidityUsd: number;
    minVolume24h: number;
    cap: number;
    rugcheck: boolean;
    requireExitable: boolean;
    realertRatingPoints: number;
    realertMovePct: number;
  }
): Plugin {
  return {
    name: "new-coin-scan-scheduler",
    async configureServer(server) {
      if (!databaseUrl) return;
      if (!enabled) {
        server.config.logger.info(
          "[scan-scheduler] disabled. Set SERVER_SCHEDULER_SCAN=true in .env.local to enable server-side new-coin scanning."
        );
        return;
      }
      const pool = new Pool({ connectionString: databaseUrl });
      const TICK_MS = Math.max(2, opts.intervalMin) * 60 * 1000;
      let busy = false;
      // Seed-only on the FIRST tick when the prior scan is stale/missing:
      // markets.ts flags every coin new vs a stale cache, which would flood. A
      // fresh prior (process restart mid-run) skips seeding so real new coins
      // still alert immediately.
      let firstTick = true;

      const portOf = () => {
        const addr = server.httpServer?.address();
        if (addr && typeof addr === "object" && addr.port) return addr.port;
        return 47391;
      };

      // One-time cutover backfill: seed the ledger from coins already alerted in
      // the last 24h using the cached scan's live rating/mcap, so the switch to
      // ledger-based suppression doesn't fire one more round of the exact dupes
      // it exists to stop. Only coins present in the cache are seeded (a real
      // baseline); a coin with no live snapshot is left to alert once and set its
      // own baseline rather than being seeded null (which would mute it forever).
      const backfillLedger = async () => {
        try {
          const recent: string[] = (
            await pool.query(
              `select distinct scroll_to_id from m_paper_alerts
               where kind = 'newcoin' and scroll_to_id is not null
                 and at > now() - interval '24 hours'`
            )
          ).rows.map((r: any) => r.scroll_to_id);
          if (recent.length === 0) return;
          const cacheRow = (await pool.query("select data from m_scan_cache where id = 1")).rows[0];
          const cached: ScanResult | null = cacheRow
            ? typeof cacheRow.data === "string"
              ? JSON.parse(cacheRow.data)
              : cacheRow.data
            : null;
          const byAddr = new Map((cached?.tokens ?? []).map((t) => [t.address, t]));
          for (const addr of recent) {
            const t = byAddr.get(addr);
            if (!t) continue; // no live snapshot → let it alert once for a real baseline
            await pool.query(
              `insert into m_newcoin_ledger (address, last_rating, last_mcap)
               values ($1, $2, $3) on conflict (address) do nothing`,
              [addr, t.rating, t.marketCap || t.fdv || null]
            );
          }
          server.config.logger.info(
            `[scan-scheduler] ledger backfill seeded up to ${recent.length} recently-alerted coin(s).`
          );
        } catch (e) {
          server.config.logger.warn(
            `[scan-scheduler] ledger backfill skipped: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      };

      const tick = async () => {
        if (busy) return;
        busy = true;
        try {
          const base = `http://127.0.0.1:${portOf()}`;
          setMarketsApiBase(base);
          setSafetyApiBase(base);
          const priorRow = (
            await pool.query("select data, scanned_at from m_scan_cache where id = 1")
          ).rows[0];
          const prior: ScanResult | undefined = priorRow
            ? typeof priorRow.data === "string"
              ? JSON.parse(priorRow.data)
              : priorRow.data
            : undefined;
          const priorAgeMs = priorRow?.scanned_at
            ? Date.now() - new Date(priorRow.scanned_at).getTime()
            : Infinity;

          const result = await scanMemecoins(prior);
          await pool.query(
            `insert into m_scan_cache (id, data, scanned_at) values (1, $1, $2)
             on conflict (id) do update set data = $1, scanned_at = $2`,
            [JSON.stringify(result), result.scannedAt || new Date().toISOString()]
          );

          const stalePrior = priorAgeMs > 2 * TICK_MS;
          if (firstTick && stalePrior) {
            firstTick = false;
            server.config.logger.info(
              `[scan-scheduler] seeded from ${result.tokens.length} tokens (prior stale/missing); no alerts this tick.`
            );
            return;
          }
          firstTick = false;

          // Scan-data prefilter (free, no extra calls). The bar is traction
          // (band + liquidity + volume); the verdict gate is the cheap first
          // pass at "not obviously shady" — "trap risk" means thin/one-sided/
          // wash-traded/too-new by the scan's own scoring. requireExitable
          // tightens it to the cleanest tier (exitScore high, riskFlags <= 1).
          const qualifying = result.tokens.filter(
            (t) =>
              t.isNewSinceLastScan === true &&
              opts.bands.includes(t.ratingBand) &&
              t.liquidityUsd >= opts.minLiquidityUsd &&
              t.volume24h >= opts.minVolume24h &&
              (opts.requireExitable ? t.verdict === "exitable" : t.verdict !== "trap risk")
          );
          if (qualifying.length === 0) return;

          // Cross-tick suppression via the persistent new-coin ledger. A coin we
          // have already alerted on does NOT re-alert just because it rotated
          // back into the candidate feed (which is why big, long-lived coins like
          // JUP/PUMP kept re-surfacing under the old 6h window). It re-alerts ONLY
          // when it materially improves since we last showed it: a rating jump
          // (>= realertRatingPoints) OR a significant, notable mcap move
          // (>= realertMovePct). The ledger is independent of m_paper_alerts, so
          // the user dismissing or purging the alerts log never resurrects a coin
          // (the two bugs behind "same coins keep coming back even after I dismiss").
          const qualAddrs = qualifying.map((t) => t.address);
          const ledger = new Map<string, { last_rating: number | null; last_mcap: number | null }>(
            (
              await pool.query(
                `select address, last_rating, last_mcap from m_newcoin_ledger
                 where address = any($1::text[])`,
                [qualAddrs]
              )
            ).rows.map((r: any) => [r.address, r])
          );

          const candidates = qualifying
            .filter((t) => {
              const prev = ledger.get(t.address);
              if (!prev) return true; // never alerted → genuinely fresh to the user
              const ratingJump =
                prev.last_rating != null &&
                t.rating - prev.last_rating >= opts.realertRatingPoints;
              const mcapNow = t.marketCap || t.fdv || 0;
              const mcapMove =
                prev.last_mcap != null && prev.last_mcap > 0 && mcapNow > 0
                  ? Math.abs(mcapNow - prev.last_mcap) / prev.last_mcap >=
                    opts.realertMovePct / 100
                  : false;
              return ratingJump || mcapMove;
            })
            .slice(0, opts.cap);
          let n = 0;
          let shady = 0;
          let unverified = 0;
          for (const t of candidates) {
            // Rug screen (free RugCheck): skip coins flagged rugged / honeypot /
            // mint+freeze authority open / insider-bundled / top-holder
            // concentration. ok:false means RugCheck can't verify (often a
            // brand-new, not-yet-indexed mint); since the user wants
            // non-shady coins, "unverified" is treated as skip, just logged.
            // rugScore (RugCheck's normalized score) is also surfaced in the
            // alert so the user sees how clean each coin scored, not just pass/fail.
            let rugScore: number | null = null;
            if (opts.rugcheck) {
              const screen = await screenRugCheck(t.address);
              if (!screen.ok) {
                unverified++;
                server.config.logger.info(
                  `[scan-scheduler] ${t.symbol} skipped: RugCheck could not verify (${screen.error.slice(0, 80)}).`
                );
                continue;
              }
              if (screen.blocked) {
                shady++;
                server.config.logger.info(
                  `[scan-scheduler] ${t.symbol} skipped as shady: ${screen.blockers[0]}`
                );
                continue;
              }
              rugScore = screen.score;
            }
            await pool.query(
              `insert into m_paper_alerts (id, at, text, kind, scroll_to_id, dismissed)
               values ($1, now(), $2, 'newcoin', $3, false)
               on conflict (id) do nothing`,
              [
                `al_${Date.now().toString(36)}_${Math.round(
                  (n + 1) * 1000 + t.address.length
                ).toString(36)}`,
                formatNewCoinAlert(t, rugScore),
                t.address
              ]
            );
            // Record the snapshot at emit time as the improvement baseline: the
            // coin won't re-alert until its rating climbs realertRatingPoints or
            // its mcap moves realertMovePct from HERE. Survives alert-log purges.
            await pool.query(
              `insert into m_newcoin_ledger (address, last_alerted_at, last_rating, last_mcap)
               values ($1, now(), $2, $3)
               on conflict (address) do update set
                 last_alerted_at = now(),
                 last_rating = excluded.last_rating,
                 last_mcap = excluded.last_mcap`,
              [t.address, t.rating, t.marketCap || t.fdv || null]
            );
            n++;
          }
          if (n > 0 || shady > 0 || unverified > 0) {
            const dropped = qualifying.length - candidates.length;
            server.config.logger.info(
              `[scan-scheduler] ${n} new-coin alert(s) emitted` +
                `${shady > 0 ? `, ${shady} shady skipped` : ""}` +
                `${unverified > 0 ? `, ${unverified} unverified skipped` : ""}` +
                `${dropped > 0 ? `, ${dropped} capped/deduped` : ""}.`
            );
          }
        } catch (e) {
          server.config.logger.warn(
            `[scan-scheduler] tick failed: ${e instanceof Error ? e.message : String(e)}`
          );
        } finally {
          busy = false;
        }
      };

      await backfillLedger();
      setTimeout(tick, 45_000);
      setInterval(tick, TICK_MS);
      server.config.logger.info(
        `[scan-scheduler] enabled. First tick in 45s, then every ${opts.intervalMin} min. ` +
          `Bar: bands ${opts.bands.join("/")}, liq >= $${opts.minLiquidityUsd}, vol >= $${opts.minVolume24h}` +
          `, verdict ${opts.requireExitable ? "exitable-only" : "not-trap-risk"}` +
          `, rug screen ${opts.rugcheck ? "ON (RugCheck)" : "off"}` +
          `. Re-alert only on +${opts.realertRatingPoints} rating or ${opts.realertMovePct}% mcap move.`
      );
    }
  };
}

// ---------------------------------------------------------------------------
// CoinGecko proxy with a server-side response cache.
//
// CoinGecko Demo tier: 30 calls/min, 10k/month. The "Rotation context" panel
// on the Meme Coin tab calls /search/trending and the memecoin category
// endpoint every ~3 minutes; this cache absorbs burst reloads and HMR clicks
// so we never hit the limit. TTL is per-endpoint (trending is more volatile
// than category data).
//
// Auth: CoinGecko Demo keys go in x-cg-demo-api-key. Pro keys would use
// x-cg-pro-api-key, but Demo is what we provision.
// ---------------------------------------------------------------------------
type CacheEntry = { at: number; ttlMs: number; status: number; body: string };
const coingeckoCache = new Map<string, CacheEntry>();

function coingeckoPlugin(apiKey: string | undefined): Plugin {
  return {
    name: "coingecko-bridge",
    configureServer(server) {
      setIntegrationStatus("coingecko", {
        configured: !!apiKey,
        healthy: apiKey ? null : false,
        lastError: apiKey ? undefined : "COINGECKO_API_KEY not set in .env.local"
      });

      server.middlewares.use("/api/coingecko", async (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        if (!apiKey) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: "COINGECKO_API_KEY is not set in .env.local" }));
          return;
        }
        try {
          // Path after /api/coingecko/ is forwarded as-is to api.coingecko.com.
          // Example: /api/coingecko/search/trending → /api/v3/search/trending.
          const u = new URL(req.url ?? "/", "http://x");
          const path = u.pathname.replace(/^\/api\/coingecko\/?/, "");
          if (!path) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "missing path after /api/coingecko/" }));
            return;
          }
          const upstream = `https://api.coingecko.com/api/v3/${path}${u.search}`;
          // Per-endpoint TTL: trending = 2min, category/coins/markets = 5min.
          const ttlMs = path.startsWith("search/trending") ? 120_000 : 300_000;
          const cached = coingeckoCache.get(upstream);
          if (cached && Date.now() - cached.at < cached.ttlMs) {
            res.statusCode = cached.status;
            res.setHeader("X-CG-Cache", "hit");
            res.end(cached.body);
            return;
          }
          const upstreamRes = await fetch(upstream, {
            headers: { "x-cg-demo-api-key": apiKey, accept: "application/json" }
          });
          const text = await upstreamRes.text();
          if (upstreamRes.ok) {
            coingeckoCache.set(upstream, { at: Date.now(), ttlMs, status: upstreamRes.status, body: text });
            setIntegrationStatus("coingecko", { healthy: true, lastOkAt: new Date().toISOString() });
          } else {
            setIntegrationStatus("coingecko", {
              healthy: false,
              lastErrorAt: new Date().toISOString(),
              lastError: `upstream ${upstreamRes.status}: ${text.slice(0, 120)}`
            });
          }
          res.statusCode = upstreamRes.status;
          res.setHeader("X-CG-Cache", "miss");
          res.end(text);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setIntegrationStatus("coingecko", {
            healthy: false,
            lastErrorAt: new Date().toISOString(),
            lastError: msg
          });
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: msg }));
        }
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Static-config integrations (no live health checks, just "is the env var
// present?"). The integrationsStatusPlugin reads from `integrationStatus`
// for the live ones, plus this map for the still-or-already configured ones,
// and returns a single payload.
// ---------------------------------------------------------------------------
function seedConfiguredOnly(key: string, configured: boolean, note?: string) {
  setIntegrationStatus(key, {
    configured,
    healthy: configured ? true : null,
    lastError: configured ? undefined : note ?? "env var not set"
  });
}

// ---------------------------------------------------------------------------
// /api/integrations endpoint: powers the "Integrations" UI panel. Returns
// a snapshot of every integration's health, what powers what, and the env
// var name to set if something's missing. Read-only; never writes.
// ---------------------------------------------------------------------------
function integrationsStatusPlugin(env: Record<string, string>): Plugin {
  return {
    name: "integrations-status",
    configureServer(server) {
      // Seed the entries the user can verify at a glance. The PumpPortal and
      // CoinGecko entries get live updates from their own plugins.
      seedConfiguredOnly("brave", !!env.BRAVE_API_KEY, "BRAVE_API_KEY not set in .env.local");
      seedConfiguredOnly("tavily", !!env.TAVILY_API_KEY, "TAVILY_API_KEY not set in .env.local");
      seedConfiguredOnly("serper", !!env.SERPER_API_KEY, "SERPER_API_KEY not set in .env.local");
      seedConfiguredOnly("database", !!env.DATABASE_URL, "DATABASE_URL not set in .env.local");
      seedConfiguredOnly("solanaRpc", !!env.SOLANA_RPC_URL, "SOLANA_RPC_URL not set; falling back to public mainnet RPC");
      seedConfiguredOnly("helius", !!env.HELIUS_API_KEY, "HELIUS_API_KEY not set in .env.local");
      seedConfiguredOnly("ngrok", !!env.NGROK_TOKEN, "NGROK_TOKEN not set in .env.local");

      // Descriptors are static and shared with the UI so a panel render
      // doesn't need to special-case each key. Kept here (server side) so
      // a future plugin add only needs to update one file.
      const meta: Record<string, { label: string; powers: string; envVar: string; docs?: string }> = {
        brave: {
          label: "Brave Search",
          powers: "Tier-1 search for memecoin chatter + Reddit thread finder. Independent index (not Google-derived), largest free quota of the three providers.",
          envVar: "BRAVE_API_KEY",
          docs: "https://brave.com/search/api/"
        },
        tavily: {
          label: "Tavily",
          powers: "Tier-2 search for chatter / Reddit thread finder. Curated snippets when Brave returns empty.",
          envVar: "TAVILY_API_KEY",
          docs: "https://app.tavily.com"
        },
        serper: {
          label: "Serper",
          powers: "Tier-3 search fallback (Google SERP). Last-resort when Brave + Tavily both fail.",
          envVar: "SERPER_API_KEY",
          docs: "https://serper.dev"
        },
        database: {
          label: "Postgres",
          powers: "All Meme Coin state (positions, trade log, queue, scan cache, pump candidates)",
          envVar: "DATABASE_URL"
        },
        solanaRpc: {
          label: "Solana RPC",
          powers: "Wallet balance reads, transaction confirmation, swap delta reads",
          envVar: "SOLANA_RPC_URL"
        },
        helius: {
          label: "Helius",
          powers: "Smart-money webhooks (coming) + optional RPC upgrade",
          envVar: "HELIUS_API_KEY",
          docs: "https://dashboard.helius.dev"
        },
        ngrok: {
          label: "ngrok (dev only)",
          powers: "Public URL for Helius webhook receiver during local development",
          envVar: "NGROK_TOKEN",
          docs: "https://dashboard.ngrok.com/get-started/your-authtoken"
        },
        coingecko: {
          label: "CoinGecko",
          powers: "Rotation context panel (search-trending memes + memecoin sector flow)",
          envVar: "COINGECKO_API_KEY",
          docs: "https://www.coingecko.com/en/api/pricing"
        },
        pumpportal: {
          label: "PumpPortal",
          powers: "Real-time pump.fun mint stream (replaces the gated coins endpoint)",
          envVar: "(no key; uses DATABASE_URL for landing the stream)",
          docs: "https://pumpportal.fun/data-api/real-time/"
        }
      };

      server.middlewares.use("/api/integrations", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        const payload = Object.keys(meta).map((key) => ({
          key,
          ...meta[key],
          status: integrationStatus[key] ?? { configured: false, healthy: null }
        }));
        res.end(JSON.stringify({ ok: true, integrations: payload, at: new Date().toISOString() }));
      });
    }
  };
}

// /api/usage/summary: returns this calendar month's call count + cap + pct
// per metered provider, for the in-app rate-limit banner. Cheap query
// (indexed on (provider, called_at desc)), polled every ~60s by the banner.
function apiUsagePlugin(databaseUrl: string | undefined): Plugin {
  return {
    name: "api-usage-summary",
    configureServer(server) {
      server.middlewares.use("/api/usage/summary", async (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        if (!databaseUrl) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: "DATABASE_URL not set" }));
          return;
        }
        try {
          const pool = getUsagePool(databaseUrl);
          // Calendar-month aligned to the user's local clock would require
          // a tz field; just use UTC month for now. Tavily's quota resets
          // are also UTC-aligned per their docs.
          const { rows } = await pool.query(
            `select provider, count(*)::int as used
             from m_api_usage
             where called_at >= date_trunc('month', now() at time zone 'utc')
             group by provider`
          );
          const usedByProvider: Record<string, number> = {};
          for (const r of rows) usedByProvider[String(r.provider)] = Number(r.used);
          const summary = Object.entries(API_MONTHLY_CAPS).map(([provider, cap]) => {
            const used = usedByProvider[provider] ?? 0;
            return { provider, used, cap, pct: Math.round((used / cap) * 1000) / 10 };
          });
          res.end(JSON.stringify({ ok: true, summary, at: new Date().toISOString() }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: msg }));
        }
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const runtimePlugins = [
    localOnlyPlugin(),
    claudeCliPlugin(env.ENABLE_LOCAL_CLAUDE === "true"),
    bravePlugin(env.BRAVE_API_KEY, env.DATABASE_URL),
    tavilyPlugin(env.TAVILY_API_KEY, env.DATABASE_URL),
    serperPlugin(env.SERPER_API_KEY, env.DATABASE_URL),
    apiUsagePlugin(env.DATABASE_URL),
    marketDataPlugin(),
    memecoinDbPlugin(
      env.DATABASE_URL,
      env.SERVER_SCHEDULER_WATCH === "true",
      env.SERVER_SCHEDULER_SCAN === "true"
    ),
    solanaRpcPlugin(env.SOLANA_RPC_URL),
    jupiterPlugin(),
    geckoTerminalPlugin(),
    rugcheckPlugin(),
    pumpPortalCollectorPlugin(env.DATABASE_URL),
    positionWatchSchedulerPlugin(env.DATABASE_URL, env.SERVER_SCHEDULER_WATCH === "true"),
    scanSchedulerPlugin(env.DATABASE_URL, env.SERVER_SCHEDULER_SCAN === "true", {
      intervalMin: Number(env.SCAN_INTERVAL_MIN) || 15,
      bands: (env.NEWCOIN_BANDS || "A").split(",").map((s) => s.trim()).filter(Boolean),
      minLiquidityUsd: Number(env.NEWCOIN_MIN_LIQUIDITY_USD) || 50000,
      minVolume24h: Number(env.NEWCOIN_MIN_VOLUME_24H) || 75000,
      cap: Number(env.NEWCOIN_MAX_ALERTS_PER_SCAN) || 5,
      rugcheck: env.NEWCOIN_RUGCHECK !== "false",
      requireExitable: env.NEWCOIN_REQUIRE_EXITABLE !== "false",
      realertRatingPoints: Number(env.NEWCOIN_REALERT_RATING_POINTS) || 10,
      realertMovePct: Number(env.NEWCOIN_REALERT_MOVE_PCT) || 40
    }),
    coingeckoPlugin(env.COINGECKO_API_KEY),
    integrationsStatusPlugin(env)
  ].map(withPreviewSupport);

  return {
    plugins: [react(), ...runtimePlugins],
    server: {
      host: "127.0.0.1",
      port: 5176,
      strictPort: true
    },
    preview: {
      host: "127.0.0.1",
      port: 5176,
      strictPort: true
    },
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            minSize: 20_000,
            maxSize: 400_000,
            groups: [{ name: "vendor", test: /node_modules/ }]
          }
        }
      }
    }
  };
});
