import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createMemoryStore } from "../server/services/memoryStore.js";

function sourceBlock(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `Missing block start: ${startText}`);
  const end = endText ? source.indexOf(endText, start + startText.length) : -1;
  return end > start ? source.slice(start, end) : source.slice(start);
}

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

test("re-login can recover visitor records by cached subject ids when the old visitor id is gone", () => {
  const server = readFileSync("server/index.js", "utf8");
  const dbStore = readFileSync("server/services/dbStore.js", "utf8");
  const memoryStore = readFileSync("server/services/memoryStore.js", "utf8");
  const apiService = readFileSync("src/services/api.js", "utf8");

  assert.match(apiService, /function getClaimSubjectIds\(\)/);
  assert.match(apiService, /headers\.set\("X-Claim-Subject-Ids", getClaimSubjectIds\(\)\.join\(","\)\)/);
  assert.match(server, /function subjectIdsForClaim\(req\)/);
  assert.match(server, /req\.get\("x-claim-subject-ids"\)/);
  assert.match(server, /const subjectIds = subjectIdsForClaim\(req\)/);
  assert.match(server, /await store\.claimSubjectData\(\{\s*subjectIds,\s*userId,\s*\}\)/);
  assert.match(dbStore, /async claimSubjectData\(\{ subjectIds, userId \}\)/);
  assert.match(dbStore, /u\.nickname like 'visitor:%'/);
  assert.match(memoryStore, /claimSubjectData\(\{ subjectIds, userId \}\)/);
});

