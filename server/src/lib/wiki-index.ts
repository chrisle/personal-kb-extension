import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

// Lightweight in-memory index over wiki/*.md to power live-notes lookups
// without spawning a model. Built lazily on first use, refreshed via TTL so
// edits show up within a few seconds.

const STOPWORDS = new Set<string>([
  "the","a","an","and","or","but","of","in","on","at","to","for","with","by",
  "is","are","was","were","be","been","being","am","have","has","had","having",
  "do","does","did","doing","will","would","should","could","may","might","must",
  "shall","can","cannot","this","that","these","those","i","you","he","she","it",
  "we","they","them","me","my","your","his","her","its","our","their","what",
  "which","who","whom","whose","when","where","why","how","all","any","both",
  "some","one","each","every","other","another","such","no","not","nor","only",
  "own","same","so","than","too","very","just","also","get","got","getting",
  "make","makes","made","like","look","looks","see","saw","seen","says","said",
  "say","go","goes","went","gone","come","came","take","took","taken","know",
  "knew","known","think","thought","want","wanted","yeah","ok","okay","right",
  "really","kind","sort","gonna","wanna","actually","basically","probably",
  "maybe","need","needs","needed","good","well","thing","things","stuff","way",
  "ways","time","times","day","guys","guy","sure","alright","etc","because",
  "from","into","over","under","about","against","between","through","during",
  "before","after","above","below","there","here","again","further","then",
  "once","more","most","up","down","out","off","still","always","never",
  "let","lets","yes","hey","oh","um","uh","huh","mm","hmm","gotta","kinda",
]);

export interface IndexedPage {
  path: string;        // wiki-relative, e.g. "wiki/concepts/foo.md"
  title: string;
  folder: string;      // top-level folder under wiki/, or "_root"
  bullet: string;      // pre-extracted single-line summary
  bodyLower: string;   // for fast contains
  termFreq: Map<string, number>;
}

export interface WikiIndex {
  vault: string;
  builtAt: number;
  pages: IndexedPage[];
  docFreq: Map<string, number>;
}

const cache = new Map<string, WikiIndex>();
const TTL_MS = 5_000;

async function collectMdFiles(dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await collectMdFiles(full, out);
    else if (/\.md$/i.test(e.name)) out.push(full);
  }
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const re = /[a-z][a-z0-9'-]{2,}/g;
  const lower = text.toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    const t = m[0].replace(/^['-]+|['-]+$/g, "");
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    tokens.push(t);
  }
  return tokens;
}

