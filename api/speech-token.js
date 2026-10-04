// Vercel serverless function: POST /api/speech-token -> short-lived Deepgram token
import { handleSpeechToken } from "../lib/handler.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }
  res.setHeader("Cache-Control", "no-store");
  const { status, body } = await handleSpeechToken(req.headers["x-access-code"]);
  res.status(status).json(body);
}
