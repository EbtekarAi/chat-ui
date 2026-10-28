// Ebtekar Chat UI — a tiny, dependency-free server.
// It serves the web page and proxies chat requests to the Ebtekar Developer Gateway,
// so your API key stays on the server and never reaches the browser.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

try { process.loadEnvFile?.(); } catch { /* no .env file — use real environment variables */ }

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.EBTEKAR_API_KEY;
const BASE_URL = (process.env.EBTEKAR_BASE_URL || "https://ebtekarai.ir/api/developer-gateway").replace(/\/+$/, "");
const MODEL = process.env.EBTEKAR_MODEL || "ebtekar-smart";
const SYSTEM = process.env.EBTEKAR_SYSTEM || "تو دستیار ابتکار هستی. پاسخ‌ها را واضح، دقیق و به زبان کاربر بنویس.";
const MAX_TOKENS = Number(process.env.EBTEKAR_MAX_TOKENS || 2048);
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 20); // per visitor IP

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

if (!API_KEY) {
  console.error("✗ EBTEKAR_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

// --- tiny in-memory rate limiter (per IP, sliding minute) ---
const hits = new Map();
function allowed(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (list.length >= RATE_PER_MIN) return false;
  list.push(now);
  hits.set(ip, list);
  return true;
}

function readJson(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("Request too large"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

// Accept only plain user/assistant text turns, with sane limits.
function cleanMessages(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 40) return null;
  const out = [];
  for (const m of input) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    const content = m.content.trim().slice(0, 8000);
    if (content) out.push({ role: m.role, content });
  }
  return out.length && out[out.length - 1].role === "user" ? out : null;
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function handleChat(req, res) {
  const ip = req.socket.remoteAddress || "unknown";
  if (!allowed(ip)) return send(res, 429, { error: "Too many requests — please wait a minute." });

  let body;
  try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { error: e.message }); }
  const messages = cleanMessages(body.messages);
  if (!messages) return send(res, 400, { error: "messages must be a non-empty list ending with a user turn." });

  const upstreamAbort = new AbortController();
  res.on("close", () => upstreamAbort.abort()); // visitor left → stop the model (and the cost)

  let upstream;
  try {
    upstream = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      signal: upstreamAbort.signal,
      headers: {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, stream: true, messages }),
    });
  } catch (e) {
    if (upstreamAbort.signal.aborted) return;
    return send(res, 502, { error: "Could not reach Ebtekar. Check your network and try again." });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error(`upstream ${upstream.status} (request-id: ${upstream.headers.get("x-request-id") || "-"})`, text.slice(0, 300));
    const friendly = { 401: "API key is invalid or expired.", 402: "Not enough wallet balance.", 403: "This key can't use that model.", 429: "Rate limit reached — try again shortly." };
    return send(res, upstream.status, { error: friendly[upstream.status] || "The model request failed." });
  }

  // Relay the Server-Sent Events stream unchanged.
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch { /* aborted by the visitor */ }
  res.end();
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  const rel = normalize(decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)).replace(/^([/\\])+/, "");
  if (rel.includes("..")) return send(res, 400, { error: "Bad path" });
  try {
    const data = await readFile(join(PUBLIC_DIR, rel));
    res.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream" });
    res.end(data);
  } catch {
    send(res, 404, { error: "Not found" });
  }
}

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
    if (req.method === "GET" && req.url === "/api/config") return send(res, 200, { model: MODEL });
    if (req.method === "GET") return serveStatic(req, res);
    send(res, 405, { error: "Method not allowed" });
  })
  .listen(PORT, () => console.log(`✓ Ebtekar Chat UI → http://localhost:${PORT}  (model: ${MODEL})`));
