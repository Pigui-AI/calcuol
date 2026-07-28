"use client";
/** Pantalla 55 — Comparación de escenarios/runs (fase 7). Ruta estática: /compare?project=&scenario= */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ReferenceLine,
} from "recharts";
import { api, ApiError, CompareResult, Project, Run, Scenario } from "@/lib/api";
import { money, num, pct } from "@/lib/format";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, SectionTitle, Skeleton, inputClass,
} from "@/components/ui";

const ANALYSIS_TABS = [
  { label: "Sensibilidad", path: "/sensitivity/" },
  { label: "Comparar runs", path: "/compare/" },
] as const;

const MIN_RUNS = 2;
const MAX_RUNS = 5;

/** KPIs destacados en la gráfica comparativa (los demás quedan en la tabla). */
const CHART_KPIS = ["rev.total", "tx.gmv", "pnl.ebitda", "cash.balance_end"];

/** KPIs que son conteos o meses: no se formatean como moneda. */
const COUNT_KPIS = new Set(["b2b.clients_end", "b2c.consumers_end", "summary.breakeven_month"]);

const SERIES_COLORS = ["#713dff", "#10b981", "#f59e0b", "#0ea5e9", "#ec4899"];

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.detail as { field_errors?: Record<string, string> } | string | null;
    if (d && typeof d === "object" && d.field_errors) return Object.values(d.field_errors).join(" · ");
    return String(e.message);
  }
  return String(e);
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.endsWith("Z") || value.includes("+") ? value : `${value}Z`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

