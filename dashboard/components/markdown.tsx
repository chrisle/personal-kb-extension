"use client";

import type React from "react";

export function stripFrontmatter(md: string): { body: string; title: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { body: md, title: "" };
  const fm = m[1];
  const body = m[2];
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return { body, title: titleMatch?.[1] ?? "" };
}

export function renderInline(
  text: string,
  onWikilink: (stem: string, display: string) => void,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let s = text;
  let k = 0;
  while (s.length > 0) {
    const wm = s.match(/^\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/);
    if (wm) {
      const stem = wm[1].trim();
      const display = wm[2]?.trim() || stem;
      parts.push(
        <span key={k++} className="wiki-link" onClick={() => onWikilink(stem, display)}>
          {display}
        </span>,
      );
      s = s.slice(wm[0].length);
      continue;
    }
    const fn = s.match(/^\[\^([^\]]+)\]/);
    if (fn) {
      const label = fn[1].trim();
      parts.push(
        <sup key={k++} className="md-fn-ref">
          <a href={`#fn-${label}`}>{label}</a>
        </sup>,
      );
      s = s.slice(fn[0].length);
      continue;
    }
    const bm = s.match(/^\*\*(.+?)\*\*/);
    if (bm) { parts.push(<strong key={k++}>{bm[1]}</strong>); s = s.slice(bm[0].length); continue; }
    const im = s.match(/^\*(.+?)\*/);
    if (im) { parts.push(<em key={k++}>{im[1]}</em>); s = s.slice(im[0].length); continue; }
    const cm = s.match(/^`(.+?)`/);
    if (cm) { parts.push(<code key={k++} className="md-code">{cm[1]}</code>); s = s.slice(cm[0].length); continue; }
    const lm = s.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (lm) {
      parts.push(<a key={k++} href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a>);
      s = s.slice(lm[0].length);
      continue;
    }
    const next = s.search(/\[\[|\*\*|\*(?!\*)|`|\[/);
    if (next === -1) { parts.push(s); s = ""; }
    else if (next === 0) { parts.push(s[0]); s = s.slice(1); }
    else { parts.push(s.slice(0, next)); s = s.slice(next); }
  }
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

export function Markdown({
  content,
  onWikilink,
}: {
  content: string;
  onWikilink: (stem: string, display: string) => void;
}) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      elements.push(
        <pre key={i} className="md-pre">
          <code className={lang ? `lang-${lang}` : ""}>{codeLines.join("\n")}</code>
        </pre>,
      );
      i++; continue;
    }

    const hm = line.match(/^(#{1,4})\s+(.*)/);
    if (hm) {
      const lvl = hm[1].length;
      const Tag = `h${lvl}` as "h1" | "h2" | "h3" | "h4";
      elements.push(<Tag key={i} className="md-heading">{renderInline(hm[2], onWikilink)}</Tag>);
      i++; continue;
    }

    if (line.match(/^---+$/) || line.match(/^\*\*\*+$/) || line.match(/^___+$/)) {
      elements.push(<hr key={i} className="md-hr" />); i++; continue;
    }

    if (line.startsWith("> ")) {
      const qLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) { qLines.push(lines[i].slice(2)); i++; }
      elements.push(
        <blockquote key={i} className="md-blockquote">
          {qLines.map((l, j) => <p key={j}>{renderInline(l, onWikilink)}</p>)}
        </blockquote>,
      );
      continue;
    }

    if (line.match(/^[-*+]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*+]\s+/)) { items.push(lines[i].replace(/^[-*+]\s+/, "")); i++; }
      elements.push(
        <ul key={i} className="md-ul">
          {items.map((item, j) => <li key={j}>{renderInline(item, onWikilink)}</li>)}
        </ul>,
      );
      continue;
    }

    if (line.match(/^\d+\.\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) { items.push(lines[i].replace(/^\d+\.\s+/, "")); i++; }
      elements.push(
        <ol key={i} className="md-ol">
          {items.map((item, j) => <li key={j}>{renderInline(item, onWikilink)}</li>)}
        </ol>,
      );
      continue;
    }

    if (line.includes("|") && lines[i + 1]?.match(/^[\s|:-]+$/)) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes("|")) { tableLines.push(lines[i]); i++; }
      const [headerRow, , ...bodyRows] = tableLines;
      const headers = headerRow.split("|").filter((c) => c.trim() !== "").map((c) => c.trim());
      const rows = bodyRows.map((r) =>
        r.split("|").filter((c) => c.trim() !== "").map((c) => c.trim()),
      );
      elements.push(
        <div key={i} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>{headers.map((h, j) => <th key={j}>{renderInline(h, onWikilink)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{renderInline(cell, onWikilink)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (line.trim() === "") { i++; continue; }

    const fnDef = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (fnDef) {
      const label = fnDef[1].trim();
      const bodyLines: string[] = [fnDef[2]];
      i++;
      while (i < lines.length && lines[i].match(/^\s{2,}\S/)) {
        bodyLines.push(lines[i].replace(/^\s+/, ""));
        i++;
      }
      elements.push(
        <div key={i} id={`fn-${label}`} className="md-footnote">
          <span className="md-footnote-label">{label}.</span>{" "}
          {renderInline(bodyLines.join(" "), onWikilink)}
        </div>,
      );
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^#{1,4}\s/) &&
      !lines[i].startsWith("```") &&
      !lines[i].match(/^[-*+]\s/) &&
      !lines[i].match(/^\d+\.\s/) &&
      !lines[i].startsWith("> ") &&
      !lines[i].match(/^---+$/) &&
      !lines[i].match(/^\[\^[^\]]+\]:\s/)
    ) { paraLines.push(lines[i]); i++; }
    if (paraLines.length > 0) {
      // Preserve single newlines as <br/> rather than collapsing to spaces —
      // Obsidian-flavored markdown treats line breaks as significant (lists of
      // labeled fields, address blocks, etc.).
      const inline: React.ReactNode[] = [];
      for (let li = 0; li < paraLines.length; li++) {
        if (li > 0) inline.push(<br key={`br-${li}`} />);
        inline.push(
          <span key={`l-${li}`}>{renderInline(paraLines[li], onWikilink)}</span>,
        );
      }
      elements.push(<p key={i} className="md-para">{inline}</p>);
    }
  }

  return <div className="md-body">{elements}</div>;
}
