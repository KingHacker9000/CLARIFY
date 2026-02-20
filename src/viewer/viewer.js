const panel = document.getElementById("panel");
const statusEl = document.getElementById("status");
const fileInput = document.getElementById("fileInput");
const openFileBtn = document.getElementById("openFile");

function renderEmpty(tab = "orientation") {
  if (tab === "orientation") {
    panel.innerHTML = `
      <h3 style="margin:0 0 6px 0;">Paper Orientation</h3>
      <p style="margin:0;color:#666;">
        Open a PDF to generate purpose, focus points, key terms, and a reading map.
      </p>
    `;
    return;
  }

  const messages = {
    explain: "No explanations yet. Select text in the PDF, then use shortcuts.",
    glossary: "Your glossary is empty. Save terms from explanations.",
    figures: "No figure translations yet. Select a caption and translate.",
    walkthrough: "No walkthrough notes yet. Generate section one-liners."
  };

  panel.innerHTML = `
    <div style="height:100%;display:grid;place-items:center;text-align:center;color:#666;padding:30px;">
      <div>
        <div style="font-size:22px;margin-bottom:10px;">💡</div>
        <div>${messages[tab] ?? "Empty"}</div>
      </div>
    </div>
  `;
}

function setActiveTab(tab) {
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  renderEmpty(tab);
}

document.querySelectorAll(".tab").forEach((b) => {
  b.addEventListener("click", () => setActiveTab(b.dataset.tab));
});

openFileBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  statusEl.textContent = `Loaded: ${file.name} (PDF render: TODO)`;

  // TODO: integrate PDF.js rendering here
  // For now, just show that the pipeline works.
  setActiveTab("orientation");
});

// Load optional ?src= URL
const params = new URLSearchParams(location.search);
const src = params.get("src");
if (src) {
  statusEl.textContent = `Source: ${src} (PDF render: TODO)`;
}

setActiveTab("orientation");