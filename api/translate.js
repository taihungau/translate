// Vercel serverless function: POST /api/translate
import { handleTranslate } from "../lib/handler.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }
  // Vercel parses JSON bodies; a malformed body arrives as a string or undefined.
  if (typeof req.body !== "object" || req.body === null) return res.status(400).json({ error: "Invalid JSON" });
  const { status, body } = await handleTranslate(req.body, req.headers["x-access-code"]);
  res.status(status).json(body);
}
