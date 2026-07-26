// InstaGuardAI — content.js
// Watches Instagram DOM, extracts post data (including image URL for OCR), triggers analysis

const PROCESSED_ATTR = "data-instaguard-processed";
const analyzedPosts = new WeakSet();

// ─── Main Observer ────────────────────────────────────────────────────────────

const observer = new MutationObserver(debounce(scanForPosts, 800));
observer.observe(document.body, { childList: true, subtree: true });
setTimeout(scanForPosts, 1000);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SHOW_PANEL") {
    showPanel(message.data);
  }
});

// ─── Post Scanner ─────────────────────────────────────────────────────────────

function scanForPosts() {
  // ONLY target <article> elements — these are the actual posts on Instagram.
  // Do NOT use broad selectors like div[role='presentation'] — those match
  // comments, profile headers, sidebars, and other UI elements.
  document.querySelectorAll("article").forEach((post) => {
    if (post.hasAttribute(PROCESSED_ATTR) || analyzedPosts.has(post)) return;

    // Must be a real post: tall enough, and contains an actual post image
    // (not a profile pic or comment avatar)
    const hasPostImage = post.querySelector("div._aagv img, div[role='button'] img");
    const isTallEnough = post.offsetHeight > 300;
    if (!hasPostImage || !isTallEnough) return;

    // Skip if it's nested inside another article (avoid double-processing)
    if (post.closest("article article")) return;

    post.setAttribute(PROCESSED_ATTR, "true");
    analyzedPosts.add(post);

    const postData = extractPostData(post);

    // Only analyze if there's actual content to check
    if (!postData.caption && !postData.altText && !postData.imageUrl) return;

    analyzePost(post, postData);
  });
}

// ─── Data Extraction (now includes imageUrl for OCR) ─────────────────────────

function extractPostData(postEl) {
  // Caption text
  const captionEl = postEl.querySelector(
    "span[class*='caption'], div[class*='caption'], h1 + div span, span._aacl, div._a9zs span"
  );
  const caption = captionEl?.innerText?.trim() || "";

  // Image — get both alt text AND the src URL (for OCR)
  const imgEl = postEl.querySelector("img[alt]");
  const altText = imgEl?.alt || "";
  const imageUrl = imgEl?.src || "";

  // Username
  const usernameEl = postEl.querySelector(
    "a[href*='/'] span, span[class*='username'], header a, a.x1i10hfl span"
  );
  const username = usernameEl?.innerText?.trim() || "Unknown";

  // Post URL
  const linkEl = postEl.querySelector("a[href*='/p/'], a[href*='/reel/']");
  const postUrl = linkEl?.href || window.location.href;

  return { caption, altText, imageUrl, username, postUrl };
}

// ─── Analysis & Badge ─────────────────────────────────────────────────────────

function analyzePost(postEl, postData) {
  const badge = injectLoadingBadge(postEl);
  const cacheKey = (postData.caption || postData.altText || "").slice(0, 100);

  chrome.runtime.sendMessage({ type: "ANALYZE_POST", data: postData });

  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    const data = await chrome.storage.local.get([`result_${cacheKey}`]);
    const result = data[`result_${cacheKey}`];
    if (result) {
      clearInterval(poll);
      updateBadge(badge, result, postEl);
    }
    if (attempts > 30) clearInterval(poll);
  }, 1000);
}

// ─── Badge Injection ──────────────────────────────────────────────────────────

function injectLoadingBadge(postEl) {
  // Target specifically the image wrapper, not the whole article
  const imgEl = postEl.querySelector("div._aagv img, div[role='button'] > div > img");
  const target = imgEl?.closest("div._aagv") || imgEl?.parentElement || null;

  if (!target) return null;
  if (target.querySelector(".ig-badge")) return null;

  const badge = document.createElement("div");
  badge.className = "ig-badge ig-loading";
  badge.innerHTML = `
    <span class="ig-icon">⟳</span>
    <span class="ig-label">Scanning…</span>
  `;

  if (getComputedStyle(target).position === "static") {
    target.style.position = "relative";
  }
  target.appendChild(badge);
  return badge;
}

function updateBadge(badge, result, postEl) {
  if (!badge) return;

  const verdictMap = {
    SAFE: { cls: "ig-safe", icon: "✓", label: "Safe" },
    VERIFY: { cls: "ig-verify", icon: "!", label: "Verify" },
    LIKELY_FAKE: { cls: "ig-fake", icon: "✕", label: "Likely Fake" }
  };

  const v = verdictMap[result.verdict] || verdictMap["VERIFY"];

  badge.className = `ig-badge ${v.cls}`;
  badge.innerHTML = `
    <span class="ig-icon">${v.icon}</span>
    <span class="ig-label">${v.label}</span>
    <span class="ig-confidence">${result.confidence}%</span>
  `;

  // Show source indicators
  if (result.pib_debunks?.length > 0) {
    const pibTag = document.createElement("span");
    pibTag.className = "ig-pib-tag";
    pibTag.textContent = "PIB ⚠";
    badge.appendChild(pibTag);
  }

  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    showPanel(result);
  });
}

// ─── Fact-Check Panel ─────────────────────────────────────────────────────────

