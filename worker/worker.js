/**
 * Cloudflare Worker — Reading Practice Tracker
 *
 * Required Worker secrets (set in Cloudflare dashboard):
 *   NOTION_TOKEN        — your Notion integration token (secret_xxx...)
 *   NOTION_DATABASE_ID  — the UUID of the Sessions database
 *   GEMINI_API_KEY      — your Google AI Studio API key (for Gemini TTS fallback)
 *   GCP_API_KEY         — Google Cloud API key restricted to Cloud Text-to-Speech API
 *
 * Routes:
 *   POST /session      — create a new session in Notion
 *   GET  /sessions     — list sessions (properties only)
 *   GET  /session/:id  — get one session with full block content
 *   POST /tts          — synthesise British English speech
 *                          body { sentence, model: "gcp" | "quick" | "full" }
 *                          returns { format: "mp3" | "pcm16", data: "<base64>" }
 *   POST /generate     — generate a British English practice sentence / passage
 *                          body { weaknesses: string[], length: "sentence" | "passage" }
 *                          returns { text: "..." }
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// ─── Notion HTTP helper ────────────────────────────────────────────────────────

async function notion(env, method, path, body) {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ─── Markdown → Notion blocks ──────────────────────────────────────────────────

function parseInline(text) {
  const parts = [];
  // Match **bold** and plain text segments
  const regex = /\*\*(.+?)\*\*/g;
  let last = 0, match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last)
      parts.push({ type: "text", text: { content: text.slice(last, match.index) } });
    parts.push({ type: "text", text: { content: match[1] }, annotations: { bold: true } });
    last = match.index + match[0].length;
  }
  if (last < text.length)
    parts.push({ type: "text", text: { content: text.slice(last) } });
  return parts.length ? parts : [{ type: "text", text: { content: text } }];
}

function parseTable(tableLines) {
  // Drop separator rows (| --- | :---: | etc.)
  const dataRows = tableLines.filter(
    (l) => !/^\s*\|[\s|:-]+\|\s*$/.test(l)
  );
  if (!dataRows.length) return null;

  const rows = dataRows.map((l) =>
    l.split("|").slice(1, -1).map((c) => c.trim())
  );
  const width = Math.max(...rows.map((r) => r.length));

  return {
    type: "table",
    table: {
      table_width: width,
      has_column_header: true,
      has_row_header: false,
      children: rows.map((cells) => ({
        type: "table_row",
        table_row: {
          cells: Array.from({ length: width }, (_, i) =>
            parseInline(cells[i] ?? "")
          ),
        },
      })),
    },
  };
}

function markdownToBlocks(md) {
  const blocks = [];
  const lines = md.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Headings
    if (line.startsWith("### ")) {
      blocks.push({ type: "heading_3", heading_3: { rich_text: parseInline(line.slice(4)) } });
      i++; continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "heading_2", heading_2: { rich_text: parseInline(line.slice(3)) } });
      i++; continue;
    }
    if (line.startsWith("# ")) {
      blocks.push({ type: "heading_1", heading_1: { rich_text: parseInline(line.slice(2)) } });
      i++; continue;
    }

    // Divider
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      blocks.push({ type: "divider", divider: {} });
      i++; continue;
    }

    // Bullet list
    if (line.startsWith("- ") || line.startsWith("* ")) {
      blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: parseInline(line.slice(2)) } });
      i++; continue;
    }

    // Numbered list
    const numMatch = line.match(/^\d+\.\s+(.+)/);
    if (numMatch) {
      blocks.push({ type: "numbered_list_item", numbered_list_item: { rich_text: parseInline(numMatch[1]) } });
      i++; continue;
    }

    // Table — collect consecutive pipe lines
    if (line.startsWith("|")) {
      const tLines = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        tLines.push(lines[i++]);
      }
      const tBlock = parseTable(tLines);
      if (tBlock) blocks.push(tBlock);
      continue;
    }

    // Paragraph — split if over 2000 chars
    if (line.length > 2000) {
      for (let c = 0; c < line.length; c += 2000) {
        blocks.push({ type: "paragraph", paragraph: { rich_text: parseInline(line.slice(c, c + 2000)) } });
      }
    } else {
      blocks.push({ type: "paragraph", paragraph: { rich_text: parseInline(line) } });
    }
    i++;
  }

  return blocks;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Notion rich_text blocks have a 2000 char limit — split long text into chunks
