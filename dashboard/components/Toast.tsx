"use client";

import { createContext, useContext } from "react";

// ── Types ──────────────────────────────────────────────────────────────────────

export type Toast = {
  id: string;
  type: "info" | "success" | "error";
  title: string;
  body?: string;
};

export interface ToastContextValue {
  addToast: (t: Omit<Toast, "id">) => void;
}

// ── Context ────────────────────────────────────────────────────────────────────

export const ToastContext = createContext<ToastContextValue>({
  addToast: () => undefined,
});

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

// ── ToastStack ─────────────────────────────────────────────────────────────────

const BORDER_COLOR: Record<Toast["type"], string> = {
  info: "var(--accent)",
  success: "var(--ok)",
  error: "var(--err)",
};

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="toast"
          style={{ borderLeftColor: BORDER_COLOR[toast.type] }}
        >
          <div className="toast-header">
            <span className="toast-title">{toast.title}</span>
            <button
              className="toast-dismiss"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
          {toast.body && <p className="toast-body">{toast.body}</p>}
        </div>
      ))}
    </div>
  );
}
