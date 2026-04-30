"use client";

import { useEffect, useRef, useState } from "react";

type EntryStatus = "queued" | "active" | "done" | "failed" | "skipped";
type EventType = "add" | "change" | "unlink";

interface Entry {
  id: string;
  vault: string;
  rel: string;
  event: EventType;
  status: EntryStatus;
  enqueuedAt: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  message?: string;
}

interface Snapshot {
  queued: Entry[];
  active: Entry[];
  recent: Entry[];
  concurrency: number;
  updatedAt: number;
}

const EMPTY: Snapshot = { queued: [], active: [], recent: [], concurrency: 0, updatedAt: 0 };

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
}

function vaultName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export default function Page() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;

    const connect = () => {
      if (cancelled) return;
      source = new EventSource("/api/events");
      source.onopen = () => setConnected(true);
      source.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as Snapshot;
          setSnapshot(data);
        } catch {
          // ignore
        }
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (cancelled) return;
        reconnectTimer.current = setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      source?.close();
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  return (
    <main>
      <header>
        <h1>Wiki ingest queue</h1>
        <span className={`status-pill ${connected ? "live" : ""}`}>
          <span className="dot" />
          {connected ? "live" : "reconnecting…"}
        </span>
      </header>

      <div className="summary">
        <div className="card">
          <div className="label">Processing</div>
          <div className="value">
            {snapshot.active.length}
            <span style={{ color: "var(--muted)", fontSize: 14, marginLeft: 4 }}>
              / {snapshot.concurrency || "—"}
            </span>
          </div>
        </div>
        <div className="card">
          <div className="label">Queued</div>
          <div className="value">{snapshot.queued.length}</div>
        </div>
        <div className="card">
          <div className="label">Recent</div>
          <div className="value">{snapshot.recent.length}</div>
        </div>
      </div>

      <section className="panel">
        <h2>
          Processing now <span className="count">{snapshot.active.length}</span>
        </h2>
        {snapshot.active.length === 0 ? (
          <div className="empty">Nothing processing.</div>
        ) : (
          <ul className="entries">
            {snapshot.active.map((e) => (
              <li key={e.id} className="active">
                <span className={`badge ${e.event}`}>{e.event}</span>
                <span className="path">
                  <span className="vault">{vaultName(e.vault)} ›</span>
                  {e.rel}
                </span>
                <span className="meta">
                  {e.startedAt ? formatDuration(now - e.startedAt) : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>
          Queued <span className="count">{snapshot.queued.length}</span>
        </h2>
        {snapshot.queued.length === 0 ? (
          <div className="empty">Queue is empty.</div>
        ) : (
          <ul className="entries">
            {snapshot.queued.map((e) => (
              <li key={e.id}>
                <span className={`badge ${e.event}`}>{e.event}</span>
                <span className="path">
                  <span className="vault">{vaultName(e.vault)} ›</span>
                  {e.rel}
                </span>
                <span className="meta">waiting {formatDuration(now - e.enqueuedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>
          Recent <span className="count">{snapshot.recent.length}</span>
        </h2>
        {snapshot.recent.length === 0 ? (
          <div className="empty">No completed ingests yet.</div>
        ) : (
          <ul className="entries">
            {snapshot.recent.map((e) => (
              <li key={e.id}>
                <span className={`badge ${e.event}`}>{e.event}</span>
                <span className="path">
                  <span className="vault">{vaultName(e.vault)} ›</span>
                  {e.rel}
                </span>
                <span className="meta">
                  <span className={`status ${e.status}`}>{e.status}</span>
                  {e.startedAt && e.endedAt
                    ? ` · ${formatDuration(e.endedAt - e.startedAt)}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer>
        Updates stream from /api/events. Snapshot at /api/state.
      </footer>
    </main>
  );
}
