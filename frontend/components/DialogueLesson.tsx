"use client";
/** Lección en diálogo: el alumno verbaliza el malentendido típico de uso de la
 *  plataforma y el mentor lo corrige. Los subtítulos SON el contenido; la voz
 *  (speechSynthesis) es mejora progresiva — sin soporte, el botón desaparece.
 *  Guiones autorados en backend/app/content/tutorial_es.py. */
import { useEffect, useRef, useState } from "react";
import { DialogueTurn } from "@/lib/api";
import { speak, stopSpeech, ttsSupported } from "@/lib/tts";

export default function DialogueLesson({ stepKey, turns }:
  { stepKey: string; turns: DialogueTurn[] }) {
  const [open, setOpen] = useState(false);
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const [canSpeak, setCanSpeak] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => { setCanSpeak(ttsSupported()); }, []);

  // cambiar de paso cierra el diálogo y corta la voz; también al desmontar
  useEffect(() => {
    setOpen(false);
    cancelled.current = true;
    stopSpeech();
    setPlayingIdx(null);
  }, [stepKey]);
  useEffect(() => () => { cancelled.current = true; stopSpeech(); }, []);

  if (!turns.length) return null;

  const stop = () => {
    cancelled.current = true;
    stopSpeech();
    setPlayingIdx(null);
  };
  const playFrom = (i: number) => {
    if (cancelled.current || i >= turns.length) { setPlayingIdx(null); return; }
    setPlayingIdx(i);
    speak(turns[i].text, () => { if (!cancelled.current) playFrom(i + 1); });
  };
  const play = () => {
    stopSpeech();
    cancelled.current = false;
    playFrom(0);
  };

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-white">
      <button onClick={() => { if (open) stop(); setOpen((v) => !v); }}
        className="flex w-full items-center justify-between px-3 py-2 text-left">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          🗣️ Escúchalo como conversación
        </span>
        <span className="text-xs text-slate-400">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-3 py-2">
          <div className="space-y-1.5">
            {turns.map((turn, i) => {
              const isMentor = turn.speaker === "mentor";
              const isPlaying = playingIdx === i;
              return (
                <div key={i} className={`flex ${isMentor ? "justify-start" : "justify-end"}`}>
                  <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs leading-relaxed transition
                    ${isMentor ? "bg-pigui-50 text-slate-700" : "bg-slate-100 text-slate-600"}
                    ${isPlaying ? "ring-2 ring-pigui-300" : ""}`}>
                    <p className={`mb-0.5 text-[9px] font-semibold uppercase tracking-wide
                      ${isMentor ? "text-pigui-700" : "text-slate-400"}`}>
                      {isMentor ? "🧭 Mentor" : "Tú"}
                    </p>
                    {turn.text}
                  </div>
                </div>
              );
            })}
          </div>
          {canSpeak && (
            <div className="mt-2 flex items-center gap-2">
              {playingIdx === null ? (
                <button onClick={play}
                  className="rounded-md border border-pigui-200 bg-pigui-50 px-2.5 py-1 text-[11px] font-medium text-pigui-700 hover:bg-pigui-100">
                  ▶ Reproducir con voz
                </button>
              ) : (
                <button onClick={stop}
                  className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50">
                  ⏹ Detener
                </button>
              )}
              <span className="text-[10px] text-slate-400">voz del navegador · los subtítulos siempre están</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
