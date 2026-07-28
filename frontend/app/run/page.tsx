"use client";
/** Resultados del run — pantallas 53, 56–60, 64–70 y export 72. Ruta estática: /run?project=&id= */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, Legend, ReferenceLine,
} from "recharts";
import { api, API_URL, Project, Run, RunResults } from "@/lib/api";
import { money, num, monthName } from "@/lib/format";
import MetricTable, { MetricRowDef } from "@/components/MetricTable";
import { Button, Card, CardBody, EmptyState, ErrorState, KpiCard, SectionTitle, Skeleton } from "@/components/ui";

const TABS = ["Dashboard", "Plan mensual", "P&L", "Flujo de efectivo", "Unit economics"] as const;

const ALL_KEYS = [
  "b2b.clients_end", "b2b.adds_activated", "b2b.churned", "b2b.reactivated", "b2b.clients_avg",
  "b2c.consumers_end", "b2c.buyers", "b2c.transactions",
  "tx.gmv", "tx.eligible_utility", "tx.business_net",
  "rev.commission", "rev.subscriptions", "rev.tokens", "rev.subscribers",
  "points.emitted", "points.redeemed", "points.expired", "points.balance_end",
  "cash.collected_immediate", "ar.new", "ar.collections", "ar.writeoffs", "ar.balance_end",
  "cost.variable_items", "cost.tokens", "cost.fixed", "cost.acquisition",
  "pnl.revenue", "pnl.variable_costs", "pnl.gross_margin", "pnl.contribution_margin",
  "pnl.opex", "pnl.ebitda", "pnl.ebitda_margin",
  "cash.in_total", "cash.out_total", "cash.net", "cash.points_paid_out", "cash.balance_end",
  "ue.arpa", "ue.cm_per_client", "ue.cac", "ue.ltv", "ue.ltv_cac", "ue.payback_months", "ue.take_rate",
  "kpi.burn_net", "kpi.runway_months",
].join(",");

const PLAN_ROWS: MetricRowDef[] = [
  { label: "Clientes B2B al cierre", key: "b2b.clients_end", kind: "count", strong: true },
  { label: "Altas activadas", key: "b2b.adds_activated", kind: "count" },
  { label: "Churn B2B", key: "b2b.churned", kind: "count" },
  { label: "Reactivados", key: "b2b.reactivated", kind: "count" },
  { label: "Consumidores activos", key: "b2c.consumers_end", kind: "count", strong: true },
  { label: "Compradores", key: "b2c.buyers", kind: "count" },
  { label: "Transacciones", key: "b2c.transactions", kind: "count" },
  { label: "GMV", key: "tx.gmv", strong: true },
  { label: "Utilidad elegible", key: "tx.eligible_utility" },
  { label: "Comisión Pigui (25%)", key: "rev.commission" },
  { label: "Puntos emitidos (5%)", key: "points.emitted" },
  { label: "Utilidad del negocio (70%)", key: "tx.business_net" },
  { label: "Ingresos Pigui", key: "pnl.revenue", strong: true },
  { label: "EBITDA", key: "pnl.ebitda", strong: true },
  { label: "Caja al cierre", key: "cash.balance_end", strong: true },
];

const PNL_ROWS: MetricRowDef[] = [
  { label: "Comisiones", key: "rev.commission" },
  { label: "Suscripciones", key: "rev.subscriptions" },
  { label: "IA / tokens", key: "rev.tokens" },
  { label: "Ingresos totales", key: "pnl.revenue", strong: true },
  { label: "Costos variables", key: "pnl.variable_costs" },
  { label: "Margen bruto", key: "pnl.gross_margin", strong: true },
  { label: "Contribution margin", key: "pnl.contribution_margin" },
  { label: "OPEX (fijos + adquisición)", key: "pnl.opex" },
  { label: "EBITDA", key: "pnl.ebitda", strong: true },
  { label: "Margen EBITDA", key: "pnl.ebitda_margin", kind: "pct" },
];

