// Vercel serverless function: POST /api/teacher -> the AI English teacher's next turn, streamed
// as plain text (tagged lines: "ru: …", "en: …", "card: …"), so the page can speak each line as
// soon as it is written. See lib/teacher.js.
import { handleTeacher } from "../lib/teacher.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }
  if (typeof req.body !== "object" || req.body === null) return res.status(400).json({ error: "Invalid JSON" });
  // When she interrupts, the page drops the request: stop paying for words nobody will hear.
  const stop = new AbortController();
  res.on("close", () => { if (!res.writableFinished) stop.abort(); });
  const write = (text) => {
    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.status(200);
    }
    res.write(text);
  };
  const result = await handleTeacher(req.body, req.headers["x-access-code"], write, { signal: stop.signal });
  if (result.status !== 200) return res.status(result.status).json(result.body);
  if (!res.headersSent) res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end();
}
