const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";

export async function transcribeAudioFile(file) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to transcribe audio.");
  }

  if (!file?.buffer?.length) {
    throw new Error("Audio file is required.");
  }

  const formData = new FormData();
  const audioBlob = new Blob([file.buffer], { type: file.mimetype || "audio/webm" });
  formData.append("file", audioBlob, file.originalname || "answer.webm");
  formData.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe");
  formData.append("language", "zh");

  const response = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: formData,
  });

  const payload = await response.json().catch(async () => ({ error: { message: await response.text() } }));

  if (!response.ok) {
    throw new Error(payload?.error?.message || `Audio transcription failed: ${response.status}`);
  }

  return {
    text: String(payload.text || "").trim(),
    model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
  };
}
