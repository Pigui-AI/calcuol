"use client";
/** Mini-escenas animadas del tutorial: cada una "actúa" cómo se usa un paso de
 *  la plataforma (llenar valores, guardar, simular…). Por defecto son utilería
 *  visual; si el servidor manda `scene_data` (datos reales del proyecto, ya
 *  formateados y truncados), la escena reproduce lo que el usuario hizo. El
 *  fallback es por dato: cualquier campo ausente usa la utilería. */
import { useEffect, useState } from "react";
import { TutorialSceneData } from "@/lib/api";

const D = (s: number) => ({ animationDelay: `${s}s` });

type SceneProps = { d?: TutorialSceneData };

/** Campo de formulario que se "escribe" solo. */
function Field({ label, value, delay, w = "w-24" }:
  { label: string; value: string; delay: number; w?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[10px] text-slate-400">{label}</span>
      <span className={`rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-700 ${w}`}>
        <span className="a-type" style={D(delay)}>{value}</span>
      </span>
    </div>
  );
}

function Caption({ text, delay }: { text: string; delay: number }) {
  return (
    <p className="a-fade absolute inset-x-3 bottom-2 text-center text-[10px] font-medium text-slate-500"
      style={D(delay)}>{text}</p>
  );
}

function SceneProyecto({ d }: SceneProps) {
  return (
    <div className="relative h-full p-3">
      <div className="mx-auto w-56 rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
        <p className="mb-1.5 text-[10px] font-semibold text-slate-600">Nuevo proyecto</p>
        <div className="space-y-1.5">
          <Field label="Nombre" value={d?.project_name ?? "Mi plan Pigui"} delay={0.3} />
          <Field label="Moneda" value={d?.currency ?? "MXN"} delay={1.2} w="w-12" />
          <Field label="Horizonte" value={d?.horizon_label ?? "60 meses"} delay={1.9} w="w-16" />
        </div>
        <div className="a-press mt-2 w-max rounded-md bg-pigui-600 px-2.5 py-1 text-[10px] font-medium text-white"
          style={D(3.0)}>Crear proyecto</div>
      </div>
      <div className="a-pop absolute right-4 top-6 rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-1.5 text-[10px] font-medium text-emerald-700 shadow-sm"
        style={D(3.6)}>✓ Proyecto creado</div>
      <Caption text={d ? "Así nació este proyecto: tu tablero de juego" :
        "Llenas tres datos y ya tienes tu tablero de juego"} delay={4.2} />
    </div>
  );
}

function SceneClientes({ d }: SceneProps) {
  const branches = d?.branches?.length ? d.branches : ["Centro", "Norte"];
  const products: [string, string][] = d?.products?.length
    ? d.products.map((p) => [p.name, p.price] as [string, string])
    : [["Café americano", "$45"], ["Croissant", "$38"], ["Latte", "$55"]];
  const baseline = d?.baseline_line ?? "Línea base: ventas $92,000 · 2,400 tickets · 740 consumidores";
  return (
    <div className="relative h-full p-3">
      <div className="a-pop mx-auto w-60 rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm" style={D(0.2)}>
        <p className="text-[11px] font-semibold text-slate-700">🏪 {d?.client_name ?? "Café Alborada"}</p>
        <div className="mt-1 flex gap-1.5">
          {branches.map((name, i) => (
            <span key={name} className="a-pop rounded bg-pigui-50 px-1.5 py-0.5 text-[9px] text-pigui-700"
              style={D(0.9 + i * 0.4)}>📍 {name}</span>
          ))}
        </div>
        <div className="mt-1.5 space-y-1 border-t border-slate-100 pt-1.5">
          {products.map(([n, p], i) => (
            <div key={n} className="a-fade flex justify-between text-[10px] text-slate-600" style={D(1.8 + i * 0.5)}>
              <span>{n}</span><span className="font-medium">{p}</span>
            </div>
          ))}
        </div>
        <div className="a-slide-up mt-1.5 rounded bg-slate-50 px-1.5 py-1 text-[9px] text-slate-500" style={D(3.4)}>
          {baseline}
        </div>
      </div>
      <Caption text="Sucursales + menú + números de un mes normal = el motor ya la conoce" delay={4.2} />
    </div>
  );
}

