"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown, stripFrontmatter } from "@/components/markdown";

// ── Types ────────────────────────────────────────────────────────────────────
interface GraphNode {
  id: string;
  stem: string;
  title: string;
  domain: string;
  type: string;
  degree: number;
}
interface GraphEdge { source: string; target: string; }
interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; }

// Internal simulation node (mutates each frame)
interface SimNode extends GraphNode {
  x: number; y: number;
  vx: number; vy: number;
  r: number;
  color: string;
  folder: string;
}
interface SimEdge { source: SimNode; target: SimNode; }

// Top-level folder of a wiki path: wiki/concepts/foo.md → "concepts"
function topFolder(id: string): string {
  if (!id) return "_root";
  const stripped = id.replace(/^wiki\//, "");
  const slash = stripped.indexOf("/");
  if (slash < 0) return "_root";
  return stripped.slice(0, slash);
}

// Map "wiki/concepts/foo.md" → "/concepts/foo" (URL-encoded)
function pathToUrl(rel: string): string {
  if (!rel || rel === "wiki/index.md") return "/";
  const stripped = rel.replace(/^wiki\//, "").replace(/\.md$/, "");
  if (!stripped) return "/";
  return "/" + stripped.split("/").map(encodeURIComponent).join("/");
}

// Visual styling
const NODE_FALLBACK_COLOR = "rgba(200,200,210,0.9)";
const NODE_HOVER_COLOR = "#fff";
const EDGE_COLOR = "rgba(170,170,185,0.16)";
const EDGE_HOVER_COLOR = "rgba(200,200,210,0.85)";
const LABEL_COLOR = "rgba(220,220,225,0.78)";
const LABEL_DIM_COLOR = "rgba(190,190,200,0.42)";

// Curated palette tuned for a black canvas — high contrast, low garishness.
const DOMAIN_PALETTE = [
  "#f4a78a", // peach
  "#7fc8a9", // sage
  "#a6b8ff", // periwinkle
  "#f0c674", // wheat
  "#c8a6e6", // lavender
  "#7fb8d4", // sky
  "#e89bb1", // rose
  "#9ed27a", // grass
  "#e6c07a", // honey
  "#9bc6c2", // teal
];

function colorForDomain(domain: string | undefined): string {
  if (!domain || domain === "_global" || domain === "_root") return NODE_FALLBACK_COLOR;
  // Stable string hash → palette index
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) | 0;
  return DOMAIN_PALETTE[Math.abs(h) % DOMAIN_PALETTE.length];
}

// Stable physics step. Tuned to converge without exploding even for hundreds
// of nodes by capping forces and velocities and pruning far-away repulsion.
const REPEL_STRENGTH = 3500;
const REPEL_MAX_DIST = 1100;
const REPEL_MIN_DIST = 12;
const SPRING_LEN = 280;
const SPRING_K = 0.04;
const CENTER_K = 0.0015;
const CLUSTER_K = 0.04;          // pull same-folder nodes toward their centroid (tight clumps)
const CLUSTER_TARGET_DIST = 1600; // desired separation between cluster centroids
const CLUSTER_REPEL_K = 0.025;    // stiffness of the soft cluster-spread spring
const DAMPING = 0.72;            // damping — visible motion after a drag, settles within a second
const VEL_CAP = 22;
const REST_ENERGY = 0.004;       // park threshold — high enough that small jitter doesn't keep sim alive

// Label visibility thresholds
const HUB_DEGREE = 8;
const ZOOM_ALL_LABELS = 1.4;

interface PhysNode { x: number; y: number; vx: number; vy: number; folder?: string; }

function physicsStep(
  nodes: PhysNode[],
  edges: { source: PhysNode; target: PhysNode }[],
  pinned: PhysNode | null,
): void {
  const n = nodes.length;
  if (n === 0) return;

  // Repulsion (O(n²), pruned by REPEL_MAX_DIST)
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d > REPEL_MAX_DIST) continue;
      if (d < REPEL_MIN_DIST) {
        // Jitter overlapping nodes apart
        if (d < 0.001) {
          dx = (Math.random() - 0.5);
          dy = (Math.random() - 0.5);
          d = Math.sqrt(dx * dx + dy * dy) || 1;
        }
        d = REPEL_MIN_DIST;
      }
      const f = REPEL_STRENGTH / (d * d);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
  }

  // Spring attraction along edges
  for (const e of edges) {
    const dx = e.target.x - e.source.x;
    const dy = e.target.y - e.source.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - SPRING_LEN) * SPRING_K;
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    e.source.vx += fx; e.source.vy += fy;
    e.target.vx -= fx; e.target.vy -= fy;
  }

  // Cluster force: each node drifts toward the centroid of its folder so
  // same-folder nodes form visible clumps. Skip "_root" so root pages don't
  // all collapse to the middle.
  const centroids = new Map<string, { sx: number; sy: number; n: number }>();
  const folderMembers = new Map<string, PhysNode[]>();
  for (const node of nodes) {
    const f = node.folder;
    if (!f || f === "_root") continue;
    let c = centroids.get(f);
    if (!c) { c = { sx: 0, sy: 0, n: 0 }; centroids.set(f, c); }
    c.sx += node.x; c.sy += node.y; c.n++;
    let m = folderMembers.get(f);
    if (!m) { m = []; folderMembers.set(f, m); }
    m.push(node);
  }
  // Attraction to own centroid
  for (const node of nodes) {
    const f = node.folder;
    if (!f || f === "_root") continue;
    const c = centroids.get(f);
    if (!c || c.n < 2) continue;
    const cx = c.sx / c.n;
    const cy = c.sy / c.n;
    node.vx += (cx - node.x) * CLUSTER_K;
    node.vy += (cy - node.y) * CLUSTER_K;
  }
  // Soft repulsion between different-folder centroids: clumps have a desired
  // separation distance. If they're closer than that, push apart linearly; if
  // farther, no force. Linear force has a stable equilibrium (no saturation,
  // no orbiting), so the system actually settles instead of perpetually
  // shuffling.
  const folders: string[] = [];
  const folderCentroidsXY = new Map<string, { x: number; y: number }>();
  for (const [f, c] of centroids) {
    if (c.n < 2) continue;
    folders.push(f);
    folderCentroidsXY.set(f, { x: c.sx / c.n, y: c.sy / c.n });
  }
  for (let i = 0; i < folders.length; i++) {
    const ca = folderCentroidsXY.get(folders[i])!;
    const membersA = folderMembers.get(folders[i])!;
    for (let j = i + 1; j < folders.length; j++) {
      const cb = folderCentroidsXY.get(folders[j])!;
      const membersB = folderMembers.get(folders[j])!;
      let dx = ca.x - cb.x;
      let dy = ca.y - cb.y;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d < 0.001) {
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        d = Math.sqrt(dx * dx + dy * dy) || 1;
      }
      if (d >= CLUSTER_TARGET_DIST) continue;
      const fmag = (CLUSTER_TARGET_DIST - d) * CLUSTER_REPEL_K;
      const fx = (dx / d) * fmag;
      const fy = (dy / d) * fmag;
      for (const m of membersA) { m.vx += fx; m.vy += fy; }
      for (const m of membersB) { m.vx -= fx; m.vy -= fy; }
    }
  }

  // Center gravity, damping, velocity cap, integration
  for (const node of nodes) {
    if (node === pinned) {
      node.vx = 0; node.vy = 0;
      continue;
    }
    node.vx -= node.x * CENTER_K;
    node.vy -= node.y * CENTER_K;
    node.vx *= DAMPING;
    node.vy *= DAMPING;
    if (node.vx > VEL_CAP) node.vx = VEL_CAP;
    else if (node.vx < -VEL_CAP) node.vx = -VEL_CAP;
    if (node.vy > VEL_CAP) node.vy = VEL_CAP;
    else if (node.vy < -VEL_CAP) node.vy = -VEL_CAP;
    node.x += node.vx;
    node.y += node.vy;
  }
}