function textBlocks(content) {
  const chunks = [];
  for (let i = 0; i < content.length; i += 2000) {
    chunks.push({
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: content.slice(i, i + 2000) } }] }
    });
  }
  return chunks;
}

// ─── TTS: Google Cloud (primary) + Gemini (fallback) ───────────────────────────
//
// Response envelope (all branches):
//   { format: "mp3" | "pcm16", data: "<base64>" }
//
// Browser plays "mp3" directly as a data URL; "pcm16" (24kHz/16-bit/mono) is
// wrapped in a WAV header client-side before playback.

async function handleTts(request, env) {
  const { sentence, model } = await request.json();
  if (!sentence?.trim()) {
    return Response.json({ error: "No sentence provided" }, { status: 400 });
  }

  try {
    if (model === "full" || model === "quick") {
      return await handleGeminiTts(sentence, model, env);
    }
    // Default: Google Cloud TTS (en-GB Neural2)
    return await handleGcpTts(sentence, env);
  } catch (err) {
    return Response.json({ error: err.message || String(err) }, { status: 502 });
  }
}

// ─── Google Cloud TTS ──────────────────────────────────────────────────────────
// Voice: en-GB-Neural2-C (female British English RP).
// Free tier: 1M Neural2 chars/month. Returns base64-encoded MP3.
// Auth: restricted API key passed as ?key= query param.

