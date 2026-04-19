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
  const { weaknesses, length } = await request.json();
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
    ? buildPassagePrompt(briefs)
    : buildSentencePrompt(briefs[0]);

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
            maxOutputTokens: 4000,     // generous — 500-word passage ≈ 750 tokens, but thinking tokens also count
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

function buildSentencePrompt(brief) {
  return `Generate exactly ONE natural British English sentence (10–20 words) suitable for pronunciation practice.
The sentence MUST be rich in: ${brief}.
Use everyday conversational vocabulary. Pick a fresh mundane topic (e.g. weekend errands, a café, commuting, the weather, cooking, a phone call).
Output ONLY the sentence itself — no quotes, no explanation, no heading.`;
}

function buildPassagePrompt(briefs) {
  const features = briefs.map((b, i) => `  ${i + 1}. ${b}`).join("\n");
  return `Write a natural British English practice passage of ABOUT 500 WORDS (accept 450–550).
Split into 4–6 short paragraphs.
Pick a fresh mundane everyday topic — vary it each time (e.g. a weekend train journey, a visit to the café, cooking a meal, a phone call with a friend, running errands, waiting at the post office, a rainy afternoon at home).

The passage MUST distribute the following pronunciation features naturally and densely across the text:
${features}

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
      } else {
        res = Response.json({ error: "Not found" }, { status: 404 });
      }
      return addCors(res);
    } catch (err) {
      return addCors(Response.json({ error: err.message }, { status: 500 }));
    }
  },
};
