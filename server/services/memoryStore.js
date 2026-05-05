import { cosineSimilarity } from "./embeddings.js";

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeVisitorId(visitorId) {
  return String(visitorId || "anonymous-public").replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 80) || "anonymous-public";
}

export function createMemoryStore() {
  const subjects = [];
  const documents = [];
  const chunks = [];
  const savedQuestions = [];

  return {
    createSubject({ visitorId, name }) {
      const ownerId = normalizeVisitorId(visitorId);
      const subject = {
        id: uid("sub"),
        visitorId: ownerId,
        name,
        createdAt: new Date().toISOString(),
      };
      subjects.unshift(subject);
      return subject;
    },

    listSubjects({ visitorId } = {}) {
      const ownerId = normalizeVisitorId(visitorId);
      return subjects.filter((subject) => subject.visitorId === ownerId).map((subject) => ({
        ...subject,
        documentCount: documents.filter((document) => document.subjectId === subject.id).length,
        chunkCount: chunks.filter((chunk) => chunk.subjectId === subject.id).length,
      }));
    },

    getSubject({ visitorId, subjectId }) {
      const ownerId = normalizeVisitorId(visitorId);
      const subject = subjects.find((item) => item.id === subjectId && item.visitorId === ownerId);
      if (!subject) return null;
      const subjectDocuments = documents.filter((document) => document.subjectId === subjectId);
      const latestDocument = subjectDocuments[0];
      return {
        ...subject,
        sourceFileName: latestDocument?.fileName || "",
        sourceFileSize: latestDocument?.size || 0,
        documentCount: subjectDocuments.length,
        chunkCount: chunks.filter((chunk) => chunk.subjectId === subjectId).length,
      };
    },

    deleteSubject({ visitorId, subjectId }) {
      const ownerId = normalizeVisitorId(visitorId);
      const index = subjects.findIndex((item) => item.id === subjectId && item.visitorId === ownerId);
      if (index < 0) return false;
      subjects.splice(index, 1);
      for (let i = documents.length - 1; i >= 0; i -= 1) {
        if (documents[i].subjectId === subjectId) documents.splice(i, 1);
      }
      for (let i = chunks.length - 1; i >= 0; i -= 1) {
        if (chunks[i].subjectId === subjectId) chunks.splice(i, 1);
      }
      return true;
    },

    createDocument(documentInput) {
      const document = {
        id: uid("doc"),
        visitorId: normalizeVisitorId(documentInput.visitorId),
        ...documentInput,
        createdAt: new Date().toISOString(),
      };
      documents.unshift(document);
      return document;
    },

    getDocumentHashesForSubject({ visitorId, subjectId }) {
      const ownerId = normalizeVisitorId(visitorId);
      return Array.from(
        new Set(
          documents
            .filter((document) => document.visitorId === ownerId && document.subjectId === subjectId && document.contentHash)
            .map((document) => document.contentHash),
        ),
      );
    },

    getPriorQuestionsByDocumentHashes({ visitorId, documentHashes, types, limit = 500 }) {
      if (!documentHashes?.length) return [];
      const ownerId = normalizeVisitorId(visitorId);
      const hashSet = new Set(documentHashes);
      return savedQuestions
        .filter((question) => question.visitorId === ownerId && hashSet.has(question.documentHash) && types.includes(question.type))
        .slice(-limit)
        .reverse()
        .map((question) => ({ title: question.title, type: question.type }));
    },

    addChunks(input) {
      const chunkInputs = Array.isArray(input) ? input : input.chunks;
      const ownerId = normalizeVisitorId(Array.isArray(input) ? undefined : input.visitorId);
      const saved = chunkInputs.map((chunk) => ({
        id: uid("chk"),
        visitorId: ownerId,
        ...chunk,
        createdAt: new Date().toISOString(),
      }));
      chunks.push(...saved);
      return saved;
    },

    searchChunks({ visitorId, subjectId, queryEmbedding, limit = 5 }) {
      const ownerId = normalizeVisitorId(visitorId);
      return chunks
        .filter((chunk) => chunk.visitorId === ownerId && chunk.subjectId === subjectId)
        .map((chunk) => ({
          ...chunk,
          score: Number(cosineSimilarity(queryEmbedding, chunk.embedding).toFixed(4)),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    },

    listChunks({ visitorId, subjectId, limit = 1000 }) {
      const ownerId = normalizeVisitorId(visitorId);
      return chunks
        .filter((chunk) => chunk.visitorId === ownerId && chunk.subjectId === subjectId)
        .sort((left, right) => left.chunkIndex - right.chunkIndex)
        .slice(0, limit);
    },

    saveQuestions({ visitorId, subjectId, questions, documentHash = null }) {
      const ownerId = normalizeVisitorId(visitorId);
      const saved = questions.map((question) => ({
        ...question,
        id: uid("q"),
        visitorId: ownerId,
        subjectId,
        documentHash,
      }));
      savedQuestions.push(...saved);
      return saved;
    },

    getRecentQuestions({ visitorId, subjectId, types, limit = 30 }) {
      const ownerId = normalizeVisitorId(visitorId);
      return savedQuestions
        .filter((question) => question.visitorId === ownerId && question.subjectId === subjectId && types.includes(question.type))
        .slice(-limit)
        .reverse();
    },
  };
}
