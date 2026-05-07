"use client";

import { useEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/AppHeader";

interface QueueEntry {
  id: string;
  vault: string;
  rel: string;
  event: "add" | "change" | "unlink" | "maintenance";
  status: "queued" | "active" | "done" | "failed" | "skipped";
  enqueuedAt: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  message?: string;
  retries?: number;
}

interface DashboardSnapshot {
  queued: QueueEntry[];
  active: QueueEntry[];
  recent: QueueEntry[];
  concurrency: number;
  updatedAt: number;
  maintenanceEnabled?: boolean;
}

function elapsed(from: number, to?: number): string {
  const ms = (to ?? Date.now()) - from;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function vaultName(vault: string): string {
  return vault.split("/").pop() ?? vault;
}

function EntryRow({
  entry,
  showElapsed,
  onCancel,
  onRetry,
}: {
  entry: QueueEntry;
  showElapsed?: boolean;
  onCancel?: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (entry.status !== "active") return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [entry.status]);

  const meta = entry.endedAt && entry.startedAt
    ? elapsed(entry.startedAt, entry.endedAt)
    : entry.startedAt && entry.status === "active"
    ? elapsed(entry.startedAt, now)
    : showElapsed && entry.enqueuedAt
    ? `+${elapsed(entry.enqueuedAt)}`
    : "";

  const isMaintenance = entry.event === "maintenance";

  return (
    <>
      <li className={entry.status === "active" ? "active" : ""}>
        <span className={`badge ${entry.event}`}>
          {isMaintenance ? <em>Maintenance pass</em> : entry.event}
        </span>
        <span>
          <span className="vault">{vaultName(entry.vault)}</span>
          <span className="path" style={isMaintenance ? { fontStyle: "italic", color: "var(--muted)" } : undefined}>
            {isMaintenance ? "automated maintenance" : entry.rel}
          </span>
          {entry.retries !== undefined && entry.retries > 0 && (
            <span style={{ color: "var(--warn)", fontSize: 11, display: "block" }}>
              retry #{entry.retries}
            </span>
          )}
        </span>
        <span className="meta" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <span className={`status ${entry.status}`}>{entry.status}</span>
          {meta && <span style={{ display: "block" }}>{meta}</span>}
          {(entry.status === "queued" || entry.status === "active") && onCancel && (
            <button
              onClick={() => onCancel(entry.id)}
              style={{
                fontSize: 10,
                padding: "1px 7px",
                border: "1px solid color-mix(in srgb, var(--err) 40%, transparent)",
                borderRadius: 4,
                background: "none",
                color: "var(--err)",
                cursor: "pointer",
                marginTop: 2,
              }}
            >
              Cancel
            </button>
          )}
          {entry.status === "failed" && onRetry && (
            <button
              onClick={() => onRetry(entry.id)}
              style={{
                fontSize: 10,
                padding: "1px 7px",
                border: "1px solid color-mix(in srgb, var(--warn) 40%, transparent)",
                borderRadius: 4,
                background: "none",
                color: "var(--warn)",
                cursor: "pointer",
                marginTop: 2,
              }}
            >
              Retry
            </button>
          )}
        </span>
      </li>
      {entry.status === "failed" && entry.message && (
        <li style={{ padding: "0 18px 8px", borderBottom: "1px solid var(--border)", display: "block" }}>
          <pre
            className="entry-error"
            style={{
              margin: 0,
              fontSize: 11,
              fontFamily: "var(--mono)",
              color: "var(--err)",
              background: "color-mix(in srgb, var(--err) 6%, transparent)",
              border: "1px solid color-mix(in srgb, var(--err) 18%, transparent)",
              borderRadius: 4,
              padding: "5px 10px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {entry.message}
          </pre>
        </li>
      )}
    </>
  );
}

export default function QueuePage() {
  const [snap, setSnap] = useState<DashboardSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [showOnlyFailed, setShowOnlyFailed] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data as string) as DashboardSnapshot;
        setSnap(parsed);
      } catch { /* ignore */ }
    };
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, []);

  async function cancelJob(id: string): Promise<void> {
    await fetch(`/api/queue/${id}/cancel`, { method: "POST" });
  }

  async function retryJob(id: string): Promise<void> {
    await fetch(`/api/queue/${id}/retry`, { method: "POST" });
  }

  const totalDone = snap ? snap.recent.filter((e) => e.status === "done").length : 0;
  const totalFailed = snap ? snap.recent.filter((e) => e.status === "failed").length : 0;

  const filteredRecent = showOnlyFailed
    ? (snap?.recent ?? []).filter(e => e.status === "failed")
    : (snap?.recent ?? []);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <AppHeader active="queue" />

      <div ref={bodyRef} className="drawer-body" style={{ flex: 1, maxWidth: 900, margin: "0 auto", width: "100%", padding: "24px 20px 60px" }}>
        {!snap && (
          <div className="empty">{connected ? "Loading…" : "Connecting to server…"}</div>
        )}

        {snap && (
          <>
            <div className="summary">
              <div className="card">
                <div className="label">Active</div>
                <div className="value" style={{ color: snap.active.length > 0 ? "var(--warn)" : undefined }}>
                  {snap.active.length}
                  <span className="value-sub">/ {snap.concurrency}</span>
                </div>
              </div>
              <div className="card">
                <div className="label">Queued</div>
                <div className="value">{snap.queued.length}</div>
              </div>
              <div className="card">
                <div className="label">Done</div>
                <div className="value" style={{ color: totalDone > 0 ? "var(--ok)" : undefined }}>{totalDone}</div>
              </div>
              <div className="card">
                <div className="label">Failed</div>
                <div className="value" style={{ color: totalFailed > 0 ? "var(--err)" : undefined }}>{totalFailed}</div>
              </div>
            </div>

            {snap.active.length > 0 && (
              <section className="panel">
                <h2>Active <span className="count">{snap.active.length}</span></h2>
                <ul className="entries">
                  {snap.active.map((e) => (
                    <EntryRow key={e.id} entry={e} onCancel={cancelJob} />
                  ))}
                </ul>
              </section>
            )}

            <section className="panel">
              <h2>Queued <span className="count">{snap.queued.length}</span></h2>
              {snap.queued.length === 0
                ? <div className="empty">No files pending.</div>
                : <ul className="entries">
                    {snap.queued.map((e) => (
                      <EntryRow key={e.id} entry={e} showElapsed onCancel={cancelJob} />
                    ))}
                  </ul>}
            </section>

            <section className="panel">
              <h2>
                Recent <span className="count">{snap.recent.length}</span>
                <div className="filter-row" style={{ marginLeft: "auto" }}>
                  <button
                    className={`filter-btn${showOnlyFailed ? " active" : ""}`}
                    onClick={() => setShowOnlyFailed(v => !v)}
                    style={{
                      fontSize: 11,
                      padding: "2px 10px",
                      border: `1px solid ${showOnlyFailed ? "color-mix(in srgb, var(--err) 50%, transparent)" : "var(--border)"}`,
                      borderRadius: 999,
                      background: showOnlyFailed ? "color-mix(in srgb, var(--err) 10%, transparent)" : "none",
                      color: showOnlyFailed ? "var(--err)" : "var(--muted)",
                      cursor: "pointer",
                      fontFamily: "var(--mono)",
                    }}
                  >
                    {showOnlyFailed ? "Showing: Failures" : "Show: All"}
                  </button>
                </div>
              </h2>
              {filteredRecent.length === 0
                ? <div className="empty">{showOnlyFailed ? "No failed entries." : "No completed entries yet."}</div>
                : <ul className="entries">
                    {filteredRecent.map((e) => (
                      <EntryRow key={e.id} entry={e} onCancel={cancelJob} onRetry={retryJob} />
                    ))}
                  </ul>}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
