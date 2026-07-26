// TruthLens — panel.js
// Renders analysis result in the standalone panel page

document.addEventListener("DOMContentLoaded", () => {
  // Try to get result from URL params (passed from content.js) or storage
  const params = new URLSearchParams(window.location.search);
  const fromStorage = params.get("fromStorage");

  if (fromStorage) {
    chrome.storage.local.get(["lastResult"], (data) => {
      if (data.lastResult) {
        renderPanel(data.lastResult);
      } else {
        renderError();
      }
    });
  } else {
    // Listen for message from content.js
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "RENDER_PANEL" && msg.data) {
        renderPanel(msg.data);
      }
    });
  }
});

function renderPanel(result) {
  const content = document.getElementById("panelContent");
  if (!content) return;

  const verdictClass = {
    SAFE: "safe",
    VERIFY: "verify",
    LIKELY_FAKE: "fake"
  }[result.verdict] || "verify";

  const verdictIcon = { safe: "✓", verify: "!", fake: "✕" }[verdictClass];

  const verdictLabel = {
    SAFE: "Safe Content",
    VERIFY: "Needs Verification",
    LIKELY_FAKE: "Likely Fake"
  }[result.verdict] || "Verify";

  const verdictSub = {
    SAFE: "This content appears credible and factual.",
    VERIFY: "This content contains unverified claims.",
    LIKELY_FAKE: "This content shows signs of misinformation."
  }[result.verdict] || "";

  const confColor = { safe: "#22c55e", verify: "#f59e0b", fake: "#ef4444" }[verdictClass];

  const flagsHTML = result.red_flags?.length
    ? result.red_flags.map(f => `<li>${f}</li>`).join("")
    : "<li>No specific flags detected</li>";

  const sourcesHTML = result.suggested_sources?.length
    ? result.suggested_sources.map(s =>
        `<a class="chip" href="https://${s}" target="_blank">${s}</a>`
      ).join("")
    : "";

  const captionHTML = result.caption
    ? `<div class="section">
        <div class="section-title">Analyzed Caption</div>
        <p class="caption-preview">"${result.caption.slice(0, 200)}${result.caption.length > 200 ? '…' : ''}"</p>
       </div>`
    : "";

  content.innerHTML = `
    <div class="verdict-hero ${verdictClass}">
      <span class="verdict-icon">${verdictIcon}</span>
      <div class="verdict-title">${verdictLabel}</div>
      <div class="verdict-sub">${verdictSub}</div>
    </div>

    <div class="conf-row">
      <span class="conf-label">Confidence</span>
      <div class="conf-track">
        <div class="conf-fill" style="width:${result.confidence}%; background:${confColor}"></div>
      </div>
      <span class="conf-pct">${result.confidence}%</span>
    </div>

    <div class="section">
      <div class="section-title">AI Analysis</div>
      <p class="reasoning-text">${result.reasoning}</p>
    </div>

    <div class="section">
      <div class="section-title">Red Flags Detected</div>
      <ul class="flag-list">${flagsHTML}</ul>
    </div>

    ${captionHTML}

    ${sourcesHTML ? `
    <div class="section">
      <div class="section-title">Verify At</div>
      <div class="source-chips">${sourcesHTML}</div>
    </div>` : ""}
  `;
}

function renderError() {
  const content = document.getElementById("panelContent");
  if (content) {
    content.innerHTML = `
      <div style="text-align:center; padding:60px 20px; color:#555;">
        <p style="font-size:14px;">No analysis data found.</p>
        <p style="font-size:12px; margin-top:8px;">Click a badge on Instagram to see results.</p>
      </div>
    `;
  }
}
