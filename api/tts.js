// Vercel serverless function: GET /api/tts?text=…&voice=female|male -> MP3 of the text, read aloud
// in American English. The same text always gives the same audio, so the CDN keeps it for a year:
// each line costs one Deepgram request, however often it is played.
import { handleTts } from "../lib/handler.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Use GET" });
  }
  const { text, voice, code } = req.query;
  const result = await handleTts(text, voice, code ?? req.headers["x-access-code"]);
  if (result.status !== 200) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(result.status).json(result.body);
  }
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
  res.status(200).send(result.audio);
}
