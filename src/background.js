// InstaGuardAI — background.js
// Handles local WebLLM (text analysis) + local Tesseract.js (OCR) + NewsAPI + PIB Fact Check
// Groq has been fully removed — no API key, no external AI call, no rate limit.
//
// Requires Chrome 124+ (WebGPU is available directly inside MV3 service workers
// since that release — see https://chromiumdash.appspot.com/commit/8d78510e4aca5ac3cd8ee4a33e96b404eaa43246).

import * as webllm from "./vendor/webllm.bundle.js";
import Tesseract from "./vendor/tesseract.bundle.js";

// ⚠ Replace with your NewsAPI key from https://newsapi.org (free tier works)
const NEWS_API_KEY = "YOUR_NEWSAPI_KEY_HERE";
const NEWS_API_URL = "https://newsapi.org/v2/everything";

// PIB Fact Check RSS feed (no key needed — government public feed)
const PIB_FEED_URL = "https://pib.gov.in/RssMain.aspx?ModID=6&eType=9&LangID=1";

// Local LLM model — ~900MB one-time download, cached by the browser afterward.
// Falls back to the fp32 build for devices/GPUs without fp16 shader support.
const PRIMARY_MODEL_ID = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
const FALLBACK_MODEL_ID = "Qwen2.5-1.5B-Instruct-q4f32_1-MLC";

// Cache to avoid re-analyzing same content
const analysisCache = new Map();

let enginePromise = null;
let ocrWorkerPromise = null;

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ANALYZE_POST") {
    handleAnalysis(message.data, sendResponse);
    return true;
  }
  if (message.type === "OPEN_PANEL") {
    chrome.tabs.sendMessage(sender.tab.id, {
      type: "SHOW_PANEL",
      data: message.data
    });
  }
});

// ─── Main Analysis Orchestrator ───────────────────────────────────────────────
async function handleAnalysis(postData, sendResponse) {
  const cacheKey = (postData.caption || postData.altText || postData.ocrText || "").slice(0, 100);
  if (cacheKey && analysisCache.has(cacheKey)) {
    sendResponse({ success: true, result: analysisCache.get(cacheKey) });
    return;
  }

  try {
    if (postData.imageUrl && !postData.ocrText) {
      postData.ocrText = await runOCR(postData.imageUrl);
    }

    const [llmResult, newsResult, pibResult] = await Promise.allSettled([
      analyzeWithLocalLLM(postData),
      checkNewsAPI(postData),
      checkPIBFactCheck(postData)
    ]);

    // Debug logging — open chrome://extensions → service worker → console to see these
    console.log("[InstaGuardAI] LocalLLM:", llmResult.status, llmResult.status === "rejected" ? llmResult.reason?.message : llmResult.value?.verdict);
    console.log("[InstaGuardAI] NewsAPI:", newsResult.status, newsResult.status === "rejected" ? newsResult.reason?.message : newsResult.value?.found);
    console.log("[InstaGuardAI] PIB:", pibResult.status, pibResult.status === "rejected" ? pibResult.reason?.message : pibResult.value?.matched);

    const result = combineResults(
      llmResult.status === "fulfilled" ? llmResult.value : null,
      newsResult.status === "fulfilled" ? newsResult.value : null,
      pibResult.status === "fulfilled" ? pibResult.value : null,
      postData
    );

    console.log("[InstaGuardAI] Final verdict:", result.verdict, result.confidence + "%");

    if (cacheKey) analysisCache.set(cacheKey, result);
    await chrome.storage.local.set({ [`result_${cacheKey}`]: result });
    sendResponse({ success: true, result });
  } catch (error) {
    console.error("[InstaGuardAI] Fatal error:", error);
    sendResponse({ success: false, error: error.message });
  }
}

// ─── 1. Local LLM Analysis (WebLLM, replaces Groq) ────────────────────────────
async function getEngine() {
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    const initProgressCallback = (progress) => {
      // Let popup.js poll/show download progress if it wants to.
      chrome.storage.local.set({ modelLoadProgress: progress });
      console.log("[InstaGuardAI] Model load:", progress.text);
    };
    try {
      return await webllm.CreateMLCEngine(PRIMARY_MODEL_ID, { initProgressCallback });
    } catch (err) {
      console.warn("[InstaGuardAI] fp16 model failed, falling back to fp32:", err.message);
      return await webllm.CreateMLCEngine(FALLBACK_MODEL_ID, { initProgressCallback });
    }
  })();

  return enginePromise;
}

async function analyzeWithLocalLLM(postData) {
  const engine = await getEngine();
  const prompt = buildAnalysisPrompt(postData);

  const response = await engine.chat.completions.create({
    messages: [
      {
        role: "system",
        content: "You are a misinformation detection AI. Always respond with valid JSON only, no markdown, no extra text."
      },
      { role: "user", content: prompt }
    ],
    max_tokens: 700,
    temperature: 0.1,
    response_format: { type: "json_object" }
  });

  const rawText = response.choices?.[0]?.message?.content || "";
  console.log("[InstaGuardAI] Raw LLM output:", rawText);
  return parseLLMResponse(rawText, postData);
}

