# CLARIFY — In-Context Research Reading Assistant (Chrome Extension Prototype)

CLARIFY is a Manifest V3 Chrome extension that opens PDF research papers in a custom viewer and provides an in-context reading assistant in a right-side panel.

This prototype is based on formative research findings from undergraduate students reading academic papers. The core goal is to reduce reading friction without disrupting flow.

---

# 1. Core Problem This Project Solves

From formative probes and course documentation, the key pain points when students read research papers are:

1. Unfamiliar terms and acronyms introduced early without explanation.
2. Context-switching to ChatGPT/Google breaks reading flow.
3. AI explanations are often too long or not grounded in the paper.
4. Figures and tables are hard to interpret (numbers → meaning → claim mapping).
5. Students want orientation before reading (what is this paper about? what matters?).
6. Trust is fragile — readers want grounding (quotes + section references).

CLARIFY directly addresses these issues inside the PDF reading environment.

---

# 2. Design Principles (Non-Negotiable)

These principles must guide all implementation decisions:

## 2.1 Reading Flow First
- Never block the PDF with large modals.
- Default explanations must be short (<= ~35 words).
- Progressive disclosure for deeper explanations.

## 2.2 In-Context Assistance
- Explanations are triggered from text selection.
- Always include grounding (page number + snippet quote).
- Provide “Jump to source” functionality.

## 2.3 Minimal UI
- No heavy app header.
- No branding bar at the top.
- Viewer should feel like a native PDF reader with a right utility panel.
- Sidebar uses compact icon tabs.

## 2.4 Trust Through Grounding
Every explanation card must include:
- Page number
- Section header (best effort)
- Direct quote snippet from PDF
- Jump-to-source action

## 2.5 Operate on Selection + Small Context
- Never upload entire PDFs by default.
- Only operate on selected text and small surrounding windows.
- Store minimal persistent data.

---

# 3. Feature Set (Current + Roadmap)

## 3.1 Viewer
- Opens local PDFs
- Opens remote PDF URLs
- Supports PDFs from current tab when possible
- Text layer enabled for selection
- Basic controls: zoom, page navigation, fit width

## 3.2 Sidebar Tabs
Icons only (minimal):

- 📘 Orientation
- 💡 Explain
- 🔖 Glossary
- 📊 Figures/Tables
- 🧩 Walkthrough

## 3.3 Core Flows

### Flow 1 — Orientation
Before reading:
- 2–3 sentence purpose summary
- Main contribution
- “What to focus on”
- Key terms preview
- Reading map (sections + 1-line intent)

Collapsible into a small chip.

### Flow 2 — Define / Explain
Triggered via:
- Text selection + popover
- Keyboard shortcuts

Default structure:
1. One-line explanation
2. Grounding block
3. Expandable:
   - ELI5
   - Step-by-step
   - “How this paper uses it”

### Flow 3 — Figure/Table Translation
Triggered via caption selection.

Structure:
- What it shows
- Key takeaway
- How it supports the claim
- What to look at
- Grounding (caption + nearby paragraph)

### Flow 4 — Glossary
- Save terms
- One-line definitions
- Jump to source
- Persistent in chrome.storage.local

### Flow 5 — Walkthrough
- Section-by-section 1-line summaries
- Editable
- Persistent

---

# 4. Architecture Overview

This is a Manifest V3 extension with no build step.

## 4.1 Structure

clarify-extension/
- manifest.json
- README.md
- src/
  - background/
    - service_worker.js
  - popup/
    - popup.html
    - popup.js
    - popup.css
  - viewer/
    - viewer.html
    - viewer.js
    - viewer.css
  - shared/
    - storage.js
    - diagnostics.js
    - llm/ (later)
- assets/icons/

## 4.2 Components

### Service Worker
- Opens viewer tab
- Handles open-from-current-tab logic
- Logs via diagnostics layer

### Popup
- Minimal launcher
- No heavy UI

### Viewer
- PDF.js integration
- Sidebar UI
- Card system
- Selection detection
- Keyboard shortcuts

### Shared Modules
- storage.js — wrapper around chrome.storage.local
- diagnostics.js — scoped logger
- llm/ — mock first, OpenAI-ready later

---

# 5. Data Storage Rules

Use chrome.storage.local only.

Persist:
- Glossary entries
- Walkthrough notes
- Card history (optional)
- Diagnostics.verbose flag
- API key (if added later)

Never persist:
- Full PDF text
- Full document contents
- Large context blobs

---

# 6. LLM Policy

Default: Mock LLM (deterministic placeholder)

When API key is set:
- Use OpenAI module
- Only send:
  - Selected text
  - Small surrounding context window
  - Metadata (page, section)

All LLM responses must follow structured format:

1. One-line explanation
2. Optional expansions:
   - ELI5
   - Step-by-step
   - Paper usage
3. Grounding block populated from PDF snippet

---

# 7. Debugging & Diagnostics

## 7.1 Loading Extension
1. Go to chrome://extensions
2. Enable Developer Mode
3. Click Load Unpacked
4. Select project root folder

## 7.2 Reload After Changes
- Click refresh icon in chrome://extensions
- Refresh viewer tab

## 7.3 Service Worker Logs
chrome://extensions → Inspect Service Worker

## 7.4 Viewer Logs
Open DevTools in viewer tab (F12)

## 7.5 Diagnostics Toggle
Viewer toolbar includes:
- Verbose logging toggle
- Copy debug info (JSON)

No PDF content should be logged.

---

# 8. Constraints for Codex

Codex must not:
- Add heavy UI frameworks
- Add authentication
- Upload entire PDFs
- Convert this into a chat application

Codex must:
- Keep UI minimal
- Keep logic modular
- Avoid breaking MV3 compatibility
- Stop when prompt scope is complete

---

# 9. Target User

Undergraduate student reading research papers who:
- Gets stuck on unfamiliar terminology
- Wants quick clarification without leaving the PDF
- Values trust and grounding
- Sometimes wants deeper explanation
- Wants structure before diving in

---

# 10. Long-Term Vision

CLARIFY is not a chatbot.

It is a structured reading companion that:
- Preserves cognitive flow
- Provides progressive explanation
- Grounds all assistance in the source document
- Helps build durable mental models of research papers

All implementation decisions should support this direction.