# Qimoshua RAG backend

This is the first backend foundation for the app.

## Start

```bash
npm install
npm run server
```

The API starts at:

```txt
http://localhost:8787
```

## First test flow

1. Create a subject:

```http
POST /api/subjects
{ "name": "exam subject" }
```

2. Upload a document:

```http
POST /api/documents/upload
form-data:
  subjectId=<subject id>
  file=<txt, md, pdf, or docx file>
```

3. Search the knowledge base:

```http
POST /api/retrieval/search
{ "subjectId": "<subject id>", "query": "important concept", "limit": 5 }
```

## What is real and what is temporary

- File extraction, chunking, and retrieval endpoints are in place.
- Storage uses PostgreSQL + pgvector when `DATABASE_URL` is present. Without it, the API falls back to memory mode and resets when the server restarts.
- Embedding uses a local development fallback until a model provider is connected.
- `server/db/schema.sql` is the target PostgreSQL + pgvector schema.

## Document conversion

The production architecture should run document conversion on the backend server, not on each user's computer.

Users only upload files in the browser:

```txt
browser upload -> backend server -> MarkItDown -> Markdown -> chunking -> Supabase
```

Install the Python converter on the backend runtime:

```bash
python -m pip install -r server/requirements.txt
```

Then enable it in `.env`:

```env
DOCUMENT_CONVERTER=markitdown
PYTHON_BIN=python
```

If MarkItDown is unavailable or conversion fails, the server falls back to the built-in extractor so uploads do not break.