function buildAnalysisPrompt(postData) {
  const ocrSection = postData.ocrText
    ? `\nText extracted from image (OCR): "${postData.ocrText}"`
    : "";

  return `You are a misinformation detection AI. Analyze this Instagram post and respond ONLY in valid JSON.

POST DETAILS:
Caption: "${postData.caption || "No caption"}"
Alt Text / Image Description: "${postData.altText || "Not available"}"
Username: "${postData.username || "Unknown"}"${ocrSection}

Respond ONLY with this JSON (no markdown, no extra text):
{
  "verdict": "SAFE" | "VERIFY" | "LIKELY_FAKE",
  "confidence": <number 0-100>,
  "reasoning": "<2-3 sentence explanation>",
  "red_flags": ["<flag1>", "<flag2>"],
  "topics": ["<topic1>", "<topic2>"],
  "suggested_sources": ["<source1>", "<source2>"],
  "tone_analysis": "<emotional/neutral/manipulative/alarmist>",
  "writing_style": "<factual/opinion/satire/clickbait>"
}

Rules:
- SAFE = credible, factual, personal content
- VERIFY = needs fact-checking, unverified claims
- LIKELY_FAKE = clear misinformation, manipulated media, satire presented as fact
- Also analyze OCR text from image if provided — image text is often where fake claims appear`;
}

function extractJSONBlock(rawText) {
  // Strip code fences first
  let clean = rawText.replace(/```json|```/g, "").trim();

  // Try straight parse
  try {
    JSON.parse(clean);
    return clean;
  } catch { /* fall through */ }

  // Pull the first {...} block even if the model added prose before/after
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const slice = clean.slice(start, end + 1);
    try {
      JSON.parse(slice);
      return slice;
    } catch { /* fall through */ }
  }

  // Truncated JSON (hit max_tokens before closing) — try to close it off
  if (start !== -1) {
    let slice = clean.slice(start);
    // Count braces/brackets to see what's unclosed
    const openBraces = (slice.match(/{/g) || []).length;
    const closeBraces = (slice.match(/}/g) || []).length;
    const openBrackets = (slice.match(/\[/g) || []).length;
    const closeBrackets = (slice.match(/\]/g) || []).length;
    slice = slice.replace(/,\s*$/, ""); // trailing comma before we patch
    slice += "]".repeat(Math.max(0, openBrackets - closeBrackets));
    slice += "}".repeat(Math.max(0, openBraces - closeBraces));
    try {
      JSON.parse(slice);
      return slice;
    } catch { /* give up */ }
  }

  return null;
}

function parseLLMResponse(rawText, postData) {
  try {
    const clean = extractJSONBlock(rawText);
    if (!clean) throw new Error("No valid JSON found in LLM output");
    const parsed = JSON.parse(clean);
    return {
      verdict: parsed.verdict || "VERIFY",
      confidence: parsed.confidence ?? 50,
      reasoning: parsed.reasoning || "Unable to determine.",
      red_flags: parsed.red_flags || [],
      topics: parsed.topics || [],
      suggested_sources: parsed.suggested_sources || [],
      tone_analysis: parsed.tone_analysis || "unknown",
      writing_style: parsed.writing_style || "unknown",
      caption: postData.caption,
      username: postData.username,
      timestamp: Date.now()
    };
  } catch (err) {
    console.warn("[InstaGuardAI] Failed to parse LLM JSON:", err.message, "| raw:", rawText.slice(0, 300));
    return {
      verdict: "VERIFY",
      confidence: 40,
      reasoning: "Analysis inconclusive. Please verify this content manually.",
      red_flags: [],
      topics: [],
      suggested_sources: ["snopes.com", "factcheck.org"],
      tone_analysis: "unknown",
      writing_style: "unknown",
      caption: postData.caption,
      username: postData.username,
      timestamp: Date.now()
    };
  }
}

