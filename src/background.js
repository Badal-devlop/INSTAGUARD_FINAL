// InstaGuardAI — background.js
// Handles Groq AI + NewsAPI + PIB Fact Check + OCR analysis

const GROQ_API_KEY = "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"; // Replace with your key
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// ⚠️ Replace with your NewsAPI key from https://newsapi.org (free tier works)
const NEWS_API_KEY = "YOUR_NEWSAPI_KEY_HERE";
const NEWS_API_URL = "https://newsapi.org/v2/everything";

// PIB Fact Check RSS feed (no key needed — government public feed)
const PIB_FEED_URL = "https://pib.gov.in/RssMain.aspx?ModID=6&eType=9&LangID=1";

// Cache to avoid re-analyzing same content
const analysisCache = new Map();

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

    const [groqResult, newsResult, pibResult] = await Promise.allSettled([
      analyzeWithGroq(postData),
      checkNewsAPI(postData),
      checkPIBFactCheck(postData)
    ]);

    // Debug logging — open chrome://extensions → service worker → console to see these
    console.log("[InstaGuardAI] Groq:", groqResult.status, groqResult.status === "rejected" ? groqResult.reason?.message : groqResult.value?.verdict);
    console.log("[InstaGuardAI] NewsAPI:", newsResult.status, newsResult.status === "rejected" ? newsResult.reason?.message : newsResult.value?.found);
    console.log("[InstaGuardAI] PIB:", pibResult.status, pibResult.status === "rejected" ? pibResult.reason?.message : pibResult.value?.matched);

    const result = combineResults(
      groqResult.status === "fulfilled" ? groqResult.value : null,
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

// ─── 1. Groq AI Analysis ──────────────────────────────────────────────────────

async function analyzeWithGroq(postData) {
  const prompt = buildGroqPrompt(postData);

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "You are a misinformation detection AI. Always respond with valid JSON only."
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 500,
      temperature: 0.1,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Groq API error: ${response.status} - ${JSON.stringify(err)}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content || "";
  return parseGroqResponse(rawText, postData);
}

function buildGroqPrompt(postData) {
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

function parseGroqResponse(rawText, postData) {
  try {
    const clean = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    return {
      verdict: parsed.verdict || "VERIFY",
      confidence: parsed.confidence || 50,
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
  } catch {
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

// ─── 2. NewsAPI Cross-Check ───────────────────────────────────────────────────

async function checkNewsAPI(postData) {
  // Build a search query from caption or OCR text
  const text = postData.caption || postData.ocrText || postData.altText || "";
  if (!text || text.length < 10) {
    return { found: false, articles: [], query: "" };
  }

  // Extract key phrases (first 60 chars avoids noise)
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

// ─── 3. PIB Fact Check ────────────────────────────────────────────────────────

async function checkPIBFactCheck(postData) {
  const text = (postData.caption || postData.ocrText || "").toLowerCase();
  if (!text || text.length < 10) {
    return { matched: false, debunks: [] };
  }

  // PIB blocks direct CORS requests from extensions, so route through a public proxy
  const PROXY_URL = "https://api.allorigins.win/get?url=" + encodeURIComponent(PIB_FEED_URL);
  const response = await fetch(PROXY_URL);
  if (!response.ok) {
    throw new Error(`PIB feed error: ${response.status}`);
  }

  const json = await response.json();
  const xmlText = json.contents;
  const debunks = parsePIBFeed(xmlText);

  // Extract keywords from post text for matching
  const postKeywords = extractKeywords(text);

  // Match against PIB debunks
  const matched = debunks.filter(item => {
    const itemText = (item.title + " " + item.description).toLowerCase();
    return postKeywords.some(kw => kw.length > 4 && itemText.includes(kw));
  });

  return {
    matched: matched.length > 0,
    debunks: matched.slice(0, 3), // top 3 matches
    totalChecked: debunks.length
  };
}

function parsePIBFeed(xmlText) {
  // Parse RSS XML manually (no DOMParser in service workers)
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
  // Remove common stop words and return meaningful keywords
  const stopWords = new Set(["the", "is", "in", "and", "or", "a", "an", "to", "of", "for", "on", "with", "this", "that", "are", "was", "has", "not", "will", "from", "by"]);
  return text
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
}

// ─── 4. OCR — Extract Text from Image ────────────────────────────────────────

async function runOCR(imageUrl) {
  try {
    // Use Groq's vision model to extract text from the image
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct", // Groq vision model
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: imageUrl }
              },
              {
                type: "text",
                text: "Extract ALL text visible in this image. Return only the raw text, nothing else. If no text is visible, return empty string."
              }
            ]
          }
        ],
        max_tokens: 300,
        temperature: 0
      })
    });

    if (!response.ok) return "";
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || "";
  } catch {
    return ""; // OCR is best-effort, don't fail the whole analysis
  }
}

// ─── 5. Combine All Results into Final Verdict ────────────────────────────────

function combineResults(groq, news, pib, postData) {
  // Start with Groq's verdict as base
  const base = groq || {
    verdict: "VERIFY",
    confidence: 40,
    reasoning: "AI analysis unavailable.",
    red_flags: [],
    topics: [],
    suggested_sources: [],
    tone_analysis: "unknown",
    writing_style: "unknown"
  };

  let confidenceAdjustment = 0;
  const extraFlags = [];
  const sources = { groq: "AI Analysis", news: null, pib: null };

  // NewsAPI: boosts or reduces confidence
  if (news?.found) {
    if (news.articles.length >= 2) {
      // Story exists in multiple outlets → likely real
      confidenceAdjustment += (base.verdict === "SAFE" ? +10 : -5);
      sources.news = `Found in ${news.articles.length} news source(s)`;
    } else {
      sources.news = `Found in 1 news source`;
    }
  } else if (news && !news.found) {
    // No mainstream coverage → suspicious if it's a claim
    if (base.verdict !== "SAFE") {
      confidenceAdjustment += 5; // more confident it's fake
      extraFlags.push("No mainstream media coverage found");
    }
    sources.news = "Not found in mainstream media";
  }

  // PIB: if PIB has debunked something matching this post → strong signal
  if (pib?.matched && pib.debunks.length > 0) {
    base.verdict = "LIKELY_FAKE";
    confidenceAdjustment += 20;
    extraFlags.push("⚠️ PIB has fact-checked similar content");
    sources.pib = `Matched ${pib.debunks.length} PIB fact-check(s)`;
  } else if (pib) {
    sources.pib = "No PIB debunks found";
  }

  // Clamp confidence to 0-99
  const finalConfidence = Math.min(99, Math.max(5, base.confidence + confidenceAdjustment));

  // Build combined reasoning
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
    // Extra data for the panel UI
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