function SceneSupuestos({ d }: SceneProps) {
  return (
    <div className="relative h-full p-3">
      <div className="mx-auto w-64 rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
        <p className="mb-1 text-[10px] font-semibold text-slate-600">Churn mensual B2B</p>
        <p className="font-mono text-[9px] text-slate-400">b2b.churn_rate</p>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="rounded border border-slate-200 px-2 py-1 font-mono text-[11px] text-slate-400 line-through">
            {d?.old_value ?? "0.03"}</span>
          <span className="text-slate-400">→</span>
          <span className="a-pop rounded border-2 border-pigui-500 px-2 py-1 font-mono text-[11px] font-semibold text-pigui-700"
            style={D(1.0)}>{d?.new_value ?? "0.05"}</span>
          <span className="a-press ml-1 rounded-md bg-pigui-600 px-2 py-1 text-[10px] font-medium text-white" style={D(2.2)}>
            Guardar
          </span>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] text-slate-500">
            {d?.v_old_label ?? "v1 · 0.03 · guardada"}</span>
          <span className="a-pop rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700"
            style={D(2.9)}>{d?.v_new_label ?? "v2 · 0.05 · vigente ✓"}</span>
        </div>
      </div>
      <Caption text={d ? "Tu churn quedó así: la versión anterior sigue guardada" :
        "Como guardar partida en un videojuego: la versión anterior no se borra"} delay={3.8} />
    </div>
  );
}

function SceneCrecimiento({ d }: SceneProps) {
  return (
    <div className="relative h-full p-3">
      <svg viewBox="0 0 240 105" className="mx-auto h-28 w-full max-w-[280px]">
        <line x1="18" y1="92" x2="230" y2="92" stroke="#cbd5e1" strokeWidth="1" />
        <line x1="18" y1="10" x2="18" y2="92" stroke="#cbd5e1" strokeWidth="1" />
        {/* curva objetivo */}
        <path d="M20 88 C 80 84, 120 60, 150 38 S 210 14, 228 12" fill="none"
          stroke="#713dff" strokeWidth="2.5" className="a-draw" strokeLinecap="round" />
        {/* techo de capacidad */}
        <line x1="18" y1="45" x2="230" y2="45" stroke="#f59e0b" strokeWidth="1.5"
          strokeDasharray="5 4" className="a-fade" style={D(1.9)} />
        <text x="222" y="40" fontSize="8" fill="#b45309" textAnchor="end" className="a-fade" style={D(2.2)}>
          {d?.capacity_label ?? "capacidad del equipo"}
        </text>
        {/* altas reales: barras recortadas por el techo */}
        {[[40, 14], [70, 22], [100, 33], [130, 42], [160, 47], [190, 47], [215, 47]].map(([x, h], i) => (
          <rect key={x} x={x} y={92 - h} width="12" height={h} rx="2"
            fill={h >= 47 ? "#f59e0b" : "#a78bfa"} className="a-rise"
            style={{ ...D(2.4 + i * 0.22), transformOrigin: "center bottom", transformBox: "fill-box" } as React.CSSProperties} />
        ))}
      </svg>
      <Caption text="La curva quiere subir, pero el techo naranja recorta: eso es un cuello de botella" delay={4.2} />
    </div>
  );
}