async function handleGcpTts(sentence, env) {
  if (!env.GCP_API_KEY) throw new Error("Missing GCP_API_KEY secret");

  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${env.GCP_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text: sentence },
        voice: { languageCode: "en-GB", name: "en-GB-Neural2-C" },
        audioConfig: { audioEncoding: "MP3" },
      }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GCP TTS failed: ${errText}`);
  }
  const data = await res.json();
  if (!data.audioContent) throw new Error("GCP TTS returned no audio");
  return Response.json({ format: "mp3", data: data.audioContent });
}

// ─── Gemini TTS (legacy / premium fallback) ────────────────────────────────────

async function handleGeminiTts(sentence, model, env) {
  // "full" → 3.1 (richer, 3 RPM free tier); "quick" → 2.5 (faster, higher limit)
  const modelName = model === "full"
    ? "gemini-3.1-flash-tts-preview"
    : "gemini-2.5-flash-preview-tts";

  const text = `Speak in British English (Received Pronunciation): ${sentence}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
          },
        },
      }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini TTS failed: ${errText}`);
  }
  const json = await res.json();
  const b64 = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new Error("No audio in Gemini response");
  return Response.json({ format: "pcm16", data: b64 });
}

// ─── Gemini text generation (practice sentences & passages) ────────────────────
// POST /generate
//   body: { weaknesses: string[], length: "sentence" | "passage" }
//   returns: { text: "..." }

const WEAKNESS_BRIEFS = {
  schwa:      "unstressed function words (of, to, for, was, the, a, and, from) reducing to /ə/ in connected speech",
  aspiration: "word-initial stressed /p/, /t/, /k/ that receive strong aspiration (e.g. pick, time, cat, park, tickets)",
  linking:    "consonant-to-vowel word boundaries (catenation) and vowel-to-vowel intrusive /r/, /w/, /j/ linking",
  stress:     "alternating stressed content words and weak-form function words to create English stress-timed rhythm",
  glottal:    "syllable-final /t/ before consonants that native RP speakers glottalise to [ʔ] (e.g. quite good, that man, get back)",
};

async function handleGenerate(request, env) {
  const { weaknesses, length, size, intonation } = await request.json();
  if (!Array.isArray(weaknesses) || weaknesses.length === 0) {
    return Response.json({ error: "No weaknesses selected" }, { status: 400 });
  }
  if (!env.GEMINI_API_KEY) {
    return Response.json({ error: "Missing GEMINI_API_KEY secret" }, { status: 500 });
  }

  const briefs = weaknesses
    .map(k => WEAKNESS_BRIEFS[k])
    .filter(Boolean);
  if (briefs.length === 0) {
    return Response.json({ error: "Unknown weakness key(s)" }, { status: 400 });
  }

  const prompt = length === "passage"
    ? buildPassagePrompt(briefs, size, intonation)
    : buildSentencePrompt(briefs[0], size, intonation);

  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.9,          // high variety across regenerations
            maxOutputTokens: 6000,     // 1000-word passage ≈ 1500 tokens; extra headroom for thinking tokens
            thinkingConfig: { thinkingBudget: 0 }, // disable internal reasoning; this is a shallow task
          },
        }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      return Response.json({ error: `Gemini generate failed: ${errText}` }, { status: 502 });
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return Response.json({ error: "Empty generation response" }, { status: 502 });

    // Strip accidental wrapping quotes / markdown fences
    const cleaned = text
      .replace(/^```[a-zA-Z]*\n?/, "")
      .replace(/\n?```$/, "")
      .replace(/^["']|["']$/g, "")
      .trim();
    return Response.json({ text: cleaned });
  } catch (err) {
    return Response.json({ error: err.message || String(err) }, { status: 502 });
  }
}

// ── Delivery scoring (Gemini 2.5 Flash, multimodal audio) ─────────────────
async function handleScoreLine(request, env) {
  const { target, audioBase64, mime } = await request.json();
  if (!target || !audioBase64) {
    return Response.json({ error: "target and audioBase64 required" }, { status: 400 });
  }
  if (!env.GEMINI_API_KEY) {
    return Response.json({ error: "Missing GEMINI_API_KEY secret" }, { status: 500 });
  }
  const audioMime = mime || "audio/webm";
  const prompt = [
    `You are a Standard Southern British English (SSBE / RP) pronunciation coach.`,
    `The attached audio is a learner's ATTEMPT to read this target line:`,
    `  "${target}"`,
    ``,
    `Do these steps in order, and be strict:`,
    `1. Transcribe the audio verbatim — write EXACTLY what you hear, including`,
    `   mispronunciations, missing words, filler, or silence. Do NOT assume the`,
    `   learner said the target. If you hear nothing intelligible, return "".`,
    `2. Assess audio quality: "clear" | "noisy" | "choppy" | "unintelligible".`,
    `   "choppy" = dropouts, glitches, or truncated words.`,
    `   "unintelligible" = too broken to evaluate pronunciation fairly.`,
    `3. Compare the transcript to the target. Score pronunciation 0–100:`,
    `   - If transcript is empty or audio is "unintelligible": pct MUST be ≤ 20.`,
    `   - If audio is "choppy" OR transcript is missing many target words: pct ≤ 40.`,
    `   - Otherwise score on SSBE features: weak forms (schwa for function words),`,
    `     catenation/linking-r, glottal T, aspiration of /p t k/, stress timing, intonation.`,
    `4. Write 2–4 short coaching notes. If audio quality capped the score, the`,
    `   FIRST note must say so plainly (e.g. "Audio was choppy — re-record").`,
    ``,
    `Return STRICT JSON only, no markdown fences:`,
    `{"pct": <integer 0-100>, "heard": "<verbatim transcript or empty string>", "audio_quality": "<clear|noisy|choppy|unintelligible>", "notes": ["<short note>", ...]}`,
  ].join("\n");
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: audioMime, data: audioBase64 } },
            ],
          }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 800,
            thinkingConfig: { thinkingBudget: 0 },
            responseMimeType: "application/json",
          },
        }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      return Response.json({ error: `Gemini score failed: ${errText}` }, { status: 502 });
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return Response.json({ error: "Empty score response" }, { status: 502 });
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (_) {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return Response.json({ error: "Non-JSON score response" }, { status: 502 });
      parsed = JSON.parse(m[0]);
    }
    const pct = Math.max(0, Math.min(100, Math.round(Number(parsed.pct) || 0)));
    const notes = Array.isArray(parsed.notes) ? parsed.notes.map(String).slice(0, 6) : [];
    const heard = typeof parsed.heard === "string" ? parsed.heard : "";
    const audio_quality = ["clear","noisy","choppy","unintelligible"].includes(parsed.audio_quality)
      ? parsed.audio_quality : "clear";
    return Response.json({ pct, heard, audio_quality, notes });
  } catch (err) {
    return Response.json({ error: err.message || String(err) }, { status: 502 });
  }
}

