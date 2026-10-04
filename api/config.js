// Vercel serverless function: GET /api/config -> which speech recognition the server supports
import { speechConfig } from "../lib/handler.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(speechConfig());
}
