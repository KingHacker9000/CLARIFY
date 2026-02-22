# CLARIFY

In-context PDF reading assistant for Chrome (Manifest V3).

CLARIFY opens PDFs in a custom viewer and lets you define terms, explain passages, translate figure captions, and build reading structure without leaving the document.

## Why CLARIFY

Reading research papers often breaks flow because you need to jump across tabs for definitions and explanations. CLARIFY keeps those actions in the same PDF view and stores helpful context (cards, glossary, walkthrough) per document.

## What It Does Today

- Opens local and remote PDFs in a custom PDF.js viewer.
- Shows selection popover actions: Highlight, Define, Explain, Translate (Figures).
- Generates orientation summaries and section-level reading guidance.
- Maintains per-document:
  - Explanation/definition cards
  - Glossary entries
  - Walkthrough notes
  - Orientation cache and section intents
- Supports light/dark theme, flow/structure reading modes, and diagnostics.
- Supports `mock` and `OpenAI` LLM providers (with fallback handling).

## Quick Start

### 1. Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository root (the folder containing `manifest.json`).

### 2. Open CLARIFY viewer

Use any of these paths:

- Extension popup -> **Open CLARIFY Viewer**
- Extension popup -> **Open current tab (if PDF)**
- Right-click a PDF link -> **Open PDF in CLARIFY**
- Enable **Auto-open PDF links in CLARIFY** in viewer settings

### 3. Load a PDF

- Click the folder/open icon in the viewer toolbar to open a local PDF, or
- Open from a PDF URL via popup/context menu.

## How To Use

### Selection actions

1. Select text inside the PDF.
2. Use the popover action:
   - `Highlight`
   - `Define`
   - `Explain`
   - `Translate (Figures)`

### Keyboard shortcuts

| Action | Windows/Linux | macOS |
| --- | --- | --- |
| Highlight selection | `Ctrl+Shift+H` | `Cmd+Shift+H` |
| Define selection | `Ctrl+Shift+D` | `Cmd+Shift+D` |
| Explain selection | `Ctrl+Shift+E` | `Cmd+Shift+E` |
| Translate figure/caption selection | `Ctrl+Shift+T` | `Cmd+Shift+T` |
| Dismiss selection UI | `Esc` | `Esc` |

### Sidebar tabs

- `Orientation`: Purpose, contribution, focus bullets, key terms, reading map.
- `Explain`: Definition/explanation cards grounded to page/section snippets.
- `Glossary`: Saved terms with one-line definitions and source context.
- `Figures`: Figure/table translation cards.
- `Walkthrough`: Section-by-section one-liners for guided reading.

## Settings, LLM Modes, and Privacy

Open the 3-dot menu in the viewer toolbar to access settings.

### LLM modes

- `auto` (default): Uses OpenAI only when an API key is present; otherwise uses mock.
- `mock`: Deterministic local mock responses.
- `openai`: Uses OpenAI directly; requires API key.

### Context scope

- `selection`: Use selected text + nearby context.
- `page`: Use page context.
- `whole_pdf`: Uses uploaded PDF context (requires OpenAI key + upload enabled).

### Privacy notes

- By default, CLARIFY does not upload full documents.
- Whole-PDF behavior is explicit and opt-in.
- OpenAI key is saved in extension local storage (`chrome.storage.local`).

## Development

No build step is required.

1. Edit files directly.
2. Reload the extension in `chrome://extensions`.
3. Refresh any open CLARIFY viewer tab.

Helpful debug entry points:

- Service worker logs: `chrome://extensions` -> **Inspect service worker**
- Viewer logs: DevTools in the viewer tab
- Debug bundle: Viewer menu -> **Copy debug info**

## Repository Layout

```text
.
|-- manifest.json
|-- README.md
|-- assets/
|   `-- icons/
`-- src/
    |-- background/
    |   `-- service_worker.js
    |-- popup/
    |-- shared/
    |   |-- diagnostics.js
    |   |-- storage.js
    |   |-- settings_schema.js
    |   `-- llm/
    |       |-- index.js
    |       `-- providers/
    |-- vendor/
    |   `-- pdfjs/
    `-- viewer/
        |-- viewer.html
        |-- viewer.js
        |-- selection.js
        `-- mode_manager.js
```

## Known Limitations

- Some remote PDFs cannot be fetched due to CORS/auth restrictions. Download locally and open the file when this happens.
- `file://` auto-redirect behavior can vary by browser settings.
- This is a prototype and does not yet include automated tests.

## Roadmap Direction

- Better citation grounding controls
- Stronger document-level retrieval for long PDFs
- UX polish for orientation and walkthrough workflows