function showPanel(result) {
  document.querySelector(".ig-panel-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "ig-panel-overlay";

  const verdictColor = {
    SAFE: "#22c55e",
    VERIFY: "#f59e0b",
    LIKELY_FAKE: "#ef4444"
  }[result.verdict] || "#f59e0b";

  const redFlagsHTML = result.red_flags?.length
    ? result.red_flags.map(f => `<li>${f}</li>`).join("")
    : "<li>No specific flags detected</li>";

  const sourcesHTML = result.suggested_sources?.length
    ? result.suggested_sources.map(s => `<a href="https://${s}" target="_blank">${s}</a>`).join("")
    : "";

  // NewsAPI articles section
  const newsHTML = result.news_articles?.length
    ? `<div class="ig-panel-section">
        <div class="ig-section-title">📰 News Coverage</div>
        <p class="ig-source-note">${result.news_note}</p>
        ${result.news_articles.map(a =>
          `<a class="ig-news-link" href="${a.url}" target="_blank">
            <span class="ig-news-source">${a.source}</span> — ${a.title?.slice(0, 80)}...
          </a>`
        ).join("")}
      </div>`
    : `<div class="ig-panel-section">
        <div class="ig-section-title">📰 News Coverage</div>
        <p class="ig-source-note">${result.news_note || "No news check available."}</p>
      </div>`;

  // PIB Fact Check section
  const pibHTML = result.pib_debunks?.length
    ? `<div class="ig-panel-section ig-pib-alert">
        <div class="ig-section-title">🏛️ PIB Fact Check — MATCH FOUND</div>
        ${result.pib_debunks.map(d =>
          `<div class="ig-pib-item">
            <strong>${d.title}</strong>
            ${d.link ? `<a href="${d.link}" target="_blank">View →</a>` : ""}
          </div>`
        ).join("")}
      </div>`
    : `<div class="ig-panel-section">
        <div class="ig-section-title">🏛️ PIB Fact Check</div>
        <p class="ig-source-note">${result.pib_note || "No PIB debunks matched."}</p>
      </div>`;

  // OCR text section (only if text was found)
  const ocrHTML = result.ocr_text
    ? `<div class="ig-panel-section">
        <div class="ig-section-title">🔍 Text in Image (OCR)</div>
        <p class="ig-ocr-text">"${result.ocr_text.slice(0, 200)}"</p>
      </div>`
    : "";

  // Source breakdown
  const breakdownHTML = result.source_breakdown
    ? `<div class="ig-source-breakdown">
        <span class="ig-source-chip">🤖 ${result.source_breakdown.ai || "AI"}</span>
        ${result.source_breakdown.news ? `<span class="ig-source-chip">📰 ${result.source_breakdown.news}</span>` : ""}
        ${result.source_breakdown.pib ? `<span class="ig-source-chip">🏛️ ${result.source_breakdown.pib}</span>` : ""}
      </div>`
    : "";

  overlay.innerHTML = `
    <div class="ig-panel">
      <button class="ig-panel-close" id="igClose">✕</button>

      <div class="ig-panel-header">
        <div class="ig-panel-logo">InstaGuard<span>AI</span></div>
        <div class="ig-panel-verdict" style="color:${verdictColor}">
          ${result.verdict?.replace("_", " ")}
        </div>
      </div>

      ${breakdownHTML}

      <div class="ig-confidence-bar">
        <div class="ig-confidence-label">Confidence</div>
        <div class="ig-bar-track">
          <div class="ig-bar-fill" style="width:${result.confidence}%; background:${verdictColor}"></div>
        </div>
        <div class="ig-confidence-value">${result.confidence}%</div>
      </div>

      <div class="ig-panel-section">
        <div class="ig-section-title">🤖 AI Analysis (Local, on-device)</div>
        <p class="ig-reasoning">${result.reasoning}</p>
        ${result.tone_analysis ? `<p class="ig-meta">Tone: <strong>${result.tone_analysis}</strong> · Style: <strong>${result.writing_style}</strong></p>` : ""}
      </div>

      <div class="ig-panel-section">
        <div class="ig-section-title">⚑ Red Flags</div>
        <ul class="ig-flags">${redFlagsHTML}</ul>
      </div>

      ${ocrHTML}
      ${newsHTML}
      ${pibHTML}

      ${sourcesHTML ? `
      <div class="ig-panel-section">
        <div class="ig-section-title">🔗 Verify At</div>
        <div class="ig-sources">${sourcesHTML}</div>
      </div>` : ""}

      <button class="ig-report-btn" id="igReport">⚑ Report this post</button>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById("igClose").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById("igReport").addEventListener("click", () => handleReport(result));
}

// ─── Community Report ─────────────────────────────────────────────────────────

function handleReport(result) {
  chrome.storage.local.get(["reports"], (data) => {
    const reports = data.reports || [];
    reports.push({
      url: window.location.href,
      verdict: result.verdict,
      timestamp: Date.now(),
      caption: result.caption?.slice(0, 100)
    });
    chrome.storage.local.set({ reports });
  });

  const btn = document.getElementById("igReport");
  if (btn) {
    btn.textContent = "✓ Reported — Thank you!";
    btn.disabled = true;
    btn.style.opacity = "0.6";
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
