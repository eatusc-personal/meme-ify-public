import { Coins, ShieldCheck, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiUsageBanner } from "./components/ApiUsageBanner";
import { MemeCoinPanel } from "./components/memecoin/MemeCoinPanel";
import { FlowChart } from "./components/flow/FlowChart";

type Tab = "memecoin" | "memecoin_flow";


const VALID_TABS: Tab[] = ["memecoin", "memecoin_flow"];

function readTabFromHash(): Tab {
  const fromHash = window.location.hash.slice(1);
  return (VALID_TABS as string[]).includes(fromHash) ? (fromHash as Tab) : "memecoin";
}

function App() {
  const [tab, setTab] = useState<Tab>(readTabFromHash);

  useEffect(() => {
    const onHashChange = () => setTab(readTabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const desired = `#${tab}`;
    if (window.location.hash !== desired) {
      window.history.replaceState(null, "", desired);
    }
  }, [tab]);

  const navItems: Array<{ id: Tab; label: string; icon: typeof Coins }> = [
    { id: "memecoin", label: "Meme Coin", icon: Coins },
    { id: "memecoin_flow", label: "Meme Coin Flow", icon: Workflow }
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>meme-ify</strong>
            <span>Meme coin trading</span>
          </div>
        </div>
        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <a
                href={`#${item.id}`}
                className={tab === item.id ? "nav-item active" : "nav-item"}
                key={item.id}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={18} />
          <span>Manual approval first. APIs can be added after workflows are stable.</span>
        </div>
      </aside>

      <main className="main">
        <ApiUsageBanner />
        <header className="topbar">
          <div>
            <p className="eyebrow">Meme coin trading</p>
            <h1>{navItems.find((item) => item.id === tab)?.label}</h1>
          </div>
        </header>


        {tab === "memecoin" && <MemeCoinPanel />}

        {tab === "memecoin_flow" && <FlowChart />}
      </main>
    </div>
  );
}

export default App;
