"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown, stripFrontmatter } from "@/components/markdown";

// ── Web Speech API shims ──────────────────────────────────────────────────────
interface SRAlt { transcript: string; confidence: number }
interface SRResult { isFinal: boolean; 0: SRAlt; length: number }
interface SREvent { resultIndex: number; results: { length: number; [i: number]: SRResult } }
interface SR {
  continuous: boolean; interimResults: boolean; lang: string;
  start: () => void; stop: () => void; abort: () => void;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null; onstart: (() => void) | null;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => SR;
    webkitSpeechRecognition?: new () => SR;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface LiveNoteItem { topic: string; path: string; title: string; bullet: string; }
interface LiveNotesResult { topics: string[]; items: LiveNoteItem[]; }

interface TopicCard {
  path: string;
  title: string;
  shortBody: string;
  longBody: string;
  longLoaded: boolean;
  longLoading: boolean;
  expanded: boolean;
  firstSeen: string;
  updates: { time: string; text: string }[];
  flash: boolean;
}
interface MinuteEntry { time: string; text: string; }
interface ActionItem  { id: number; text: string; done: boolean; }

// ── Constants (same as live-notes) ────────────────────────────────────────────
const REFRESH_MIN_NEW_CHARS   = 120;
const REFRESH_PAUSE_MS        = 2500;
const REFRESH_MIN_INTERVAL_MS = 30000;
const TRANSCRIPT_WINDOW_CHARS = 1500;
const FINAL_RING_MAX          = 4000;
const TRANSCRIPT_BANNER_CHARS = 600;

function nowTime(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function MeetingPage() {
  // ── Transcription state ──
  const [supported, setSupported]     = useState<boolean | null>(null);
  const [listening, setListening]     = useState(false);
  const [interim, setInterim]         = useState("");
  const [finalized, setFinalized]     = useState("");
  const [errMsg, setErrMsg]           = useState("");
  const [devices, setDevices]         = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId]       = useState<string>("");
  const [audioLevel, setAudioLevel]   = useState(0);
  const [showHelp, setShowHelp]       = useState(false);

  // ── Meeting state ──
  const [cards, setCards]             = useState<TopicCard[]>([]);
  const [minutes, setMinutes]         = useState<MinuteEntry[]>([]);
  const [actions, setActions]         = useState<ActionItem[]>([]);
  const [promptText, setPromptText]   = useState("");
  const [promptLoading, setPromptLoading] = useState(false);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [extracting, setExtracting]   = useState(false);
  const actionIdRef                   = useRef(0);

  // ── Refs ──
  const recRef                  = useRef<SR | null>(null);
  const wantListeningRef        = useRef(false);
  const finalizedRef            = useRef("");
  const lastSpeechAtRef         = useRef(0);
  const lastSuggestedFinalLenRef = useRef(0);
  const lastSuggestAtRef        = useRef(0);
  const inFlightRef             = useRef(false);
  const mediaStreamRef          = useRef<MediaStream | null>(null);
  const audioContextRef         = useRef<AudioContext | null>(null);
  const analyserRef             = useRef<AnalyserNode | null>(null);
  const meterRafRef             = useRef<number | null>(null);
  const deviceIdRef             = useRef<string>("default");
  const cardMapRef              = useRef<Map<string, true>>(new Map());
  const minutesEndRef           = useRef<HTMLDivElement>(null);
  const actionsEndRef           = useRef<HTMLDivElement>(null);
  const bannerScrollRef         = useRef<HTMLDivElement>(null);

  deviceIdRef.current = deviceId;
  finalizedRef.current = finalized;

  // ── Browser support detection ──
  useEffect(() => {
    if (typeof window === "undefined") return;
    setSupported(Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition));
  }, []);

  // ── Helpers ──
  const addActionItem = useCallback((text: string) => {
    setActions(prev => [...prev, { id: actionIdRef.current++, text, done: false }]);
  }, []);

  const addOrUpdateCard = useCallback((item: LiveNoteItem) => {
    const time = nowTime();
    if (cardMapRef.current.has(item.path)) {
      setCards(prev => prev.map(c =>
        c.path === item.path && item.bullet && item.bullet !== c.shortBody
          ? { ...c, flash: true, updates: [...c.updates, { time, text: item.bullet }] }
          : c
      ));
      setTimeout(() => {
        setCards(prev => prev.map(c => c.path === item.path ? { ...c, flash: false } : c));
      }, 900);
    } else {
      cardMapRef.current.set(item.path, true);
      setCards(prev => [{
        path: item.path, title: item.title, shortBody: item.bullet,
        longBody: "", longLoaded: false, longLoading: false,
        expanded: false, firstSeen: time, updates: [], flash: false,
      }, ...prev]);
    }
  }, []);

