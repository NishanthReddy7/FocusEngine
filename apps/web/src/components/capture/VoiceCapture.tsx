"use client";

import { useRef, useState } from "react";
import { Mic, Square } from "lucide-react";

/**
 * Ramble stub (ARCHITECTURE.md §7 components list / README "what's stubbed").
 * Recording via `MediaRecorder` is real; speech-to-text is NOT implemented —
 * `TODO(STT)`. The recorded blob is discarded on stop; wiring a transcription
 * service and feeding its output into `parseQuickAdd()` is the documented
 * next step.
 */
export function VoiceCapture() {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        // TODO(STT): send the recorded blob (new Blob(chunksRef.current)) to
        // a speech-to-text service and feed the transcript into
        // parseQuickAdd() — not implemented in this scaffold.
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "microphone access denied");
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void (recording ? stopRecording() : startRecording())}
        aria-pressed={recording}
        title="Ramble — voice capture (transcription is a stub)"
        className="inline-flex items-center gap-2 rounded-md border border-hairline px-3 py-2 text-secondary text-muted transition-colors duration-150 hover:bg-surface hover:text-ink"
      >
        {recording ? <Square size={14} className="text-overdue" /> : <Mic size={14} />}
        {recording ? "Stop" : "Ramble"}
      </button>
      {error && <span className="font-mono text-[11px] text-overdue">{error}</span>}
    </div>
  );
}
