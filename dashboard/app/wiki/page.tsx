"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown, stripFrontmatter } from "@/components/markdown";

// ── Types ────────────────────────────────────────────────────────────────────
type EntryStatus = "queued" | "active" | "done" | "failed" | "skipped";
type EventType = "add" | "change" | "unlink";

interface Entry {
  id: string; vault: string; rel: string; event: EventType; status: EntryStatus;
  enqueuedAt: number; startedAt?: number; endedAt?: number; exitCode?: number | null; message?: string;
}
interface Snapshot { queued: Entry[]; active: Entry[]; recent: Entry[]; concurrency: number; updatedAt: number; }
interface SearchResult { path: string; title: string; snippet: string; }
interface WikiPage { path: string; content: string; }

const EMPTY_SNAP: Snapshot = { queued: [], active: [], recent: [], concurrency: 0, updatedAt: 0 };
const LOG_MAX = 500;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function vaultName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function logLineClass(line: string): string {
  const l = line.toLowerCase();
  if (l.includes("failed") || l.includes("error") || l.includes("spawn failed")) return "log-err";
  if (l.includes(" done ") || l.includes("✓") || l.includes(" ok") || l.includes("complete")) return "log-ok";
  if (l.includes("skipped") || l.includes("skipping")) return "log-skip";
  if (l.includes("[stdout]") || l.includes("[stderr]")) return "log-sub";
  return "";
}

