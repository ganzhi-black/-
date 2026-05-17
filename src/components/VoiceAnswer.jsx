import { Mic, RotateCcw, Square } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { createRealtimeAudioSocket } from "../services/api.js";

const TARGET_SAMPLE_RATE = 16000;

function getRecordingSupport() {
  if (typeof window === "undefined") return false;
  return Boolean(window.AudioContext || window.webkitAudioContext) && Boolean(navigator.mediaDevices?.getUserMedia);
}

function downsampleTo16k(input, sourceSampleRate) {
  if (sourceSampleRate === TARGET_SAMPLE_RATE) return input;

  const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    output[i] = sum / Math.max(1, end - start);
  }

  return output;
}

function floatTo16BitPcm(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

function joinAnswerParts(parts) {
  return parts.filter(Boolean).join(parts.length > 1 ? "\n" : "");
}

export default function VoiceAnswer({ value, onChange, disabled }) {
  const [recording, setRecording] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [supported, setSupported] = useState(getRecordingSupport);
  const [error, setError] = useState("");
  const audioContextRef = useRef(null);
  const sourceRef = useRef(null);
  const processorRef = useRef(null);
  const streamRef = useRef(null);
  const socketRef = useRef(null);
  const socketCloseTimerRef = useRef(null);
  const baseTextRef = useRef("");
  const finalTextRef = useRef("");
  const partialTextRef = useRef("");

  const hint = useMemo(() => {
    if (!supported) return "当前浏览器不支持录音，请换 Chrome 或 Edge";
    if (connecting) return "正在连接语音模型";
    return recording ? "松开结束录音" : "按住实时转写";
  }, [connecting, recording, supported]);

  function renderTranscript() {
    const nextText = joinAnswerParts([baseTextRef.current.trim(), finalTextRef.current.trim(), partialTextRef.current.trim()]);
    onChange(nextText);
  }

  function cleanupAudio() {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    audioContextRef.current?.close();
    processorRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
    audioContextRef.current = null;
  }

  function finishSocket() {
    const socket = socketRef.current;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "finish" }));
      socketCloseTimerRef.current = setTimeout(() => socket.close(), 3000);
    } else {
      socket.close();
    }
    socketRef.current = null;
  }

  async function start(event) {
    event?.preventDefault();
    if (disabled || recording || connecting || !supported) return;

    setError("");
    setConnecting(true);
    if (socketCloseTimerRef.current) clearTimeout(socketCloseTimerRef.current);
    baseTextRef.current = value || "";
    finalTextRef.current = "";
    partialTextRef.current = "";

    try {
      const socket = createRealtimeAudioSocket();
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.onmessage = (messageEvent) => {
        const message = JSON.parse(messageEvent.data);
        if (message.type === "ready") {
          setConnecting(false);
          setRecording(true);
          return;
        }

        if (message.type === "partial") {
          partialTextRef.current = message.text || "";
          renderTranscript();
          return;
        }

        if (message.type === "final") {
          const text = String(message.text || "").trim();
          if (text) {
            finalTextRef.current = joinAnswerParts([finalTextRef.current.trim(), text]);
            partialTextRef.current = "";
            renderTranscript();
          }
          return;
        }

        if (message.type === "finished") {
          if (socketCloseTimerRef.current) clearTimeout(socketCloseTimerRef.current);
          socket.close();
          return;
        }

        if (message.type === "error") {
          setError(message.error || "语音识别失败，请稍后再试");
          stop();
        }
      };

      socket.onerror = () => {
        setError("语音服务连接失败，请检查 Qwen 配置");
        stop();
      };

      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onclose = () => reject(new Error("语音连接已关闭"));
      });

      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContext();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (audioEvent) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const input = audioEvent.inputBuffer.getChannelData(0);
        const downsampled = downsampleTo16k(input, audioContext.sampleRate);
        socket.send(floatTo16BitPcm(downsampled));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      audioContextRef.current = audioContext;
      sourceRef.current = source;
      processorRef.current = processor;
      streamRef.current = stream;
    } catch (startError) {
      setError(startError.message || "无法启动录音");
      setConnecting(false);
      setRecording(false);
      setSupported(getRecordingSupport());
      cleanupAudio();
      finishSocket();
    }
  }

  function stop(event) {
    event?.preventDefault();
    if (!recording && !connecting) return;
    setRecording(false);
    setConnecting(false);
    cleanupAudio();
    finishSocket();
  }

  return (
    <div className="voice-panel">
      <button
        type="button"
        className={`mic-button ${recording ? "recording" : ""}`}
        onPointerDown={start}
        onPointerUp={stop}
        onPointerCancel={stop}
        onPointerLeave={stop}
        disabled={disabled || !supported}
        aria-label={hint}
      >
        {recording ? <Square size={24} /> : <Mic size={26} />}
        {recording && (
          <span className="wave" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
      </button>
      <div className="voice-copy">
        <strong>{hint}</strong>
        <span>{error || "按住说话，文字会实时出现在答案框里"}</span>
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="也可以直接输入答案，或按住麦克风实时语音作答"
        rows={7}
        disabled={disabled}
      />
      <button type="button" className="ghost-button compact" onClick={() => onChange("")} disabled={disabled || !value}>
        <RotateCcw size={16} />
        清空重答
      </button>
    </div>
  );
}
