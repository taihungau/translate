import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { translateLines, TranslationRefusedError } from "./translator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const PORT = Number(process.env.PORT) || 3000;
const MAX_LINES_PER_REQUEST = 60;
const MAX_BODY_BYTES = 256 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validate(body) {
  if (!body || !Array.isArray(body.lines)) return "Body must be { lines: [{id, text}], context?: string[] }";
  if (body.lines.length === 0 || body.lines.length > MAX_LINES_PER_REQUEST)
    return `lines must contain 1-${MAX_LINES_PER_REQUEST} items`;
  for (const l of body.lines) {
    if (typeof l?.id !== "string" || typeof l?.text !== "string") return "Each line needs string id and text";
  }
  if (body.context !== undefined && (!Array.isArray(body.context) || body.context.some((c) => typeof c !== "string")))
    return "context must be an array of strings";
  return null;
}

async function handleTranslate(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status ? err.message : "Invalid JSON" });
  }
  const problem = validate(body);
  if (problem) return sendJson(res, 400, { error: problem });

  try {
    const translations = await translateLines(body.lines, body.context ?? []);
    sendJson(res, 200, { translations });
  } catch (err) {
    if (err instanceof TranslationRefusedError) return sendJson(res, 422, { error: err.message });
    if (err instanceof Anthropic.AuthenticationError)
      return sendJson(res, 500, { error: "Anthropic credentials are missing or invalid. Set ANTHROPIC_API_KEY." });
    if (err instanceof Anthropic.RateLimitError) return sendJson(res, 429, { error: "Rate limited, retry shortly." });
    if (err instanceof Anthropic.APIError) {
      console.error("Anthropic API error:", err.status, err.message);
      return sendJson(res, 502, { error: `Translation service error (${err.status ?? "network"})` });
    }
    console.error(err);
    sendJson(res, 500, { error: "Translation failed" });
  }
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/translate") return handleTranslate(req, res);
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  res.writeHead(405).end();
});

server.listen(PORT, () => {
  console.log(`Subtitle translator running at http://localhost:${PORT}`);
});