// "wiki/concepts/foo.md" → "/wiki/concepts/foo"
function pathToUrl(rel: string): string {
  if (!rel || rel === "wiki/index.md") return "/wiki";
  const stripped = rel.replace(/^wiki\//, "").replace(/\.md$/, "");
  if (!stripped) return "/wiki";
  return "/wiki/" + stripped.split("/").map(encodeURIComponent).join("/");
}

// Read current URL → wiki page path, or null for wiki home
function urlToWikiPath(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const queryPath = params.get("path");
  if (queryPath) return queryPath;
  let pathname: string;
  try { pathname = decodeURIComponent(window.location.pathname); } catch { return null; }
  const trimmed = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  // Must be under /wiki/
  if (!trimmed.startsWith("wiki/")) return null;
  const sub = trimmed.slice("wiki/".length);
  if (!sub) return null;
  return sub.endsWith(".md") ? `wiki/${sub}` : `wiki/${sub}.md`;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Page() {
  const [panel, setPanel] = useState<"none" | "queue" | "logs">("none");
  const [now, setNow] = useState(() => Date.now());
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAP);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Wiki state
  const [wikiPage, setWikiPage] = useState<WikiPage | null>(null);
  const [wikiTitle, setWikiTitle] = useState("");
  const [wikiBody, setWikiBody] = useState("");
  const [wikiHistory, setWikiHistory] = useState<Array<{ path: string; title: string }>>([]);
  const [wikiLoading, setWikiLoading] = useState(false);
  const [wikiError, setWikiError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  // Log state
  const [logLines, setLogLines] = useState<string[]>([]);
  const logBodyRef = useRef<HTMLDivElement>(null);
  const logBottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(true);

  // Load a wiki page by path
  const loadPage = useCallback(async (path: string, opts?: { pushHistory?: boolean; updateUrl?: boolean }) => {
    const pushHistory = opts?.pushHistory ?? true;
    const updateUrl = opts?.updateUrl ?? true;
    setWikiLoading(true);
    setWikiError("");
    setSearchResults(null);
    setSearchQuery("");
    try {
      const r = await fetch(`/api/wiki?path=${encodeURIComponent(path)}`);
      if (!r.ok) { setWikiError(`Failed to load ${path}`); return; }
      const data = await r.json() as WikiPage;
      const { body, title } = stripFrontmatter(data.content);
      if (pushHistory && wikiPage) {
        setWikiHistory((h) => [...h, { path: wikiPage.path, title: wikiTitle }]);
      }
      setWikiPage(data);
      setWikiTitle(title || path.split("/").pop()?.replace(".md", "") || path);
      setWikiBody(body);
      if (updateUrl && typeof window !== "undefined") {
        const newUrl = pathToUrl(data.path);
        const cur = window.location.pathname + window.location.search;
        if (cur !== newUrl) history.pushState(null, "", newUrl);
      }
    } catch {
      setWikiError("Network error loading page");
    } finally {
      setWikiLoading(false);
    }
  }, [wikiPage, wikiTitle]);

  // Load page by stem (wikilink)
  const loadByStem = useCallback(async (stem: string) => {
    setWikiLoading(true);
    setWikiError("");
    setSearchResults(null);
    try {
      const r = await fetch(`/api/wiki/by-stem?stem=${encodeURIComponent(stem)}`);
      if (!r.ok) { setWikiError(`Page not found: ${stem}`); return; }
      const data = await r.json() as WikiPage;
      const { body, title } = stripFrontmatter(data.content);
      if (wikiPage) setWikiHistory((h) => [...h, { path: wikiPage.path, title: wikiTitle }]);
      setWikiPage(data);
      setWikiTitle(title || stem);
      setWikiBody(body);
      if (typeof window !== "undefined") {
        const newUrl = pathToUrl(data.path);
        const cur = window.location.pathname + window.location.search;
        if (cur !== newUrl) history.pushState(null, "", newUrl);
      }
    } catch {
      setWikiError("Network error");
    } finally {
      setWikiLoading(false);
    }
  }, [wikiPage, wikiTitle]);

  // Go back in wiki history
  const goBack = useCallback(() => {
    if (wikiHistory.length === 0) {
      setWikiPage(null);
      setWikiTitle("");
      setWikiBody("");
      setSearchResults(null);
      if (typeof window !== "undefined" && window.location.pathname !== "/wiki") {
        history.pushState(null, "", "/wiki");
      }
      return;
    }
    const prev = wikiHistory[wikiHistory.length - 1];
    setWikiHistory((h) => h.slice(0, -1));
    void loadPage(prev.path, { pushHistory: false });
  }, [wikiHistory, loadPage]);

  // Go to wiki home (centered search)
  const goHome = useCallback(() => {
    setWikiPage(null);
    setWikiTitle("");
    setWikiBody("");
    setWikiHistory([]);
    setSearchResults(null);
    setSearchQuery("");
    setWikiError("");
    if (typeof window !== "undefined" && window.location.pathname !== "/wiki") {
      history.pushState(null, "", "/wiki");
    }
  }, []);

  // Search
  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setSearchLoading(true);
    setSearchResults(null);
    try {
      const r = await fetch(`/api/wiki/search?q=${encodeURIComponent(q)}`);
      const data = await r.json() as { results: SearchResult[] };
      setSearchResults(data.results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  // On mount: read URL → wiki path. Listen for popstate (back/forward).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const initial = urlToWikiPath();
    if (initial) void loadPage(initial, { pushHistory: false, updateUrl: false });

    const onPop = () => {
      const target = urlToWikiPath();
      if (!target) {
        setWikiPage(null);
        setWikiTitle("");
        setWikiBody("");
        setWikiHistory([]);
        setSearchResults(null);
        setSearchQuery("");
        setWikiError("");
        return;
      }
      setWikiHistory([]);
      void loadPage(target, { pushHistory: false, updateUrl: false });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Queue SSE
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    const connect = () => {
      if (cancelled) return;
      source = new EventSource("/api/events");
      source.onmessage = (ev) => { try { setSnapshot(JSON.parse(ev.data as string) as Snapshot); } catch { /* ignore */ } };
      source.onerror = () => {
        source?.close();
        if (cancelled) return;
        reconnectTimer.current = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => { cancelled = true; if (reconnectTimer.current) clearTimeout(reconnectTimer.current); source?.close(); };
  }, []);

  // Log SSE
  useEffect(() => {
    const source = new EventSource("/api/logs");
    source.addEventListener("init", (ev) => { try { setLogLines(JSON.parse(ev.data as string) as string[]); } catch { /* ignore */ } });
    source.addEventListener("line", (ev) => {
      try {
        const line = JSON.parse(ev.data as string) as string;
        setLogLines((prev) => { const next = [...prev, line]; return next.length > LOG_MAX ? next.slice(-LOG_MAX) : next; });
      } catch { /* ignore */ }
    });
    return () => source.close();
  }, []);

  useEffect(() => {
    if (autoScrollRef.current) logBottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [logLines]);

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(id); }, []);

  const onWikilink = useCallback((stem: string) => { void loadByStem(stem); }, [loadByStem]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const closePanel = () => setPanel("none");
  const togglePanel = (p: "queue" | "logs") => setPanel((cur) => cur === p ? "none" : p);

  return (
    <div className="app">
      <header className="app-header">
        <button className="header-title-btn" onClick={goHome}>
          Personal Knowledge Base
        </button>
        <nav className="header-nav">
          <a className="nav-btn" href="/">
            Graph
          </a>
          <a className="nav-btn" href="/live-notes">
            Live Notes
          </a>
          <button
            className={`nav-btn ${panel === "queue" ? "active" : ""}`}
            onClick={() => togglePanel("queue")}
          >
            Queue
            {snapshot.active.length + snapshot.queued.length > 0 && (
              <span className="nav-badge">{snapshot.active.length + snapshot.queued.length}</span>
            )}
          </button>
          <button
            className={`nav-btn ${panel === "logs" ? "active" : ""}`}
            onClick={() => togglePanel("logs")}
          >
            Logs
          </button>
        </nav>
      </header>

      {(() => {
        const isHome = !wikiPage && !wikiLoading && !wikiError && searchResults === null;
        if (isHome) {
          return (
            <main className="home-main">
              <div className="home-hero">
                <h1 className="home-title">Personal Knowledge Base</h1>
                <form
                  className="home-search-form"
                  onSubmit={(e) => { e.preventDefault(); void runSearch(searchQuery); }}
                >
                  <input
                    autoFocus
                    className="home-search-input"
                    type="text"
                    placeholder="Search the knowledge base…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  <button type="submit" className="home-search-btn" disabled={searchLoading}>
                    {searchLoading ? "Searching…" : "Search"}
                  </button>
                </form>
              </div>
            </main>
          );
        }
        return (
          <main className="wiki-main">
            <div className="wiki-search-bar">
              <form onSubmit={(e) => { e.preventDefault(); void runSearch(searchQuery); }}>
                <input
                  className="wiki-search-input"
                  type="text"
                  placeholder="Search the knowledge base…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <button type="submit" className="wiki-search-btn" disabled={searchLoading}>
                  {searchLoading ? "Searching…" : "Search"}
                </button>
                {(searchResults !== null || searchQuery) && (
                  <button type="button" className="wiki-search-clear" onClick={() => { setSearchResults(null); setSearchQuery(""); }}>✕</button>
                )}
              </form>
            </div>

            {(wikiHistory.length > 0 || (wikiPage && wikiPage.path !== "wiki/index.md")) && (
              <div className="wiki-breadcrumb">
                <button className="crumb-btn" onClick={goHome}>Home</button>
                {wikiHistory.map((h, i) => (
                  <span key={i}>
                    <span className="crumb-sep"> › </span>
                    <button className="crumb-btn" onClick={() => { setWikiHistory((hist) => hist.slice(0, i)); void loadPage(h.path, { pushHistory: false }); }}>{h.title}</button>
                  </span>
                ))}
                {wikiPage && wikiPage.path !== "wiki/index.md" && (
                  <><span className="crumb-sep"> › </span><span className="crumb-current">{wikiTitle}</span></>
                )}
              </div>
            )}

            {searchResults !== null && (
              <div className="wiki-search-results">
                <div className="search-results-header">
                  {searchResults.length === 0 ? "No results found." : `${searchResults.length} result${searchResults.length === 1 ? "" : "s"}`}
                </div>
                {searchResults.map((r, i) => (
                  <div key={i} className="search-result" onClick={() => void loadPage(r.path)}>
                    <div className="search-result-title">{r.title}</div>
                    <div className="search-result-path">{r.path}</div>
                    {r.snippet && <div className="search-result-snippet">{r.snippet}</div>}
                  </div>
                ))}
              </div>
            )}

            {wikiError && <div className="wiki-error">{wikiError}</div>}
            {wikiLoading && <div className="wiki-loading">Loading…</div>}
            {!wikiLoading && !wikiError && searchResults === null && wikiBody && (
              <div className="wiki-content">
                {wikiTitle && <h1 className="wiki-page-title">{wikiTitle}</h1>}
                <Markdown content={wikiBody} onWikilink={onWikilink} />
                {wikiHistory.length > 0 && (
                  <button className="wiki-back-btn" onClick={goBack}>← Back</button>
                )}
              </div>
            )}
          </main>
        );
      })()}

      {/* Drawers — slide in over the wiki */}
      {panel !== "none" && <div className="drawer-backdrop" onClick={closePanel} />}

      <aside className={`drawer ${panel === "queue" ? "open" : ""}`}>
        <div className="drawer-header">
          <span>Ingest Queue</span>
          <button className="drawer-close" onClick={closePanel}>✕</button>
        </div>
        <div className="drawer-body">
          <div className="summary">
            <div className="card"><div className="label">Processing</div>
              <div className="value">{snapshot.active.length}<span className="value-sub">/{snapshot.concurrency || "—"}</span></div></div>
            <div className="card"><div className="label">Queued</div><div className="value">{snapshot.queued.length}</div></div>
            <div className="card"><div className="label">Recent</div><div className="value">{snapshot.recent.length}</div></div>
          </div>

          <section className="panel">
            <h2>Processing now <span className="count">{snapshot.active.length}</span></h2>
            {snapshot.active.length === 0 ? <div className="empty">Nothing processing.</div> : (
              <ul className="entries">{snapshot.active.map((e) => (
                <li key={e.id} className="active">
                  <span className={`badge ${e.event}`}>{e.event}</span>
                  <span className="path"><span className="vault">{vaultName(e.vault)} ›</span>{e.rel}</span>
                  <span className="meta">{e.startedAt ? formatDuration(now - e.startedAt) : "—"}</span>
                </li>
              ))}</ul>
            )}
          </section>

          <section className="panel">
            <h2>Queued <span className="count">{snapshot.queued.length}</span></h2>
            {snapshot.queued.length === 0 ? <div className="empty">Queue is empty.</div> : (
              <ul className="entries">{snapshot.queued.map((e) => (
                <li key={e.id}>
                  <span className={`badge ${e.event}`}>{e.event}</span>
                  <span className="path"><span className="vault">{vaultName(e.vault)} ›</span>{e.rel}</span>
                  <span className="meta">waiting {formatDuration(now - e.enqueuedAt)}</span>
                </li>
              ))}</ul>
            )}
          </section>

          <section className="panel">
            <h2>Recent <span className="count">{snapshot.recent.length}</span></h2>
            {snapshot.recent.length === 0 ? <div className="empty">No completed ingests yet.</div> : (
              <ul className="entries">{snapshot.recent.map((e) => (
                <li key={e.id}>
                  <span className={`badge ${e.event}`}>{e.event}</span>
                  <span className="path"><span className="vault">{vaultName(e.vault)} ›</span>{e.rel}</span>
                  <span className="meta">
                    <span className={`status ${e.status}`}>{e.status}</span>
                    {e.startedAt && e.endedAt ? ` · ${formatDuration(e.endedAt - e.startedAt)}` : ""}
                  </span>
                </li>
              ))}</ul>
            )}
          </section>
        </div>
      </aside>

      <aside className={`drawer ${panel === "logs" ? "open" : ""}`}>
        <div className="drawer-header">
          <span>Live Logs <span className="drawer-count">{logLines.length}</span></span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="log-scroll-btn" onClick={() => {
              const next = !autoScroll; setAutoScroll(next); autoScrollRef.current = next;
              if (next) logBottomRef.current?.scrollIntoView({ behavior: "instant" });
            }}>{autoScroll ? "auto-scroll on" : "auto-scroll off"}</button>
            <button className="drawer-close" onClick={closePanel}>✕</button>
          </div>
        </div>
        <div className="log-body drawer-log-body" ref={logBodyRef} onScroll={() => {
          const el = logBodyRef.current; if (!el) return;
          const at = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          autoScrollRef.current = at; setAutoScroll(at);
        }}>
          {logLines.length === 0 ? <div className="empty">No log output yet.</div> : (
            logLines.map((line, i) => <div key={i} className={`log-line ${logLineClass(line)}`}>{line}</div>)
          )}
          <div ref={logBottomRef} />
        </div>
      </aside>
    </div>
  );
}
