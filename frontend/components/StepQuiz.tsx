"use client";
/** Quiz «Compruébalo» de un paso del tutorial. Cada distractor trae feedback
 *  que nombra el malentendido y, si toca repasar OTRO paso, un botón para
 *  saltar ahí. Las respuestas numéricas llegan resueltas del servidor; aquí
 *  solo se presenta y se lleva la cuenta. El resultado lo guarda el padre en
 *  localStorage: es metacognición personal, no estado del proyecto. */
import { useEffect, useState } from "react";
import { QuizQuestion } from "@/lib/api";

export interface QuizScore { best: number; total: number; passed: boolean }

export default function StepQuiz({ stepKey, questions, personalized, score, onFinish, onReview }: {
  stepKey: string;
  questions: QuizQuestion[];
  personalized: boolean;
  score?: QuizScore;
  onFinish: (stepKey: string, correct: number, total: number) => void;
  onReview: (stepKey: string) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [finished, setFinished] = useState(false);

  useEffect(() => { setIdx(0); setPicked({}); setFinished(false); }, [stepKey]);

  // en modo «datos de ejemplo» se ocultan las preguntas con números reales
  const visible = personalized ? questions : questions.filter((q) => !q.uses_real_data);
  if (!visible.length) return null;

  const q = visible[Math.min(idx, visible.length - 1)];
  const chosen = picked[idx];
  const answered = chosen !== undefined;
  const correctCount = visible.reduce((acc, qq, i) =>
    acc + (picked[i] !== undefined && qq.options[picked[i]]?.correct ? 1 : 0), 0);
  const isLast = idx === visible.length - 1;

  const finish = () => {
    setFinished(true);
    onFinish(stepKey, correctCount, visible.length);
  };
  const retry = () => { setIdx(0); setPicked({}); setFinished(false); };

  return (
    <div className="mt-2 rounded-md border border-violet-100 bg-violet-50/50 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-700">
          🎯 Compruébalo
        </p>
        <div className="flex items-center gap-1.5">
          {q.uses_real_data && !finished && (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">
              con tus números
            </span>
          )}
          {score?.passed && (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">
              ✓ entendido
            </span>
          )}
          {!finished && (
            <span className="text-[10px] text-slate-400">{idx + 1} de {visible.length}</span>
          )}
        </div>
      </div>

      {finished ? (
        <div className="mt-1.5">
          <p className="text-xs text-slate-700">
            {correctCount === visible.length
              ? <>✅ {correctCount} de {visible.length}: el porqué ya lo tienes. El stepper ahora marca este paso como «entendido».</>
              : <>Llevas {correctCount} de {visible.length}. Lee el feedback de las que fallaste y vuelve a intentar.</>}
          </p>
          <button onClick={retry}
            className="mt-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-pigui-700">
            ↻ Reintentar
          </button>
        </div>
      ) : (
        <div className="mt-1.5">
          <p className="text-xs font-medium leading-relaxed text-slate-800">{q.text}</p>
          <div className="mt-1.5 space-y-1">
            {q.options.map((o, i) => {
              const isChosen = chosen === i;
              const cls = !answered
                ? "border-slate-200 bg-white hover:border-violet-300 hover:bg-violet-50"
                : o.correct
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : isChosen
                    ? "border-rose-300 bg-rose-50 text-rose-800"
                    : "border-slate-100 bg-white text-slate-400";
              return (
                <button key={i} disabled={answered}
                  onClick={() => setPicked((p) => ({ ...p, [idx]: i }))}
                  className={`block w-full rounded-md border px-2 py-1.5 text-left text-xs leading-relaxed transition ${cls}`}>
                  {o.text}
                </button>
              );
            })}
          </div>
          {answered && (
            <div className="mt-1.5 rounded-md bg-white/80 px-2 py-1.5">
              <p className="text-[11px] leading-relaxed text-slate-600">
                {q.options[chosen].feedback}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {!q.options[chosen].correct && q.options[chosen].review_step && (
                  <button onClick={() => onReview(q.options[chosen].review_step!)}
                    className="rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-100">
                    Repasar ese paso →
                  </button>
                )}
                <button onClick={() => (isLast ? finish() : setIdx((i) => i + 1))}
                  className="rounded-md bg-pigui-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-pigui-700">
                  {isLast ? "Ver resultado" : "Siguiente"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
