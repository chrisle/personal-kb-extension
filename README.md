# Personal Knowledge Base

Turns any folder into an always-updated knowledge base. Drop files in; Claude reads, summarizes, and cross-references them into a searchable wiki you can browse like Wikipedia.

## How it works

Adding, updating, or deleting files in your folder automatically updates the knowledge base.

Supports `.md` `.txt` `.csv` `.doc` `.docx` `.ppt` `.pptx` `.xls` `.xlsx` `.pdf` `.png` `.jpg` `.webp` `.gif`

## Commands

| Command | What it does |
|---|---|
| `/kb-query` | Ask Claude any question about your knowledge base |
| `/kb-view` | Browse your knowledge base like Wikipedia |
| `/save` | Add a Claude conversation to the knowledge base |

## Obsidian

Compatible with Obsidian — edit pages by hand, browse the knowledge graph, use any Obsidian plugin.

## Local only

Plain markdown files on your disk. No cloud sync. No special formats. Optionally in git.

## Install

1. Download `personal-knowledge-base.mcpb` from the [latest release](https://github.com/chrisle/personal-kb-extension/releases/latest).
2. Open Claude Desktop → **Settings → Extensions**.
3. Drag the `.mcpb` file into the Extensions window.
4. Click the extension → add one or more folders under **Knowledge folders**.
5. Toggle the extension **on**. Open a new chat.

Open `http://localhost:3737` in a browser to see your wiki and the live ingest queue.

→ [Advanced configuration](ADVANCED.md) · [Building from source](DEVELOPMENT.md)

## License

MIT — see [LICENSE](LICENSE). See [ATTRIBUTION.md](ATTRIBUTION.md) for upstream credits.
