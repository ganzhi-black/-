import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const DEFAULT_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const DEFAULT_MODEL = "fun-asr-realtime";

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function createRunTaskMessage(taskId) {
  return {
    header: {
      action: "run-task",
      task_id: taskId,
      streaming: "duplex",
    },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model: process.env.QWEN_ASR_MODEL || DEFAULT_MODEL,
      parameters: {
        format: "pcm",
        sample_rate: 16000,
      },
      input: {},
    },
  };
}

function createFinishTaskMessage(taskId) {
  return {
    header: {
      action: "finish-task",
      task_id: taskId,
      streaming: "duplex",
    },
    payload: {
      input: {},
    },
  };
}

function forwardQwenResult(clientWs, message) {
  const event = message?.header?.event;

  if (event === "task-started") {
    sendJson(clientWs, { type: "ready" });
    return;
  }

  if (event === "result-generated") {
    const sentence = message?.payload?.output?.sentence;
    if (!sentence || sentence.heartbeat) return;

    sendJson(clientWs, {
      type: sentence.sentence_end ? "final" : "partial",
      text: sentence.text || "",
    });
    return;
  }

  if (event === "task-finished") {
    sendJson(clientWs, { type: "finished" });
    return;
  }

  if (event === "task-failed") {
    sendJson(clientWs, {
      type: "error",
      error: message?.header?.error_message || "Qwen speech recognition failed.",
    });
  }
}

export function setupQwenRealtimeAsr(server) {
  const wss = new WebSocketServer({ server, path: "/api/audio/realtime" });

  wss.on("connection", (clientWs) => {
    if (process.env.ASR_PROVIDER !== "qwen") {
      sendJson(clientWs, { type: "error", error: "ASR_PROVIDER must be qwen." });
      clientWs.close();
      return;
    }

    if (!process.env.DASHSCOPE_API_KEY) {
      sendJson(clientWs, { type: "error", error: "DASHSCOPE_API_KEY is required." });
      clientWs.close();
      return;
    }

    const taskId = crypto.randomUUID();
    const queuedAudioFrames = [];
    let taskStarted = false;
    let taskFinished = false;

    const qwenWs = new WebSocket(process.env.QWEN_ASR_ENDPOINT || DEFAULT_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
        "user-agent": "qimoshua-ai-trainer/1.0",
      },
    });

    qwenWs.on("open", () => {
      qwenWs.send(JSON.stringify(createRunTaskMessage(taskId)));
    });

    qwenWs.on("message", (data, isBinary) => {
      if (isBinary) return;

      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (message?.header?.event === "task-started") {
        taskStarted = true;
        while (queuedAudioFrames.length && qwenWs.readyState === WebSocket.OPEN) {
          qwenWs.send(queuedAudioFrames.shift());
        }
      }

      if (message?.header?.event === "task-finished" || message?.header?.event === "task-failed") {
        taskFinished = true;
      }

      forwardQwenResult(clientWs, message);
    });

    qwenWs.on("error", (error) => {
      sendJson(clientWs, { type: "error", error: error.message || "Qwen WebSocket error." });
    });

    qwenWs.on("close", () => {
      if (!taskFinished) sendJson(clientWs, { type: "finished" });
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });

    clientWs.on("message", (data, isBinary) => {
      if (!isBinary) {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (message.type === "finish" && qwenWs.readyState === WebSocket.OPEN) {
          qwenWs.send(JSON.stringify(createFinishTaskMessage(taskId)));
        }
        return;
      }

      if (qwenWs.readyState !== WebSocket.OPEN || !taskStarted) {
        queuedAudioFrames.push(data);
        return;
      }

      qwenWs.send(data);
    });

    clientWs.on("close", () => {
      if (qwenWs.readyState === WebSocket.OPEN && !taskFinished) {
        qwenWs.send(JSON.stringify(createFinishTaskMessage(taskId)));
      }
      setTimeout(() => {
        if (qwenWs.readyState === WebSocket.OPEN || qwenWs.readyState === WebSocket.CONNECTING) {
          qwenWs.close(1000, "client closed");
        }
      }, 1000);
    });
  });
}
