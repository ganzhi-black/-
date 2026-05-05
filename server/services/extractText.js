import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { convertFileToMarkdown } from "./markitdown.js";
import { repairMojibake } from "./textRepair.js";

function extensionOf(fileName = "") {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? parts.at(-1) : "";
}

function startsWith(buffer, signature) {
  return signature.every((byte, index) => buffer[index] === byte);
}

function looksLikePdf(file) {
  return file.mimetype === "application/pdf" || extensionOf(file.originalname) === "pdf" || startsWith(file.buffer, [0x25, 0x50, 0x44, 0x46]);
}

function looksLikeDocx(file) {
  if (file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return true;
  if (extensionOf(file.originalname) === "docx") return true;
  if (!startsWith(file.buffer, [0x50, 0x4b])) return false;
  return file.buffer.includes(Buffer.from("word/"));
}

function looksLikeText(file) {
  const extension = extensionOf(file.originalname);
  return file.mimetype === "text/plain" || extension === "txt" || extension === "md";
}

export async function extractTextFromFile(file) {
  const extension = extensionOf(file.originalname);

  if (process.env.DOCUMENT_CONVERTER === "markitdown") {
    try {
      return repairMojibake(await convertFileToMarkdown(file));
    } catch (error) {
      console.warn("MarkItDown conversion failed; falling back to built-in extractor.", error.message);
    }
  }

  if (looksLikeText(file)) {
    return repairMojibake(file.buffer.toString("utf8"));
  }

  if (looksLikePdf(file)) {
    const parsed = await pdfParse(file.buffer);
    const text = repairMojibake(parsed.text);
    if (!text.trim()) throw new Error("PDF parsed successfully, but no selectable text was found. If this is a scanned PDF, please convert it with OCR first.");
    return text;
  }

  if (looksLikeDocx(file)) {
    const parsed = await mammoth.extractRawText({ buffer: file.buffer });
    const text = repairMojibake(parsed.value);
    if (!text.trim()) throw new Error("DOCX parsed successfully, but no text was found.");
    return text;
  }

  if (extension === "doc") {
    throw new Error("This .doc file could not be parsed automatically. Old .doc files are accepted on a best-effort basis; if this keeps failing, please open it in Word/WPS and save as .docx or PDF, then upload again.");
  }

  throw new Error("Only txt, md, pdf, doc, and docx files are supported for now. Please convert this file to .docx or PDF and upload again.");
}