test("cached subject recovery verifies the target account before updating subject ownership", () => {
  const dbStore = readFileSync("server/services/dbStore.js", "utf8");
  const claimSubjectDataBlock = dbStore.match(/async claimSubjectData\(\{ subjectIds, userId \}\) \{[\s\S]*?\n    \},\n\n    async createUser/)?.[0] || "";

  assert.match(claimSubjectDataBlock, /const targetUserResult = await client\.query\(\s*"select id from users where id = \$1 limit 1"/);
  assert.match(claimSubjectDataBlock, /if \(!targetUserResult\.rows\[0\]\) \{\s*await client\.query\("commit"\);\s*return \{ claimed: false/);
  assert.match(claimSubjectDataBlock, /const subjectResult = await client\.query/);
});

test("account data recovery failures are logged but do not block login", () => {
  const server = readFileSync("server/index.js", "utf8");
  const claimStart = server.indexOf("async function claimVisitorDataForUser");
  const claimEnd = server.indexOf("async function resolveAuth");
  const claimVisitorDataForUserBlock = claimStart >= 0 && claimEnd > claimStart ? server.slice(claimStart, claimEnd) : "";

  assert.match(claimVisitorDataForUserBlock, /if \(!userId\) return/);
  assert.match(claimVisitorDataForUserBlock, /try \{[\s\S]*await store\.claimVisitorData/);
  assert.match(claimVisitorDataForUserBlock, /logWarn\("visitor_data_claim_failed"/);
  assert.match(claimVisitorDataForUserBlock, /try \{[\s\S]*await store\.claimSubjectData/);
  assert.match(claimVisitorDataForUserBlock, /logWarn\("subject_data_claim_failed"/);
});

test("auth sessions expose the account user id instead of the session id", () => {
  const server = readFileSync("server/index.js", "utf8");
  const dbStore = readFileSync("server/services/dbStore.js", "utf8");
  const memoryStoreSource = readFileSync("server/services/memoryStore.js", "utf8");
  const publicUserBlock = sourceBlock(server, "function publicUser(user)", "function sessionCookieOptions");
  const dbAuthSessionBlock = sourceBlock(dbStore, "async getAuthSession(tokenHash)", "async deleteAuthSession");

  const memoryStore = createMemoryStore();
  const user = memoryStore.createUser({
    email: "sync-test@example.com",
    passwordHash: "hash",
    nickname: "Sync Test",
  });
  memoryStore.createAuthSession({
    userId: user.id,
    tokenHash: "session-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const session = memoryStore.getAuthSession("session-token");
  assert.equal(session.user_id, user.id);
  assert.equal(session.id, user.id);

  assert.match(publicUserBlock, /id:\s*user\.user_id\s*\|\|\s*user\.id/);
  assert.match(dbAuthSessionBlock, /s\.id\s+as\s+session_id/i);
  assert.match(dbAuthSessionBlock, /s\.user_id\s+as\s+id/i);
  assert.doesNotMatch(dbAuthSessionBlock, /\n\s*s\.id,\s*\n\s*s\.user_id,/);
  assert.match(memoryStoreSource, /id:\s*user\.id,\s*\n\s*session_id:\s*session\.id/);
});

test("authenticated requests claim data stranded under the previous auth session id", () => {
  const server = readFileSync("server/index.js", "utf8");
  const visitorIdsForClaimBlock = sourceBlock(server, "function visitorIdsForClaim(req)", "function subjectIdsForClaim");
  const resolveAuthBlock = sourceBlock(server, "async function resolveAuth", "function requireAuth");

  assert.match(resolveAuthBlock, /req\.authSessionId\s*=\s*session\.session_id/);
  assert.match(visitorIdsForClaimBlock, /req\.authSessionId/);
  assert.match(resolveAuthBlock, /await claimVisitorDataForUser\(req, req\.user\.id\)/);
});

test("server-backed account reads are scoped by resolved user_id", () => {
  const dbStore = readFileSync("server/services/dbStore.js", "utf8");
  const readMethods = [
    ["listSubjects", "async getSubject"],
    ["getSubject", "async deleteSubject"],
    ["listQuestionsForSubject", "async deleteQuestionForSubject"],
    ["getPracticeSession", "async saveAnswer"],
    ["listMistakes", "async deleteMistake"],
  ];

  for (const [methodName, nextMethod] of readMethods) {
    const block = sourceBlock(dbStore, `async ${methodName}({`, nextMethod);
    assert.match(block, /const userId = await getUserId\(visitorId\)/, `${methodName} must resolve the logged-in account id`);
    assert.match(block, /where[\s\S]*user_id = \$1|where[\s\S]*m\.user_id = \$1|where[\s\S]*s\.user_id = \$1|where[\s\S]*q\.user_id = \$1/i, `${methodName} must query by user_id`);
  }
});

test("server-backed frontend account views do not read local study cache", () => {
  const apiService = readFileSync("src/services/api.js", "utf8");
  const methods = [
    ["getDashboard", "async createSubject"],
    ["getSubjectQuestions", "async deleteSubjectQuestion"],
    ["getSession", "async submitAnswer"],
    ["getMistakes", "async deleteMistake"],
  ];

  for (const [methodName, nextMethod] of methods) {
    const block = sourceBlock(apiService, `async ${methodName}(`, nextMethod);
    assert.doesNotMatch(block, /loadState\(/, `${methodName} must not read qimoshua_v1_state`);
    assert.doesNotMatch(block, /mockApi\./, `${methodName} must not fall back to mock local data`);
    assert.doesNotMatch(block, /questionsFromLocalSubjectSessions|mergeSubjectQuestions|cachedSession|normalizeMistakes/, `${methodName} must not merge local subjects, history, sessions, or mistakes`);
  }
});

test("successful authentication refreshes account data from the server before navigation", () => {
  const authPage = readFileSync("src/pages/AuthPage.jsx", "utf8");
  const submitBlock = sourceBlock(authPage, "async function submit(event)", "return (");

  assert.match(submitBlock, /onAuthenticated\(nextUser\)/);
  assert.match(submitBlock, /await api\.refreshAccountData\(\)/);
  assert.match(submitBlock, /await api\.refreshAccountData\(\)[\s\S]*navigate\(targetPath/);
});
