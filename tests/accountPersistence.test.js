import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("subject list includes database-backed question and practice metadata", () => {
  const dbStore = readFileSync("server/services/dbStore.js", "utf8");

  assert.match(dbStore, /generated_question_count/);
  assert.match(dbStore, /last_practice_at/);
  assert.match(dbStore, /count\(distinct q\.id\)/);
  assert.match(dbStore, /max\(ps\.started_at\)/);
});

test("dashboard preserves server-generated subject counts across devices", () => {
  const apiService = readFileSync("src/services/api.js", "utf8");

  assert.doesNotMatch(apiService, /generatedQuestionCount:\s*countGeneratedQuestions/);
});

test("generated questions and sessions are persisted before the API responds", () => {
  const server = readFileSync("server/index.js", "utf8");

  assert.doesNotMatch(server, /void store\s*\.\s*saveQuestions/);
  assert.doesNotMatch(server, /void store\s*\.\s*createPracticeSession/);
  assert.match(server, /await store\s*\.\s*saveQuestions/);
  assert.match(server, /await store\s*\.\s*createPracticeSession/);
});

test("answers and finish state are persisted before summary navigation", () => {
  const server = readFileSync("server/index.js", "utf8");
  const apiService = readFileSync("src/services/api.js", "utf8");

  assert.doesNotMatch(server, /void store\s*\.\s*saveAnswer/);
  assert.match(server, /await store\s*\.\s*saveAnswer/);
  assert.doesNotMatch(apiService, /void request\(`\/api\/sessions\/\$\{sessionId\}\/finish`/);
  assert.match(apiService, /await request\(`\/api\/sessions\/\$\{sessionId\}\/finish`/);
});

test("summary page does not redirect completed sessions back to the quiz", () => {
  const summaryPage = readFileSync("src/pages/SummaryPage.jsx", "utf8");

  assert.match(summaryPage, /session\.summary\s*\|\|\s*session\.completedAt/);
});