export default function GraphPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<SimNode | null>(null);
  const [minDegree, setMinDegree] = useState(0);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<SimNode | null>(null);
  const [pageContent, setPageContent] = useState<string>("");
  const [pageLoading, setPageLoading] = useState(false);

  // Simulation state — kept in refs so the animation loop can mutate freely
  const simNodesRef = useRef<SimNode[]>([]);
  const simEdgesRef = useRef<SimEdge[]>([]);
  const cameraRef = useRef({ x: 0, y: 0, zoom: 1 });
  const dragStateRef = useRef<
    | { kind: "node"; node: SimNode; startX: number; startY: number; armed: boolean }
    | { kind: "pan"; lastX: number; lastY: number; startX: number; startY: number; moved: boolean }
    | null
  >(null);
  const hoverRef = useRef<SimNode | null>(null);
  const selectedRef = useRef<SimNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({ w: 800, h: 600 });
  const searchRef = useRef("");
  const positionCacheRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Keep refs in sync with state so the render loop can read them without re-subscribing
  useEffect(() => { searchRef.current = search.trim().toLowerCase(); }, [search]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  // Load graph data
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/wiki/graph");
        if (!r.ok) {
          if (!cancelled) setError(`Failed to load graph (${r.status})`);
          return;
        }
        const json = await r.json() as GraphData;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setError("Network error loading graph");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Build sim graph when data or filters change, then pre-warm so the user sees a
  // stable layout instead of an explosion. Positions are cached across rebuilds
  // so adjusting the filter doesn't reset everything to the spiral.
  useEffect(() => {
    if (!data) return;
    const visibleNodes = data.nodes.filter((n) => n.degree >= minDegree);
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = data.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));

    const byId = new Map<string, SimNode>();
    const N = visibleNodes.length;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const spread = Math.max(200, Math.sqrt(Math.max(N, 1)) * 60);
    const cache = positionCacheRef.current;
    const hadCache = cache.size > 0;

    const sim: SimNode[] = visibleNodes.map((n, i) => {
      const cached = cache.get(n.id);
      let x: number, y: number;
      if (cached) {
        x = cached.x; y = cached.y;
      } else {
        const a = i * golden;
        const r = spread * Math.sqrt((i + 0.5) / Math.max(N, 1));
        x = Math.cos(a) * r;
        y = Math.sin(a) * r;
      }
      const folder = topFolder(n.id);
      const node: SimNode = {
        ...n,
        x, y,
        vx: 0, vy: 0,
        r: 3 + Math.min(15, Math.sqrt(n.degree) * 2.2),
        color: colorForDomain(folder),
        folder,
      };
      byId.set(n.id, node);
      return node;
    });
    const edges: SimEdge[] = [];
    for (const e of visibleEdges) {
      const s = byId.get(e.source);
      const t = byId.get(e.target);
      if (s && t) edges.push({ source: s, target: t });
    }
    simNodesRef.current = sim;
    simEdgesRef.current = edges;

    // Pre-warm: run silent steps until kinetic energy is negligible, then freeze.
    // Cached positions converge fast; cold starts need more iterations.
    const maxSteps = hadCache
      ? Math.min(400, Math.max(80, Math.floor(20000 / (N + 30))))
      : Math.min(2000, Math.max(400, Math.floor(60000 / (N + 30))));
    const minSteps = hadCache ? 30 : Math.min(200, maxSteps);
    const energyThreshold = 0.05;
    for (let s = 0; s < maxSteps; s++) {
      physicsStep(sim, edges, null);
      if (s >= minSteps) {
        let energy = 0;
        for (const node of sim) energy += node.vx * node.vx + node.vy * node.vy;
        if (energy / Math.max(sim.length, 1) < energyThreshold) break;
      }
    }
    for (const node of sim) { node.vx = 0; node.vy = 0; }

    // Save settled positions for the next rebuild (filter slider, etc.)
    const newCache = new Map<string, { x: number; y: number }>();
    for (const node of sim) newCache.set(node.id, { x: node.x, y: node.y });
    positionCacheRef.current = newCache;

    // Auto-fit camera to bounding box only on the first build; otherwise keep
    // user's pan/zoom so adjusting the filter doesn't yank the view.
    if (!hadCache && sim.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const node of sim) {
        if (node.x < minX) minX = node.x;
        if (node.y < minY) minY = node.y;
        if (node.x > maxX) maxX = node.x;
        if (node.y > maxY) maxY = node.y;
      }
      const { w, h } = sizeRef.current;
      const span = Math.max(maxX - minX, maxY - minY) + 80;
      const fit = Math.min(w, h) / Math.max(span, 1);
      const zoom = Math.max(0.2, Math.min(1.4, fit));
      // Pan so the bounding box centroid lands at the canvas center. The render
      // transform is (w/2 + cam.x + worldX*zoom), so cam.x = -centerX*zoom.
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      cameraRef.current = { x: -centerX * zoom, y: -centerY * zoom, zoom };
    } else if (sim.length === 0) {
      cameraRef.current = { x: 0, y: 0, zoom: 1 };
    }
  }, [data, minDegree]);

  // Resize canvas to container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handle = () => {
      const rect = el.getBoundingClientRect();
      sizeRef.current = { w: rect.width, h: rect.height };
      const c = canvasRef.current;
      if (c) {
        const dpr = window.devicePixelRatio || 1;
        c.width = Math.floor(rect.width * dpr);
        c.height = Math.floor(rect.height * dpr);
        c.style.width = `${rect.width}px`;
        c.style.height = `${rect.height}px`;
        const ctx = c.getContext("2d");
        if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };
    handle();
    const ro = new ResizeObserver(handle);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Animation loop (forces + render)
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const tick = () => {
      const nodes = simNodesRef.current;
      const edges = simEdgesRef.current;
      const cam = cameraRef.current;
      const { w, h } = sizeRef.current;
      const dragging = dragStateRef.current;

      // Run physics whenever the system has measurable kinetic energy or the
      // user is actively dragging. Damping (0.6) brings everything to natural
      // rest — no artificial cooling cutoff to cause "sudden stops".
      if (nodes.length > 0) {
        // A node-drag only counts as "active" once it's armed (pointer moved).
        const dragging_node = dragging && dragging.kind === "node" && dragging.armed;
        if (dragging_node) {
          // While dragging: skip physics entirely. The pointer-move handler
          // updates the dragged node's position directly; everything else
          // stays exactly where it was.
        } else {
          let energy = 0;
          for (const node of nodes) energy += node.vx * node.vx + node.vy * node.vy;
          const avgEnergy = energy / nodes.length;
          if (avgEnergy > REST_ENERGY) {
            physicsStep(nodes, edges, null);
          } else {
            for (const node of nodes) { node.vx = 0; node.vy = 0; }
          }
        }
      }

      // Render
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2 + cam.x, h / 2 + cam.y);
      ctx.scale(cam.zoom, cam.zoom);

      const hov = hoverRef.current;
      const sel = selectedRef.current;
      // Hovered + selected nodes both keep their edges highlighted and fill white.
      const highlightSet = new Set<SimNode>();
      if (hov) highlightSet.add(hov);
      if (sel) highlightSet.add(sel);
      const hasHighlight = highlightSet.size > 0;
      const q = searchRef.current;
      const hasQuery = q.length > 0;

      // A node "matches" search if its title or path contains the query.
      // Connected nodes (1-hop) of matches stay visible too so context is preserved.
      const matchSet = new Set<SimNode>();
      const neighborSet = new Set<SimNode>();
      if (hasQuery) {
        for (const node of nodes) {
          if (node.title.toLowerCase().includes(q) || node.id.toLowerCase().includes(q)) matchSet.add(node);
        }
        for (const e of edges) {
          if (matchSet.has(e.source)) neighborSet.add(e.target);
          if (matchSet.has(e.target)) neighborSet.add(e.source);
        }
      }
      const isVisible = (n: SimNode) => !hasQuery || matchSet.has(n) || neighborSet.has(n);

      // Edges: faint default pass first, then a brighter highlight pass for any
      // edge attached to the hovered or selected node.
      ctx.lineWidth = 1 / cam.zoom;
      ctx.beginPath();
      ctx.strokeStyle = EDGE_COLOR;
      for (const e of edges) {
        if (hasHighlight && (highlightSet.has(e.source) || highlightSet.has(e.target))) continue;
        if (hasQuery && !(matchSet.has(e.source) && matchSet.has(e.target))
            && !(matchSet.has(e.source) || matchSet.has(e.target))) continue;
        ctx.moveTo(e.source.x, e.source.y);
        ctx.lineTo(e.target.x, e.target.y);
      }
      ctx.stroke();

      if (hasHighlight) {
        ctx.strokeStyle = EDGE_HOVER_COLOR;
        ctx.lineWidth = 1.4 / cam.zoom;
        ctx.beginPath();
        for (const e of edges) {
          if (highlightSet.has(e.source) || highlightSet.has(e.target)) {
            ctx.moveTo(e.source.x, e.source.y);
            ctx.lineTo(e.target.x, e.target.y);
          }
        }
        ctx.stroke();
      }

      // Nodes — full alpha for visible / matching, dim for non-matching when search is active
      for (const node of nodes) {
        const visible = isVisible(node);
        ctx.globalAlpha = visible ? 1 : 0.12;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
        ctx.fillStyle = highlightSet.has(node) || matchSet.has(node) ? NODE_HOVER_COLOR : node.color;
        ctx.fill();
        // Selected node: outline ring so it stays visually distinct from hover
        if (node === sel) {
          ctx.strokeStyle = NODE_HOVER_COLOR;
          ctx.lineWidth = 1.5 / cam.zoom;
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.r + 3 / cam.zoom, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // Labels: shown only for hub nodes (high degree), the hovered/selected
      // node and its 1-hop neighbors, and search matches/neighbors. When zoomed
      // in past ZOOM_ALL_LABELS, show everything.
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      if (cam.zoom > 0.35) {
        const showAll = cam.zoom > ZOOM_ALL_LABELS;
        const highlightConnected = new Set<SimNode>();
        if (hasHighlight) {
          for (const node of highlightSet) highlightConnected.add(node);
          for (const e of edges) {
            if (highlightSet.has(e.source)) highlightConnected.add(e.target);
            if (highlightSet.has(e.target)) highlightConnected.add(e.source);
          }
        }
        for (const node of nodes) {
          const isHi = highlightSet.has(node);
          const isHubNode = node.degree >= HUB_DEGREE;
          const isHiNbr = highlightConnected.has(node);
          const isMatch = hasQuery && matchSet.has(node);
          const isMatchNbr = hasQuery && neighborSet.has(node);
          const shouldShow = isHi || isHiNbr || isHubNode || isMatch || isMatchNbr || showAll;
          if (!shouldShow) continue;
          if (hasQuery && !isMatch && !isMatchNbr) ctx.globalAlpha = 0.25;
          else ctx.globalAlpha = 1;
          const fontPx = (isHi || isMatch ? 12 : isHubNode ? 11 : 10) / cam.zoom;
          ctx.font = `${fontPx}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
          ctx.fillStyle = isHi || isMatch
            ? NODE_HOVER_COLOR
            : isHubNode || isHiNbr || isMatchNbr
            ? LABEL_COLOR
            : LABEL_DIM_COLOR;
          ctx.fillText(node.title.slice(0, 40), node.x, node.y + node.r + 3 / cam.zoom);
        }
        ctx.globalAlpha = 1;
      }

      ctx.restore();
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [data]);

  // Convert screen → world coords
  const toWorld = useCallback((sx: number, sy: number) => {
    const cam = cameraRef.current;
    const { w, h } = sizeRef.current;
    return { x: (sx - w / 2 - cam.x) / cam.zoom, y: (sy - h / 2 - cam.y) / cam.zoom };
  }, []);

  const findNode = useCallback((sx: number, sy: number): SimNode | null => {
    const { x, y } = toWorld(sx, sy);
    let best: SimNode | null = null;
    let bestD2 = Infinity;
    for (const node of simNodesRef.current) {
      const dx = node.x - x;
      const dy = node.y - y;
      const r = node.r + 4;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 < bestD2) { best = node; bestD2 = d2; }
    }
    return best;
  }, [toWorld]);

  const onPointerDown = useCallback((ev: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const hit = findNode(sx, sy);
    if (hit) {
      dragStateRef.current = {
        kind: "node",
        node: hit,
        startX: ev.clientX, startY: ev.clientY,
        armed: false,
      };
    } else {
      dragStateRef.current = {
        kind: "pan",
        lastX: ev.clientX, lastY: ev.clientY,
        startX: ev.clientX, startY: ev.clientY,
        moved: false,
      };
    }
    ev.currentTarget.setPointerCapture(ev.pointerId);
  }, [findNode]);

  const onPointerMove = useCallback((ev: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const drag = dragStateRef.current;
    if (drag) {
      if (drag.kind === "node") {
        // Don't move (or wake the sim) on a stationary press — only once the
        // pointer has actually traveled past the click-vs-drag threshold.
        if (!drag.armed) {
          if (Math.abs(ev.clientX - drag.startX) > 3 || Math.abs(ev.clientY - drag.startY) > 3) {
            drag.armed = true;
          } else {
            return;
          }
        }
        const w = toWorld(sx, sy);
        drag.node.x = w.x; drag.node.y = w.y;
        drag.node.vx = 0; drag.node.vy = 0;
      } else {
        cameraRef.current.x += ev.clientX - drag.lastX;
        cameraRef.current.y += ev.clientY - drag.lastY;
        drag.lastX = ev.clientX; drag.lastY = ev.clientY;
        if (Math.abs(ev.clientX - drag.startX) > 3 || Math.abs(ev.clientY - drag.startY) > 3) {
          drag.moved = true;
        }
      }
      return;
    }
    const hit = findNode(sx, sy);
    hoverRef.current = hit;
    if (hit !== hover) setHover(hit);
  }, [findNode, hover, toWorld]);

  const openInPanel = useCallback(async (node: SimNode) => {
    setSelected(node);
    setPageLoading(true);
    setPageContent("");
    try {
      const r = await fetch(`/api/wiki?path=${encodeURIComponent(node.id)}`);
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

  // Wikilink clicks inside the side panel ask the server to launch the
  // referenced file in the user's default app (Obsidian/VS Code/Finder/etc.)
  // rather than navigating within the dashboard. The panel itself stays put
  // so the user keeps their context.
  const onPanelWikilink = useCallback(async (stem: string) => {
    try {
      const r = await fetch(`/api/wiki/open?stem=${encodeURIComponent(stem)}`);
      if (!r.ok && r.status === 404) {
        // Fall back to loading content in the panel for a missing file so the
        // user gets feedback instead of a silent no-op.
        setPageContent(`Page "${stem}" not found`);
      }
    } catch {
      // Network error is silent — the user already sees the panel content.
    }
  }, []);

  const onPointerUp = useCallback((ev: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragStateRef.current;
    dragStateRef.current = null;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    if (!drag) return;
    if (drag.kind === "node") {
      // If the pointer never armed (didn't move past the threshold), this was
      // a click on the node → open the side panel.
      if (!drag.armed) {
        void openInPanel(drag.node);
      }
    } else if (!drag.moved) {
      // Tap on empty canvas with no pan → clear selection / dismiss side panel
      setSelected(null);
      setPageContent("");
    }
  }, [openInPanel]);

  const onWheel = useCallback((ev: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const cam = cameraRef.current;
    const { w, h } = sizeRef.current;
    const worldX = (sx - w / 2 - cam.x) / cam.zoom;
    const worldY = (sy - h / 2 - cam.y) / cam.zoom;
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.max(0.15, Math.min(6, cam.zoom * factor));
    // Keep cursor anchored
    cam.x = sx - w / 2 - worldX * next;
    cam.y = sy - h / 2 - worldY * next;
    cam.zoom = next;
  }, []);

  const onPointerLeave = useCallback(() => {
    hoverRef.current = null;
    setHover(null);
  }, []);

  const closePanel = useCallback(() => {
    setSelected(null);
    setPageContent("");
  }, []);

  const visibleCount = data ? data.nodes.filter((n) => n.degree >= minDegree).length : 0;
  const visibleEdgeCount = data
    ? data.edges.filter((e) => {
        const s = data.nodes.find((n) => n.id === e.source);
        const t = data.nodes.find((n) => n.id === e.target);
        return s && t && s.degree >= minDegree && t.degree >= minDegree;
      }).length
    : 0;

  // Legend: list of folders currently visible, each with a swatch + count.
  // Sorted by count desc so the largest categories come first.
  const legend = useMemo(() => {
    if (!data) return [] as { folder: string; count: number; color: string }[];
    const counts = new Map<string, number>();
    for (const n of data.nodes) {
      if (n.degree < minDegree) continue;
      const f = topFolder(n.id);
      if (f === "_root") continue;
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([folder, count]) => ({ folder, count, color: colorForDomain(folder) }))
      .sort((a, b) => b.count - a.count);
  }, [data, minDegree]);

  return (
    <div className="graph-page">
      <header className="app-header">
        <a className="header-title-btn" href="/">Personal Knowledge Base</a>
        <nav className="header-nav">
          <a className="nav-btn active" href="/graph">Graph</a>
          <a className="nav-btn" href="/live-notes">Live Notes</a>
          <a className="nav-btn" href="/">Wiki</a>
        </nav>
      </header>

      <div className="graph-toolbar">
        <span className="graph-stats">
          {data ? `${visibleCount} / ${data.nodes.length} pages · ${visibleEdgeCount} links` : loading ? "Loading…" : ""}
        </span>
        <input
          className="graph-search"
          type="search"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="graph-filter">
          <span>Min links</span>
          <input
            type="range"
            min={0}
            max={10}
            value={minDegree}
            onChange={(e) => setMinDegree(Number(e.target.value))}
          />
          <span className="graph-filter-val">{minDegree}</span>
        </label>
      </div>

      <div className="graph-canvas-wrap" ref={containerRef}>
        {error && <div className="graph-error">{error}</div>}
        {!error && data && data.nodes.length === 0 && (
          <div className="graph-empty">No wiki pages yet. Drop a file into your vault to start building the graph.</div>
        )}
        <canvas
          ref={canvasRef}
          className="graph-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
          onWheel={onWheel}
        />
        {legend.length > 0 && (
          <div className="graph-legend">
            {legend.map(({ folder, count, color }) => (
              <div key={folder} className="graph-legend-item">
                <span className="graph-legend-swatch" style={{ background: color }} />
                <span className="graph-legend-label">{folder}</span>
                <span className="graph-legend-count">{count}</span>
              </div>
            ))}
          </div>
        )}

        {hover && !selected && (
          <div className="graph-tooltip">
            <div className="graph-tooltip-title">{hover.title}</div>
            <div className="graph-tooltip-meta">
              {hover.folder !== "_root" && <span className="graph-tag">{hover.folder}</span>}
              {hover.type && <span className="graph-tag">{hover.type}</span>}
              <span className="graph-tag">{hover.degree} link{hover.degree === 1 ? "" : "s"}</span>
            </div>
            <div className="graph-tooltip-path">{hover.id}</div>
          </div>
        )}

        {selected && (
          <aside className="graph-side-panel">
            <header className="graph-side-header">
              <div className="graph-side-title">{selected.title}</div>
              <button className="graph-side-close" onClick={closePanel} aria-label="Close">×</button>
            </header>
            <div className="graph-side-meta">
              {selected.folder !== "_root" && <span className="graph-tag">{selected.folder}</span>}
              {selected.type && <span className="graph-tag">{selected.type}</span>}
              <span className="graph-tag">{selected.degree} link{selected.degree === 1 ? "" : "s"}</span>
            </div>
            <div className="graph-side-body">
              {pageLoading
                ? <div className="graph-side-loading">Loading…</div>
                : <Markdown content={pageContent} onWikilink={onPanelWikilink} />}
            </div>
            <footer className="graph-side-footer">
              <a className="graph-side-open" href={pathToUrl(selected.id)}>Open full page →</a>
            </footer>
          </aside>
        )}
      </div>
    </div>
  );
}
