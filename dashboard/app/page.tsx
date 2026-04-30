"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

type AppView = "wiki" | "queue" | "logs";
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

// ── Markdown renderer ────────────────────────────────────────────────────────

function stripFrontmatter(md: string): { body: string; title: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { body: md, title: "" };
  const fm = m[1];
  const body = m[2];
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return { body, title: titleMatch?.[1] ?? "" };
}

function renderInline(
  text: string,
  onWikilink: (stem: string, display: string) => void,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let s = text;
  let k = 0;
  while (s.length > 0) {
    const wm = s.match(/^\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/);
    if (wm) {
      const stem = wm[1].trim(); const display = wm[2]?.trim() || stem;
      parts.push(<span key={k++} className="wiki-link" onClick={() => onWikilink(stem, display)}>{display}</span>);
      s = s.slice(wm[0].length); continue;
    }
    const bm = s.match(/^\*\*(.+?)\*\*/); if (bm) { parts.push(<strong key={k++}>{bm[1]}</strong>); s = s.slice(bm[0].length); continue; }
    const im = s.match(/^\*(.+?)\*/); if (im) { parts.push(<em key={k++}>{im[1]}</em>); s = s.slice(im[0].length); continue; }
    const cm = s.match(/^`(.+?)`/); if (cm) { parts.push(<code key={k++} className="md-code">{cm[1]}</code>); s = s.slice(cm[0].length); continue; }
    const lm = s.match(/^\[([^\]]+)\]\(([^)]+)\)/); if (lm) { parts.push(<a key={k++} href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a>); s = s.slice(lm[0].length); continue; }
    const next = s.search(/\[\[|\*\*|\*(?!\*)|`|\[/);
    if (next === -1) { parts.push(s); s = ""; }
    else if (next === 0) { parts.push(s[0]); s = s.slice(1); }
    else { parts.push(s.slice(0, next)); s = s.slice(next); }
  }
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

function Markdown({ content, onWikilink }: { content: string; onWikilink: (stem: string, display: string) => void }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      elements.push(<pre key={i} className="md-pre"><code className={lang ? `lang-${lang}` : ""}>{codeLines.join("\n")}</code></pre>);
      i++; continue;
    }

    // Headings
    const hm = line.match(/^(#{1,4})\s+(.*)/);
    if (hm) {
      const lvl = hm[1].length;
      const Tag = `h${lvl}` as "h1" | "h2" | "h3" | "h4";
      elements.push(<Tag key={i} className="md-heading">{renderInline(hm[2], onWikilink)}</Tag>);
      i++; continue;
    }

    // HR
    if (line.match(/^---+$/) || line.match(/^\*\*\*+$/) || line.match(/^___+$/)) {
      elements.push(<hr key={i} className="md-hr" />); i++; continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const qLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) { qLines.push(lines[i].slice(2)); i++; }
      elements.push(<blockquote key={i} className="md-blockquote">{qLines.map((l, j) => <p key={j}>{renderInline(l, onWikilink)}</p>)}</blockquote>);
      continue;
    }

    // Unordered list
    if (line.match(/^[-*+]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*+]\s+/)) { items.push(lines[i].replace(/^[-*+]\s+/, "")); i++; }
      elements.push(<ul key={i} className="md-ul">{items.map((item, j) => <li key={j}>{renderInline(item, onWikilink)}</li>)}</ul>);
      continue;
    }

    // Ordered list
    if (line.match(/^\d+\.\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) { items.push(lines[i].replace(/^\d+\.\s+/, "")); i++; }
      elements.push(<ol key={i} className="md-ol">{items.map((item, j) => <li key={j}>{renderInline(item, onWikilink)}</li>)}</ol>);
      continue;
    }

    // Table (basic)
    if (line.includes("|") && lines[i + 1]?.match(/^[\s|:-]+$/)) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes("|")) { tableLines.push(lines[i]); i++; }
      const [headerRow, , ...bodyRows] = tableLines;
      const headers = headerRow.split("|").filter((c) => c.trim() !== "").map((c) => c.trim());
      const rows = bodyRows.map((r) => r.split("|").filter((c) => c.trim() !== "").map((c) => c.trim()));
      elements.push(
        <div key={i} className="md-table-wrap">
          <table className="md-table">
            <thead><tr>{headers.map((h, j) => <th key={j}>{renderInline(h, onWikilink)}</th>)}</tr></thead>
            <tbody>{rows.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{renderInline(cell, onWikilink)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      continue;
    }

    // Empty line
    if (line.trim() === "") { i++; continue; }

    // Paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^#{1,4}\s/) &&
      !lines[i].startsWith("```") &&
      !lines[i].match(/^[-*+]\s/) &&
      !lines[i].match(/^\d+\.\s/) &&
      !lines[i].startsWith("> ") &&
      !lines[i].match(/^---+$/)
    ) { paraLines.push(lines[i]); i++; }
    if (paraLines.length > 0) {
      elements.push(<p key={i} className="md-para">{renderInline(paraLines.join(" "), onWikilink)}</p>);
    }
  }

  return <div className="md-body">{elements}</div>;
}

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

// ── Main component ────────────────────────────────────────────────────────────

