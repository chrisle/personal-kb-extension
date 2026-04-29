# Attributions

This DXT is adapted from `AgriciDaniel/claude-obsidian`, which is itself an implementation of the LLM Wiki pattern. Key credits below.

---

## LLM Wiki Pattern

**Author:** Andrej Karpathy
**Source:** https://github.com/karpathy
**Use:** The core architecture — using an LLM to build and maintain a structured wiki from raw sources — is based on the LLM Wiki pattern Karpathy described publicly. This DXT is an independent implementation; no code or content from Karpathy's repositories was copied.

---

## claude-obsidian (upstream)

**Author:** AgriciDaniel / AI Marketing Hub
**License:** MIT
**Repository:** https://github.com/AgriciDaniel/claude-obsidian
**Use:** This DXT lifts the wiki schema (`WIKI.md`), Obsidian Templater configurations (`_templates/`), and `.obsidian/` defaults from the upstream repo verbatim. The slash-command and tool surface is reimplemented as MCP primitives so it works under Claude Desktop, since the upstream plugin format (`commands/`, `skills/`, `agents/`, `hooks/`) only loads inside Claude Code.

---

## ITS CSS Snippets

**Author:** SlRvb
**Source:** https://github.com/SlRvb/Obsidian--ITS-Theme
**License:** GPL-2.0
**Files:** `assets/obsidian/snippets/ITS-Dataview-Cards.css`, `assets/obsidian/snippets/ITS-Image-Adjustments.css`

These snippets are distributed under GPL-2.0. Per GPL-2.0 terms, any modifications to these files must also be released under GPL-2.0.

---

## Obsidian Plugins (pre-installed)

The following Obsidian community plugins ship inside `assets/obsidian/plugins/` as binaries from the upstream repo. Properties of their respective authors; users should verify license terms via each plugin's repository.

| Plugin | Author | Repository |
|--------|--------|-----------|
| Calendar | Liam Cain | https://github.com/liamcain/obsidian-calendar-plugin |
| Thino | Boninall (Quorafind) | https://github.com/Quorafind/Obsidian-Thino |
| Obsidian Excalidraw | Zsolt Viczian | https://github.com/zsviczian/obsidian-excalidraw-plugin |
| Obsidian Banners | Danny Hernandez | https://github.com/noatpad/obsidian-banners |

---

## This DXT

**License:** MIT (see [LICENSE](LICENSE))
**Author:** Christopher Le (Accenture)
**Purpose:** Internal Accenture distribution channel for the LLM Wiki pattern in Claude Desktop.
