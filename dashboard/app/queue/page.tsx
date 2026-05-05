"use client";

import { useEffect, useRef, useState } from "react";

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

function EntryRow({ entry, showElapsed }: { entry: QueueEntry; showElapsed?: boolean }) {
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
    <li className={entry.status === "active" ? "active" : ""}>
      <span className={`badge ${entry.event}`}>
        {isMaintenance ? <em>Maintenance pass</em> : entry.event}
      </span>
      <span>
        <span className="vault">{vaultName(entry.vault)}</span>
        <span className="path" style={isMaintenance ? { fontStyle: "italic", color: "var(--muted)" } : undefined}>
          {isMaintenance ? "automated maintenance" : entry.rel}
        </span>
        {entry.message && <span style={{ color: "var(--err)", fontSize: 11, display: "block" }}>{entry.message}</span>}
      </span>
      <span className="meta">
        {entry.status === "active" || entry.status === "queued" ? (
          <span className={`status ${entry.status}`}>{entry.status}</span>
        ) : (
          <span className={`status ${entry.status}`}>{entry.status}</span>
        )}
        {meta && <span style={{ display: "block" }}>{meta}</span>}
      </span>
    </li>
  );
}

export default function QueuePage() {
  const [snap, setSnap] = useState<DashboardSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [maintenanceEnabled, setMaintenanceEnabled] = useState<boolean>(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data as string) as DashboardSnapshot;
        setSnap(parsed);
        setMaintenanceEnabled(parsed.maintenanceEnabled ?? true);
      } catch { /* ignore */ }
    };
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, []);

  const totalDone = snap ? snap.recent.filter((e) => e.status === "done").length : 0;
  const totalFailed = snap ? snap.recent.filter((e) => e.status === "failed").length : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header className="app-header">
        <a className="header-title-btn" href="/">Personal Knowledge Base</a>
        <nav className="header-nav">
          <a className="nav-btn" href="/wiki">Wiki</a>
          <a className="nav-btn active" href="/queue">Queue</a>
          <a className="nav-btn" href="/log">Log</a>
          <button
            className={`nav-btn maintenance-toggle ${maintenanceEnabled ? "active" : ""}`}
            onClick={async () => {
              const r = await fetch("/api/maintenance/toggle", { method: "POST" });
              if (r.ok) {
                const j = await r.json() as { maintenanceEnabled: boolean };
                setMaintenanceEnabled(j.maintenanceEnabled);
              }
            }}
          >
            Maintenance {maintenanceEnabled ? "ON" : "OFF"}
          </button>
        </nav>
      </header>

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
                  {snap.active.map((e) => <EntryRow key={e.id} entry={e} />)}
                </ul>
              </section>
            )}

            <section className="panel">
              <h2>Queued <span className="count">{snap.queued.length}</span></h2>
              {snap.queued.length === 0
                ? <div className="empty">No files pending.</div>
                : <ul className="entries">
                    {snap.queued.map((e) => <EntryRow key={e.id} entry={e} showElapsed />)}
                  </ul>}
            </section>

            <section className="panel">
              <h2>Recent <span className="count">{snap.recent.length}</span></h2>
              {snap.recent.length === 0
                ? <div className="empty">No completed entries yet.</div>
                : <ul className="entries">
                    {snap.recent.map((e) => <EntryRow key={e.id} entry={e} />)}
                  </ul>}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