  // ── Audio device management (identical to live-notes) ──
  const stopMediaCapture = useCallback(() => {
    if (meterRafRef.current !== null) { cancelAnimationFrame(meterRafRef.current); meterRafRef.current = null; }
    if (audioContextRef.current) { void audioContextRef.current.close().catch(() => {}); audioContextRef.current = null; }
    analyserRef.current = null;
    if (mediaStreamRef.current) { for (const t of mediaStreamRef.current.getTracks()) t.stop(); mediaStreamRef.current = null; }
    setAudioLevel(0);
  }, []);

  const refreshDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter(d => d.kind === "audioinput"));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refreshDevices();
    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
      const onChange = () => void refreshDevices();
      navigator.mediaDevices.addEventListener("devicechange", onChange);
      return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
    }
  }, [refreshDevices]);

  const acquireDevice = useCallback(async (id: string): Promise<MediaStream | null> => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
    stopMediaCapture();
    const constraints: MediaStreamConstraints = {
      audio: id
        ? { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : true,
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;
      const Ctx: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser); analyserRef.current = analyser;
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        setAudioLevel(Math.min(1, Math.sqrt(Math.sqrt(sum / buf.length)) * 2));
        meterRafRef.current = requestAnimationFrame(tick);
      };
      tick();
      void refreshDevices();
      return stream;
    } catch (e) {
      setErrMsg(`Could not open microphone: ${(e as Error).message}`);
      return null;
    }
  }, [stopMediaCapture, refreshDevices]);

  // ── Speech recognition ──
  const buildRecognizer = useCallback((): SR | null => {
    if (typeof window === "undefined") return null;
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return null;
    const r = new Ctor();
    r.continuous = true; r.interimResults = true; r.lang = "en-US";
    r.onstart = () => setListening(true);
    r.onresult = (ev: SREvent) => {
      let interimText = ""; let newFinal = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i]; const txt = res[0].transcript;
        if (res.isFinal) newFinal += (newFinal ? " " : "") + txt.trim();
        else interimText += txt;
      }
      if (newFinal) {
        setFinalized(prev => {
          const merged = (prev + (prev ? " " : "") + newFinal).trim();
          return merged.length > FINAL_RING_MAX ? merged.slice(merged.length - FINAL_RING_MAX) : merged;
        });
      }
      setInterim(interimText);
      lastSpeechAtRef.current = Date.now();
    };
    r.onerror = e => { if (e.error !== "no-speech" && e.error !== "aborted") setErrMsg(`Speech error: ${e.error}`); };
    r.onend = () => {
      setListening(false);
      if (wantListeningRef.current) { try { r.start(); } catch { /* ignore */ } }
    };
    return r;
  }, []);

  const startListening = useCallback(async () => {
    setErrMsg("");
    wantListeningRef.current = true;
    const stream = await acquireDevice(deviceIdRef.current);
    if (!stream) { wantListeningRef.current = false; return; }
    let r = recRef.current;
    if (!r) { r = buildRecognizer(); recRef.current = r; }
    if (!r) { setErrMsg("Speech recognition not supported. Try Chrome, Edge, or Safari."); return; }
    try { r.start(); } catch { /* already started */ }
  }, [acquireDevice, buildRecognizer]);

  const stopListening = useCallback(() => {
    wantListeningRef.current = false;
    const r = recRef.current;
    if (r) { try { r.stop(); } catch { /* ignore */ } }
    stopMediaCapture(); setInterim("");
  }, [stopMediaCapture]);

  const switchDevice = useCallback(async (newId: string) => {
    setDeviceId(newId);
    try { window.localStorage.setItem("meeting-device", newId); } catch { /* ignore */ }
    if (!wantListeningRef.current) return;
    const r = recRef.current;
    if (r) { try { r.abort(); } catch { /* ignore */ } }
    recRef.current = null;
    const stream = await acquireDevice(newId);
    if (!stream) { wantListeningRef.current = false; return; }
    const fresh = buildRecognizer();
    recRef.current = fresh;
    if (fresh) { try { fresh.start(); } catch { /* ignore */ } }
  }, [acquireDevice, buildRecognizer]);

  // Restore saved device
  useEffect(() => {
    try { const s = window.localStorage.getItem("meeting-device"); if (s) setDeviceId(s); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    if (!devices.length) return;
    if (deviceId && devices.some(d => d.deviceId === deviceId)) return;
    const first = devices.find(d => d.deviceId);
    if (first) setDeviceId(first.deviceId);
  }, [devices, deviceId]);

  // ── Extraction pipeline: Claude minutes/actions/topics → KB fan-out ──
  const runExtraction = useCallback(async () => {
    if (inFlightRef.current) return;
    const now = Date.now();
    if (now - lastSuggestAtRef.current < REFRESH_MIN_INTERVAL_MS) return;
    const fullTranscript = finalizedRef.current;
    if (!fullTranscript.trim()) return;

    inFlightRef.current = true;
    lastSuggestedFinalLenRef.current = fullTranscript.length;
    lastSuggestAtRef.current = now;
    setExtracting(true);
    try {
      // Stage 1: Claude extracts minutes, topics, action items
      const r = await fetch("/api/meeting/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: fullTranscript }),
      });
      if (!r.ok) return;
      const data = await r.json() as { minutes: string[]; topics: string[]; actions: string[] };

      // Replace minutes (full regeneration from transcript)
      if (data.minutes?.length) {
        const t = nowTime();
        setMinutes(data.minutes.map(text => ({ time: t, text })));
      }

      // Replace actions, preserving done state on unchanged items
      if (data.actions?.length) {
        setActions(prev => {
          const doneSet = new Set(prev.filter(a => a.done).map(a => a.text));
          return data.actions.map((text: string, i: number) => ({
            id: actionIdRef.current + i,
            text,
            done: doneSet.has(text),
          }));
        });
        actionIdRef.current += data.actions.length;
      }

      // Stage 2: fan-out parallel KB lookups per topic
      if (data.topics?.length) {
        await Promise.all(
          data.topics.slice(0, 5).map(async (topic: string) => {
            try {
              const sr = await fetch("/api/live-notes/suggest", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ transcript: topic }),
              });
              if (!sr.ok) return;
              const sd = await sr.json() as LiveNotesResult;
              for (const item of (sd.items ?? []).slice(0, 1)) addOrUpdateCard(item);
            } catch { /* ignore */ }
          })
        );
      }
    } catch { /* ignore */ } finally {
      inFlightRef.current = false;
      setExtracting(false);
    }
  }, [addOrUpdateCard]);

  // Trigger extraction on pause after enough new speech
  useEffect(() => {
    const id = setInterval(() => {
      const newChars = finalizedRef.current.length - lastSuggestedFinalLenRef.current;
      const sincePause = Date.now() - lastSpeechAtRef.current;
      if (newChars >= REFRESH_MIN_NEW_CHARS && sincePause >= REFRESH_PAUSE_MS) {
        void runExtraction();
      }
    }, 250);
    return () => clearInterval(id);
  }, [runExtraction]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      const r = recRef.current;
      if (r) { try { r.abort(); } catch { /* ignore */ } }
      stopMediaCapture();
    };
  }, [stopMediaCapture]);

  // ── "Find out more" expansion ──
  const expandCard = useCallback(async (path: string) => {
    setCards(prev => prev.map(c => {
      if (c.path !== path) return c;
      if (c.longLoaded) return { ...c, expanded: !c.expanded };
      return { ...c, longLoading: true };
    }));
    const card = cards.find(c => c.path === path);
    if (card?.longLoaded) return;
    try {
      const r = await fetch(`/api/wiki?path=${encodeURIComponent(path)}`);
      if (!r.ok) return;
      const json = await r.json() as { content: string };
      const { body } = stripFrontmatter(json.content);
      setCards(prev => prev.map(c =>
        c.path === path ? { ...c, longBody: body, longLoaded: true, longLoading: false, expanded: true } : c
      ));
    } catch {
      setCards(prev => prev.map(c => c.path === path ? { ...c, longLoading: false } : c));
    }
  }, [cards]);

  // ── Open in Obsidian ──
  const openInKB = useCallback(async (path: string) => {
    const stem = path.replace(/^wiki\//, "").replace(/\.md$/, "");
    try { await fetch(`/api/wiki/open?stem=${encodeURIComponent(stem)}`); } catch { /* ignore */ }
  }, []);

  // ── Toggle action item done ──
  const toggleAction = useCallback((id: number) => {
    setActions(prev => prev.map(a => a.id === id ? { ...a, done: !a.done } : a));
  }, []);

  // ── Prompt input handler ──
  const handlePrompt = useCallback(async () => {
    const query = promptText.trim();
    if (!query) return;
    setPromptText("");

    const actionMatch = query.match(/^action[:\s]+(.+)/i);
    if (actionMatch) {
      addActionItem(actionMatch[1].trim());
      return;
    }

    // Manual KB search — direct suggest call, bypasses extraction throttle
    setPromptLoading(true);
    try {
      const r = await fetch("/api/live-notes/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: query }),
      });
      if (r.ok) {
        const data = await r.json() as LiveNotesResult;
        for (const item of (data.items ?? []).slice(0, 3)) addOrUpdateCard(item);
      }
    } catch { /* ignore */ } finally {
      setPromptLoading(false);
    }
  }, [promptText, addActionItem, addOrUpdateCard]);

  // ── Clear session ──
  const clearSession = useCallback(() => {
    setFinalized(""); setInterim(""); setCards([]);
    setMinutes([]); setActions([]);
    cardMapRef.current.clear();
    lastSuggestedFinalLenRef.current = 0;
  }, []);

  // Auto-scroll minutes and actions to bottom
  useEffect(() => { minutesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [minutes]);
  useEffect(() => { actionsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [actions]);

  // Auto-scroll transcript banner to show newest text on the right
  useEffect(() => {
    if (bannerScrollRef.current) {
      bannerScrollRef.current.scrollLeft = bannerScrollRef.current.scrollWidth;
    }
  }, [finalized, interim]);

  // ── Derived display values ──
  const bannerText = finalized.length > TRANSCRIPT_BANNER_CHARS
    ? "…" + finalized.slice(finalized.length - TRANSCRIPT_BANNER_CHARS)
    : finalized;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="meeting-app">

      {/* Header */}
      <header className="meeting-header">
        {/* Device picker */}
        <select
          className="ln-device"
          value={deviceId}
          onChange={e => void switchDevice(e.target.value)}
          title="Audio input device"
        >
          {devices.length === 0 && <option value="">No microphones — grant permission</option>}
          {devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `Microphone ${i + 1}`}
            </option>
          ))}
        </select>

        <button
          className="ln-help-btn"
          onClick={() => setShowHelp(v => !v)}
          title="How to capture audio from another app"
        >?</button>

        {/* VU meter */}
        <div className="meeting-meter" title={`Input level: ${Math.round(audioLevel * 100)}%`}>
          <div className="meeting-meter-bar" style={{ width: `${Math.round(audioLevel * 100)}%` }} />
        </div>

        {/* Start/Stop */}
        <button
          className={`ln-mic ${listening ? "on" : ""}`}
          onClick={() => void (listening ? stopListening() : startListening())}
          disabled={supported === false}
          title={listening ? "Stop listening" : "Start listening"}
        >
          <span className="ln-mic-dot" />
          {listening ? "Listening" : supported === false ? "Unsupported" : "Start"}
        </button>

        <button className="ln-clear" onClick={clearSession} disabled={!finalized && cards.length === 0}>
          Clear
        </button>

        {extracting && <span className="meeting-extracting">⟳ Analyzing…</span>}

        {/* Nav */}
        <nav className="meeting-header-nav">
          <a href="/">Graph</a>
          <a href="/wiki">Wiki</a>
          <a href="/live-notes">Live Notes</a>
          <a href="/queue">Queue</a>
          <a href="/log">Log</a>
        </nav>
      </header>

      {/* Help panel */}
      {showHelp && (
        <div className="ln-help">
          <strong>Listen to another app (Zoom, Teams, etc.):</strong> Install a virtual audio driver like{" "}
          <a href="https://existential.audio/blackhole/" target="_blank" rel="noreferrer">BlackHole</a> (free) or{" "}
          <a href="https://rogueamoeba.com/loopback/" target="_blank" rel="noreferrer">Loopback</a> (paid).
          Create a Multi-Output Device in Audio MIDI Setup, route your meeting app through it, then pick
          the BlackHole device above.
        </div>
      )}

      {errMsg && <div className="ln-err">{errMsg}</div>}
      {supported === false && (
        <div className="ln-err">Speech recognition not supported. Open in Chrome, Edge, or Safari.</div>
      )}

      {/* Transcript banner */}
      <div className="meeting-transcript-bar">
        <span className={`meeting-transcript-label ${listening ? "" : "off"}`}>
          {listening ? "● LIVE" : "○ IDLE"}
        </span>
        <div className="meeting-transcript-scroll" ref={bannerScrollRef}>
          <span className="meeting-transcript-final">
            {finalized || (listening ? "Listening… start speaking." : "Press Start to begin transcribing.")}
          </span>
          {interim && <span className="meeting-transcript-interim"> {interim}</span>}
        </div>
        <button
          className="meeting-transcript-expand-btn"
          onClick={() => setTranscriptExpanded(v => !v)}
          title={transcriptExpanded ? "Collapse transcript" : "Expand transcript"}
        >
          {transcriptExpanded ? "▲" : "▼"}
        </button>
      </div>

      {/* Expanded full transcript */}
      {transcriptExpanded && (
        <div className="meeting-transcript-full">
          {finalized || "No transcript yet."}
          {interim && <span className="meeting-transcript-interim"> {interim}</span>}
        </div>
      )}

      {/* Main 2-column body */}
      <div className="meeting-body">

        {/* Left: stacking topic cards + prompt bar */}
        <div className="meeting-cards-col">
          <div className="meeting-cards-scroll">
            {cards.length === 0 ? (
              <div className="meeting-empty">
                Start speaking —<br />
                KB hits appear here as cards.
              </div>
            ) : (
              cards.map(card => (
                <div key={card.path} className={`meeting-card ${card.flash ? "updated" : ""}`}>
                  <div className="meeting-card-header">
                    <span className="meeting-card-title">{card.title}</span>
                    <span className="meeting-card-time">{card.firstSeen}</span>
                  </div>

                  <div className="meeting-card-body">
                    {card.expanded
                      ? <Markdown content={card.longBody} onWikilink={() => void 0} />
                      : <p>{card.shortBody || <em style={{ opacity: 0.5 }}>No summary available.</em>}</p>
                    }
                    {card.longLoading && <p style={{ opacity: 0.5, fontSize: 12 }}>Loading…</p>}
                  </div>

                  {card.updates.map((u, i) => (
                    <div key={i} className="meeting-card-update">
                      <span className="meeting-card-update-time">{u.time} — update</span>
                      <p>{u.text}</p>
                    </div>
                  ))}

                  <div className="meeting-card-footer">
                    <button className="meeting-card-expand" onClick={() => void expandCard(card.path)}>
                      {card.expanded ? "Show less ↑" : "Find out more ↓"}
                    </button>
                    <button className="meeting-card-open" onClick={() => void openInKB(card.path)}>
                      📄 Open in KB
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Prompt bar pinned at bottom of left col */}
          <div className="meeting-prompt-bar">
            <input
              className="meeting-prompt-input"
              type="text"
              value={promptText}
              onChange={e => setPromptText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") void handlePrompt(); }}
              placeholder='Ask anything, or "action: …" to log an action item'
            />
            <button
              className="meeting-prompt-btn"
              onClick={() => void handlePrompt()}
              disabled={promptLoading || !promptText.trim()}
            >
              {promptLoading ? "…" : "Ask →"}
            </button>
          </div>
        </div>

        {/* Right: minutes + action items */}
        <div className="meeting-right-col">

          <div className="meeting-minutes">
            <div className="meeting-panel-label">Minutes</div>
            {minutes.map((m, i) => (
              <div key={i} className="meeting-minute">
                <span className="meeting-minute-time">{m.time}</span>
                <span>{m.text}</span>
              </div>
            ))}
            <div ref={minutesEndRef} />
          </div>

          <div className="meeting-actions">
            <div className="meeting-panel-label">Action items</div>
            {actions.map(a => (
              <div
                key={a.id}
                className={`meeting-action ${a.done ? "done" : ""}`}
                onClick={() => toggleAction(a.id)}
              >
                <span className="meeting-action-check" />
                <span className="meeting-action-text">{a.text}</span>
              </div>
            ))}
            <div ref={actionsEndRef} />
          </div>

        </div>
      </div>
    </div>
  );
}