const INTONATION_INSTRUCTIONS = `
INTONATION MARKS — insert the following Unicode arrows INLINE at natural tone boundaries so a learner can see the target prosodic contour:
  • Place "↗" IMMEDIATELY BEFORE a word whose accented syllable carries a rising tone. Rising tone is used for:
    - yes/no questions ("Are you ↗coming?")
    - non-final items in a list ("I bought ↗apples, ↗pears, and ↘bananas.")
    - continuation within a long sentence, clause-final rise before "and/but/so"
    - polite checks and soft invitations
  • Place "↘" IMMEDIATELY BEFORE a word whose accented syllable carries a falling tone. Falling tone is used for:
    - declarative statements (at the final stressed word)
    - wh-questions ("What's your ↘name?")
    - commands and final list items
  • Use arrows sparingly — only on the one or two most prominent tone-bearing syllables per intonation phrase. Do NOT put an arrow on every word.
  • Do not explain the arrows, do not add a legend.`;

function buildSentencePrompt(brief, size, intonation) {
  const range =
    size === "short" ? "6–10 words"
    : size === "long"  ? "20–30 words"
    : "10–20 words"; // "med" or unspecified
  const intoBlock = intonation ? "\n" + INTONATION_INSTRUCTIONS : "";
  return `Generate exactly ONE natural British English sentence (${range}) suitable for pronunciation practice.
The sentence MUST be rich in: ${brief}.
Use everyday conversational vocabulary. Pick a fresh mundane topic (e.g. weekend errands, a café, commuting, the weather, cooking, a phone call).${intoBlock}
Output ONLY the sentence itself — no quotes, no explanation, no heading.`;
}

function buildPassagePrompt(briefs, size, intonation) {
  const features = briefs.map((b, i) => `  ${i + 1}. ${b}`).join("\n");
  const words = [200, 500, 1000].includes(Number(size)) ? Number(size) : 500;
  const lo = Math.round(words * 0.9);
  const hi = Math.round(words * 1.1);
  const paras =
    words <= 250 ? "2–3 short paragraphs"
    : words <= 600 ? "4–6 short paragraphs"
    : "7–10 short paragraphs";
  const intoBlock = intonation ? "\n" + INTONATION_INSTRUCTIONS : "";
  return `Write a natural British English practice passage of ABOUT ${words} WORDS (accept ${lo}–${hi}).
Split into ${paras}.
Pick a fresh mundane everyday topic — vary it each time (e.g. a weekend train journey, a visit to the café, cooking a meal, a phone call with a friend, running errands, waiting at the post office, a rainy afternoon at home).

The passage MUST distribute the following pronunciation features naturally and densely across the text:
${features}${intoBlock}

Use natural connected speech that a native RP speaker would produce. Do NOT explain the features, do NOT annotate, do NOT add headings or a title. Output ONLY the passage prose.`;
}

// ─── Route handlers ────────────────────────────────────────────────────────────

