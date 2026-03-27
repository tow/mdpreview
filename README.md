# MarkdownPreview

A native macOS app for previewing and exporting Markdown files. Features a file tree navigator, live preview with multiple themes, and PDF export with configurable page layout.

## Features

- **File tree navigation** — browse directories and select Markdown files
- **Live preview** — rendered in WebKit with 6 built-in themes (GitHub, Water, Sakura, Simple, Splendor, Air)
- **PDF export** — configurable page size, margins, headers/footers, and logo embedding
- **Document mode** — print-optimized layout using Paged.js for paginated preview
- **Find in document** — Cmd+F search with forward/backward navigation
- **Auto-reload** — watches files for changes and refreshes automatically
- **Syntax highlighting** — code blocks highlighted with Highlight.js

## Requirements

- macOS 14.0 (Sonoma) or later
- Xcode 16+

## Build

```bash
make build      # compile
make install    # build and install to /Applications
make open       # install and launch
make clean      # clean derived data
```

## Usage

Open the app and select a Markdown file from the file tree, or open a `.md` file directly — MarkdownPreview registers as a viewer for Markdown files.

Set `MDPREVIEW_ROOT` to control the default browsing directory.

PDF export settings are stored in `~/Library/Application Support/MarkdownPreview/pdf.json`.
