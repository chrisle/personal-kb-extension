/**
 * Minimal YAML frontmatter parser. Handles scalar string fields only — sufficient
 * for the wiki schema (type, title, domain, status, created, updated). Lists and
 * nested objects are ignored.
 */
export interface Frontmatter {
  type?: string;
  title?: string;
  domain?: string;
  status?: string;
  created?: string;
  updated?: string;
  [key: string]: string | undefined;
}

export function parseFrontmatter(content: string): Frontmatter {
  if (!content.startsWith("---")) return {};
  const after = content.slice(3);
  const endRel = after.search(/\n---\s*(\n|$)/);
  if (endRel === -1) return {};
  const yaml = after.slice(0, endRel);

  const out: Frontmatter = {};
  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2].trim();
    if (!val) continue;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

/** Map frontmatter `type` value to its wiki/ subfolder name. */
export const TYPE_TO_FOLDER: Record<string, string> = {
  concept: "concepts",
  entity: "entities",
  domain: "domains",
  source: "sources",
  comparison: "comparisons",
  question: "questions",
  meta: "meta",
};

export function folderForType(type: string | undefined): string | null {
  if (!type) return null;
  return TYPE_TO_FOLDER[type.toLowerCase()] ?? null;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
