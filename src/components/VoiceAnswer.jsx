import { Mic, RotateCcw, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

function getSpeechRecognition() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export default function VoiceAnswer({ value, onChange, disabled }) {
  const [recording, setRecording] = useState(false);
  const [supported, setSupported] = useState(() => Boolean(getSpeechRecognition()));
  const recorderRef = useRef(null);
  const recognitionRef = useRef(null);

  const hint = useMemo(() => {
    if (!supported) return "当前浏览器不支持语音转文字，请直接输入答案";
    return recording ? "松开结束" : "按住说出答案";
  }, [recording, supported]);

  useEffect(() => {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      setSupported(false);
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i][0].transcript;
      }
      onChange(text);
    };
    recognition.onerror = () => setSupported(false);
    recognitionRef.current = recognition;
    return () => recognition.stop();
  }, [onChange]);

  async function start() {
    if (disabled || recording || !supported) return;
    setRecording(true);
    try {
      const stream = await navigator.mediaDevices?.getUserMedia({ audio: true });
      if (stream && window.MediaRecorder) {
        recorderRef.current = new MediaRecorder(stream);
        recorderRef.current.start();
      }
      recognitionRef.current?.start();
    } catch {
      setSupported(false);
      setRecording(false);
    }
  }

  function stop() {
    if (!recording) return;
    setRecording(false);
    recognitionRef.current?.stop();
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    recorderRef.current?.stream?.getTracks().forEach((track) => track.stop());
  }

  return (
    <div className="voice-panel">
      <button
        type="button"
        className={`mic-button ${recording ? "recording" : ""}`}
        onMouseDown={start}
        onMouseUp={stop}
        onMouseLeave={stop}
        onTouchStart={start}
        onTouchEnd={stop}
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
        <span>转写后可继续修改，再提交批改</span>
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="语音转写会显示在这里，也可以直接输入你的答案"
        rows={7}
        disabled={disabled}
      />
      <button type="button" className="ghost-button compact" onClick={() => onChange("")} disabled={disabled || !value}>
        <RotateCcw size={16} />
        重新录制
      </button>
    </div>
  );
}
