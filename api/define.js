// Vercel serverless function — ask Gemini for a 1–2 sentence definition + a
// natural example sentence for a single word. Definition is returned in the
// user's native language; the example sentence stays in the target language.

const MODEL = "gemini-2.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const WINDOW_SECONDS = 3600;
const MAX_REQUESTS = 80; // single-word lookups; users will hit this more than story-gen
const MAX_WORD_CHARS = 80;

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

// Direction is en-to-zh (English word, native lang zh) or zh-to-en (Chinese word, native lang en).
function buildPrompt({ word, direction }) {
  if (direction === "zh-to-en") {
    return `You are a bilingual dictionary helper. For the Chinese word or phrase below, produce:
1. A clear English definition in 1–2 sentences. Plain, learner-friendly.
2. One natural example sentence IN CHINESE (繁體中文 preferred unless the word is clearly simplified-only) that uses the word in context. Aim for a sentence a fluent reader would actually say or write — not a textbook line.

Output ONLY a JSON object on a single line, in this exact shape:
{"definition":"...","example":"..."}

Word: ${word}`;
  }
  // default: en-to-zh
  return `You are a bilingual dictionary helper. For the English word or phrase below, produce:
1. A clear definition in 繁體中文 (Traditional Chinese), 1–2 sentences. Plain, learner-friendly, no Pinyin.
2. One natural example sentence IN ENGLISH that uses the word in context. Aim for a sentence a fluent speaker would actually say or write — not a textbook line.

Output ONLY a JSON object on a single line, in this exact shape:
{"definition":"...","example":"..."}

Word: ${word}`;
}

function extractJson(text) {
  if (!text) return null;
  // strip code fences if Gemini wraps the JSON in ```json ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  // find the first {...} block
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(candidate.slice(first, last + 1));
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  if (!process.env.GEMINI_API_KEY) return send(res, 500, { error: "Server missing GEMINI_API_KEY" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const word = typeof body.word === "string" ? body.word.trim() : "";
  const direction = body.direction === "zh-to-en" ? "zh-to-en" : "en-to-zh";
  if (!word) return send(res, 400, { error: "Missing word" });
  if (word.length > MAX_WORD_CHARS) return send(res, 400, { error: "Word too long" });

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return send(res, 429, { error: "Too many requests. Please slow down (80 / hour)." });
  }

  const prompt = buildPrompt({ word, direction });
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 512,
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
    return send(res, 502, { error: "Definition service unreachable" });
  }

  if (!geminiRes.ok) {
    const errBody = await geminiRes.text().catch(() => "");
    console.error("Gemini error:", geminiRes.status, errBody);
    return send(res, 502, { error: "Definition service returned an error" });
  }

  const data = await geminiRes.json().catch(() => null);
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("").trim();
  const parsed = extractJson(text);

  if (!parsed || typeof parsed.definition !== "string" || typeof parsed.example !== "string") {
    console.error("Could not parse define response:", text);
    return send(res, 502, { error: "Definition could not be parsed" });
  }

  return send(res, 200, {
    word,
    definition: parsed.definition.trim(),
    example: parsed.example.trim(),
  });
}
