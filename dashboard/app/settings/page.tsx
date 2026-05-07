"use client";

import { useEffect, useState } from "react";
import { AppHeader } from "../../components/AppHeader";

interface Settings {
  maxRetries: number;
  retryOnFailure: boolean;
  maintenanceEnabled: boolean;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<Settings>;
      })
      .then(setSettings)
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load settings");
      });
  }, []);

  async function handleMaintenanceToggle() {
    if (!settings) return;
    try {
      const res = await fetch("/api/maintenance/toggle", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { maintenanceEnabled: boolean };
      setSettings({ ...settings, maintenanceEnabled: data.maintenanceEnabled });
    } catch {
      // silently ignore toggle errors
    }
  }

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          maxRetries: settings.maxRetries,
          retryOnFailure: settings.retryOnFailure,
        }),
      });
    } catch {
      // silently ignore save errors
    }
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 0",
    borderBottom: "1px solid var(--border)",
  };

  return (
    <div className="app">
      <AppHeader active="settings" />
      <main style={{ maxWidth: 600, margin: "0 auto", padding: "32px 20px" }}>
        <h1 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: 24 }}>Settings</h1>

        {loadError !== null && (
          <div style={{ color: "var(--muted)", marginBottom: 16 }}>
            Error loading settings: {loadError}
          </div>
        )}

        {settings === null && loadError === null && (
          <div style={{ color: "var(--muted)" }}>Loading…</div>
        )}

        {settings !== null && (
          <>
            <section className="panel" style={{ marginBottom: 16 }}>
              <h2>Queue</h2>

              {/* Maintenance Mode */}
              <div style={rowStyle}>
                <div>
                  <div style={{ fontWeight: 500 }}>Maintenance Mode</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
                    Pause queue processing
                  </div>
                </div>
                <button
                  className={`nav-btn maintenance-toggle${settings.maintenanceEnabled ? " active" : ""}`}
                  onClick={handleMaintenanceToggle}
                >
                  {settings.maintenanceEnabled ? "ON" : "OFF"}
                </button>
              </div>

              {/* Max Retries */}
              <div style={rowStyle}>
                <div>
                  <div style={{ fontWeight: 500 }}>Max Retries</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>0 = disabled</div>
                </div>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={settings.maxRetries}
                  onChange={(e) =>
                    setSettings({ ...settings, maxRetries: Number(e.target.value) })
                  }
                  style={{ width: 64, padding: "4px 8px", textAlign: "center" }}
                />
              </div>

              {/* Retry on Failure */}
              <div style={{ ...rowStyle, borderBottom: "none" }}>
                <div>
                  <div style={{ fontWeight: 500 }}>Retry on Failure</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
                    Re-queue items that fail processing
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={settings.retryOnFailure}
                  onChange={(e) =>
                    setSettings({ ...settings, retryOnFailure: e.target.checked })
                  }
                  style={{ width: 18, height: 18, cursor: "pointer" }}
                />
              </div>
            </section>

            <button className="nav-btn" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : saved ? "Saved!" : "Save"}
            </button>
          </>
        )}
      </main>
    </div>
  );
}
