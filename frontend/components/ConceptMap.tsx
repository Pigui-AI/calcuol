"use client";
/** Mapa del motor: la jerarquía real de dependencias del roadmap con el
 *  estado que calcula el servidor. Responde lo que el stepper lineal no
 *  puede: qué depende de qué y por qué borrar datos regresa un paso a
 *  pendiente. Clic en un nodo abre su guía (el zoom general→detalle es el
 *  panel de detalle que ya existe). SVG a mano: sin dependencias nuevas. */
import { OnboardingStep } from "@/lib/api";
import { QuizScore } from "@/components/StepQuiz";
import { ICONS } from "@/components/roadmapMeta";

const W = 168, H = 56;

const POS: Record<string, { x: number; y: number }> = {
  proyecto: { x: 16, y: 132 },
  clientes: { x: 254, y: 16 },
  supuestos: { x: 254, y: 92 },
  crecimiento: { x: 254, y: 168 },
  operaciones: { x: 254, y: 244 },
  simulacion: { x: 494, y: 132 },
  analisis: { x: 716, y: 56 },
  entregable: { x: 716, y: 208 },
};

const EDGES: [string, string][] = [
  ["proyecto", "clientes"], ["proyecto", "supuestos"],
  ["proyecto", "crecimiento"], ["proyecto", "operaciones"],
  ["clientes", "simulacion"], ["supuestos", "simulacion"],
  ["crecimiento", "simulacion"], ["operaciones", "simulacion"],
  ["simulacion", "analisis"], ["simulacion", "entregable"],
];

const NODE_STYLE: Record<string, { fill: string; stroke: string; text: string; sub: string }> = {
  completado: { fill: "#ecfdf5", stroke: "#10b981", text: "#065f46", sub: "#059669" },
  en_progreso: { fill: "#f3f1ff", stroke: "#713dff", text: "#3b089c", sub: "#6316f7" },
  pendiente: { fill: "#ffffff", stroke: "#e2e8f0", text: "#475569", sub: "#94a3b8" },
};

function edgePath(from: string, to: string): string {
  const a = POS[from];
  const b = POS[to];
  const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
  const dx = Math.max(30, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export default function ConceptMap({ steps, quizScores, onSelect }: {
  steps: OnboardingStep[];
  quizScores: Record<string, QuizScore>;
  onSelect: (stepKey: string) => void;
}) {
  const byKey: Record<string, OnboardingStep> = {};
  steps.forEach((s) => { byKey[s.key] = s; });
  if (!POS.proyecto || !byKey.proyecto) return null;

  return (
    <div>
      <div className="overflow-x-auto pb-1">
        <svg viewBox="0 0 900 320" className="w-full min-w-[760px]" role="img"
          aria-label="Mapa del motor: dependencias entre los pasos del roadmap">
          {EDGES.map(([from, to]) => {
            const done = byKey[from]?.status === "completado";
            return (
              <path key={`${from}-${to}`} d={edgePath(from, to)} fill="none"
                stroke={done ? "#6ee7b7" : "#e2e8f0"} strokeWidth={done ? 2 : 1.5} />
            );
          })}
          <text x={POS.simulacion.x + W / 2} y={POS.simulacion.y + H + 16}
            fontSize="9" fill="#94a3b8" textAnchor="middle">
            📸 congela snapshot → run reproducible
          </text>
          {steps.filter((s) => POS[s.key]).map((step) => {
            const { x, y } = POS[step.key];
            const style = NODE_STYLE[step.status] ?? NODE_STYLE.pendiente;
            const passed = quizScores[step.key]?.passed;
            return (
              <g key={step.key} onClick={() => onSelect(step.key)} className="cursor-pointer"
                role="button" aria-label={`${step.title} — ${step.status}`}>
                <rect x={x} y={y} width={W} height={H} rx={11}
                  fill={style.fill} stroke={style.stroke}
                  strokeWidth={step.status === "en_progreso" ? 2.5 : 1.5} />
                <svg x={x + 12} y={y + 17} width={22} height={22} viewBox="0 0 24 24"
                  fill="none" stroke={style.stroke} strokeWidth={1.8}
                  strokeLinecap="round" strokeLinejoin="round">
                  {ICONS[step.icon] ?? ICONS.folder}
                </svg>
                <text x={x + 42} y={y + 25} fontSize="12.5" fontWeight="600" fill={style.text}>
                  {step.short}
                </text>
                <text x={x + 42} y={y + 41} fontSize="9.5" fill={style.sub}>
                  {step.status === "completado" ? "✓ completado"
                    : step.status === "en_progreso" ? "● en progreso" : "○ pendiente"}
                  {passed ? "  ·  🎯 entendido" : ""}
                </text>
                <circle cx={x + W - 17} cy={y + 17} r={9} fill="none" stroke={style.stroke} strokeWidth={1.2} />
                <text x={x + W - 17} y={y + 20.5} fontSize="9.5" fontWeight="600"
                  fill={style.text} textAnchor="middle">{step.order}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        Cada nodo depende de los anteriores y su estado sale de lo que existe en tu proyecto:
        si borras datos, el paso vuelve a pendiente. Haz clic en un nodo para abrir su guía.
      </p>
    </div>
  );
}
