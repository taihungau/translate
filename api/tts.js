// Vercel serverless function: GET /api/tts?text=…&voice=female|male -> MP3 of the text, read aloud
// in American English. The same text always gives the same audio, so the CDN keeps it for a year:
// each line costs one Deepgram request, however often it is played.
// With &teacher=1 it is the AI teacher's voice, in English or (&lang=ru) Russian.
// With &lipsync=1 the answer is JSON instead: the MP3 as base64 and when each word is said, for
// the course's talking face (cached the same way, so a line is timed once).
import { handleTts, handleLipsync } from "../lib/handler.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Use GET" });
  }
  const { text, voice, code, lipsync, lang, teacher } = req.query;
  if (lipsync === "1") {
    const timed = await handleLipsync(text, voice, code ?? req.headers["x-access-code"]);
    res.setHeader("Cache-Control", timed.status === 200 ? "public, max-age=31536000, s-maxage=31536000, immutable" : "no-store");
    return res.status(timed.status).json(timed.body);
  }
  const result = await handleTts(text, voice, code ?? req.headers["x-access-code"], { lang: lang ?? "en", teacher: teacher === "1" });
  if (result.status !== 200) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(result.status).json(result.body);
  }
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
  res.status(200).send(result.audio);
}
