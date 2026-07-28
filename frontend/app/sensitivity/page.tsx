"use client";
/** Pantalla 54 — Análisis de sensibilidad (fase 7). Ruta estática: /sensitivity?project=&scenario= */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ReferenceLine,
} from "recharts";
import {
  api, ApiError, Assumption, Project, SensitivityResult, SensitivityRow, SensitivityTarget,
} from "@/lib/api";
import { money, num } from "@/lib/format";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, KpiCard, SectionTitle, Skeleton, inputClass,
} from "@/components/ui";

const ANALYSIS_TABS = [
  { label: "Sensibilidad", path: "/sensitivity/" },
  { label: "Comparar runs", path: "/compare/" },
] as const;

/** Supuestos que más mueven el modelo (etiqueta de respaldo si el servidor no manda descripción). */
const VARIABLE_CATALOG: { key: string; label: string }[] = [
  { key: "b2b.churn_rate", label: "Churn mensual B2B" },
  { key: "b2b.cac", label: "CAC completo por cliente activado" },
  { key: "b2b.curve.rate", label: "Velocidad de la curva de adquisición" },
  { key: "b2b.acquisition_budget_monthly", label: "Presupuesto mensual de adquisición" },
  { key: "b2b.onboarding_capacity_monthly", label: "Capacidad de onboarding mensual" },
  { key: "b2c.purchase_conversion", label: "Consumidores activos que compran en el mes" },
  { key: "b2c.purchase_frequency", label: "Transacciones por comprador/mes" },
  { key: "b2c.avg_ticket", label: "Ticket promedio" },
  { key: "b2c.margin_pct", label: "Margen elegible sobre venta neta" },
  { key: "b2c.consumer_churn_rate", label: "Churn mensual de consumidores" },
  { key: "revenue.commission.pigui_pct", label: "Participación Pigui sobre utilidad elegible" },
  { key: "payments.stripe_share", label: "Parte del GMV cobrada vía Pigui Scan/Stripe" },
];

const MAX_VARIABLES = 8;

const AGGREGATION_HINT: Record<string, string> = {
  sum: "suma del horizonte",
  last: "último valor del horizonte",
  summary: "escalar del resumen del run",
};

/** Objetivos que son conteos (no montos) para no formatearlos como moneda. */
const COUNT_TARGETS = new Set(["b2b.clients_end", "b2c.consumers_end", "summary.breakeven_month"]);

/** Resumen del historial de análisis guardados (append-only en el servidor). */
interface SensitivityAnalysisSummary {
  id: string;
  target_metric: string;
  target_label?: string | null;
  baseline_value?: string | null;
  variables?: { key: string }[] | null;
  engine_version?: string | null;
  created_at?: string | null;
}

/** Errores de la API en español: usa field_errors si el backend los manda (422). */
function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.detail as { field_errors?: Record<string, string> } | string | null;
    if (d && typeof d === "object" && d.field_errors) {
      return "El servidor rechazó la configuración; revisa los campos marcados.";
    }
    return String(e.message);
  }
  return String(e);
}

function errFields(e: unknown): Record<string, string> {
  if (e instanceof ApiError) {
    const d = e.detail as { field_errors?: Record<string, string> } | string | null;
    if (d && typeof d === "object" && d.field_errors) return d.field_errors;
  }
  return {};
}

function fieldErrorFor(errors: Record<string, string>, key: string): string | undefined {
  if (errors[key]) return errors[key];
  return Object.entries(errors).find(([k]) => k.includes(key))?.[1];
}

/**
 * Valor inicial del formulario: ±20% sobre el valor efectivo del supuesto.
 * Es solo una sugerencia de captura (no un cálculo financiero): el motor del
 * servidor es el único que corre el batch y calcula deltas y elasticidades.
 */
