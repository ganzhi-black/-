import { cosineSimilarity } from "./embeddings.js";

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createMemoryStore() {
  const subjects = [];
  const documents = [];
  const chunks = [];
  const savedQuestions = [];

  return {
    createSubject({ name }) {
      const subject = {
        id: uid("sub"),
        name,
        createdAt: new Date().toISOString(),
      };
      subjects.unshift(subject);
      return subject;
    },

    listSubjects() {
      return subjects.map((subject) => ({
        ...subject,
        documentCount: documents.filter((document) => document.subjectId === subject.id).length,
        chunkCount: chunks.filter((chunk) => chunk.subjectId === subject.id).length,
      }));
    },

    getSubject(subjectId) {
      const subject = subjects.find((item) => item.id === subjectId);
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

    deleteSubject(subjectId) {
      const index = subjects.findIndex((item) => item.id === subjectId);
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
        ...documentInput,
        createdAt: new Date().toISOString(),
      };
      documents.unshift(document);
      return document;
    },

    getDocumentHashesForSubject({ subjectId }) {
      return Array.from(
        new Set(
          documents
            .filter((document) => document.subjectId === subjectId && document.contentHash)
            .map((document) => document.contentHash),
        ),
      );
    },

    getPriorQuestionsByDocumentHashes({ documentHashes, types, limit = 500 }) {
      if (!documentHashes?.length) return [];
      const hashSet = new Set(documentHashes);
      return savedQuestions
        .filter((question) => hashSet.has(question.documentHash) && types.includes(question.type))
        .slice(-limit)
        .reverse()
        .map((question) => ({ title: question.title, type: question.type }));
    },

    addChunks(chunkInputs) {
      const saved = chunkInputs.map((chunk) => ({
        id: uid("chk"),
        ...chunk,
        createdAt: new Date().toISOString(),
      }));
      chunks.push(...saved);
      return saved;
    },

    searchChunks({ subjectId, queryEmbedding, limit = 5 }) {
      return chunks
        .filter((chunk) => chunk.subjectId === subjectId)
        .map((chunk) => ({
          ...chunk,
          score: Number(cosineSimilarity(queryEmbedding, chunk.embedding).toFixed(4)),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    },

    listChunks({ subjectId, limit = 1000 }) {
      return chunks
        .filter((chunk) => chunk.subjectId === subjectId)
        .sort((left, right) => left.chunkIndex - right.chunkIndex)
        .slice(0, limit);
    },

    saveQuestions({ subjectId, questions, documentHash = null }) {
      const saved = questions.map((question) => ({
        ...question,
        id: uid("q"),
        subjectId,
        documentHash,
      }));
      savedQuestions.push(...saved);
      return saved;
    },

    getRecentQuestions({ subjectId, types, limit = 30 }) {
      return savedQuestions
        .filter((question) => question.subjectId === subjectId && types.includes(question.type))
        .slice(-limit)
        .reverse();
    },
  };
}