export default function Page() {
  const [view, setView] = useState<AppView>("wiki");
  const [connected, setConnected] = useState(false);
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
  const loadPage = useCallback(async (path: string, pushHistory = true) => {
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
    } catch {
      setWikiError("Network error");
    } finally {
      setWikiLoading(false);
    }
  }, [wikiPage, wikiTitle]);

  // Go back in wiki history
  const goBack = useCallback(() => {
    if (wikiHistory.length === 0) {
      // Back to home (index)
      setWikiPage(null);
      setWikiTitle("");
      setWikiBody("");
      setSearchResults(null);
      return;
    }
    const prev = wikiHistory[wikiHistory.length - 1];
    setWikiHistory((h) => h.slice(0, -1));
    void loadPage(prev.path, false);
  }, [wikiHistory, loadPage]);

  // Go to home (wiki index)
  const goHome = useCallback(() => {
    setWikiPage(null);
    setWikiTitle("");
    setWikiBody("");
    setWikiHistory([]);
    setSearchResults(null);
    setSearchQuery("");
    setWikiError("");
    void loadIndex();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadIndex = useCallback(async () => {
    setWikiLoading(true);
    setWikiError("");
    try {
      const r = await fetch("/api/wiki");
      if (!r.ok) { setWikiError("No wiki found — use /kb to set one up in Claude."); return; }
      const data = await r.json() as WikiPage;
      const { body, title } = stripFrontmatter(data.content);
      setWikiPage(data);
      setWikiTitle(title || "Index");
      setWikiBody(body);
      setWikiHistory([]);
    } catch {
      setWikiError("Could not connect to server");
    } finally {
      setWikiLoading(false);
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

  // Load index on mount and when switching to wiki view
  useEffect(() => {
    if (view === "wiki" && !wikiPage && !wikiLoading) {
      void loadIndex();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Queue SSE
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    const connect = () => {
      if (cancelled) return;
      source = new EventSource("/api/events");
      source.onopen = () => setConnected(true);
      source.onmessage = (ev) => { try { setSnapshot(JSON.parse(ev.data as string) as Snapshot); } catch { /* ignore */ } };
      source.onerror = () => {
        setConnected(false); source?.close();
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

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <button className={`header-title-btn ${view === "wiki" ? "active" : ""}`} onClick={() => { setView("wiki"); goHome(); }}>
            Personal Knowledge Base
          </button>
        </div>
        <nav className="header-nav">
          <button className={`nav-btn ${view === "wiki" ? "active" : ""}`} onClick={() => setView("wiki")}>Wiki</button>
          <button className={`nav-btn ${view === "queue" ? "active" : ""}`} onClick={() => setView("queue")}>
            Queue {snapshot.active.length + snapshot.queued.length > 0 && (
              <span className="nav-badge">{snapshot.active.length + snapshot.queued.length}</span>
            )}
          </button>
          <button className={`nav-btn ${view === "logs" ? "active" : ""}`} onClick={() => setView("logs")}>Logs</button>
        </nav>
        <div className="header-right">
          <span className={`status-pill ${connected ? "live" : ""}`}>
            <span className="dot" />
            {connected ? "live" : "reconnecting…"}
          </span>
        </div>
      </header>

      {view === "wiki" && (
        <main className="wiki-main">
          {/* Search bar */}
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

          {/* Breadcrumb */}
          {(wikiHistory.length > 0 || (wikiPage && wikiPage.path !== "wiki/index.md")) && (
            <div className="wiki-breadcrumb">
              <button className="crumb-btn" onClick={goHome}>Home</button>
              {wikiHistory.map((h, i) => (
                <span key={i}>
                  <span className="crumb-sep"> › </span>
                  <button className="crumb-btn" onClick={() => { setWikiHistory((hist) => hist.slice(0, i)); void loadPage(h.path, false); }}>{h.title}</button>
                </span>
              ))}
              {wikiPage && wikiPage.path !== "wiki/index.md" && (
                <><span className="crumb-sep"> › </span><span className="crumb-current">{wikiTitle}</span></>
              )}
            </div>
          )}

          {/* Search results */}
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

          {/* Page content or loading */}
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
      )}

      {view === "queue" && (
        <main className="queue-main">
          <div className="summary">
            <div className="card"><div className="label">Processing</div>
              <div className="value">{snapshot.active.length}<span className="value-sub">/ {snapshot.concurrency || "—"}</span></div></div>
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
        </main>
      )}

      {view === "logs" && (
        <main className="logs-main">
          <div className="log-header-bar">
            <span className="log-count">{logLines.length} lines</span>
            <button className="log-scroll-btn" onClick={() => {
              const next = !autoScroll; setAutoScroll(next); autoScrollRef.current = next;
              if (next) logBottomRef.current?.scrollIntoView({ behavior: "instant" });
            }}>
              {autoScroll ? "auto-scroll on" : "auto-scroll off"}
            </button>
          </div>
          <div className="log-body" ref={logBodyRef} onScroll={() => {
            const el = logBodyRef.current; if (!el) return;
            const at = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            autoScrollRef.current = at; setAutoScroll(at);
          }}>
            {logLines.length === 0 ? <div className="empty">No log output yet.</div> : (
              logLines.map((line, i) => <div key={i} className={`log-line ${logLineClass(line)}`}>{line}</div>)
            )}
            <div ref={logBottomRef} />
          </div>
        </main>
      )}
    </div>
  );
}