function shift(value: string, factor: number): string {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return value;
  const shifted = n * factor;
  const abs = Math.abs(shifted);
  const decimals = abs === 0 ? 2 : abs < 1 ? 4 : abs < 100 ? 2 : 0;
  return String(parseFloat(shifted.toFixed(decimals)));
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.endsWith("Z") || value.includes("+") ? value : `${value}Z`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

function Sensitivity() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";
  const scenarioId = params.get("scenario") ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [targets, setTargets] = useState<SensitivityTarget[] | null>(null);
  const [assumptions, setAssumptions] = useState<Assumption[] | null>(null);
  const [history, setHistory] = useState<SensitivityAnalysisSummary[]>([]);
  const [noProjects, setNoProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [targetMetric, setTargetMetric] = useState("");
  const [vars, setVars] = useState<Record<string, { low: string; high: string }>>({});
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<SensitivityResult | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);

  // Sin parámetros: conserva el proyecto de la URL si existe; si no, el primero disponible.
  useEffect(() => {
    if (projectId && scenarioId) return;
    api.get<Project[]>("/projects")
      .then((list) => {
        const p = list.find((x) => x.id === projectId) ?? list[0];
        if (p && p.scenarios.length > 0) {
          router.replace(`/sensitivity/?project=${p.id}&scenario=${p.scenarios[0].id}`);
        } else {
          setNoProjects(true);
        }
      })
      .catch((e) => setError(String(e.message)));
  }, [projectId, scenarioId, router]);

  const loadHistory = useCallback(() => {
    if (!projectId) return;
    api.get<SensitivityAnalysisSummary[] | { analyses: SensitivityAnalysisSummary[] }>(
      `/projects/${projectId}/sensitivity-analyses`)
      .then((r) => setHistory(Array.isArray(r) ? r : r.analyses ?? []))
      .catch(() => setHistory([]));
  }, [projectId]);

  const load = useCallback(() => {
    if (!projectId || !scenarioId) return;
    setError(null);
    Promise.all([
      api.get<Project>(`/projects/${projectId}`),
      api.get<SensitivityTarget[]>("/sensitivity-targets"),
      api.get<{ assumptions: Assumption[] }>(`/scenarios/${scenarioId}/assumptions`),
    ])
      .then(([p, t, a]) => {
        setProject(p);
        setTargets(t);
        setAssumptions(a.assumptions);
        setTargetMetric((prev) => prev || t.find((x) => x.key === "pnl.ebitda")?.key || t[0]?.key || "");
      })
      .catch((e) => setError(String(e.message)));
    loadHistory();
  }, [projectId, scenarioId, loadHistory]);
  useEffect(load, [load]);

  // Cambiar de escenario reinicia la configuración y el resultado mostrado.
  useEffect(() => {
    setVars({});
    setResult(null);
    setActiveId(null);
    setRunError(null);
    setFieldErrors({});
  }, [scenarioId]);

  const baseValues = useMemo(() => {
    const map: Record<string, Assumption> = {};
    (assumptions ?? []).forEach((a) => { map[a.key] = a; });
    return map;
  }, [assumptions]);

  const selectedKeys = VARIABLE_CATALOG.map((v) => v.key).filter((k) => k in vars);
  const limitReached = selectedKeys.length >= MAX_VARIABLES;
  const complete = selectedKeys.length > 0
    && selectedKeys.every((k) => vars[k].low.trim() !== "" && vars[k].high.trim() !== "");

  const toggle = (key: string) => {
    setVars((prev) => {
      const next = { ...prev };
      if (key in next) {
        delete next[key];
        return next;
      }
      if (Object.keys(next).length >= MAX_VARIABLES) return prev;
      const base = baseValues[key]?.value ?? "";
      next[key] = { low: shift(base, 0.8), high: shift(base, 1.2) };
      return next;
    });
  };

  const setBound = (key: string, side: "low" | "high", value: string) => {
    setVars((prev) => (key in prev ? { ...prev, [key]: { ...prev[key], [side]: value } } : prev));
  };

  const runAnalysis = async () => {
    setRunning(true);
    setRunError(null);
    setFieldErrors({});
    try {
      const r = await api.post<SensitivityResult>(
        `/projects/${projectId}/scenarios/${scenarioId}/sensitivity`,
        {
          target_metric: targetMetric,
          variables: selectedKeys.map((k) => ({ key: k, low: vars[k].low.trim(), high: vars[k].high.trim() })),
          actor: "usuario",
        },
      );
      setResult(r);
      setActiveId(r.id ?? null);
      loadHistory();
    } catch (e) {
      setRunError(errText(e));
      setFieldErrors(errFields(e));
    } finally {
      setRunning(false);
    }
  };

  const openAnalysis = async (id: string) => {
    setDetailLoading(id);
    setRunError(null);
    try {
      const r = await api.get<SensitivityResult>(`/sensitivity-analyses/${id}`);
      setResult(r);
      setActiveId(id);
      setTargetMetric(r.target_metric);
    } catch (e) {
      setRunError(errText(e));
    } finally {
      setDetailLoading(null);
    }
  };

  const currency = project?.base_currency ?? "MXN";
  const isCount = result ? COUNT_TARGETS.has(result.target_metric) : false;
  const fmtTarget = useCallback(
    (v: string | number | null | undefined) => (isCount ? num(v, 1) : money(v, currency)),
    [isCount, currency],
  );

  const tornado = useMemo(() => {
    if (!result) return [];
    // El servidor ya los entrega ordenados por impacto absoluto descendente.
    return result.results.map((r: SensitivityRow) => ({
      clave: r.key,
      "Escenario bajo": r.delta_low === null ? null : parseFloat(r.delta_low),
      "Escenario alto": r.delta_high === null ? null : parseFloat(r.delta_high),
    }));
  }, [result]);

  if (!projectId || !scenarioId) {
    if (noProjects) {
      return (
        <EmptyState
          title="Aún no hay proyectos"
          description="Crea tu primer proyecto y define sus supuestos para poder medir qué variables mueven más el resultado."
          action={<Button href="/projects/new/">Crear proyecto</Button>}
        />
      );
    }
    if (error) return <ErrorState message={error} />;
    return <Skeleton rows={5} />;
  }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!project || !targets || !assumptions) return <Skeleton rows={5} />;

  const activeTarget = targets.find((t) => t.key === targetMetric);

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link>{" / "}
        <Link href={`/project/?id=${project.id}`} className="hover:text-pigui-700">{project.name}</Link>
        {" / "}Análisis de sensibilidad
      </nav>
      <SectionTitle
        title="Análisis de sensibilidad"
        subtitle="Cada variable se mueve sola sobre el mismo snapshot; el servidor corre el batch y devuelve el tornado ordenado por impacto."
        right={
          <select
            className={`${inputClass} !w-auto`}
            value={scenarioId}
            onChange={(e) => router.replace(`/sensitivity/?project=${project.id}&scenario=${e.target.value}`)}
          >
            {project.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg border border-slate-200 bg-white p-1">
        {ANALYSIS_TABS.map((t) => (
          <Link
            key={t.path}
            href={`${t.path}?project=${projectId}&scenario=${scenarioId}`}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${
              t.path === "/sensitivity/" ? "bg-pigui-600 text-white" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <Card className="mb-4">
        <CardBody className="space-y-5">
          <div className="md:max-w-md">
            <span className="mb-1 block text-sm font-medium text-slate-700">Métrica objetivo</span>
            <select className={inputClass} value={targetMetric} onChange={(e) => setTargetMetric(e.target.value)}>
              {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            <p className="mt-1 text-xs text-slate-400">
              {activeTarget
                ? `${activeTarget.key} · agregación: ${AGGREGATION_HINT[activeTarget.aggregation] ?? activeTarget.aggregation}`
                : "Selecciona la métrica que quieres medir."}
            </p>
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-slate-800">Variables a mover</p>
                <p className="text-xs text-slate-500">
                  Los valores bajo/alto vienen pre-llenados con ±20% del valor efectivo del escenario: son solo
                  un punto de partida editable, no un cálculo del modelo.
                </p>
              </div>
              <Badge tone={limitReached ? "queued" : "default"}>
                {selectedKeys.length} / {MAX_VARIABLES} variables
              </Badge>
            </div>
            {limitReached && (
              <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
                Máximo {MAX_VARIABLES} variables por análisis: cada una agrega dos corridas completas al batch del
                servidor. Desmarca alguna para elegir otra.
              </p>
            )}

            <div className="space-y-2">
              {VARIABLE_CATALOG.map((v) => {
                const a = baseValues[v.key];
                const checked = v.key in vars;
                const disabled = !checked && (limitReached || !a);
                const fe = fieldErrorFor(fieldErrors, v.key);
                return (
                  <div
                    key={v.key}
                    className={`rounded-lg border p-3 ${
                      checked ? "border-pigui-300 bg-pigui-50/40" : "border-slate-200 bg-white"
                    } ${disabled ? "opacity-60" : ""}`}
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex min-w-0 flex-1 items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4 accent-pigui-600"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggle(v.key)}
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-slate-800">
                            {a?.description || v.label}
                          </span>
                          <span className="block font-mono text-[11px] text-slate-400">{v.key}</span>
                        </span>
                      </label>
                      <div className="text-right">
                        <p className="text-[11px] uppercase tracking-wide text-slate-400">Valor base</p>
                        <p className="font-mono text-sm text-slate-700">
                          {a ? a.value : "no disponible"}{a?.unit ? ` ${a.unit}` : ""}
                        </p>
                      </div>
                      {a && (
                        <Badge tone={a.origin === "escenario" ? "hipotesis" : a.origin === "proyecto" ? "declarado" : "default"}>
                          {a.origin}
                        </Badge>
                      )}
                    </div>
                    {checked && (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <label className="block">
                          <span className="mb-1 block text-xs font-medium text-slate-600">Escenario bajo</span>
                          <input
                            className={inputClass}
                            value={vars[v.key].low}
                            onChange={(e) => setBound(v.key, "low", e.target.value)}
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs font-medium text-slate-600">Escenario alto</span>
                          <input
                            className={inputClass}
                            value={vars[v.key].high}
                            onChange={(e) => setBound(v.key, "high", e.target.value)}
                          />
                        </label>
                      </div>
                    )}
                    {fe && <p className="mt-2 text-xs font-medium text-rose-600">{fe}</p>}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <p className="text-xs text-slate-500">
              {selectedKeys.length > 0
                ? `El servidor ejecutará ${selectedKeys.length * 2} corridas derivadas (${selectedKeys.length} variables × 2 extremos) más el baseline.`
                : "Selecciona al menos una variable para ejecutar el análisis."}
            </p>
            <Button onClick={runAnalysis} disabled={!complete || !targetMetric || running}>
              {running ? "Ejecutando en el servidor…" : "Ejecutar análisis"}
            </Button>
          </div>
          {runError && <p className="text-sm font-medium text-rose-600">{runError}</p>}
          {Object.keys(fieldErrors).length > 0 && (
            <ul className="list-inside list-disc rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
              {Object.entries(fieldErrors).map(([k, v]) => (
                <li key={k}><span className="font-mono">{k}</span>: {v}</li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {running && (
        <Card className="mb-6">
          <CardBody>
            <p className="text-sm font-semibold text-slate-800">Corriendo el batch de sensibilidad…</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Cada corrida se ejecuta completa en el motor del servidor sobre el mismo snapshot. Puede tardar
              algunos segundos según el horizonte del proyecto.
            </p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full w-1/2 animate-pulse rounded-full bg-pigui-500" />
            </div>
          </CardBody>
        </Card>
      )}

      {result && !running && (
        <div className="mb-8 space-y-5">
          <SectionTitle
            title={`Resultado — ${result.target_label}`}
            subtitle={`Motor v${result.engine_version} · snapshot ${result.input_hash ? `${result.input_hash.slice(0, 12)}…` : "—"} · agregación ${AGGREGATION_HINT[result.aggregation] ?? result.aggregation}`}
          />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label="Baseline" value={fmtTarget(result.baseline_value)}
              hint={`${result.target_label} sin mover ninguna variable`} />
            <KpiCard label="Variables analizadas" value={num(result.results.length, 0)}
              hint={`${result.results.length * 2} corridas derivadas`} />
            <KpiCard label="Mayor impacto"
              value={<span className="font-mono text-sm">{result.results[0]?.key ?? "—"}</span>}
              hint={result.results[0] ? `Rango de ${fmtTarget(result.results[0].impact)}` : undefined} />
            <KpiCard label="Menor impacto"
              value={<span className="font-mono text-sm">{result.results[result.results.length - 1]?.key ?? "—"}</span>}
              hint={result.results.length > 0
                ? `Rango de ${fmtTarget(result.results[result.results.length - 1].impact)}`
                : undefined} />
          </div>

          <Card>
            <CardBody>
              <p className="mb-3 text-sm font-semibold text-slate-800">
                Tornado — impacto sobre {result.target_label}
              </p>
              {tornado.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">Sin variables en este análisis.</p>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(200, tornado.length * 52 + 60)}>
                  <BarChart data={tornado} layout="vertical" margin={{ left: 8, right: 16 }}>
                    <XAxis type="number" tick={{ fontSize: 10 }}
                      tickFormatter={(v) => (isCount ? num(v, 0) : money(v, currency, true))} />
                    <YAxis type="category" dataKey="clave" width={210} tick={{ fontSize: 10 }} interval={0} />
                    <Tooltip formatter={(v: number) => fmtTarget(v)} />
                    <Legend />
                    <ReferenceLine x={0} stroke="#94a3b8" />
                    <Bar dataKey="Escenario bajo" fill="#f59e0b" radius={[0, 3, 3, 0]} />
                    <Bar dataKey="Escenario alto" fill="#713dff" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
              <p className="mt-2 text-xs text-slate-400">
                Las barras muestran el delta contra el baseline ({fmtTarget(result.baseline_value)}); a la
                izquierda del cero el objetivo empeora y a la derecha mejora.
              </p>
            </CardBody>
          </Card>

          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-5 py-3">Variable</th>
                    <th className="px-3 py-3 text-right">Valor base</th>
                    <th className="px-3 py-3 text-right">Bajo (entrada)</th>
                    <th className="px-3 py-3 text-right">Bajo (resultado)</th>
                    <th className="px-3 py-3 text-right">Δ bajo</th>
                    <th className="px-3 py-3 text-right">Alto (entrada)</th>
                    <th className="px-3 py-3 text-right">Alto (resultado)</th>
                    <th className="px-3 py-3 text-right">Δ alto</th>
                    <th className="px-3 py-3 text-right">Elasticidad</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results.map((r) => {
                    const meta = baseValues[r.key];
                    const label = meta?.description
                      || VARIABLE_CATALOG.find((v) => v.key === r.key)?.label
                      || r.key;
                    const deltaClass = (v: string | null) =>
                      v === null ? "text-slate-400" : parseFloat(v) < 0 ? "text-rose-600" : "text-emerald-700";
                    return (
                      <tr key={r.key} className="border-b border-slate-100 last:border-0">
                        <td className="px-5 py-2.5">
                          <p className="font-medium text-slate-800">{label}</p>
                          <p className="font-mono text-[11px] text-slate-400">{r.key}</p>
                          {r.overridden_by && (
                            <p className="mt-0.5 text-[11px] text-amber-700">
                              El portafolio sobrescribe este supuesto ({r.overridden_by}): el motor usa{" "}
                              <span className="font-mono">{r.effective_value}</span>, por eso variarlo no
                              cambia el resultado.
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs">{r.baseline_input}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs">{r.low_input ?? "—"}</td>
                        <td className="px-3 py-2.5 text-right">{fmtTarget(r.low_value)}</td>
                        <td className={`px-3 py-2.5 text-right font-medium ${deltaClass(r.delta_low)}`}>
                          {fmtTarget(r.delta_low)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs">{r.high_input ?? "—"}</td>
                        <td className="px-3 py-2.5 text-right">{fmtTarget(r.high_value)}</td>
                        <td className={`px-3 py-2.5 text-right font-medium ${deltaClass(r.delta_high)}`}>
                          {fmtTarget(r.delta_high)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-xs text-slate-600">
                          {num(r.elasticity_low, 3)} / {num(r.elasticity_high, 3)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          <p className="text-xs text-slate-400">
            Cada corrida cambia una sola variable sobre el mismo snapshot; los impactos son comparables contra el
            mismo baseline. La elasticidad (Δ% del objetivo ÷ Δ% de la variable) se muestra como bajo / alto y
            queda vacía cuando no es definible (baseline o valor base en cero).
          </p>
        </div>
      )}

      <SectionTitle
        title="Análisis guardados"
        subtitle="Cada análisis queda congelado con el hash del snapshot que lo produjo; abre uno para volver a ver su detalle."
      />
      <Card>
        {history.length === 0 ? (
          <CardBody>
            <p className="py-6 text-center text-sm text-slate-400">
              Todavía no hay análisis guardados para este proyecto.
            </p>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3">Fecha</th>
                  <th className="px-3 py-3">Objetivo</th>
                  <th className="px-3 py-3 text-right">Variables</th>
                  <th className="px-3 py-3 text-right">Baseline</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}
                    className={`border-b border-slate-100 last:border-0 ${activeId === h.id ? "bg-pigui-50/50" : ""}`}>
                    <td className="px-5 py-2.5 text-slate-600">{fmtDate(h.created_at)}</td>
                    <td className="px-3 py-2.5">
                      <p className="text-slate-800">{h.target_label || h.target_metric}</p>
                      <p className="font-mono text-[11px] text-slate-400">{h.target_metric}</p>
                    </td>
                    <td className="px-3 py-2.5 text-right">{num(h.variables?.length ?? 0, 0)}</td>
                    <td className="px-3 py-2.5 text-right">
                      {COUNT_TARGETS.has(h.target_metric)
                        ? num(h.baseline_value, 1)
                        : money(h.baseline_value, currency, true)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button variant="ghost" onClick={() => openAnalysis(h.id)} disabled={detailLoading === h.id}>
                        {detailLoading === h.id ? "Abriendo…" : "Ver detalle"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-4 text-xs text-slate-400">
        El frontend no calcula nada: envía la configuración y muestra el batch, los deltas y la elasticidad tal
        como los devuelve el motor.
      </p>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><Sensitivity /></Suspense>;
}