function SceneOperaciones({ d }: SceneProps) {
  const rows: [string, number][] = [["Campañas", 0.4], ["Suscripciones", 1.1], ["IA y tokens", 1.8]];
  const start = d?.campaign_start ?? 3;
  const end = d?.campaign_end ?? 8;
  // la tira muestra la ventana de 12 meses donde arranca la campaña, para que
  // una campaña real de meses 13-18 no se pinte como "nunca activa"
  const windowBase = Math.floor((Math.max(1, start) - 1) / 12) * 12;
  return (
    <div className="relative h-full p-3">
      <div className="mx-auto w-56 space-y-1.5 rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
        {rows.map(([name, delay]) => (
          <div key={name} className="flex items-center justify-between">
            <span className="text-[10px] text-slate-600">{name}</span>
            <span className="relative inline-flex h-4 w-8 items-center rounded-full bg-emerald-400/90">
              <span className="a-knob absolute left-0 h-3 w-3 rounded-full bg-white shadow" style={D(delay)} />
            </span>
          </div>
        ))}
        <div className="border-t border-slate-100 pt-1.5">
          <p className="text-[9px] text-slate-400">
            Campaña {d?.campaign_name ?? "«Promo»"} · {d?.campaign_window ?? "meses 3–8"}
          </p>
          <div className="mt-1 flex gap-0.5">
            {Array.from({ length: 12 }, (_, i) => {
              const month = windowBase + i + 1;
              const active = month >= start && month <= end;
              return (
                <span key={i} className={`h-3 w-3.5 rounded-sm ${active ? "a-pop bg-pigui-500" : "bg-slate-100"}`}
                  style={active ? D(2.5 + (month - start) * 0.15) : undefined} />
              );
            })}
          </div>
        </div>
      </div>
      <Caption text="Son focos: los enciendes para probar y los apagas sin romper nada" delay={4.0} />
    </div>
  );
}

function SceneSimulacion({ d }: SceneProps) {
  return (
    <div className="relative h-full p-3">
      <div className="mx-auto flex w-64 items-start gap-3">
        <div className="a-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-pigui-600 text-white shadow"
          style={D(0.4)}>
          <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5" fill="currentColor"><path d="M8 5.5v13l11-6.5-11-6.5Z" /></svg>
        </div>
        <div className="relative flex-1 rounded-lg border border-slate-200 bg-white p-2 shadow-sm">
          <div className="a-flash absolute inset-0 rounded-lg bg-white" style={D(1.0)} />
          <p className="text-[9px] font-medium text-slate-500">📸 snapshot congelado</p>
          <div className="mt-1 flex h-14 items-end gap-1">
            {[18, 26, 34, 40, 47, 55].map((h, i) => (
              <span key={i} className="a-rise w-5 rounded-t bg-pigui-400"
                style={{ height: `${h}px`, ...D(1.8 + i * 0.25) }} />
            ))}
          </div>
          <p className="a-fade mt-1 font-mono text-[8px] text-slate-400" style={D(3.4)}>
            hash <span className="text-emerald-600">{d?.hash_short ?? "62dd88…"}</span> — misma foto, mismos números
          </p>
        </div>
      </div>
      <Caption text={d ? "Ese hash es la huella de tu última corrida exitosa" :
        "Primero la foto, luego la historia mes a mes: por eso es repetible"} delay={4.2} />
    </div>
  );
}

function SceneAnalisis({ d }: SceneProps) {
  const top = d?.top_lever ?? "churn";
  const rest = ["churn", "CAC", "ticket", "conversión"].filter((l) => l !== top).slice(0, 3);
  const bars: [string, number, number, boolean][] = [
    [top, 78, 0.5, true], [rest[0], 52, 1.1, false], [rest[1], 34, 1.7, false], [rest[2], 22, 2.3, false],
  ];
  return (
    <div className="relative h-full p-3">
      <div className="mx-auto w-60 rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
        <p className="mb-1.5 text-[10px] font-semibold text-slate-600">¿Qué mueve más el EBITDA?</p>
        {bars.map(([name, w, delay, isTop]) => (
          <div key={name} className="mb-1 flex items-center gap-1.5">
            <span className="w-16 shrink-0 truncate text-right font-mono text-[9px] text-slate-500">{name}</span>
            <span className={`a-grow-x h-3.5 rounded-r ${isTop ? "bg-pigui-600" : "bg-pigui-300"}`}
              style={{ width: `${w}%`, ...D(delay) }} />
            {isTop && <span className="a-pop text-[9px] font-semibold text-pigui-700" style={D(3.0)}>← prioridad</span>}
          </div>
        ))}
        <p className="a-fade mt-1 text-[9px] text-slate-400" style={D(3.4)}>
          cada barra = mover una sola perilla
        </p>
      </div>
      <Caption text={d ? "Tu tornado real: esa palanca es la que más mueve tu EBITDA" :
        "La barra más larga te dice dónde poner el esfuerzo primero"} delay={4.0} />
    </div>
  );
}

