// Vercel serverless function: POST /api/check-writing -> a learner's own sentence, checked
import { handleCheckWriting } from "../lib/handler.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }
  if (typeof req.body !== "object" || req.body === null) return res.status(400).json({ error: "Invalid JSON" });
  const { status, body } = await handleCheckWriting(req.body, req.headers["x-access-code"]);
  res.status(status).json(body);
}
