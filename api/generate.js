// Vercel serverless function — ask Gemini to write a short piece in the
// requested style (short story / news / dialogue / letter / poem / custom)
// that naturally uses ALL of the provided vocabulary words.

const MODEL = "gemini-2.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const WINDOW_SECONDS = 3600;
const MAX_REQUESTS = 30;
const MAX_WORDS = 25;
const MAX_CUSTOM_CHARS = 400;

const memoryBuckets = new Map();

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = memoryBuckets.get(ip);
  if (!bucket || now - bucket.start > WINDOW_SECONDS * 1000) {
    memoryBuckets.set(ip, { start: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= MAX_REQUESTS;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

// Style instructions written in the TARGET language so Gemini writes in the
// target language naturally. The user is learning the target language; their
// native language is only used for definitions, not for the story body.
const STYLE_EN = {
  short_story: "Write a short, vivid story in English of about 150 words (give or take 20). Single scene, one or two characters, a tiny arc. Concrete sensory detail. No heading.",
  news_article: "Write a short journalistic news article in English of about 200 words. Neutral tone, who/what/when/where, one quoted line. No headline before the body, just the article.",
  dialogue: "Write a casual dialogue in English between two named characters (~150 words). Use em dashes or quoted lines, alternating speakers. Keep it natural — no narration, just speech.",
  letter: "Write a warm, friendly personal letter in English (~150 words). Start with a salutation and end with a sign-off. Address it to a real-sounding name. Specific shared memories or small daily details.",
  poem: "Write a short poem in English (12–20 lines). Free verse is fine. Vivid imagery. Looser, more figurative use of the vocabulary is welcome — don't force literal meanings if a metaphor fits better.",
};
const STYLE_ZH = {
  short_story: "請用繁體中文寫一篇約 150 字的短篇故事（上下浮動 20 字）。單一場景，一兩位人物，微小起伏。具體感官細節。不要加標題。",
  news_article: "請用繁體中文寫一則約 200 字的新聞報導。客觀語氣，交代人事時地，可包含一句引述。不要在正文前加標題，直接寫報導本身。",
  dialogue: "請用繁體中文寫一段約 150 字、兩位有名字的角色之間的對話。用引號或破折號，輪流發言。自然流暢，不要旁白，只有對話。",
  letter: "請用繁體中文寫一封約 150 字的親切私信。開頭有稱謂，結尾有署名，寫給一個有名字的對象。可帶入共同回憶或日常細節。",
  poem: "請用繁體中文寫一首 8–16 行的短詩。意象鮮明，可較自由地比喻運用所列詞彙——若隱喻更貼切，不必拘泥字面意思。",
};

function buildPrompt({ words, style, customPrompt, direction }) {
  // direction tells us the TARGET language (the one the user is learning):
  //   en-to-zh  → vocab is English, primary story written in English
  //   zh-to-en  → vocab is Chinese, primary story written in 繁體中文
  // BOTH directions return both story_en AND story_zh so the client can
  // toggle between them.
  const targetIsEnglish = direction !== "zh-to-en";
  const wordsLine = words.map(w => w.word).join(targetIsEnglish ? ", " : "、");

  let styleInstruction;
  if (style === "custom" && customPrompt) {
    styleInstruction = customPrompt.trim();
  } else {
    const table = targetIsEnglish ? STYLE_EN : STYLE_ZH;
    styleInstruction = table[style] || table.short_story;
  }

  const primaryLang = targetIsEnglish ? "English" : "繁體中文 (Traditional Chinese)";
  const otherLang   = targetIsEnglish ? "繁體中文 (Traditional Chinese)" : "English";

  return `You are a careful, literary writer helping a learner read in context.

TASK
${styleInstruction}

VOCABULARY (must appear naturally in the ${primaryLang} version, in their natural meaning and grammatical form — inflections allowed but the root must clearly appear)
${wordsLine}

PROCESS
1. Write the PRIMARY piece in ${primaryLang}, matching the requested style and length, weaving every vocabulary word in naturally.
2. Break it into sentence-pair objects, ONE sentence per pair. Each pair has:
   - "en": the English sentence
   - "zh": the matching Traditional Chinese sentence
   - "vocab_spans": an object mapping each ENGLISH vocabulary word that
     appears in this sentence's "en" to the EXACT Chinese substring in
     this sentence's "zh" that translates that vocabulary word.
   Regardless of primary direction, ALWAYS use the keys "en" (for the English form) and "zh" (for the Traditional Chinese form).
3. Provide the full concatenated story in both languages for convenience as "story_en" and "story_zh".

vocab_spans RULES
- Keys are the original vocabulary words EXACTLY as listed in the
  VOCABULARY section above — no inflection (use "look forward" even if
  the sentence uses "looking forward"), no capitalisation changes.
- Values are the MINIMAL Chinese substring in "zh" that translates that
  vocabulary word — no surrounding context, no paraphrase. The substring
  MUST appear verbatim in "zh" (so a UI can locate-and-highlight it via
  substring search).
- If a vocabulary word does NOT appear in this sentence's "en", omit its
  key entirely from vocab_spans. If no vocabulary word appears at all,
  emit "vocab_spans": {}.

SENTENCE RULES
- Each pair must contain EXACTLY one sentence on each side — never combine two English sentences into one pair, never split one sentence across two pairs.
- The translation must convey the same meaning, scene, and tone — not a paraphrase. The translation does not need the vocabulary words verbatim, but vocab_spans values must.
- No preamble, no commentary, no markdown headings. Output ONLY the JSON object below.

Output JSON shape:
{
  "sentences": [
    {
      "en": "<one English sentence>",
      "zh": "<matching Traditional Chinese sentence>",
      "vocab_spans": {"<vocab word>": "<exact zh substring>"}
    },
    {"en": "...", "zh": "...", "vocab_spans": {}}
  ],
  "story_en": "<full English version, sentences concatenated with spaces>",
  "story_zh": "<full Traditional Chinese version, sentences concatenated>"
}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  if (!process.env.GEMINI_API_KEY) return send(res, 500, { error: "Server missing GEMINI_API_KEY" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const rawWords = Array.isArray(body.words) ? body.words : [];
  const words = rawWords
    .map(w => (typeof w === "string" ? { word: w } : w))
    .filter(w => w && typeof w.word === "string" && w.word.trim().length > 0)
    .map(w => ({ word: w.word.trim() }));

  if (words.length === 0) return send(res, 400, { error: "No words provided" });
  if (words.length > MAX_WORDS) return send(res, 400, { error: `Too many words (max ${MAX_WORDS})` });

  const style = typeof body.style === "string" ? body.style : "short_story";
  const direction = body.direction === "zh-to-en" ? "zh-to-en" : "en-to-zh";
  const customPrompt = typeof body.customPrompt === "string"
    ? body.customPrompt.slice(0, MAX_CUSTOM_CHARS)
    : "";

  if (style === "custom" && !customPrompt.trim()) {
    return send(res, 400, { error: "Custom style needs a prompt" });
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return send(res, 429, { error: "Too many requests. Please slow down (30 / hour)." });
  }

  const prompt = buildPrompt({ words, style, customPrompt, direction });
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.85,
      // 6000 tokens — sentence-pair structure has more JSON overhead than the
      // flat dual-string response, plus we keep the full concatenated stories
      // alongside. vocab_spans per sentence adds ~10-30 tokens of structured
      // JSON per pair, so bumped 5000 → 6000 to keep truncation headroom on
      // longer vocab lists. Previous bumps: 1200 → 2400 → 4000 → 5000.
      maxOutputTokens: 6000,
      topP: 0.95,
      responseMimeType: "application/json",
    },
  };

  let geminiRes;
  try {
    geminiRes = await fetch(`${ENDPOINT}?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("Gemini fetch failed:", err);
    return send(res, 502, { error: "Generation service unreachable" });
  }

  if (!geminiRes.ok) {
    const errBody = await geminiRes.text().catch(() => "");
    console.error("Gemini error:", geminiRes.status, errBody);
    return send(res, 502, { error: "Generation service returned an error" });
  }

  const data = await geminiRes.json().catch(() => null);
  const candidate = data?.candidates?.[0];
  const raw = candidate?.content?.parts?.map(p => p.text).join("").trim();
  const finishReason = candidate?.finishReason;

  if (!raw) {
    console.error("Empty Gemini response:", JSON.stringify(data).slice(0, 200));
    return send(res, 502, { error: "Empty response from generation service" });
  }

  // `responseMimeType: application/json` makes Gemini return a JSON string in
  // the candidate text. Parse it; fall back to a code-fence extract; finally
  // a forgiving regex pull of the flat story_en / story_zh fields so a
  // truncated MAX_TOKENS response can still surface whatever portion was
  // complete (the sentences[] array may be lost on truncation, but the
  // legacy flat strings give the client something to render).
  const parsed = parseStoryResponse(raw);

  if (!parsed) {
    console.error("Could not parse dual-language response.",
      "finishReason:", finishReason,
      "tail:", raw.slice(-80),
      "head:", raw.slice(0, 120));
    return send(res, 502, { error: "Generation response could not be parsed" });
  }

  // Filter the sentences array to only well-formed {en, zh} pairs.
  // vocab_spans is preserved when present and shaped correctly — clients
  // use it for per-sentence Chinese vocab highlighting and gracefully fall
  // back to dictionary-substring search when it's missing.
  const sentences = Array.isArray(parsed.sentences)
    ? parsed.sentences
        .filter(p => p && typeof p.en === "string" && typeof p.zh === "string")
        .map(p => {
          const out = { en: p.en.trim(), zh: p.zh.trim() };
          if (p.vocab_spans && typeof p.vocab_spans === "object" && !Array.isArray(p.vocab_spans)) {
            const spans = {};
            for (const [k, v] of Object.entries(p.vocab_spans)) {
              if (typeof k === "string" && typeof v === "string"
                  && k.trim().length > 0 && v.trim().length > 0) {
                // Normalise key to lowercase so the client can match against
                // either the original vocab string or an inflected form
                // without sensitivity to casing.
                spans[k.trim().toLowerCase()] = v.trim();
              }
            }
            out.vocab_spans = spans;
          } else {
            out.vocab_spans = {};
          }
          return out;
        })
        .filter(p => p.en.length > 0 || p.zh.length > 0)
    : [];

  return send(res, 200, {
    sentences,
    story_en: (parsed.story_en || "").trim(),
    story_zh: (parsed.story_zh || "").trim(),
  });
}

// Tries strict JSON.parse first, then code-fence extraction, then a forgiving
// per-field regex that can recover whichever pieces completed before
// MAX_TOKENS truncation. Returns an object with at least one of {sentences,
// story_en, story_zh} populated, or null if nothing could be recovered.
function parseStoryResponse(raw) {
  // Strict parse.
  try {
    const p = JSON.parse(raw);
    if (hasValidStructure(p)) return p;
  } catch {
    // fall through
  }
  // Code-fenced JSON.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const p = JSON.parse(fenced[1]);
      if (hasValidStructure(p)) return p;
    } catch {
      // fall through
    }
  }
  // Per-field regex extraction for the two flat-string fields. If sentences
  // were partially emitted, we lose them on truncation — but the flat
  // story_en / story_zh fields, which Gemini emits LAST per the prompt
  // template, still give us something useful when they made it through.
  const en = extractField(raw, "story_en");
  const zh = extractField(raw, "story_zh");
  if (en || zh) return { sentences: [], story_en: en, story_zh: zh };
  return null;
}

function hasValidStructure(p) {
  return Array.isArray(p?.sentences)
      || typeof p?.story_en === "string"
      || typeof p?.story_zh === "string";
}

function extractField(raw, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`);
  const m = raw.match(re);
  if (!m) return "";
  // Unescape the captured body: \" \\ \n \t \r \/
  return m[1]
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\\//g, "/");
}