function topFolder(rel: string): string {
  const stripped = rel.replace(/^wiki\//, "");
  const slash = stripped.indexOf("/");
  return slash < 0 ? "_root" : stripped.slice(0, slash);
}

function extractFirstSentence(body: string): string {
  const cleaned = body
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/^#+\s.*$/gm, "")
    .replace(/^>\s.*$/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (_m, stem, alias) => (alias as string | undefined) ?? (stem as string))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
  for (const para of cleaned.split(/\n\s*\n/)) {
    const t = para.replace(/\s+/g, " ").trim();
    if (t.length < 12) continue;
    const sentMatch = t.match(/.{20,}?[.!?](?:\s|$)/);
    const sentence = (sentMatch ? sentMatch[0] : t).trim();
    return sentence.length > 160 ? sentence.slice(0, 157) + "…" : sentence;
  }
  return cleaned.slice(0, 160);
}

async function build(vault: string): Promise<WikiIndex> {
  const wikiDir = path.join(vault, "wiki");
  const files: string[] = [];
  if (fs.existsSync(wikiDir)) await collectMdFiles(wikiDir, files);

  const pages: IndexedPage[] = [];
  await Promise.all(files.map(async (f) => {
    const rel = path.relative(vault, f).replace(/\\/g, "/");
    const content = await fsp.readFile(f, "utf8").catch(() => "");
    if (!content) return;
    const fm = parseFrontmatter(content);
    const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
    const stem = path.basename(f, ".md");
    const title = (fm.title as string) || stem;
    const tokens = tokenize(`${title} ${body}`);
    const termFreq = new Map<string, number>();
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    pages.push({
      path: rel,
      title,
      folder: topFolder(rel),
      bullet: extractFirstSentence(body),
      bodyLower: body.toLowerCase(),
      termFreq,
    });
  }));

  const docFreq = new Map<string, number>();
  for (const p of pages) {
    for (const term of p.termFreq.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  return { vault, builtAt: Date.now(), pages, docFreq };
}

export async function getWikiIndex(vault: string): Promise<WikiIndex> {
  const c = cache.get(vault);
  if (c && Date.now() - c.builtAt < TTL_MS) return c;
  const fresh = await build(vault);
  cache.set(vault, fresh);
  return fresh;
}

export function invalidateWikiIndex(vault?: string): void {
  if (vault) cache.delete(vault);
  else cache.clear();
}

// ── Topic extraction from a transcript window ───────────────────────────────

export function extractTopics(text: string, maxTopics = 8): string[] {
  const phrases = new Map<string, number>();

  // 1. Capitalized multi-word proper nouns ("Project Atlas")
  const phraseRe = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = phraseRe.exec(text)) !== null) {
    const p = m[1].trim();
    if (p.length < 3) continue;
    if (STOPWORDS.has(p.toLowerCase())) continue;
    phrases.set(p, (phrases.get(p) ?? 0) + 5);
  }

  // 2. Bigrams of non-stopword tokens (catches "data pipeline", "auth flow")
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    if (bigram.length < 7) continue;
    phrases.set(bigram, (phrases.get(bigram) ?? 0) + 2);
  }

  // 3. Distinctive single tokens that recur
  const tokenFreq = new Map<string, number>();
  for (const t of tokens) tokenFreq.set(t, (tokenFreq.get(t) ?? 0) + 1);
  for (const [t, freq] of tokenFreq) {
    if (freq >= 2 && t.length >= 5) {
      phrases.set(t, (phrases.get(t) ?? 0) + freq);
    } else if (t.length >= 6) {
      phrases.set(t, (phrases.get(t) ?? 0) + 1);
    }
  }

  // Sort by score, dedupe substring overlaps, cap
  const sorted = [...phrases.entries()].sort((a, b) => b[1] - a[1]);
  const kept: string[] = [];
  for (const [p] of sorted) {
    const lower = p.toLowerCase();
    let overlaps = false;
    for (const k of kept) {
      const kl = k.toLowerCase();
      if (kl === lower || kl.includes(lower) || lower.includes(kl)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;
    kept.push(p);
    if (kept.length >= maxTopics) break;
  }
  return kept;
}

// ── Matching topics → pages ─────────────────────────────────────────────────

export interface TopicMatch {
  topic: string;
  page: IndexedPage;
  score: number;
}

export function findMatchingPages(
  index: WikiIndex,
  topics: string[],
  maxPerTopic = 3,
  maxTotal = 18,
): TopicMatch[] {
  if (index.pages.length === 0 || topics.length === 0) return [];
  const results: TopicMatch[] = [];

  for (const topic of topics) {
    const tokens = tokenize(topic);
    if (tokens.length === 0) continue;
    const phraseLower = topic.toLowerCase();
    const scored: { page: IndexedPage; score: number }[] = [];

    for (const p of index.pages) {
      let score = 0;
      // Full phrase in title is the strongest signal
      if (p.title.toLowerCase().includes(phraseLower)) score += 60;
      // Full phrase in body
      else if (p.bodyLower.includes(phraseLower)) score += 25;

      // Token-level TF·IDF
      const titleLower = p.title.toLowerCase();
      for (const t of tokens) {
        const tf = p.termFreq.get(t) ?? 0;
        if (tf === 0) continue;
        const df = index.docFreq.get(t) ?? 1;
        const idf = Math.log(1 + index.pages.length / df);
        score += tf * idf;
        if (titleLower.includes(t)) score += 8;
      }

      if (score > 3) scored.push({ page: p, score });
    }

    scored.sort((a, b) => b.score - a.score);
    let added = 0;
    for (const { page, score } of scored) {
      results.push({ topic, page, score });
      added++;
      if (added >= maxPerTopic) break;
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxTotal);
}
