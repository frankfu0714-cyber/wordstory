// Vercel serverless function — looks up a single-phrase definition for a word
// via the free MyMemory Translation API. No API key required for ≤10K
// words/day per IP, which is well above personal use.
//
// Endpoint contract is unchanged from the previous Gemini-backed version so
// the iOS app and the web app don't need any changes:
//   POST { word, direction: "en-to-zh" | "zh-to-en" }
//   200  { word, definition, example }     // example is "" with MyMemory
//
// Gemini stays in place for /api/generate — the story feature is where AI
// value justifies the cost. Definitions are mundane and should be free.

const ENDPOINT = "https://api.mymemory.translated.net/get";
const WINDOW_SECONDS = 3600;
const MAX_REQUESTS = 80;
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

function langpairFor(direction) {
  // MyMemory uses BCP-47-ish pair strings separated by `|`.
  // We standardise on zh-TW so traditional-character translations are preferred.
  return direction === "zh-to-en" ? "zh-TW|en" : "en|zh-TW";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

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

  const url = `${ENDPOINT}?q=${encodeURIComponent(word)}&langpair=${encodeURIComponent(langpairFor(direction))}`;

  let upstream;
  try {
    upstream = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    console.error("MyMemory fetch failed:", err.message || err);
    return send(res, 502, { error: "Definition service unreachable" });
  }

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => "");
    console.error("MyMemory HTTP", upstream.status, errBody.slice(0, 200));
    return send(res, 502, { error: "Definition service returned an error" });
  }

  const data = await upstream.json().catch(() => null);
  const translated = data?.responseData?.translatedText;
  const responseStatus = data?.responseStatus;

  // MyMemory returns HTTP 200 even on logical errors and signals via
  // `responseStatus`. Anything other than 200 (string or number) is a fault.
  if (responseStatus !== undefined && responseStatus !== 200 && responseStatus !== "200") {
    const detail = data?.responseDetails || "";
    console.error("MyMemory logical error:", responseStatus, detail);
    return send(res, 502, { error: "Definition could not be parsed" });
  }

  if (typeof translated !== "string" || !translated.trim()) {
    console.error("MyMemory empty translation:", JSON.stringify(data).slice(0, 200));
    return send(res, 502, { error: "Definition could not be parsed" });
  }

  return send(res, 200, {
    word,
    definition: translated.trim(),
    example: "",
  });
}
