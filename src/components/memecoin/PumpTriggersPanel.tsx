import { Sparkles } from "lucide-react";
import { useState } from "react";
import { type PumpEvent } from "../../lib/pumpwatch";
import { useCollapsibleSection } from "../../hooks/useCollapsibleSection";
import { PanelTitle } from "../PanelTitle";

// The pump-trigger log: coins that ran up 50%+, each with a social-media scan
// of what may have caused it. Built by logPumps() in MemeCoinPanel.
export function PumpTriggersPanel({
  events,
  onShowCoin
}: {
  events: PumpEvent[];
  onShowCoin: (address: string) => void;
}) {
  const section = useCollapsibleSection("pump-triggers");
  // Paged so the section stays compact; matches the closed-positions pager.
  const PAGE_SIZE = 10;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(events.length / PAGE_SIZE));
  const pageSafe = Math.min(Math.max(0, page), pageCount - 1);
  const paged = events.slice(pageSafe * PAGE_SIZE, pageSafe * PAGE_SIZE + PAGE_SIZE);

  return (
    <section className={`panel wide ${section.className}`}>
      <PanelTitle
        icon={Sparkles}
        title="Pump triggers"
        collapsed={section.collapsed}
        onToggle={section.toggle}
      />
      <p className="muted">
        When a coin you hold crosses +50% from entry, or a scanned coin is up
        50%+ over 24h, the tool runs one social-media scan to capture what may
        have triggered it. A research log of what moves coins. Each coin is
        logged once per day; stored locally in this browser.
      </p>
      {events.length === 0 ? (
        <p className="empty">
          No pump triggers logged yet. They appear after a held position spikes
          or a scan turns up a big mover.
        </p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Coin</th>
                  <th>Detected</th>
                  <th>Trigger</th>
                  <th>Social chatter</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <button
                        className="mc-tickerlink"
                        title="Open this coin"
                        onClick={() => onShowCoin(e.address)}
                      >
                        {e.symbol}
                      </button>
                    </td>
                    <td>{new Date(e.detectedAt).toLocaleString()}</td>
                    <td>{e.trigger}</td>
                    <td>
                      {e.chatter
                        ? e.chatter.total === 0
                          ? "no posts found"
                          : `${e.chatter.total} posts (${e.chatter.byPlatform.x} X, ${e.chatter.byPlatform.reddit} Reddit)`
                        : `social scan failed${e.chatterError ? `: ${e.chatterError}` : ""}`}
                      {e.chatter && e.chatter.items[0] && (
                        <>
                          {" · "}
                          <a href={e.chatter.items[0].url} target="_blank" rel="noreferrer">
                            top post
                          </a>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <div className="mc-pager">
              <button
                className="ghost-button"
                disabled={pageSafe === 0}
                onClick={() => setPage(pageSafe - 1)}
              >
                Prev
              </button>
              <span>
                Page {pageSafe + 1} of {pageCount} · {events.length} events
              </span>
              <button
                className="ghost-button"
                disabled={pageSafe >= pageCount - 1}
                onClick={() => setPage(pageSafe + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
