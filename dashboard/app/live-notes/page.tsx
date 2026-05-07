"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown, stripFrontmatter } from "@/components/markdown";

// ── Types ────────────────────────────────────────────────────────────────────
interface LiveNoteItem { topic: string; path: string; title: string; bullet: string; }
interface LiveNotesResult { topics: string[]; items: LiveNoteItem[]; }

// Minimal type shim for Web Speech API
interface SRAlt { transcript: string; confidence: number }
interface SRResult { isFinal: boolean; 0: SRAlt; length: number }
interface SREvent { resultIndex: number; results: { length: number; [i: number]: SRResult } }
interface SR {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => SR;
    webkitSpeechRecognition?: new () => SR;
  }
}

const REFRESH_MIN_NEW_CHARS = 40;     // require this much new text since last suggest
const REFRESH_PAUSE_MS = 600;         // require this much silence
const REFRESH_MIN_INTERVAL_MS = 1200; // hard floor between requests
const TRANSCRIPT_WINDOW_CHARS = 1500; // chunk sent to backend
const FINAL_RING_MAX = 4000;          // keep this many chars of finalized transcript on screen

// Map "wiki/concepts/foo.md" → "/wiki/concepts/foo" so the Open-full-page link
// lands on the wiki page route.
function pathToUrl(rel: string): string {
  if (!rel || rel === "wiki/index.md") return "/wiki";
  const stripped = rel.replace(/^wiki\//, "").replace(/\.md$/, "");
  if (!stripped) return "/wiki";
  return "/wiki/" + stripped.split("/").map(encodeURIComponent).join("/");
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function LiveNotesPage() {
  // Transcription state
  const [supported, setSupported] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [finalized, setFinalized] = useState("");
  const [lastSpeechAt, setLastSpeechAt] = useState(0);
  const [errMsg, setErrMsg] = useState("");
  const [showActivity, setShowActivity] = useState(true);

  // KB suggestion state
  const [items, setItems] = useState<LiveNoteItem[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [, setLastSuggestAt] = useState(0);

  // Side-panel state (clicking a bullet opens an inline preview, not a tab)
  const [selected, setSelected] = useState<LiveNoteItem | null>(null);
  const [pageContent, setPageContent] = useState<string>("");
  const [pageLoading, setPageLoading] = useState(false);

  // Audio source state
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [audioLevel, setAudioLevel] = useState(0); // 0-1, used for VU meter
  const [, setPermissionAsked] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // Layout: top pane height as a fraction (0.1 - 0.7); persisted to localStorage
  const [topFraction, setTopFraction] = useState(0.25);
  const draggingRef = useRef(false);
  const layoutRef = useRef<HTMLDivElement>(null);

  // Activity log (filtered subset of /api/logs for live-notes events + client-side events)
  const [activity, setActivity] = useState<string[]>([]);
  const activityRef = useRef<HTMLDivElement>(null);
  const pushActivity = useCallback((line: string) => {
    setActivity((prev) => {
      const next = [...prev, line];
      return next.length > 80 ? next.slice(-80) : next;
    });
  }, []);
  const stamp = () => new Date().toLocaleTimeString("en-US", { hour12: false });

  // Refs (so async handlers see latest values without stale closures)
  const recRef = useRef<SR | null>(null);
  const wantListeningRef = useRef(false);
  const finalizedRef = useRef("");
  const lastSpeechAtRef = useRef(0);
  const lastSuggestedFinalLenRef = useRef(0);
  const lastSuggestAtRef = useRef(0);
  const inFlightRef = useRef(false);
  const transcriptBoxRef = useRef<HTMLDivElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const deviceIdRef = useRef<string>("default");
  deviceIdRef.current = deviceId;

  finalizedRef.current = finalized;
  lastSpeechAtRef.current = lastSpeechAt;

  // Detect speech support
  useEffect(() => {
    if (typeof window === "undefined") return;
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setSupported(Boolean(Ctor));
  }, []);

  // Enumerate audio input devices (labels only available after first permission grant)
  const refreshDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all.filter((d) => d.kind === "audioinput");
      setDevices(inputs);
      pushActivity(
        `${stamp()} found ${inputs.length} audio input${inputs.length === 1 ? "" : "s"}` +
          (inputs.some((d) => !d.label) ? " (grant mic permission to see names)" : ""),
      );
    } catch (e) {
      pushActivity(`${stamp()} ⚠ enumerateDevices failed: ${(e as Error).message}`);
    }
  }, [pushActivity]);

  useEffect(() => {
    void refreshDevices();
    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
      const onChange = () => void refreshDevices();
      navigator.mediaDevices.addEventListener("devicechange", onChange);
      return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
    }
  }, [refreshDevices]);

  // Tear down the active media stream + meter
  const stopMediaCapture = useCallback(() => {
    if (meterRafRef.current !== null) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    if (mediaStreamRef.current) {
      for (const t of mediaStreamRef.current.getTracks()) t.stop();
      mediaStreamRef.current = null;
    }
    setAudioLevel(0);
  }, []);

  // Claim the chosen audioinput device. Browsers route the system speech
  // recognizer to whichever device a tab has actively claimed via getUserMedia.
  const acquireDevice = useCallback(async (id: string): Promise<MediaStream | null> => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      pushActivity(`${stamp()} ⚠ getUserMedia not available`);
      return null;
    }
    stopMediaCapture();
    const constraints: MediaStreamConstraints = {
      audio: id
        ? { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : true,
    };
    pushActivity(`${stamp()} requesting audio device ${id ? id.slice(0, 8) + "…" : "(browser pick)"}`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;
      setPermissionAsked(true);

      const track = stream.getAudioTracks()[0];
      const label = track?.label || "(unnamed device)";
      pushActivity(`${stamp()} ✓ acquired "${label}"`);

      // Set up VU meter so the user can see audio is reaching the page
      const Ctx: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analyserRef.current = analyser;

      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        setAudioLevel(Math.min(1, Math.sqrt(rms) * 2));
        meterRafRef.current = requestAnimationFrame(tick);
      };
      tick();

      void refreshDevices();
      return stream;
    } catch (e) {
      const msg = (e as Error).message;
      pushActivity(`${stamp()} ✗ getUserMedia failed: ${msg}`);
      setErrMsg(`Could not open microphone: ${msg}`);
      return null;
    }
  }, [pushActivity, refreshDevices, stopMediaCapture]);

  // Auto-scroll transcript
  useEffect(() => {
    const el = transcriptBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [finalized, interim]);

  // Build & manage SpeechRecognition
  const buildRecognizer = useCallback((): SR | null => {
    if (typeof window === "undefined") return null;
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return null;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    r.onstart = () => setListening(true);
    r.onresult = (ev: SREvent) => {
      let interimText = "";
      let newFinal = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const txt = res[0].transcript;
        if (res.isFinal) newFinal += (newFinal ? " " : "") + txt.trim();
        else interimText += txt;
      }
      if (newFinal) {
        setFinalized((prev) => {
          const merged = (prev + (prev ? " " : "") + newFinal).trim();
          return merged.length > FINAL_RING_MAX ? merged.slice(merged.length - FINAL_RING_MAX) : merged;
        });
      }
      setInterim(interimText);
      setLastSpeechAt(Date.now());
    };
    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") {
        setErrMsg(`Speech error: ${e.error}`);
      }
    };
    r.onend = () => {
      setListening(false);
      if (wantListeningRef.current) {
        try { r.start(); } catch { /* ignore */ }
      }
    };
    return r;
  }, []);

  const startListening = useCallback(async () => {
    setErrMsg("");
    wantListeningRef.current = true;
    const stream = await acquireDevice(deviceIdRef.current);
    if (!stream) { wantListeningRef.current = false; return; }
    let r = recRef.current;
    if (!r) {
      r = buildRecognizer();
      recRef.current = r;
    }
    if (!r) { setErrMsg("Speech recognition not supported in this browser. Try Chrome, Edge, or Safari."); return; }
    try { r.start(); } catch { /* already started */ }
  }, [acquireDevice, buildRecognizer]);

  const stopListening = useCallback(() => {
    wantListeningRef.current = false;
    const r = recRef.current;
    if (r) { try { r.stop(); } catch { /* ignore */ } }
    stopMediaCapture();
    setInterim("");
  }, [stopMediaCapture]);

  // Switch device while listening: tear down recognizer + stream, re-acquire, restart
  const switchDevice = useCallback(async (newId: string) => {
    setDeviceId(newId);
    if (typeof window !== "undefined") {
      try { window.localStorage.setItem("ln-device", newId); } catch { /* ignore */ }
    }
    if (!wantListeningRef.current) return;
    pushActivity(`${stamp()} switching device…`);
    const r = recRef.current;
    if (r) { try { r.abort(); } catch { /* ignore */ } }
    recRef.current = null;
    const stream = await acquireDevice(newId);
    if (!stream) { wantListeningRef.current = false; return; }
    const fresh = buildRecognizer();
    recRef.current = fresh;
    if (fresh) { try { fresh.start(); } catch { /* ignore */ } }
  }, [acquireDevice, buildRecognizer, pushActivity]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = window.localStorage.getItem("ln-device");
      if (saved && saved !== "default") setDeviceId(saved);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (devices.length === 0) return;
    const stillValid = deviceId && devices.some((d) => d.deviceId === deviceId);
    if (stillValid) return;
    const first = devices.find((d) => d.deviceId);
    if (first) setDeviceId(first.deviceId);
  }, [devices, deviceId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = window.localStorage.getItem("ln-top-fraction");
      if (saved) {
        const v = parseFloat(saved);
        if (Number.isFinite(v) && v >= 0.1 && v <= 0.7) setTopFraction(v);
      }
    } catch { /* ignore */ }
  }, []);

  // Drag-to-resize between transcript and bullet panes
  const onDividerMouseDown = useCallback((ev: React.MouseEvent) => {
    ev.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const container = layoutRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      let frac = (e.clientY - rect.top) / rect.height;
      if (!Number.isFinite(frac)) return;
      frac = Math.max(0.1, Math.min(0.7, frac));
      setTopFraction(frac);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try { window.localStorage.setItem("ln-top-fraction", String(topFractionRef.current)); } catch { /* ignore */ }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  const topFractionRef = useRef(topFraction);
  topFractionRef.current = topFraction;

  const onDividerKeyDown = useCallback((e: React.KeyboardEvent) => {
    const STEP = 0.02;
    if (e.key === "ArrowUp") { e.preventDefault(); setTopFraction((f) => Math.max(0.1, f - STEP)); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setTopFraction((f) => Math.min(0.7, f + STEP)); }
    else if (e.key === "Home") { e.preventDefault(); setTopFraction(0.25); }
  }, []);

  const clearTranscript = useCallback(() => {
    setFinalized("");
    setInterim("");
    setItems([]);
    setTopics([]);
    setSelected(null);
    setPageContent("");
    lastSuggestedFinalLenRef.current = 0;
  }, []);

  // Suggestion fetch
  const requestSuggestions = useCallback(async () => {
    if (inFlightRef.current) return;
    const now = Date.now();
    if (now - lastSuggestAtRef.current < REFRESH_MIN_INTERVAL_MS) return;

    const fullFinal = finalizedRef.current;
    if (!fullFinal) return;
    const window = fullFinal.length > TRANSCRIPT_WINDOW_CHARS
      ? fullFinal.slice(fullFinal.length - TRANSCRIPT_WINDOW_CHARS)
      : fullFinal;

    inFlightRef.current = true;
    setSuggestLoading(true);
    lastSuggestedFinalLenRef.current = fullFinal.length;
    lastSuggestAtRef.current = now;
    setLastSuggestAt(now);

    pushActivity(`${stamp()} → POST /api/live-notes/suggest (${window.length} chars)`);
    const fetchT0 = performance.now();

    try {
      const r = await fetch("/api/live-notes/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: window }),
      });
      if (!r.ok) {
        pushActivity(`${stamp()} ✗ HTTP ${r.status} from suggest`);
        return;
      }
      const data = await r.json() as LiveNotesResult;
      const elapsed = Math.round(performance.now() - fetchT0);
      pushActivity(
        `${stamp()} ← ${elapsed}ms · topics=${data.topics?.length ?? 0} items=${data.items?.length ?? 0}`,
      );
      setItems((prev) => mergeItems(prev, data.items ?? []));
      setTopics((prev) => mergeTopics(prev, data.topics ?? []));
    } catch (e) {
      pushActivity(`${stamp()} ✗ network error: ${(e as Error).message}`);
    } finally {
      inFlightRef.current = false;
      setSuggestLoading(false);
    }
  }, [pushActivity]);

  // Smart trigger loop: tick every 250ms and decide whether to fetch
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const newChars = finalizedRef.current.length - lastSuggestedFinalLenRef.current;
      const sincePause = now - lastSpeechAtRef.current;
      if (newChars >= REFRESH_MIN_NEW_CHARS && sincePause >= REFRESH_PAUSE_MS) {
        void requestSuggestions();
      }
    }, 250);
    return () => clearInterval(id);
  }, [requestSuggestions]);

  // Cleanup
  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      const r = recRef.current;
      if (r) { try { r.abort(); } catch { /* ignore */ } }
      stopMediaCapture();
    };
  }, [stopMediaCapture]);

  // Subscribe to server log SSE — filter for live-notes events
  useEffect(() => {
    const source = new EventSource("/api/logs");
    const isRelevant = (line: string) => /\[live-notes(?:-stderr)?\]/.test(line);
    source.addEventListener("init", (ev) => {
      try {
        const lines = JSON.parse(ev.data as string) as string[];
        const tail = lines.filter(isRelevant).slice(-20);
        if (tail.length) setActivity(tail.map(formatServerLogLine));
      } catch { /* ignore */ }
    });
    source.addEventListener("line", (ev) => {
      try {
        const line = JSON.parse(ev.data as string) as string;
        if (!isRelevant(line)) return;
        pushActivity(formatServerLogLine(line));
      } catch { /* ignore */ }
    });
    return () => source.close();
  }, [pushActivity]);

  // Auto-scroll the activity strip
  useEffect(() => {
    const el = activityRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activity]);

  // Log mic state transitions
  useEffect(() => {
    if (supported === false) pushActivity(`${stamp()} ⚠ SpeechRecognition not supported in this browser`);
  }, [supported, pushActivity]);
  useEffect(() => {
    pushActivity(`${stamp()} ${listening ? "🎤 listening started" : "⏸ listening stopped"}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  // Group items by topic for rendering. Topics keep their first-seen order;
  // the group header text matches the topic phrase from the transcript.
  const grouped = useMemo(() => {
    const map = new Map<string, LiveNoteItem[]>();
    for (const it of items) {
      const list = map.get(it.topic);
      if (list) list.push(it);
      else map.set(it.topic, [it]);
    }
    return [...map.entries()];
  }, [items]);

  // Open the side panel preview for a bullet (no new tab)
  const openInPanel = useCallback(async (item: LiveNoteItem) => {
    setSelected(item);
    setPageLoading(true);
    setPageContent("");
    try {
      const r = await fetch(`/api/wiki?path=${encodeURIComponent(item.path)}`);
      if (!r.ok) {
        setPageContent(`Failed to load (${r.status})`);
        return;
      }
      const json = await r.json() as { content: string };
      const { body } = stripFrontmatter(json.content);
      setPageContent(body);
    } catch {
      setPageContent("Network error loading page");
    } finally {
      setPageLoading(false);
    }
  }, []);

  // Wikilinks inside the side panel ask the server to launch the file in
  // the user's default app (matches graph-side-panel behavior).
  const onPanelWikilink = useCallback(async (stem: string) => {
    try {
      const r = await fetch(`/api/wiki/open?stem=${encodeURIComponent(stem)}`);
      if (!r.ok && r.status === 404) {
        setPageContent(`Page "${stem}" not found`);
      }
    } catch {
      // network error is silent — panel still shows current content
    }
  }, []);

  const closePanel = useCallback(() => {
    setSelected(null);
    setPageContent("");
  }, []);

  // Esc closes the side panel
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closePanel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, closePanel]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const newCharsPending = Math.max(0, finalized.length - lastSuggestedFinalLenRef.current);

  return (
    <div className="ln-app">
      <header className="ln-header">
        <a href="/wiki" className="ln-back">← Wiki</a>
        <h1 className="ln-title">Live Notes</h1>
        <a href="/meeting" className="ln-back" style={{ marginLeft: "auto" }}>Meeting →</a>
        <div className="ln-header-spacer" />
        <div className="ln-controls">
          <div className="ln-device-wrap">
            <select
              className="ln-device"
              value={deviceId}
              onChange={(e) => void switchDevice(e.target.value)}
              title="Audio input device"
            >
              {devices.length === 0 && (
                <option value="">No microphones detected — grant permission</option>
              )}
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}${d.deviceId ? "" : " (no permission yet)"}`}
                </option>
              ))}
            </select>
            <button
              className="ln-help-btn"
              onClick={() => setShowHelp((v) => !v)}
              title="How to capture audio from another app"
              aria-label="Audio routing help"
            >?</button>
          </div>

          <div className={`ln-meter ${listening ? "on" : ""}`} title={`Input level: ${Math.round(audioLevel * 100)}%`}>
            <div className="ln-meter-bar" style={{ width: `${Math.round(audioLevel * 100)}%` }} />
          </div>

          <button
            className={`ln-mic ${listening ? "on" : ""}`}
            onClick={() => void (listening ? stopListening() : startListening())}
            disabled={supported === false}
            title={listening ? "Stop listening" : "Start listening"}
          >
            <span className="ln-mic-dot" />
            {listening ? "Listening" : supported === false ? "Unsupported" : "Start"}
          </button>
          <button className="ln-clear" onClick={clearTranscript} disabled={!finalized && items.length === 0}>
            Clear
          </button>
          <span className="ln-status">
            {suggestLoading ? "Searching wiki…"
              : !listening && finalized ? "Paused"
              : listening && newCharsPending > 0 ? `+${newCharsPending} chars buffered`
              : listening ? "Listening for speech…"
              : "Idle"}
          </span>
        </div>
      </header>

      {showHelp && (
        <div className="ln-help">
          <div>
            <strong>Listen to another app (e.g. Zoom, Teams):</strong> macOS apps don't expose their audio as a microphone by default. To capture them, install a virtual audio driver:
          </div>
          <ul>
            <li><a href="https://existential.audio/blackhole/" target="_blank" rel="noreferrer">BlackHole</a> (free) or <a href="https://rogueamoeba.com/loopback/" target="_blank" rel="noreferrer">Loopback</a> (paid, easier)</li>
            <li>Open <em>Audio MIDI Setup</em> → create a Multi-Output Device that includes BlackHole + your speakers, set it as your system output, and route the source app to it.</li>
            <li>Pick the BlackHole device from the dropdown above.</li>
            <li>Browser also needs mic permission for that input.</li>
          </ul>
          <div style={{ opacity: 0.7, fontSize: 12, marginTop: 6 }}>
            Note: the Web Speech API uses whichever device the browser tab actively claims, so picking here usually works — but if the recognizer ignores your pick, set the device as the system default in <em>System Settings → Sound → Input</em>.
          </div>
        </div>
      )}

      {errMsg && <div className="ln-err">{errMsg}</div>}
      {supported === false && (
        <div className="ln-err">
          Browser doesn't support the Web Speech API. Open this page in Chrome, Edge, or Safari on macOS.
        </div>
      )}

      <div className="ln-split" ref={layoutRef}>
        {/* Top: Live transcription */}
        <section className="ln-transcript-pane" style={{ flexBasis: `${topFraction * 100}%` }}>
          <div className="ln-pane-label">Transcript</div>
          <div className="ln-transcript-box" ref={transcriptBoxRef}>
            {finalized ? (
              <span className="ln-final">{finalized}</span>
            ) : (
              <span className="ln-placeholder">
                {listening ? "Listening… start speaking." : "Press Start to begin transcribing."}
              </span>
            )}
            {interim && <span className="ln-interim"> {interim}</span>}
          </div>
        </section>

        {/* Drag handle */}
        <div
          className="ln-divider"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize transcript panel (drag, or use arrow keys)"
          tabIndex={0}
          onMouseDown={onDividerMouseDown}
          onKeyDown={onDividerKeyDown}
          title="Drag to resize"
        >
          <span className="ln-divider-grip" />
        </div>

        {/* Bottom: KB context — bullets categorized by topic */}
        <section className="ln-context-pane" style={{ flexBasis: `${(1 - topFraction) * 100}%` }}>
          <div className="ln-context-header">
            <div className="ln-pane-label">Knowledge in context</div>
            {topics.length > 0 && (
              <div className="ln-topics">
                {topics.map((t, i) => (
                  <span key={i} className="ln-topic">{t}</span>
                ))}
              </div>
            )}
          </div>

          {grouped.length === 0 ? (
            <div className="ln-empty">
              {finalized
                ? "No matching pages yet — keep talking."
                : "When you start speaking, relevant pages from your knowledge base will appear here."}
            </div>
          ) : (
            <div className="ln-bullets">
              {grouped.map(([topic, list]) => (
                <div key={topic} className="ln-topic-group">
                  <div className="ln-topic-heading">{topic}</div>
                  <ul className="ln-topic-list">
                    {list.map((item) => {
                      const active = selected?.path === item.path && selected?.topic === item.topic;
                      return (
                        <li key={`${topic}|${item.path}`} className={`ln-bullet ${active ? "active" : ""}`}>
                          <button
                            type="button"
                            className="ln-bullet-btn"
                            onClick={() => void openInPanel(item)}
                            title={item.path}
                          >
                            <span className="ln-bullet-title">{item.title}</span>
                            {item.bullet && (
                              <>
                                <span className="ln-bullet-sep"> — </span>
                                <span className="ln-bullet-text">{item.bullet}</span>
                              </>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Activity strip — fixed bottom */}
      <aside className={`ln-activity ${showActivity ? "open" : "collapsed"}`}>
        <div className="ln-activity-bar">
          <button className="ln-activity-toggle" onClick={() => setShowActivity((v) => !v)}>
            {showActivity ? "▾" : "▸"} Activity
            <span className="ln-activity-count">{activity.length}</span>
          </button>
          {showActivity && activity.length > 0 && (
            <button className="ln-activity-clear" onClick={() => setActivity([])}>clear</button>
          )}
        </div>
        {showActivity && (
          <div className="ln-activity-body" ref={activityRef}>
            {activity.length === 0 ? (
              <div className="ln-activity-empty">No activity yet.</div>
            ) : (
              activity.map((line, i) => (
                <div key={i} className="ln-activity-line">{line}</div>
              ))
            )}
          </div>
        )}
      </aside>

      {/* Side panel — bullet click opens the wiki page inline */}
      {selected && (
        <>
          <div className="ln-side-backdrop" onClick={closePanel} />
          <aside className="ln-side-panel">
            <header className="ln-side-header">
              <div className="ln-side-title">{selected.title}</div>
              <button className="ln-side-close" onClick={closePanel} aria-label="Close">×</button>
            </header>
            <div className="ln-side-meta">
              <span className="ln-side-tag">{selected.topic}</span>
              <span className="ln-side-path">{selected.path}</span>
            </div>
            <div className="ln-side-body">
              {pageLoading
                ? <div className="ln-side-loading">Loading…</div>
                : <Markdown content={pageContent} onWikilink={onPanelWikilink} />}
            </div>
            <footer className="ln-side-footer">
              <a className="ln-side-open" href={pathToUrl(selected.path)} target="_blank" rel="noreferrer">
                Open full page →
              </a>
            </footer>
          </aside>
        </>
      )}
    </div>
  );
}

// Strip ISO timestamp + leading [live-notes] tag → "HH:MM:SS [tag] message"
function formatServerLogLine(raw: string): string {
  const m = raw.match(/^(\S+)\s+\[(live-notes(?:-stderr)?)\]\s+(.*)$/);
  if (!m) return raw;
  const [, iso, tag, msg] = m;
  const date = new Date(iso);
  const time = isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("en-US", { hour12: false });
  const tagShort = tag === "live-notes-stderr" ? "stderr" : "server";
  return `${time} [${tagShort}] ${msg}`;
}

// Accumulate items as the conversation evolves: keep every (topic, path)
// bullet that has ever surfaced, refresh its bullet text on re-match,
// append new ones to the end. Capped to keep the view readable.
function mergeItems(prev: LiveNoteItem[], next: LiveNoteItem[]): LiveNoteItem[] {
  if (next.length === 0) return prev;
  const keyOf = (it: LiveNoteItem) => `${it.topic}|${it.path}`;
  const byKey = new Map<string, LiveNoteItem>();
  for (const p of prev) byKey.set(keyOf(p), p);
  for (const n of next) {
    const k = keyOf(n);
    const existing = byKey.get(k);
    // Refresh bullet text if it's non-empty (new pass might have a better one)
    byKey.set(k, existing ? { ...existing, bullet: n.bullet || existing.bullet } : n);
  }
  // Preserve insertion order: prev first (stable), then any genuinely new ones
  const ordered: LiveNoteItem[] = [];
  const seen = new Set<string>();
  for (const p of prev) {
    const k = keyOf(p);
    const cur = byKey.get(k);
    if (cur) { ordered.push(cur); seen.add(k); }
  }
  for (const n of next) {
    const k = keyOf(n);
    if (seen.has(k)) continue;
    ordered.push(byKey.get(k)!);
    seen.add(k);
  }
  // Cap to keep the surface manageable; oldest items drop off when full.
  const MAX = 60;
  return ordered.length > MAX ? ordered.slice(ordered.length - MAX) : ordered;
}

// Topics accumulate similarly so the chip strip reflects the running theme.
function mergeTopics(prev: string[], next: string[]): string[] {
  const seen = new Set(prev.map((t) => t.toLowerCase()));
  const merged = [...prev];
  for (const t of next) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(t);
  }
  const MAX = 12;
  return merged.length > MAX ? merged.slice(merged.length - MAX) : merged;
}
