"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/AppHeader";

function classifyLine(line: string): string {
  const lower = line.toLowerCase();
  if (/\[(stdout|stderr)\]/.test(line)) return "log-sub";
  if (/\b(fail|error|failed)\b/.test(lower)) return "log-err";
  if (/\b(done|✓|ingest complete|scaffold ok)\b/.test(lower)) return "log-ok";
  if (/\bskip\b/.test(lower)) return "log-skip";
  return "";
}

export default function LogPage() {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [pinned, setPinned] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  pinnedRef.current = pinned;

  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/logs");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.addEventListener("init", (ev) => {
      try {
        const initial = JSON.parse(ev.data as string) as string[];
        setLines(initial);
        if (pinnedRef.current) requestAnimationFrame(scrollToBottom);
      } catch { /* ignore */ }
    });

    source.addEventListener("line", (ev) => {
      try {
        const line = JSON.parse(ev.data as string) as string;
        setLines((prev) => {
          const next = [...prev, line];
          return next.length > 2000 ? next.slice(next.length - 2000) : next;
        });
        if (pinnedRef.current) requestAnimationFrame(scrollToBottom);
      } catch { /* ignore */ }
    });

    return () => source.close();
  }, [scrollToBottom]);

  useEffect(() => {
    if (pinned) scrollToBottom();
  }, [pinned, scrollToBottom]);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setPinned(atBottom);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <AppHeader active="log" />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 20px", borderBottom: "1px solid var(--border)", background: "var(--panel)", flexShrink: 0 }}>
        <span className="status-pill" style={{ fontSize: 12 }}>
          <span className={`dot${connected ? " live" : ""}`} style={{ width: 7, height: 7, borderRadius: "50%", background: connected ? "var(--ok)" : "var(--muted)", display: "inline-block" }} />
          {connected ? "Live" : "Disconnected"} · {lines.length} lines
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          {!pinned && (
            <button className="log-scroll-btn" onClick={() => { setPinned(true); scrollToBottom(); }}>
              ↓ Scroll to bottom
            </button>
          )}
          <button className="log-scroll-btn" onClick={() => setLines([])}>
            Clear
          </button>
        </div>
      </div>

      <div
        ref={bodyRef}
        className="log-body"
        style={{ flex: 1 }}
        onScroll={onScroll}
      >
        {lines.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13, padding: "24px 0", fontStyle: "italic" }}>
            {connected ? "No log entries yet." : "Connecting to server…"}
          </div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={`log-line ${classifyLine(line)}`}>{line}</div>
          ))
        )}
      </div>
    </div>
  );
}