async function handlePostSession(request, env) {
  const { title, date, llm, passageText, promptUsed, feedback, recordingUrl } = await request.json();

  const children = [];

  if (passageText?.trim()) {
    children.push(
      { type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "Passage Text" } }] } },
      ...textBlocks(passageText)
    );
  }

  if (promptUsed?.trim()) {
    children.push(
      { type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "Prompt Used" } }] } },
      ...textBlocks(promptUsed)
    );
  }

  if (feedback?.trim()) {
    children.push(
      { type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "LLM Feedback" } }] } },
      ...markdownToBlocks(feedback)
    );
  }

  const props = {
    "Session Title": { title: [{ type: "text", text: { content: title || "Untitled Session" } }] },
  };
  if (date) props["Date"] = { date: { start: date } };
  if (llm) props["LLM"] = { select: { name: llm } };
  if (recordingUrl) props["Recording URL"] = { url: recordingUrl };

  // Step 1: Create page with properties only (no children — Notion rejects nested
  // table row children in the initial page creation call)
  const page = await notion(env, "POST", "/pages", {
    parent: { database_id: env.NOTION_DATABASE_ID },
    properties: props,
  });

  if (page.object === "error") return Response.json({ error: page.message }, { status: 400 });

  // Step 2: Append content blocks in batches of 100 (Notion API limit)
  if (children.length > 0) {
    for (let i = 0; i < children.length; i += 100) {
      const batch = children.slice(i, i + 100);
      const appendResult = await notion(env, "PATCH", `/blocks/${page.id}/children`, { children: batch });
      if (appendResult.object === "error") {
        return Response.json({ error: appendResult.message }, { status: 400 });
      }
    }
  }

  return Response.json({ success: true, id: page.id });
}

async function handleGetSessions(env) {
  const result = await notion(env, "POST", `/databases/${env.NOTION_DATABASE_ID}/query`, {
    sorts: [{ property: "Date", direction: "descending" }],
    page_size: 100,
  });

  if (result.object === "error") return Response.json({ error: result.message }, { status: 400 });

  const sessions = result.results.map((page) => ({
    id: page.id,
    title: page.properties["Session Title"]?.title?.[0]?.plain_text ?? "Untitled",
    date: page.properties["Date"]?.date?.start ?? null,
    llm: page.properties["LLM"]?.select?.name ?? null,
    notionUrl: page.url,
  }));

  return Response.json({ sessions });
}

async function handleDeleteSession(id, env) {
  const result = await notion(env, "PATCH", `/pages/${id}`, { archived: true });
  if (result.object === "error") return Response.json({ error: result.message }, { status: 400 });
  return Response.json({ success: true });
}

async function handleGetSession(id, env) {
  const [page, blocks] = await Promise.all([
    notion(env, "GET", `/pages/${id}`),
    notion(env, "GET", `/blocks/${id}/children?page_size=100`),
  ]);

  if (page.object === "error") return Response.json({ error: page.message }, { status: 404 });

  return Response.json({
    id: page.id,
    title: page.properties["Session Title"]?.title?.[0]?.plain_text ?? "Untitled",
    date: page.properties["Date"]?.date?.start ?? null,
    llm: page.properties["LLM"]?.select?.name ?? null,
    notionUrl: page.url,
    blocks: blocks.results ?? [],
  });
}

// ─── CORS ──────────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function addCors(response) {
  const h = new Headers(response.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
  return new Response(response.body, { status: response.status, headers: h });
}

// ─── Main export ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders() });

    const url = new URL(request.url);

    try {
      let res;
      if (request.method === "POST" && url.pathname === "/session") {
        res = await handlePostSession(request, env);
      } else if (request.method === "GET" && url.pathname === "/sessions") {
        res = await handleGetSessions(env);
      } else if (request.method === "DELETE" && url.pathname.startsWith("/session/")) {
        const id = url.pathname.split("/")[2];
        res = await handleDeleteSession(id, env);
      } else if (request.method === "GET" && url.pathname.startsWith("/session/")) {
        const id = url.pathname.split("/")[2];
        res = await handleGetSession(id, env);
      } else if (request.method === "POST" && url.pathname === "/tts") {
        res = await handleTts(request, env);
      } else if (request.method === "POST" && url.pathname === "/generate") {
        res = await handleGenerate(request, env);
      } else if (request.method === "POST" && url.pathname === "/score-line") {
        res = await handleScoreLine(request, env);
      } else {
        res = Response.json({ error: "Not found" }, { status: 404 });
      }
      return addCors(res);
    } catch (err) {
      return addCors(Response.json({ error: err.message }, { status: 500 }));
    }
  },
};