function SceneEntregable({ d }: SceneProps) {
  return (
    <div className="relative h-full p-3">
      <div className="mx-auto flex w-60 items-end justify-center gap-4">
        <div className="a-slide-up w-28 rounded-lg border border-slate-200 bg-white p-2 shadow-sm" style={D(0.4)}>
          <p className="text-[9px] font-semibold text-emerald-700">📊 Excel</p>
          <div className="mt-1 space-y-0.5">
            {[0.9, 1.2, 1.5, 1.8].map((delay, i) => (
              <span key={i} className="a-grow-x block h-1.5 rounded bg-slate-200" style={{ width: `${88 - i * 14}%`, ...D(delay) }} />
            ))}
          </div>
          <p className="a-fade mt-1 font-mono text-[8px] text-slate-400" style={D(2.1)}>
            14 hojas · {d?.horizon_label ?? "60 meses"}</p>
        </div>
        <div className="a-slide-up w-28 rounded-lg border border-slate-200 bg-white p-2 shadow-sm" style={D(1.0)}>
          <p className="text-[9px] font-semibold text-pigui-700">📄 Documento</p>
          <div className="mt-1 space-y-0.5">
            {[1.5, 1.8, 2.1, 2.4].map((delay, i) => (
              <span key={i} className="a-grow-x block h-1.5 rounded bg-slate-200" style={{ width: `${92 - i * 10}%`, ...D(delay) }} />
            ))}
          </div>
          <p className="a-fade mt-1 font-mono text-[8px] text-slate-400" style={D(2.7)}>
            {d?.run_ref ?? "run a1b2c3 citado"}</p>
        </div>
        <div className="a-bounce text-pigui-600" style={D(3.0)}>
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 19h16" /></svg>
        </div>
      </div>
      <Caption text="Todo lo que compartas lleva el sello del run: cada número tiene de dónde" delay={3.6} />
    </div>
  );
}

const SCENES: Record<string, (props: SceneProps) => React.JSX.Element> = {
  proyecto: SceneProyecto,
  clientes: SceneClientes,
  supuestos: SceneSupuestos,
  crecimiento: SceneCrecimiento,
  operaciones: SceneOperaciones,
  simulacion: SceneSimulacion,
  analisis: SceneAnalisis,
  entregable: SceneEntregable,
};

export default function TutorialScene({ stepKey, data }:
  { stepKey: string; data?: TutorialSceneData }) {
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setCycle((c) => c + 1), 9500);
    return () => clearInterval(id);
  }, [stepKey]);
  const Scene = SCENES[stepKey] ?? SceneProyecto;
  return (
    <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50/80">
      <div key={`${stepKey}-${cycle}-${data ? "real" : "demo"}`} className="tut-scene h-44 w-full">
        <Scene d={data} />
      </div>
      {data && (
        <span className="absolute left-2 top-2 rounded-full border border-emerald-200 bg-emerald-50/95 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
          ● con tus datos
        </span>
      )}
      <button onClick={() => setCycle((c) => c + 1)}
        className="absolute right-2 top-2 rounded-md border border-slate-200 bg-white/90 px-2 py-0.5 text-[10px] font-medium text-slate-500 hover:text-pigui-700"
        title="Repetir la animación">↻ Repetir</button>
    </div>
  );
}
