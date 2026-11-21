import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const topics = new Set(["delivery", "pricing", "other"]);
const manualReview = { status: "manual_review", topic: null, draft: null };

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readInput(request) {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);

    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (payload && typeof payload === "object" && !Array.isArray(payload) &&
        typeof payload.text === "string" && payload.text.trim()) {
      return payload.text;
    }
  } catch {}

  return null;
}

function validResult(result) {
  return result !== null && typeof result === "object" && !Array.isArray(result) &&
    topics.has(result.topic) && typeof result.draft === "string" && result.draft.trim().length > 0;
}

async function triage(text) {
  const controller = new AbortController();
  let timeout;

  try {
    const output = await Promise.race([
      classify(text, { signal: controller.signal }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("AI request timed out"));
        }, 300);
      }),
    ]);
    const result = JSON.parse(output);
    return validResult(result)
      ? { status: "ready", topic: result.topic, draft: result.draft }
      : manualReview;
  } catch {
    return manualReview;
  } finally {
    clearTimeout(timeout);
  }
}

export function createApp() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/triage") {
      sendJson(response, 404, { status: "not_found" });
      return;
    }

    const text = await readInput(request);
    if (text === null) {
      sendJson(response, 400, { status: "invalid_input" });
      return;
    }

    sendJson(response, 200, await triage(text));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
