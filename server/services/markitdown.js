import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const vendorPath = path.resolve(serviceDir, "..", "python-vendor");
const DEFAULT_TIMEOUT_MS = 120000;

function pythonCommand() {
  return process.env.PYTHON_BIN || "python";
}

export async function convertFileToMarkdown(file) {
  const tempDir = path.join(os.tmpdir(), "qimoshua-markitdown");
  await mkdir(tempDir, { recursive: true });

  const extension = path.extname(file.originalname || "") || ".bin";
  const filePath = path.join(tempDir, `${randomUUID()}${extension}`);
  await writeFile(filePath, file.buffer);

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(pythonCommand(), ["-m", "markitdown", filePath], {
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONPATH: process.env.PYTHONPATH ? `${vendorPath}${path.delimiter}${process.env.PYTHONPATH}` : vendorPath,
        },
      });

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`markitdown timed out after ${Math.round((Number(process.env.MARKITDOWN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS) / 1000)} seconds`));
      }, Number(process.env.MARKITDOWN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
          return;
        }
        reject(new Error(stderr || `markitdown exited with code ${code}`));
      });
    });
  } finally {
    await rm(filePath, { force: true });
  }
}
