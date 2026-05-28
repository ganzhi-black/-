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

test("login and register claim existing visitor-owned study data for the account", () => {
  const server = readFileSync("server/index.js", "utf8");
  const dbStore = readFileSync("server/services/dbStore.js", "utf8");
  const memoryStore = readFileSync("server/services/memoryStore.js", "utf8");

  assert.match(dbStore, /async claimVisitorData\(\{ visitorId, userId \}\)/);
  assert.match(dbStore, /visitor:\$\{normalizeVisitorId\(visitorId\)\}/);
  assert.match(dbStore, /"subjects"/);
  assert.match(dbStore, /"documents"/);
  assert.match(dbStore, /"document_chunks"/);
  assert.match(dbStore, /"questions"/);
  assert.match(dbStore, /"practice_sessions"/);
  assert.match(dbStore, /"answers"/);
  assert.match(dbStore, /"mistakes"/);
  assert.match(dbStore, /"analytics_events"/);
  assert.match(dbStore, /update \$\{tableName\} set user_id = \$1 where user_id = \$2/);
  assert.match(dbStore, /delete from mistakes visitor_mistakes/);

  assert.match(memoryStore, /claimVisitorData\(\{ visitorId, userId \}\)/);
  assert.match(server, /async function claimVisitorDataForUser\(req, userId\)/);
  assert.match(server, /await store\.claimVisitorData\(\{\s*visitorId,\s*userId,\s*\}\)/);
  assert.match(server, /await claimVisitorDataForUser\(req, user\.id\)/);
});

test("already-authenticated sessions also claim visitor data and then send the account id", () => {
  const server = readFileSync("server/index.js", "utf8");
  const apiService = readFileSync("src/services/api.js", "utf8");

  assert.match(server, /await claimVisitorDataForUser\(req, req\.user\.id\)/);
  assert.match(apiService, /function setVisitorId\(visitorId\)/);
  assert.match(apiService, /function rememberAuthenticatedUser\(user\)/);
  assert.match(apiService, /return rememberAuthenticatedUser\(payload\.user\)/g);
});

test("re-login can still claim records after the primary visitor id was replaced by the account id", () => {
  const server = readFileSync("server/index.js", "utf8");
  const apiService = readFileSync("src/services/api.js", "utf8");

  assert.match(apiService, /const VISITOR_ALIAS_KEY = "qimoshua:visitor-id-history"/);
  assert.match(apiService, /function rememberVisitorAlias\(visitorId\)/);
  assert.match(apiService, /function getVisitorAliases\(primaryVisitorId = getVisitorId\(\)\)/);
  assert.match(apiService, /headers\.set\("X-Visitor-Aliases", getVisitorAliases\(visitorId\)\.join\(","\)\)/);
  assert.match(apiService, /rememberVisitorAlias\(previous\)/);

  assert.match(server, /function visitorIdsForClaim\(req\)/);
  assert.match(server, /req\.get\("x-visitor-aliases"\)/);
  assert.match(server, /for \(const visitorId of visitorIdsForClaim\(req\)\)/);
});
