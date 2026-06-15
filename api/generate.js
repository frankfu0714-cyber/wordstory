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
  //   en-to-zh  → vocab is English, story written in English
  //   zh-to-en  → vocab is Chinese, story written in 繁體中文
  const targetIsEnglish = direction !== "zh-to-en";
  const wordsLine = words.map(w => w.word).join(targetIsEnglish ? ", " : "、");

  let styleInstruction;
  if (style === "custom" && customPrompt) {
    styleInstruction = customPrompt.trim();
  } else {
    const table = targetIsEnglish ? STYLE_EN : STYLE_ZH;
    styleInstruction = table[style] || table.short_story;
  }

  if (targetIsEnglish) {
    return `You are a careful, literary writer helping a Traditional Chinese speaker learn English vocabulary in context.

TASK
${styleInstruction}

VOCABULARY (must use ALL of these, in their natural meaning and grammatical form — inflections allowed but the root must clearly appear)
${wordsLine}

RULES
- Write in English. Match the requested style and length.
- Weave every listed word in naturally. If a word does not fit the chosen scenario, gently steer the scenario so it does — do NOT skip the word.
- Make the surrounding sentence rich enough that the word's meaning is inferable from context.
- No preamble, no explanation, no "Here is the story", no markdown headings. Output ONLY the piece itself.`;
  }

  return `你是一位用心的文學作者，正在幫助一位英文母語的學習者透過上下文學習中文詞彙。

任務
${styleInstruction}

詞彙（必須全部自然運用，使其原意清晰可辨）
${wordsLine}

規則
- 以繁體中文寫作。配合所要求的體裁與字數。
- 必須自然地使用上述每一個詞彙；若某詞不易帶入，請微調情節以納入，不可省略。
- 周圍句意要足夠豐富，使該詞的意義可從上下文推知。
- 不要任何開場白、說明、「以下是故事」之類的話，也不要 markdown 標題。只輸出作品本身。`;
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
      maxOutputTokens: 1200,
      topP: 0.95,
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
  const story = candidate?.content?.parts?.map(p => p.text).join("").trim();

  if (!story) {
    console.error("Empty Gemini response:", JSON.stringify(data));
    return send(res, 502, { error: "Empty response from generation service" });
  }

  return send(res, 200, { story });
}
