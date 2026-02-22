# CLARIFY 📚✨

> In-context PDF reading assistant for Chrome (Manifest V3)

![Chrome Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![Status](https://img.shields.io/badge/status-prototype-F2994A)
![Build](https://img.shields.io/badge/build-no%20build%20step-2D9CDB)

CLARIFY opens PDFs in a custom viewer and helps you define terms, explain passages, translate figures, and build reading structure without leaving the document.

## ✨ Why CLARIFY

Reading research papers usually means constant context switching across tabs and tools. CLARIFY keeps assistance in the same PDF view and stores useful context per document.

## ✅ What It Does

- 📂 Opens local and remote PDFs in a custom PDF.js viewer.
- 🖱️ Shows selection actions: `Highlight`, `Define`, `Explain`, `Translate (Figures)`.
- 🧭 Generates orientation summaries and section-level reading guidance.
- 💾 Stores per-document cards, glossary entries, walkthrough notes, and orientation cache.
- 🎨 Supports light/dark themes, flow/structure reading modes, and diagnostics.
- 🤖 Supports `mock` and `OpenAI` LLM providers with fallback handling.

## 🚀 Quick Start

### 1. Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository root (the folder with `manifest.json`).

### 2. Open CLARIFY viewer

Use one of these:

- Extension popup -> **Open CLARIFY Viewer**
- Extension popup -> **Open current tab (if PDF)**
- Right-click a PDF link -> **Open PDF in CLARIFY**
- Viewer settings -> enable **Auto-open PDF links in CLARIFY**

### 3. Load a PDF

- Click the open-file icon in the viewer toolbar for a local PDF.
- Or open from a PDF URL via popup/context menu.

## 🧠 How To Use

### Selection actions

1. Select text inside the PDF.
2. Choose one action from the popover:
- `Highlight`
- `Define`
- `Explain`
- `Translate (Figures)`

### ⌨️ Keyboard shortcuts

| Action | Windows/Linux | macOS |
| --- | --- | --- |
| Highlight selection | `Ctrl+Shift+H` | `Cmd+Shift+H` |
| Define selection | `Ctrl+Shift+D` | `Cmd+Shift+D` |
| Explain selection | `Ctrl+Shift+E` | `Cmd+Shift+E` |
| Translate figure/caption selection | `Ctrl+Shift+T` | `Cmd+Shift+T` |
| Dismiss selection UI | `Esc` | `Esc` |

### Sidebar tabs

- 📘 `Orientation`: Purpose, contribution, focus bullets, key terms, reading map.
- 💡 `Explain`: Definition/explanation cards grounded to page/section snippets.
- 🔖 `Glossary`: Saved terms with one-line definitions and source context.
- 📊 `Figures`: Figure/table translation cards.
- 🧩 `Walkthrough`: Section-by-section one-liners for guided reading.

## ⚙️ Settings, LLM Modes, and Privacy

Open the 3-dot menu in the viewer toolbar.

### LLM modes

- `auto` (default): Uses OpenAI only when an API key is present; otherwise uses mock.
- `mock`: Deterministic local mock responses.
- `openai`: Uses OpenAI directly; requires API key.

### Context scope

- `selection`: Selected text + nearby context.
- `page`: Page-level context.
- `whole_pdf`: Uses uploaded PDF context (requires OpenAI key + upload enabled).

### Privacy notes

- 🔒 CLARIFY does not upload full documents by default.
- ✅ Whole-PDF behavior is explicit and opt-in.
- 🧾 OpenAI key is stored in extension local storage (`chrome.storage.local`).

## 🖼️ Screenshots

![Paper orientation overview](assets/images/paper-orientation-overview.png)

![Paper text classification example](assets/images/paper-text-classification-example.png)

## 🛠️ Development

No build step is required.

1. Edit files directly.
2. Reload the extension in `chrome://extensions`.
3. Refresh any open CLARIFY viewer tab.

Debug entry points:

- Service worker logs: `chrome://extensions` -> **Inspect service worker**
- Viewer logs: DevTools in the viewer tab
- Debug bundle: Viewer menu -> **Copy debug info**

## 🧱 Repository Layout

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

## ⚠️ Known Limitations

- Some remote PDFs cannot be fetched due to CORS/auth restrictions.
- `file://` auto-redirect behavior can vary by browser settings.
- This is a prototype and does not yet include automated tests.

## 🗺️ Roadmap Direction

- Better citation grounding controls
- Stronger document-level retrieval for long PDFs
- UX polish for orientation and walkthrough workflows