const CASH_ROWS: MetricRowDef[] = [
  { label: "Cobro inmediato (Stripe)", key: "cash.collected_immediate" },
  { label: "Cobranza AR", key: "ar.collections" },
  { label: "Entradas totales", key: "cash.in_total", strong: true },
  { label: "Salidas totales", key: "cash.out_total", strong: true },
  { label: "Redenciones de puntos pagadas", key: "cash.points_paid_out" },
  { label: "Flujo neto", key: "cash.net", strong: true },
  { label: "Caja al cierre", key: "cash.balance_end", strong: true },
  { label: "AR nueva", key: "ar.new" },
  { label: "AR saldo", key: "ar.balance_end" },
  { label: "Incobrables", key: "ar.writeoffs" },
  { label: "Saldo de puntos (pasivo)", key: "points.balance_end" },
];

const UE_ROWS: MetricRowDef[] = [
  { label: "ARPA", key: "ue.arpa" },
  { label: "CM por cliente", key: "ue.cm_per_client" },
  { label: "CAC", key: "ue.cac" },
  { label: "LTV", key: "ue.ltv" },
  { label: "LTV / CAC", key: "ue.ltv_cac", kind: "ratio", strong: true },
  { label: "Payback (meses)", key: "ue.payback_months", kind: "ratio" },
  { label: "Take rate sobre GMV", key: "ue.take_rate", kind: "pct" },
  { label: "Burn neto", key: "kpi.burn_net" },
  { label: "Runway (meses)", key: "kpi.runway_months", kind: "ratio" },
];

function RunResultsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";
  const runId = params.get("id") ?? "";
  const initialTab = TABS.find((t) => t === params.get("tab")) ?? "Dashboard";
  const [data, setData] = useState<RunResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noRun, setNoRun] = useState(false);
  const [tab, setTab] = useState<(typeof TABS)[number]>(initialTab);
  const [exporting, setExporting] = useState(false);
  const [exportJob, setExportJob] = useState<{ id: string; file_name: string } | null>(null);

  const load = useCallback(() => {
    if (!runId) return;
    api.get<RunResults>(`/simulation-runs/${runId}/results?keys=${ALL_KEYS}`)
      .then(setData)
      .catch((e) => setError(String(e.message)));
  }, [runId]);
  useEffect(load, [load]);

  // Sin run en la URL (entrada desde el menú): resuelve el último run exitoso
  // del primer escenario del proyecto, o del primer proyecto disponible.
  useEffect(() => {
    if (runId) return;
    const tabQs = params.get("tab") ? `&tab=${encodeURIComponent(params.get("tab") as string)}` : "";
    api.get<Project[]>("/projects")
      .then(async (list) => {
        const project = list.find((p) => p.id === projectId) ?? list[0];
        if (!project || project.scenarios.length === 0) { setNoRun(true); return; }
        for (const scenario of project.scenarios) {
          const runs = await api.get<Run[]>(`/scenarios/${scenario.id}/runs`);
          const ok = runs.find((r) => r.status === "succeeded");
          if (ok) { router.replace(`/run/?project=${project.id}&id=${ok.id}${tabQs}`); return; }
        }
        setNoRun(true);
      })
      .catch((e) => setError(String((e as Error).message)));
  }, [runId, projectId, params, router]);

  const doExport = async (format: "xlsx" | "doc" = "xlsx") => {
    setExporting(true);
    try {
      const job = await api.post<{ id: string; file_name: string }>(
        "/exports", { run_id: runId, format });
      setExportJob(job);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setExporting(false);
    }
  };

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.months.map((m, i) => ({
      mes: monthName(m),
      Ingresos: parseFloat(data.metrics["pnl.revenue"]?.[i] ?? "0"),
      EBITDA: parseFloat(data.metrics["pnl.ebitda"]?.[i] ?? "0"),
      Caja: parseFloat(data.metrics["cash.balance_end"]?.[i] ?? "0"),
    }));
  }, [data]);

  if (!runId) {
    if (noRun) {
      return (
        <EmptyState
          title="Aún no hay resultados"
          description="El business plan y el dashboard ejecutivo se construyen sobre una simulación. Ejecuta una para verlos."
          action={<Button href="/">Ir a proyectos</Button>}
        />
      );
    }
    if (error) return <ErrorState message={error} />;
    return <Skeleton rows={6} />;
  }
  if (error && !data) return <ErrorState message={error} onRetry={() => { setError(null); load(); }} />;
  if (!data) return <Skeleton rows={6} />;

  const { run, months, metrics } = data;
  const summary = run.summary!;
  const currency = data.project.base_currency;
  const y1 = summary.annual[0];

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href={`/project/?id=${projectId}`} className="hover:text-pigui-700">Proyecto</Link> / Resultados del run
      </nav>
      <SectionTitle
        title={`Resultados — ${data.scenario.name}`}
        subtitle={`Run ${run.id.slice(0, 12)}… · motor v${run.engine_version} · hash ${run.output_hash?.slice(0, 12)}… · ${months.length} meses desde ${data.project.start_month}`}
        right={
          <div className="flex items-center gap-2">
            {exportJob ? (
              <a className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                href={`${API_URL}/exports/${exportJob.id}/download`}>
                Descargar {exportJob.file_name}
              </a>
            ) : (
              <>
                <Button onClick={() => doExport("xlsx")} disabled={exporting}>
                  {exporting ? "Generando…" : "Exportar a Excel"}
                </Button>
                <Button variant="secondary" onClick={() => doExport("doc")} disabled={exporting}>
                  Documento ejecutivo
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg border border-slate-200 bg-white p-1">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${tab === t ? "bg-pigui-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === "Dashboard" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label="Ingresos año 1" value={money(y1.revenue, currency, true)} />
            <KpiCard label="EBITDA año 1" value={money(y1.ebitda, currency, true)}
              tone={parseFloat(y1.ebitda) >= 0 ? "good" : "bad"} />
            <KpiCard label="Punto de equilibrio"
              value={summary.breakeven_label ?? "No alcanzado"}
              tone={summary.breakeven_label ? "good" : "bad"}
              hint={summary.breakeven_month ? `Mes ${summary.breakeven_month}` : "EBITDA nunca ≥ 0 en el horizonte"} />
            <KpiCard label="Necesidad de capital" value={money(summary.funding_need, currency, true)}
              hint={`Caja mínima: ${money(summary.min_cash, currency, true)}`} />
            <KpiCard label="Clientes al cierre" value={num(summary.final_clients, 0)} />
            <KpiCard label="Consumidores al cierre" value={num(summary.final_consumers, 0)} />
            <KpiCard label="Caja final" value={money(summary.final_cash, currency, true)}
              tone={parseFloat(summary.final_cash) >= 0 ? "good" : "bad"} />
            <KpiCard label="LTV/CAC (último mes)"
              value={metrics["ue.ltv_cac"]?.[months.length - 1] ? num(metrics["ue.ltv_cac"][months.length - 1], 2) : "N/A"} />
          </div>

          <Card><CardBody>
            <p className="mb-3 text-sm font-semibold text-slate-800">Ingresos, EBITDA y caja</p>
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={chartData}>
                <XAxis dataKey="mes" tick={{ fontSize: 10 }} interval={Math.ceil(months.length / 16)} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => money(v, currency, true)} width={80} />
                <Tooltip formatter={(v: number) => money(v, currency)} />
                <Legend />
                <ReferenceLine y={0} stroke="#cbd5e1" />
                <Bar dataKey="Ingresos" fill="#713dff" radius={[3, 3, 0, 0]} />
                <Bar dataKey="EBITDA" fill="#10b981" radius={[3, 3, 0, 0]} />
                <Line dataKey="Caja" stroke="#0ea5e9" dot={false} strokeWidth={2} />
              </ComposedChart>
            </ResponsiveContainer>
          </CardBody></Card>

          <Card>
            <div className="border-b border-slate-100 px-5 py-3">
              <p className="text-sm font-semibold text-slate-800">Resumen anual (pantalla 58)</p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="px-5 py-2.5">Año</th>
                  <th className="px-3 py-2.5 text-right">Ingresos</th>
                  <th className="px-3 py-2.5 text-right">GMV</th>
                  <th className="px-3 py-2.5 text-right">EBITDA</th>
                  <th className="px-3 py-2.5 text-right">Clientes</th>
                  <th className="px-3 py-2.5 text-right">Consumidores</th>
                  <th className="px-3 py-2.5 text-right">Caja cierre</th>
                </tr>
              </thead>
              <tbody>
                {summary.annual.map((y) => (
                  <tr key={y.year} className="border-b border-slate-100 last:border-0">
                    <td className="px-5 py-2.5 font-medium">Año {y.year}</td>
                    <td className="px-3 py-2.5 text-right">{money(y.revenue, currency, true)}</td>
                    <td className="px-3 py-2.5 text-right">{money(y.gmv, currency, true)}</td>
                    <td className={`px-3 py-2.5 text-right ${parseFloat(y.ebitda) < 0 ? "text-rose-600" : "text-emerald-700"}`}>
                      {money(y.ebitda, currency, true)}
                    </td>
                    <td className="px-3 py-2.5 text-right">{num(y.clients_end, 0)}</td>
                    <td className="px-3 py-2.5 text-right">{num(y.consumers_end, 0)}</td>
                    <td className="px-3 py-2.5 text-right">{money(y.cash_end, currency, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {run.bottlenecks && (
            <Card><CardBody>
              <p className="mb-2 text-sm font-semibold text-slate-800">Restricciones de crecimiento (pantalla 30)</p>
              <p className="text-xs text-slate-500">
                Meses limitados por presupuesto: {run.bottlenecks.filter((b) => b.restriccion_activa === "presupuesto").length} ·
                por capacidad de onboarding: {run.bottlenecks.filter((b) => b.restriccion_activa === "capacidad_onboarding").length} ·
                por curva objetivo: {run.bottlenecks.filter((b) => b.restriccion_activa === "curva").length}
              </p>
              {Object.keys(summary.derived_inputs).length > 0 && (
                <div className="mt-3 rounded-lg bg-orange-50 p-3 text-xs text-orange-800">
                  <p className="font-semibold">Valores derivados del portafolio (dato estimado):</p>
                  {Object.entries(summary.derived_inputs).map(([k, v]) => (
                    <p key={k} className="mt-0.5 font-mono">{k}: {v.from ?? "—"} → {v.to} ({v.source})</p>
                  ))}
                </div>
              )}
            </CardBody></Card>
          )}
        </div>
      )}

      {tab === "Plan mensual" && (
        <MetricTable months={months} metrics={metrics} rows={PLAN_ROWS} currency={currency} />
      )}
      {tab === "P&L" && (
        <MetricTable months={months} metrics={metrics} rows={PNL_ROWS} currency={currency} />
      )}
      {tab === "Flujo de efectivo" && (
        <MetricTable months={months} metrics={metrics} rows={CASH_ROWS} currency={currency} />
      )}
      {tab === "Unit economics" && (
        <div className="space-y-4">
          {run.summary?.ltv_b2c && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <KpiCard label="LTV B2C por cohorte" value={money(run.summary.ltv_b2c, currency)}
                hint="Comisión esperada de Pigui por consumidor nuevo (retención por cohortes)" />
            </div>
          )}
          <MetricTable months={months} metrics={metrics} rows={UE_ROWS} currency={currency} />
          <p className="text-xs text-slate-400">
            LTV (B2B) = CM mensual por cliente ÷ churn. {run.summary?.ltv_b2c
              ? "El LTV B2C por cohorte usa la retención por antigüedad (fase 4)."
              : "Con cohortes activas (fase 4) se calcula además el LTV B2C por cohorte."} “—” significa
            no alcanzable/no calculable ese mes (p. ej. margen ≤ 0), según la especificación 5.6.
          </p>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={6} />}><RunResultsPage /></Suspense>;
}
