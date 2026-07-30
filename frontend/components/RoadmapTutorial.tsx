"use client";
/** Ruta de activación: tutorial guiado con el progreso real del proyecto.
 *  El estado de cada paso lo calcula el servidor (GET /onboarding); esta vista
 *  solo lo presenta. */
import { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { api, OnboardingRoadmap, OnboardingStep } from "@/lib/api";
import { Button } from "@/components/ui";
import TutorialScene from "@/components/TutorialScenes";
import StepQuiz, { QuizScore } from "@/components/StepQuiz";
import DialogueLesson from "@/components/DialogueLesson";
import { ICONS, STATUS_META } from "@/components/roadmapMeta";

// el mapa solo carga si el usuario lo abre: no penaliza la home
const ConceptMap = dynamic(() => import("@/components/ConceptMap"), { ssr: false, loading: () => null });

function StepIcon({ icon, status }: { icon: string; status: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.pendiente;
  return (
    <span className={`relative flex h-12 w-12 items-center justify-center rounded-full border-2 ${meta.ring}`}>
      {status === "completado" ? (
        <svg viewBox="0 0 24 24" className="h-6 w-6 text-white" fill="none"
          stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className={`h-5 w-5 ${meta.circle}`} fill="none"
          stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
          {ICONS[icon] ?? ICONS.folder}
        </svg>
      )}
    </span>
  );
}

function StepDetail({ step, personalized, quizScore, onQuizFinish, onReview, handsOnDone, onToggleHandsOn }: {
  step: OnboardingStep; personalized: boolean; quizScore?: QuizScore;
  onQuizFinish: (stepKey: string, correct: number, total: number, ids: string[]) => void;
  onReview: (stepKey: string) => void;
  handsOnDone: number[];
  onToggleHandsOn: (stepKey: string, index: number) => void;
}) {
  const meta = STATUS_META[step.status] ?? STATUS_META.pendiente;
  return (
    <div className={`rounded-lg border p-4 ${step.status === "en_progreso"
      ? "border-pigui-300 bg-pigui-50/60" : "border-slate-200 bg-white"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Paso {step.order}
          </p>
          <p className="font-semibold text-slate-900">{step.title}</p>
        </div>
        <span className={`shrink-0 text-xs font-medium ${meta.text}`}>{meta.label}</span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{step.what}</p>

      <div className="mt-3">
        <TutorialScene stepKey={step.key} data={personalized ? step.scene_data ?? undefined : undefined} />
      </div>

      <div className="mt-3 rounded-md border border-sky-100 bg-sky-50/70 px-3 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">
          🧒 Explicado fácil
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-slate-700">{step.eli5}</p>
      </div>

      {(step.dialogue?.length ?? 0) > 0 && (
        <DialogueLesson stepKey={step.key} turns={step.dialogue!} />
      )}

      {step.hands_on.length > 0 && (
        <div className="mt-2 rounded-md bg-slate-50 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              👉 Hazlo tú, clic por clic
            </p>
            <span className="text-[10px] text-slate-400">
              {handsOnDone.length}/{step.hands_on.length} hechos
            </span>
          </div>
          <ol className="mt-1 space-y-1">
            {step.hands_on.map((h, i) => {
              const checked = handsOnDone.includes(i);
              return (
                <li key={i}>
                  <label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-slate-600">
                    <input type="checkbox" checked={checked}
                      onChange={() => onToggleHandsOn(step.key, i)}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-pigui-600" />
                    <span className={checked ? "text-slate-400 line-through" : ""}>{h}</span>
                  </label>
                </li>
              );
            })}
          </ol>
          <p className="mt-1.5 text-[10px] text-slate-400">
            Marcar aquí es solo tu guía personal: el paso lo da por completado el servidor,
            con lo que realmente existe en tu proyecto.
          </p>
        </div>
      )}

      {(step.quiz?.length ?? 0) > 0 && (
        <StepQuiz stepKey={step.key} questions={step.quiz!} personalized={personalized}
          score={quizScore} onFinish={onQuizFinish} onReview={onReview} />
      )}

      <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
        <span className="font-semibold text-slate-700">Para tenerlo en cuenta: </span>{step.tip}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button href={step.href} variant={step.status === "completado" ? "secondary" : "primary"}
          className="!px-3 !py-1.5">
          {step.status === "completado" ? "Revisar" : "Ir a este paso"}
        </Button>
        {step.detail && <span className="text-xs text-slate-500">{step.detail}</span>}
      </div>
    </div>
  );
}

const PRIVACY_KEY = "calcuol.tutorial.privacy.v1";
const QUIZ_KEY = "calcuol.tutorial.quiz.v1";
const HANDSON_KEY = "calcuol.tutorial.handson.v1";
const VIEW_KEY = "calcuol.tutorial.view.v1";

/** Siguiente acción sugerida. Combina el estado real del servidor
 *  (current_key) con los quizzes fallidos en localStorage, y siempre dice el
 *  porqué — la misma filosofía que la columna «restricción activa». */
function NextActionBanner({ data, quizScores, onReview }: {
  data: OnboardingRoadmap;
  quizScores: Record<string, QuizScore>;
  onReview: (stepKey: string) => void;
}) {
  const failed = data.steps.find((s) => {
    const q = quizScores[s.key];
    return s.status === "completado" && q && q.total > 0 && !q.passed;
  });
  if (failed) {
    const q = quizScores[failed.key];
    return (
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2">
        <p className="text-xs text-amber-800">
          <span className="font-semibold">Hecho no es lo mismo que entendido:</span>{" "}
          hiciste «{failed.title}» en la app, pero su quiz quedó en {q.best}/{q.total}.
        </p>
        <button onClick={() => onReview(failed.key)}
          className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100">
          Repasar ese paso
        </button>
      </div>
    );
  }

  const current = data.steps.find((s) => s.key === data.current_key);
  if (current) {
    return (
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-pigui-200 bg-pigui-50/60 px-3 py-2">
        <p className="text-xs text-slate-700">
          <span className="font-semibold text-pigui-700">Tu siguiente acción:</span>{" "}
          «{current.title}». Empieza por: {current.hands_on[0]?.toLowerCase()}.
        </p>
        <span className="flex gap-2">
          <button onClick={() => onReview(current.key)}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
            Ver la guía
          </button>
          <Button href={current.href} className="!px-2.5 !py-1 !text-xs">Ir a este paso</Button>
        </span>
      </div>
    );
  }

  // solo cuentan los pasos que traen quiz: con un backend anterior (sin el
  // campo) el cierre no puede exigir un quiz que no existe
  const anyQuiz = data.steps.some((s) => (s.quiz?.length ?? 0) > 0);
  const unquizzed = data.steps.find((s) => (s.quiz?.length ?? 0) > 0 && !quizScores[s.key]?.passed);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2">
      <p className="text-xs text-emerald-800">
        {unquizzed
          ? <>Los 8 pasos están hechos 🎉 Para cerrar el círculo, comprueba que también los
              dominas: te falta el quiz de «{unquizzed.title}».</>
          : anyQuiz
            ? <>Ruta completa y entendida 🎉 Hiciste los 8 pasos y aprobaste todos los quizzes.</>
            : <>Ruta completa 🎉 Hiciste los 8 pasos.</>}
      </p>
      {unquizzed && (
        <button onClick={() => onReview(unquizzed.key)}
          className="rounded-md border border-emerald-300 bg-white px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100">
          Ir al quiz
        </button>
      )}
    </div>
  );
}

export default function RoadmapTutorial({ projectId }: { projectId?: string }) {
  const [data, setData] = useState<OnboardingRoadmap | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [personalized, setPersonalized] = useState(true);
  const [quizScores, setQuizScores] = useState<Record<string, QuizScore>>({});
  const [handsOn, setHandsOn] = useState<Record<string, number[]>>({});
  const [view, setView] = useState<"ruta" | "mapa">("ruta");

  useEffect(() => {
    api.get<OnboardingRoadmap>(`/onboarding${projectId ? `?project_id=${projectId}` : ""}`)
      .then((d) => { setData(d); setSelected(d.current_key ?? d.steps[0]?.key ?? null); })
      .catch(() => setFailed(true));
  }, [projectId]);

  useEffect(() => {
    try {
      setPersonalized(localStorage.getItem(PRIVACY_KEY) !== "generic");
      setQuizScores(JSON.parse(localStorage.getItem(QUIZ_KEY) ?? "{}"));
      setHandsOn(JSON.parse(localStorage.getItem(HANDSON_KEY) ?? "{}"));
      if (localStorage.getItem(VIEW_KEY) === "mapa") setView("mapa");
    } catch { /* SSR/privado */ }
  }, []);
  const togglePersonalized = () => {
    setPersonalized((v) => {
      try { localStorage.setItem(PRIVACY_KEY, v ? "generic" : "real"); } catch { /* sin storage */ }
      return !v;
    });
  };
  const handleQuizFinish = (stepKey: string, correct: number, total: number, ids: string[]) => {
    setQuizScores((prev) => {
      const before = prev[stepKey];
      // best/total viajan en pareja (el toggle de privacidad puede cambiar el
      // número de preguntas entre intentos): gana el intento con mejor proporción
      const better = !before || correct * (before.total || 1) >= before.best * (total || 1);
      const next = {
        ...prev,
        [stepKey]: {
          best: better ? correct : before.best,
          total: better ? total : before.total,
          passed: (before?.passed ?? false) || (total > 0 && correct === total),
          ids,
        },
      };
      try { localStorage.setItem(QUIZ_KEY, JSON.stringify(next)); } catch { /* sin storage */ }
      return next;
    });
  };
  const reviewStep = (stepKey: string) => { setSelected(stepKey); setOpen(true); };
  const switchView = (v: "ruta" | "mapa") => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* sin storage */ }
  };
  const toggleHandsOn = (stepKey: string, index: number) => {
    setHandsOn((prev) => {
      const current = new Set(prev[stepKey] ?? []);
      if (current.has(index)) current.delete(index); else current.add(index);
      const next = { ...prev, [stepKey]: Array.from(current).sort((a, b) => a - b) };
      try { localStorage.setItem(HANDSON_KEY, JSON.stringify(next)); } catch { /* sin storage */ }
      return next;
    });
  };

  if (failed || !data) return null;   // el roadmap nunca bloquea la pantalla

  const pct = Math.round((data.completed / data.total) * 100);
  const detailStep = data.steps.find((s) => s.key === selected) ?? data.steps[0];
  const anyRealData = data.steps.some((s) => s.scene_data);

  // un score solo cuenta si sus preguntas siguen existiendo en el quiz actual
  // del paso: si el contenido cambió, «entendido» debe ganarse de nuevo
  const validScores: Record<string, QuizScore> = {};
  data.steps.forEach((step) => {
    const score = quizScores[step.key];
    if (!score?.ids?.length) return;
    const current = new Set((step.quiz ?? []).map((q) => q.id));
    if (score.ids.every((id) => current.has(id))) validScores[step.key] = score;
  });

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-pigui-50 text-pigui-700">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor"
              strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5h16M4 12h16M4 19h10" />
            </svg>
          </span>
          <div>
            <h2 className="text-lg font-bold text-slate-900">Tu ruta de activación</h2>
            <p className="text-sm text-slate-500">
              Completa estos pasos para aprender a usar la plataforma de punta a punta
              {data.project && <> · proyecto <span className="font-medium text-slate-600">{data.project.name}</span></>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-sm font-semibold text-slate-900">{data.completed} de {data.total}</p>
            <p className="text-[11px] text-slate-400">pasos completados</p>
          </div>
          {anyRealData && (
            <button onClick={togglePersonalized}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"
              title="Los ejemplos del tutorial pueden usar tus datos reales o utilería genérica (útil al compartir pantalla)">
              {personalized ? "🙈 Usar datos de ejemplo" : "🏪 Usar mis datos"}
            </button>
          )}
          <button onClick={() => setOpen((v) => !v)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
            {open ? "Ocultar guía" : "Ver todos los pasos"}
          </button>
        </div>
      </div>

      <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-pigui-600 transition-all" style={{ width: `${pct}%` }} />
      </div>

      <NextActionBanner data={data} quizScores={validScores} onReview={reviewStep} />

      <div className="mt-5 flex items-center justify-between gap-2">
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
          {(["ruta", "mapa"] as const).map((v) => (
            <button key={v} onClick={() => switchView(v)}
              className={`rounded-md px-3 py-1 text-xs font-medium ${
                view === v ? "bg-pigui-600 text-white" : "text-slate-500 hover:bg-slate-50"}`}>
              {v === "ruta" ? "Ruta" : "Mapa del motor"}
            </button>
          ))}
        </div>
        {view === "mapa" && (
          <span className="text-[11px] text-slate-400">qué depende de qué, con tu estado real</span>
        )}
      </div>

      {view === "mapa" ? (
        <div className="mt-3">
          <ConceptMap steps={data.steps} quizScores={validScores} onSelect={reviewStep} />
        </div>
      ) : (
      <div className="mt-3 overflow-x-auto pb-1">
        <div className="flex min-w-[820px] items-start">
          {data.steps.map((step, i) => {
            const meta = STATUS_META[step.status] ?? STATUS_META.pendiente;
            const isSelected = step.key === selected;
            return (
              <div key={step.key} className="flex flex-1 items-start">
                <button onClick={() => { setSelected(step.key); setOpen(true); }}
                  className="flex w-full flex-col items-center gap-1.5 px-1 text-center"
                  title={step.what}>
                  <StepIcon icon={step.icon} status={step.status} />
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${
                    step.status === "pendiente" ? "bg-slate-100 text-slate-400" : "bg-pigui-100 text-pigui-700"}`}>
                    {step.order}
                  </span>
                  <span className={`text-xs font-medium leading-tight ${
                    isSelected ? "text-pigui-700" : "text-slate-700"}`}>{step.short}</span>
                  <span className={`text-[11px] ${meta.text}`}>{meta.label}</span>
                  {validScores[step.key]?.passed && (
                    <span className="text-[10px] font-medium text-emerald-600"
                      title="Aprobaste el quiz de este paso: hecho Y entendido">🎯 entendido</span>
                  )}
                </button>
                {i < data.steps.length - 1 && (
                  <span className={`mt-6 h-0.5 w-full min-w-[16px] ${
                    step.status === "completado" ? "bg-emerald-400" : "bg-slate-200"}`} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      )}

      {open && detailStep && (
        <div className="mt-5 border-t border-slate-100 pt-5">
          <div className="grid gap-3 lg:grid-cols-2">
            <StepDetail step={detailStep} personalized={personalized}
              quizScore={validScores[detailStep.key]}
              onQuizFinish={handleQuizFinish} onReview={reviewStep}
              handsOnDone={handsOn[detailStep.key] ?? []}
              onToggleHandsOn={toggleHandsOn} />
            <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
              <p className="text-sm font-semibold text-slate-800">Todos los pasos</p>
              <ol className="mt-2 space-y-1">
                {data.steps.map((s) => {
                  const meta = STATUS_META[s.status] ?? STATUS_META.pendiente;
                  return (
                    <li key={s.key}>
                      <button onClick={() => setSelected(s.key)}
                        className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                          s.key === selected ? "bg-white shadow-sm" : "hover:bg-white/70"}`}>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                            s.status === "completado" ? "bg-emerald-100 text-emerald-700"
                              : s.status === "en_progreso" ? "bg-pigui-100 text-pigui-700"
                              : "bg-slate-100 text-slate-400"}`}>{s.order}</span>
                          <span className="truncate text-slate-700">{s.title}</span>
                        </span>
                        <span className={`shrink-0 text-[11px] ${meta.text}`}>{meta.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                El estado de cada paso lo calcula el servidor con lo que ya existe en tu proyecto:
                no es una lista que se marque sola. Si borras datos, el paso vuelve a quedar pendiente.
              </p>
              {data.imports_committed > 0 && (
                <p className="mt-2 text-[11px] text-slate-500">
                  Además tienes {data.imports_committed} importación(es) confirmadas con IA.
                </p>
              )}
            </div>
          </div>
          <p className="mt-4 text-xs text-slate-500">
            ¿Prefieres leerlo completo? Descarga el{" "}
            <Link href="/manual-de-usuario.pdf" target="_blank" rel="noopener noreferrer"
              className="font-medium text-pigui-700 hover:underline">manual de usuario (PDF)</Link>:
            cubre cada pantalla, el glosario de métricas y las reglas del motor.
          </p>
        </div>
      )}
    </div>
  );
}