function CompareRuns() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";
  const scenarioId = params.get("scenario") ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<{ run: Run; scenario: Scenario }[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [noProjects, setNoProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sin parámetros: conserva el proyecto de la URL si existe; si no, el primero disponible.
  useEffect(() => {
    if (projectId) return;
    api.get<Project[]>("/projects")
      .then((list) => {
        const p = list[0];
        if (p) {
          const sid = p.scenarios[0]?.id ?? "";
          router.replace(`/compare/?project=${p.id}&scenario=${sid}`);
        } else {
          setNoProjects(true);
        }
      })
      .catch((e) => setError(String(e.message)));
  }, [projectId, router]);

  const load = useCallback(() => {
    if (!projectId) return;
    setError(null);
    api.get<Project>(`/projects/${projectId}`)
      .then(async (p) => {
        setProject(p);
        const lists = await Promise.all(
          p.scenarios.map((s) =>
            api.get<Run[]>(`/scenarios/${s.id}/runs`)
              .then((rs) => rs.map((run) => ({ run, scenario: s })))
              .catch(() => [] as { run: Run; scenario: Scenario }[])),
        );
        setRuns(lists.flat().filter((x) => x.run.status === "succeeded"));
      })
      .catch((e) => setError(String(e.message)));
  }, [projectId]);
  useEffect(load, [load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_RUNS) return prev;
      return [...prev, id];
    });
  };

  const compare = async () => {
    setComparing(true);
    setCompareError(null);
    try {
      const r = await api.get<CompareResult>(`/projects/${projectId}/compare?runs=${selected.join(",")}`);
      setResult(r);
    } catch (e) {
      setCompareError(errText(e));
    } finally {
      setComparing(false);
    }
  };

  const currency = project?.base_currency ?? "MXN";
  const fmtKpi = useCallback(
    (key: string, v: string | null | undefined) =>
      (COUNT_KPIS.has(key) ? num(v, key === "summary.breakeven_month" ? 0 : 1) : money(v, currency)),
    [currency],
  );

  // Nombre único por run para las series de la gráfica (dos runs pueden compartir etiqueta).
  const runNames = useMemo(() => {
    const map: Record<string, string> = {};
    (result?.runs ?? []).forEach((r) => { map[r.id] = `${r.label} · ${r.id.slice(0, 6)}`; });
    return map;
  }, [result]);

  const chartData = useMemo(() => {
    if (!result) return [];
    return result.kpis
      .filter((k) => CHART_KPIS.includes(k.key))
      .map((k) => {
        const row: Record<string, string | number | null> = { kpi: k.label };
        k.values.forEach((v) => {
          row[runNames[v.run_id] ?? v.run_id] = v.value === null ? null : parseFloat(v.value);
        });
        return row;
      });
  }, [result, runNames]);

  if (!projectId) {
    if (noProjects) {
      return (
        <EmptyState
          title="Aún no hay proyectos"
          description="Crea un proyecto y ejecuta al menos dos simulaciones para poder compararlas lado a lado."
          action={<Button href="/projects/new/">Crear proyecto</Button>}
        />
      );
    }
    if (error) return <ErrorState message={error} />;
    return <Skeleton rows={5} />;
  }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!project || !runs) return <Skeleton rows={5} />;

  const byScenario = project.scenarios
    .map((s) => ({ scenario: s, items: runs.filter((r) => r.scenario.id === s.id) }))
    .filter((g) => g.items.length > 0);

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link>{" / "}
        <Link href={`/project/?id=${project.id}`} className="hover:text-pigui-700">{project.name}</Link>
        {" / "}Comparar runs
      </nav>
      <SectionTitle
        title="Comparación de escenarios"
        subtitle="Selecciona entre 2 y 5 runs exitosos; el servidor calcula los deltas contra el baseline y advierte cuando la comparación no es directa."
        right={
          project.scenarios.length > 0 ? (
            <select
              className={`${inputClass} !w-auto`}
              value={scenarioId}
              onChange={(e) => router.replace(`/compare/?project=${project.id}&scenario=${e.target.value}`)}
            >
              {project.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          ) : undefined
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg border border-slate-200 bg-white p-1">
        {ANALYSIS_TABS.map((t) => (
          <Link
            key={t.path}
            href={`${t.path}?project=${projectId}&scenario=${scenarioId}`}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${
              t.path === "/compare/" ? "bg-pigui-600 text-white" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {byScenario.length === 0 ? (
        <EmptyState
          title="Todavía no hay runs exitosos"
          description="Ejecuta al menos dos simulaciones (en el mismo escenario o en escenarios distintos) para poder compararlas."
          action={<Button href={`/simulate/?project=${projectId}&scenario=${scenarioId}`}>Ejecutar simulación</Button>}
        />
      ) : (
        <Card className="mb-4">
          <CardBody className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-800">Runs disponibles</p>
                <p className="text-xs text-slate-500">
                  El orden de selección importa: el primero que marques es el baseline de la comparación.
                </p>
              </div>
              <Badge tone={selected.length >= MAX_RUNS ? "queued" : "default"}>
                {selected.length} / {MAX_RUNS} seleccionados
              </Badge>
            </div>
            {selected.length >= MAX_RUNS && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
                Máximo {MAX_RUNS} runs por comparación para que la tabla siga siendo legible. Desmarca alguno
                para elegir otro.
              </p>
            )}

            {byScenario.map((group) => (
              <div key={group.scenario.id}>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {group.scenario.name} · {group.scenario.type}
                </p>
                <div className="space-y-1.5">
                  {group.items.map(({ run }) => {
                    const idx = selected.indexOf(run.id);
                    const checked = idx >= 0;
                    const disabled = !checked && selected.length >= MAX_RUNS;
                    return (
                      <label
                        key={run.id}
                        className={`flex flex-wrap items-center gap-3 rounded-lg border p-3 ${
                          checked ? "border-pigui-300 bg-pigui-50/40" : "border-slate-200 bg-white"
                        } ${disabled ? "opacity-60" : "cursor-pointer"}`}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-pigui-600"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggle(run.id)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-slate-800">
                            {group.scenario.name} · {fmtDate(run.finished_at ?? run.created_at)}
                          </span>
                          <span className="block font-mono text-[11px] text-slate-400">
                            run {run.id.slice(0, 8)} · hash {(run.output_hash ?? run.input_hash).slice(0, 12)} ·
                            motor v{run.engine_version} · {run.horizon_months} meses
                          </span>
                        </span>
                        {checked && (
                          <Badge tone={idx === 0 ? "declarado" : "default"}>
                            {idx === 0 ? "Baseline" : `Comparado #${idx + 1}`}
                          </Badge>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <p className="text-xs text-slate-500">
                {selected.length < MIN_RUNS
                  ? `Selecciona al menos ${MIN_RUNS} runs para comparar.`
                  : `Comparando ${selected.length} runs contra el baseline seleccionado.`}
              </p>
              <div className="flex items-center gap-2">
                {selected.length > 0 && (
                  <Button variant="secondary" onClick={() => { setSelected([]); setResult(null); }}>
                    Limpiar selección
                  </Button>
                )}
                <Button onClick={compare} disabled={selected.length < MIN_RUNS || comparing}>
                  {comparing ? "Comparando…" : "Comparar"}
                </Button>
              </div>
            </div>
            {compareError && <p className="text-sm font-medium text-rose-600">{compareError}</p>}
          </CardBody>
        </Card>
      )}

      {result && (
        <div className="space-y-5">
          {result.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <p className="font-semibold">Advertencias del servidor sobre esta comparación</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          <Card>
            <div className="border-b border-slate-100 px-5 py-3">
              <p className="text-sm font-semibold text-slate-800">KPIs comparados</p>
              <p className="text-xs text-slate-500">
                El baseline es la primera columna; las demás muestran su valor con el delta absoluto y relativo
                calculados por el servidor.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-5 py-3">KPI</th>
                    {result.runs.map((r, i) => (
                      <th key={r.id} className="px-3 py-3 text-right">
                        <span className="block normal-case text-slate-700">{r.label}</span>
                        <span className="block font-mono text-[10px] normal-case text-slate-400">
                          {r.id.slice(0, 8)} · v{r.engine_version}
                        </span>
                        <span className="block text-[10px] normal-case text-slate-400">
                          {i === 0 ? "baseline" : `comparado #${i + 1}`}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.kpis.map((k) => (
                    <tr key={k.key} className="border-b border-slate-100 last:border-0">
                      <td className="px-5 py-2.5">
                        <p className="font-medium text-slate-800">{k.label}</p>
                        <p className="font-mono text-[11px] text-slate-400">{k.key}</p>
                      </td>
                      {result.runs.map((r) => {
                        const v = k.values.find((x) => x.run_id === r.id);
                        const delta = v?.delta ? parseFloat(v.delta) : null;
                        const tone = delta === null || delta === 0 ? "text-slate-400"
                          : delta > 0 ? "text-emerald-700" : "text-rose-600";
                        return (
                          <td key={r.id} className="px-3 py-2.5 text-right">
                            <span className="block text-slate-800">{fmtKpi(k.key, v?.value)}</span>
                            {v?.delta !== undefined && (
                              <span className={`block text-xs font-medium ${tone}`}>
                                {delta !== null && delta > 0 ? "+" : ""}{fmtKpi(k.key, v.delta)}
                                {v.delta_pct != null && ` (${parseFloat(v.delta_pct) > 0 ? "+" : ""}${pct(v.delta_pct, 1)})`}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {chartData.length > 0 && (
            <Card>
              <CardBody>
                <p className="mb-3 text-sm font-semibold text-slate-800">KPIs clave por run</p>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={chartData}>
                    <XAxis dataKey="kpi" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => money(v, currency, true)} width={80} />
                    <Tooltip formatter={(v: number) => money(v, currency)} />
                    <Legend />
                    <ReferenceLine y={0} stroke="#cbd5e1" />
                    {result.runs.map((r, i) => (
                      <Bar key={r.id} dataKey={runNames[r.id] ?? r.id}
                        fill={SERIES_COLORS[i % SERIES_COLORS.length]} radius={[3, 3, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </CardBody>
            </Card>
          )}

          <Card>
            <div className="border-b border-slate-100 px-5 py-3">
              <p className="text-sm font-semibold text-slate-800">Supuestos que difieren</p>
              <p className="text-xs text-slate-500">
                Solo los supuestos con al menos un valor distinto entre los snapshots comparados; se resalta lo
                que cambia respecto al baseline.
              </p>
            </div>
            {result.assumption_diffs.length === 0 ? (
              <CardBody>
                <p className="py-6 text-center text-sm text-slate-400">
                  Los runs comparados usan exactamente los mismos supuestos.
                </p>
              </CardBody>
            ) : (
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="bg-white px-5 py-3">Supuesto</th>
                      {result.runs.map((r, i) => (
                        <th key={r.id} className="bg-white px-3 py-3 text-right">
                          <span className="block normal-case text-slate-700">{r.label}</span>
                          <span className="block text-[10px] normal-case text-slate-400">
                            {i === 0 ? "baseline" : r.id.slice(0, 8)}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.assumption_diffs.map((d) => {
                      const baseValue = d.values.find((v) => v.run_id === result.runs[0]?.id)?.value ?? null;
                      return (
                        <tr key={d.key} className="border-b border-slate-100 last:border-0">
                          <td className="px-5 py-2 font-mono text-xs text-slate-700">{d.key}</td>
                          {result.runs.map((r, i) => {
                            const v = d.values.find((x) => x.run_id === r.id);
                            const changed = i > 0 && v?.value !== baseValue;
                            return (
                              <td key={r.id}
                                className={`px-3 py-2 text-right font-mono text-xs ${
                                  changed ? "font-semibold text-pigui-700" : "text-slate-600"
                                }`}>
                                {v?.value ?? "—"}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <p className="text-xs text-slate-400">
            El baseline es el primer run seleccionado; los deltas y advertencias los calcula el servidor.
          </p>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><CompareRuns /></Suspense>;
}
