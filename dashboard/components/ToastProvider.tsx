"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Toast, ToastContext, ToastStack } from "./Toast";

// ── SSE types ──────────────────────────────────────────────────────────────────

type QueueStatus = "queued" | "active" | "done" | "failed" | "skipped";

interface QueueEntry {
  id: string;
  vault: string;
  rel: string;
  event: string;
  status: QueueStatus;
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
  maintenanceEnabled?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function basename(rel: string): string {
  return rel.split("/").pop() ?? rel;
}

let nextId = 0;
function genId(): string {
  return `toast-${++nextId}-${Date.now()}`;
}

// ── ToastProvider ──────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Tracks IDs we've already processed so reconnects don't re-fire toasts.
  const seenQueuedIds = useRef<Set<string>>(new Set());
  const seenRecentIds = useRef<Set<string>>(new Set());
  // Whether we've received the first snapshot (used to seed without firing).
  const seeded = useRef(false);

  // ── addToast ──────────────────────────────────────────────────────────────
  const addToast = useCallback((t: Omit<Toast, "id">) => {
    const id = genId();
    const toast: Toast = { ...t, id };
    setToasts((prev) => [...prev, toast]);

    const delay = t.type === "error" ? 10_000 : 6_000;
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, delay);
  }, []);

  // ── dismiss ───────────────────────────────────────────────────────────────
  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  // ── SSE subscription ──────────────────────────────────────────────────────
  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let active = true;

    function connect() {
      if (!active) return;

      es = new EventSource("/api/events");

      es.addEventListener("snapshot", (e: MessageEvent) => {
        let snapshot: DashboardSnapshot;
        try {
          snapshot = JSON.parse(e.data) as DashboardSnapshot;
        } catch {
          return;
        }

        if (!seeded.current) {
          // First snapshot — seed seen sets without firing any toasts.
          for (const entry of snapshot.queued) seenQueuedIds.current.add(entry.id);
          for (const entry of snapshot.recent) seenRecentIds.current.add(entry.id);
          seeded.current = true;
          return;
        }

        // Diff queued — new entries not previously seen → info toast
        for (const entry of snapshot.queued) {
          if (!seenQueuedIds.current.has(entry.id)) {
            seenQueuedIds.current.add(entry.id);
            addToast({
              type: "info",
              title: "Queued",
              body: basename(entry.rel),
            });
          }
        }

        // Diff recent — new done/failed entries → success/error toast
        for (const entry of snapshot.recent) {
          if (!seenRecentIds.current.has(entry.id)) {
            seenRecentIds.current.add(entry.id);
            if (entry.status === "done") {
              addToast({
                type: "success",
                title: "Ingested",
                body: basename(entry.rel),
              });
            } else if (entry.status === "failed") {
              addToast({
                type: "error",
                title: `Failed: ${basename(entry.rel)}`,
                body: entry.message ?? "Unknown error",
              });
            }
          }
        }
      });

      es.onerror = () => {
        es?.close();
        es = null;
        if (!active) return;
        retryTimer = setTimeout(connect, 3_000);
      };
    }

    connect();

    return () => {
      active = false;
      es?.close();
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [addToast]);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
