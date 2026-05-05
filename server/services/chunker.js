const TARGET_CHUNK_SIZE = 800;
const MIN_CHUNK_SIZE = 300;

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function headingLevel(line) {
  const match = String(line || "").match(/^ {0,3}(#{1,6})\s+\S+/);
  return match ? match[1].length : 0;
}

function isH2(line) {
  return headingLevel(line) === 2;
}

function isH3(line) {
  return headingLevel(line) === 3;
}

function isH1(line) {
  return headingLevel(line) === 1;
}

function compactLength(text) {
  return String(text || "").replace(/\s+/g, "").length;
}

function joinParts(parts) {
  return parts.filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function splitParagraphs(text) {
  return cleanText(text)
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitSentences(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  return normalized.match(/[^。！？；.!?;]+[。！？；.!?;]?/g)?.map((item) => item.trim()).filter(Boolean) || [normalized];
}

function splitOversizedText(text, maxSize = TARGET_CHUNK_SIZE) {
  if (compactLength(text) <= maxSize) return [text.trim()].filter(Boolean);

  const sentences = splitSentences(text);
  const pieces = [];
  let current = "";

  for (const sentence of sentences) {
    const next = current ? `${current}${sentence}` : sentence;
    if (compactLength(next) > maxSize && compactLength(current) >= MIN_CHUNK_SIZE) {
      pieces.push(current.trim());
      current = sentence;
    } else if (compactLength(next) > maxSize && current) {
      pieces.push(current.trim());
      current = sentence;
    } else {
      current = next;
    }
  }

  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

function splitBodyUnderPrefix(prefix, body, maxSize = TARGET_CHUNK_SIZE) {
  const paragraphs = splitParagraphs(body);
  if (!paragraphs.length) return [prefix].filter(Boolean);

  const chunks = [];
  let current = "";

  function flush() {
    if (!current.trim()) return;
    chunks.push(joinParts([prefix, current]));
    current = "";
  }

  for (const paragraph of paragraphs) {
    const candidateBody = current ? `${current}\n\n${paragraph}` : paragraph;
    const candidate = joinParts([prefix, candidateBody]);

    if (compactLength(candidate) <= maxSize) {
      current = candidateBody;
      continue;
    }

    flush();

    const paragraphWithPrefix = joinParts([prefix, paragraph]);
    if (compactLength(paragraphWithPrefix) <= maxSize) {
      current = paragraph;
      continue;
    }

    for (const piece of splitOversizedText(paragraph, Math.max(MIN_CHUNK_SIZE, maxSize - compactLength(prefix)))) {
      chunks.push(joinParts([prefix, piece]));
    }
  }

  flush();
  return chunks.filter(Boolean);
}

function splitByH3(section, maxSize = TARGET_CHUNK_SIZE) {
  const prefix = joinParts([section.h1, section.h2]);
  const groups = [];
  let current = { h3: "", lines: [] };

  function flush() {
    if (current.h3 || current.lines.join("").trim()) groups.push(current);
    current = { h3: "", lines: [] };
  }

  for (const line of section.lines) {
    if (isH3(line)) {
      flush();
      current.h3 = line;
      continue;
    }
    current.lines.push(line);
  }
  flush();

  if (!groups.some((group) => group.h3)) {
    return splitBodyUnderPrefix(prefix, section.lines.join("\n"), maxSize);
  }

  return groups.flatMap((group) => {
    const groupPrefix = joinParts([prefix, group.h3]);
    return splitBodyUnderPrefix(groupPrefix, group.lines.join("\n"), maxSize);
  });
}

function markdownH2Sections(text) {
  const lines = cleanText(text).split("\n");
  const sections = [];
  let currentH1 = "";
  let current = null;

  function flush() {
    if (current?.h2) sections.push(current);
    current = null;
  }

  for (const line of lines) {
    if (isH1(line)) {
      flush();
      currentH1 = line.trim();
      continue;
    }

    if (isH2(line)) {
      flush();
      current = { h1: currentH1, h2: line.trim(), lines: [] };
      continue;
    }

    if (current) current.lines.push(line);
  }

  flush();
  return sections;
}

function fallbackParagraphChunks(text, maxSize = TARGET_CHUNK_SIZE) {
  const paragraphs = splitParagraphs(text);
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (compactLength(candidate) <= maxSize) {
      current = candidate;
      continue;
    }

    if (current.trim()) chunks.push(current.trim());
    if (compactLength(paragraph) > maxSize) chunks.push(...splitOversizedText(paragraph, maxSize));
    else current = paragraph;
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

export function chunkText(text, options = {}) {
  const maxSize = Number(options.chunkSize) || TARGET_CHUNK_SIZE;
  const source = cleanText(text);
  const sections = markdownH2Sections(source);
  const rawChunks = sections.length
    ? sections.flatMap((section) => {
        const whole = joinParts([section.h1, section.h2, section.lines.join("\n")]);
        return compactLength(whole) > maxSize ? splitByH3(section, maxSize) : [whole];
      })
    : fallbackParagraphChunks(source, maxSize);

  return rawChunks
    .map((chunk) => cleanText(chunk))
    .filter(Boolean)
    .map((chunk, index) => ({
      chunkIndex: index,
      text: chunk,
      tokenEstimate: Math.ceil(chunk.length / 1.6),
    }));
}
