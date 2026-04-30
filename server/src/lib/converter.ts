import * as fsp from "node:fs/promises";
import * as path from "node:path";
import JSZip from "jszip";
import * as XLSX from "xlsx";

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".canvas", ".csv"]);
const DOCX_EXTENSIONS = new Set([".docx", ".doc"]);
const PPTX_EXTENSIONS = new Set([".pptx", ".ppt"]);
const EXCEL_EXTENSIONS = new Set([".xlsx", ".xls"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

// Files to never ingest: scaffolded/managed files that aren't user knowledge.
const EXCLUDED_BASENAMES = new Set(["CLAUDE.md"]);

export function isIngestible(rel: string): boolean {
  const base = path.basename(rel);
  if (EXCLUDED_BASENAMES.has(base)) return false;
  const ext = path.extname(rel).toLowerCase();
  return (
    TEXT_EXTENSIONS.has(ext) ||
    DOCX_EXTENSIONS.has(ext) ||
    PPTX_EXTENSIONS.has(ext) ||
    EXCEL_EXTENSIONS.has(ext) ||
    PDF_EXTENSIONS.has(ext) ||
    IMAGE_EXTENSIONS.has(ext)
  );
}

export function isOfficeFile(rel: string): boolean {
  const ext = path.extname(rel).toLowerCase();
  return (
    DOCX_EXTENSIONS.has(ext) ||
    PPTX_EXTENSIONS.has(ext) ||
    EXCEL_EXTENSIONS.has(ext) ||
    PDF_EXTENSIONS.has(ext)
  );
}

export function isImageFile(rel: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

/** Extract plain text from an Office or PDF document. Returns null if extraction fails. */
export async function extractText(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  if (DOCX_EXTENSIONS.has(ext)) return extractDocx(filePath);
  if (PPTX_EXTENSIONS.has(ext)) return extractPptx(filePath);
  if (EXCEL_EXTENSIONS.has(ext)) return extractExcel(filePath);
  if (PDF_EXTENSIONS.has(ext)) return extractPdf(filePath);
  return null;
}

// DOCX: ZIP containing word/document.xml — text lives in <w:t> elements
async function extractDocx(filePath: string): Promise<string | null> {
  try {
    const buf = await fsp.readFile(filePath);
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("word/document.xml")?.async("string");
    if (!xml) return null;
    const text = xml
      .match(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)
      ?.map((m) => m.replace(/<[^>]+>/g, ""))
      .join(" ")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

// PPTX: ZIP containing ppt/slides/slide*.xml — text lives in <a:t> elements
async function extractPptx(filePath: string): Promise<string | null> {
  try {
    const buf = await fsp.readFile(filePath);
    const zip = await JSZip.loadAsync(buf);
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const n = (s: string) => parseInt(s.match(/\d+/)?.[0] ?? "0", 10);
        return n(a) - n(b);
      });
    const pages: string[] = [];
    for (const name of slideNames) {
      const xml = await zip.files[name].async("string");
      const text = xml
        .match(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)
        ?.map((m) => m.replace(/<[^>]+>/g, ""))
        .join(" ")
        .trim();
      if (text) pages.push(text);
    }
    return pages.join("\n").trim() || null;
  } catch {
    return null;
  }
}

async function extractExcel(filePath: string): Promise<string | null> {
  try {
    const workbook = XLSX.readFile(filePath);
    const parts: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.trim()) parts.push(`### ${sheetName}\n\n${csv}`);
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  } catch {
    return null;
  }
}

async function extractPdf(filePath: string): Promise<string | null> {
  try {
    // Lazy import so pdfjs-dist initialisation doesn't run at server startup
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    (pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = "";
    const data = new Uint8Array(await fsp.readFile(filePath));
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      if (text.trim()) pages.push(text);
    }
    await doc.destroy();
    return pages.join("\n").trim() || null;
  } catch {
    return null;
  }
}
