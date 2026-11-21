import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { createApp } from "./server.mjs";

const server = createApp();
let baseUrl;

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

async function request(body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { statusCode: response.status, body: await response.json() };
}

const manualReview = {
  statusCode: 200,
  body: { status: "manual_review", topic: null, draft: null },
};

test("serves the form", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<form>/);
});

for (const [text, topic] of [
  ["Когда будет доставка?", "delivery"],
  ["Какая стоимость услуги?", "pricing"],
  ["Хочу связаться с менеджером", "other"],
]) {
  test(`classifies ${topic} requests`, async () => {
    const result = await request(JSON.stringify({ text }));
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, "ready");
    assert.equal(result.body.topic, topic);
    assert.ok(typeof result.body.draft === "string" && result.body.draft.trim());
  });
}

test("rejects invalid requests", async () => {
  for (const body of [
    "", "{broken", "null", "[]", "{}", '{"text":null}',
    '{"text":123}', '{"text":[]}', '{"text":""}', JSON.stringify({ text: " \n " }),
  ]) {
    assert.deepEqual(await request(body), {
      statusCode: 400,
      body: { status: "invalid_input" },
    });
  }
});

for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`${marker} requires manual review`, async () => {
    const start = performance.now();
    assert.deepEqual(await request(JSON.stringify({ text: marker })), manualReview);
    if (marker === "[timeout]") {
      assert.ok(performance.now() - start < 900, "timeout must stop waiting before the mock's 1.2s delay");
    }
  });
}

test("recovers after a model failure", async () => {
  assert.deepEqual(await request(JSON.stringify({ text: "[error]" })), manualReview);
  const result = await request(JSON.stringify({ text: "Нужна доставка" }));
  assert.equal(result.body.status, "ready");
  assert.equal(result.body.topic, "delivery");
});

test("handles concurrent requests independently", async () => {
  const [failed, successful] = await Promise.all([
    request(JSON.stringify({ text: "[timeout]" })),
    request(JSON.stringify({ text: "Уточните стоимость" })),
  ]);
  assert.deepEqual(failed, manualReview);
  assert.equal(successful.body.status, "ready");
  assert.equal(successful.body.topic, "pricing");
});