// ─── 2. NewsAPI Cross-Check (unchanged) ───────────────────────────────────────
async function checkNewsAPI(postData) {
  const text = postData.caption || postData.ocrText || postData.altText || "";
  if (!text || text.length < 10) {
    return { found: false, articles: [], query: "" };
  }

  const query = text
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .slice(0, 8)
    .join(" ")
    .trim();

  if (!query) return { found: false, articles: [], query: "" };

  const url = `${NEWS_API_URL}?q=${encodeURIComponent(query)}&language=en&sortBy=relevancy&pageSize=3&apiKey=${NEWS_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`NewsAPI error: ${response.status}`);
  }
  const data = await response.json();
  const articles = (data.articles || []).map(a => ({
    title: a.title,
    source: a.source?.name,
    url: a.url,
    publishedAt: a.publishedAt
  }));

  return {
    found: articles.length > 0,
    articles,
    query,
    totalResults: data.totalResults || 0
  };
}

// ─── 3. PIB Fact Check (unchanged) ────────────────────────────────────────────
async function checkPIBFactCheck(postData) {
  const text = (postData.caption || postData.ocrText || "").toLowerCase();
  if (!text || text.length < 10) {
    return { matched: false, debunks: [] };
  }

  const PROXY_URL = "https://api.allorigins.win/get?url=" + encodeURIComponent(PIB_FEED_URL);
  const response = await fetch(PROXY_URL);
  if (!response.ok) {
    throw new Error(`PIB feed error: ${response.status}`);
  }
  const json = await response.json();
  const xmlText = json.contents;
  const debunks = parsePIBFeed(xmlText);

  const postKeywords = extractKeywords(text);
  const matched = debunks.filter(item => {
    const itemText = (item.title + " " + item.description).toLowerCase();
    return postKeywords.some(kw => kw.length > 4 && itemText.includes(kw));
  });

  return {
    matched: matched.length > 0,
    debunks: matched.slice(0, 3),
    totalChecked: debunks.length
  };
}

function parsePIBFeed(xmlText) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const itemContent = match[1];
    const title = extractXMLTag(itemContent, "title");
    const description = extractXMLTag(itemContent, "description");
    const link = extractXMLTag(itemContent, "link");
    const pubDate = extractXMLTag(itemContent, "pubDate");
    if (title) {
      items.push({ title, description: description?.replace(/<[^>]*>/g, "") || "", link, pubDate });
    }
  }
  return items;
}

function extractXMLTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? (match[1] || match[2] || "").trim() : "";
}

function extractKeywords(text) {
  const stopWords = new Set(["the", "is", "in", "and", "or", "a", "an", "to", "of", "for", "on", "with", "this", "that", "are", "was", "has", "not", "will", "from", "by"]);
  return text
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w));
}

// ─── 4. OCR — Extract Text from Image (Tesseract.js, replaces Groq vision) ────
async function getOCRWorker() {
  if (ocrWorkerPromise) return ocrWorkerPromise;

  ocrWorkerPromise = Tesseract.createWorker("eng", 1, {
    workerPath: chrome.runtime.getURL("src/vendor/tesseract/worker.min.js"),
    corePath: chrome.runtime.getURL("src/vendor/tesseract/tesseract-core-simd-lstm.js"),
    // Language traineddata is data, not code, so it's fine to fetch from a CDN at runtime.
    // Add this host to manifest.json host_permissions / connect-src if you change it.
    langPath: "https://tessdata.projectnaptha.com/4.0.0",
    workerBlobURL: false,
    logger: () => {}
  });

  return ocrWorkerPromise;
}

async function runOCR(imageUrl) {
  try {
    const worker = await getOCRWorker();
    const { data } = await worker.recognize(imageUrl);
    return (data.text || "").trim();
  } catch (err) {
    console.warn("[InstaGuardAI] OCR failed:", err.message);
    return ""; // OCR is best-effort, don't fail the whole analysis
  }
}

// ─── 5. Combine All Results into Final Verdict ────────────────────────────────
function combineResults(llm, news, pib, postData) {
  const base = llm || {
    verdict: "VERIFY",
    confidence: 40,
    reasoning: "Local AI analysis unavailable.",
    red_flags: [],
    topics: [],
    suggested_sources: [],
    tone_analysis: "unknown",
    writing_style: "unknown"
  };

  let confidenceAdjustment = 0;
  const extraFlags = [];
  const sources = { ai: "Local AI Analysis (WebLLM)", news: null, pib: null };

  if (news?.found) {
    if (news.articles.length >= 2) {
      confidenceAdjustment += (base.verdict === "SAFE" ? +10 : -5);
      sources.news = `Found in ${news.articles.length} news source(s)`;
    } else {
      sources.news = `Found in 1 news source`;
    }
  } else if (news && !news.found) {
    if (base.verdict !== "SAFE") {
      confidenceAdjustment += 5;
      extraFlags.push("No mainstream media coverage found");
    }
    sources.news = "Not found in mainstream media";
  }

  if (pib?.matched && pib.debunks.length > 0) {
    base.verdict = "LIKELY_FAKE";
    confidenceAdjustment += 20;
    extraFlags.push("⚠ PIB has fact-checked similar content");
    sources.pib = `Matched ${pib.debunks.length} PIB fact-check(s)`;
  } else if (pib) {
    sources.pib = "No PIB debunks found";
  }

  const finalConfidence = Math.min(99, Math.max(5, base.confidence + confidenceAdjustment));

  const newsNote = news?.found
    ? `NewsAPI found ${news.articles.length} related article(s).`
    : "No mainstream news coverage found.";
  const pibNote = pib?.matched
    ? `PIB Fact Check matched ${pib.debunks.length} government debunk(s).`
    : "PIB Fact Check: no matching debunks.";

  return {
    verdict: base.verdict,
    confidence: finalConfidence,
    reasoning: base.reasoning,
    red_flags: [...(base.red_flags || []), ...extraFlags],
    topics: base.topics || [],
    suggested_sources: base.suggested_sources || [],
    tone_analysis: base.tone_analysis,
    writing_style: base.writing_style,
    news_articles: news?.articles || [],
    pib_debunks: pib?.debunks || [],
    source_breakdown: sources,
    news_note: newsNote,
    pib_note: pibNote,
    ocr_text: postData.ocrText || null,
    caption: postData.caption,
    username: postData.username,
    timestamp: Date.now()
  };
}
