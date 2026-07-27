"use client";
/** Pantallas 24–27 — Adquisición B2B (fase 4). Ruta estática: /growth-b2b?project=&scenario= */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
} from "recharts";
import { api, ApiError, Assumption, GrowthPreview, Project } from "@/lib/api";
import { money, num, monthName } from "@/lib/format";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, KpiCard, SectionTitle, Skeleton, inputClass,
} from "@/components/ui";

const GROWTH_TABS = [
  { label: "Adquisición B2B", path: "/growth-b2b/" },
  { label: "Adopción B2C", path: "/growth-b2c/" },
  { label: "Cohortes", path: "/cohorts/" },
] as const;

const CURVE_TYPES = ["linear", "exponential", "logistic", "decelerated"] as const;

const EDITABLE: { key: string; label: string; type?: "select" }[] = [
  { key: "b2b.curve.type", label: "Tipo de curva", type: "select" },
  { key: "b2b.curve.max_clients", label: "Techo de la curva (clientes)" },
  { key: "b2b.curve.rate", label: "Tasa de la curva" },
  { key: "b2b.curve.inflection_month", label: "Mes de inflexión" },
  { key: "b2b.churn_rate", label: "Churn mensual" },
  { key: "b2b.reactivation_rate", label: "Tasa de reactivación" },
  { key: "b2b.cac", label: "CAC" },
  { key: "b2b.acquisition_budget_monthly", label: "Presupuesto mensual de adquisición" },
  { key: "b2b.onboarding_capacity_monthly", label: "Capacidad de onboarding mensual" },
];

const RESTRICTION_META: Record<string, { label: string; tone: string }> = {
  curva: { label: "Curva", tone: "default" },
  presupuesto: { label: "Presupuesto", tone: "queued" },
  capacidad_onboarding: { label: "Capacidad de onboarding", tone: "failed" },
};

function GrowthB2B() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";
  const scenarioId = params.get("scenario") ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [preview, setPreview] = useState<GrowthPreview | null>(null);
  const [noProjects, setNoProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Sin parámetros: conserva el proyecto de la URL si existe; si no, el primero disponible.
  useEffect(() => {
    if (projectId && scenarioId) return;
    api.get<Project[]>("/projects")
      .then((list) => {
        const p = list.find((x) => x.id === projectId) ?? list[0];
        if (p && p.scenarios.length > 0) {
          router.replace(`/growth-b2b/?project=${p.id}&scenario=${p.scenarios[0].id}`);
        } else {
          setNoProjects(true);
        }
      })
      .catch((e) => setError(String(e.message)));
  }, [projectId, scenarioId, router]);

  const load = useCallback(() => {
    if (!projectId || !scenarioId) return;
    setError(null);
    Promise.all([
      api.get<Project>(`/projects/${projectId}`),
      api.get<GrowthPreview>(`/projects/${projectId}/scenarios/${scenarioId}/growth-preview`),
    ])
      .then(([p, g]) => { setProject(p); setPreview(g); })
      .catch((e) => setError(String(e.message)));
  }, [projectId, scenarioId]);
  useEffect(load, [load]);
  useEffect(() => { setEdits({}); setSaveError(null); }, [scenarioId]);

  const dirty = Object.keys(edits).length > 0;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch<{ assumptions: Assumption[] }>(`/scenarios/${scenarioId}/assumptions`, {
        changes: edits, source_type: "hipotesis", actor: "usuario",
      });
      setEdits({});
      setSavedAt(new Date().toLocaleTimeString("es-MX"));
      load();
    } catch (e) {
      setSaveError(e instanceof ApiError ? String(e.message) : String(e));
    } finally {
      setSaving(false);
    }
  };

  const curveData = useMemo(() => {
    if (!preview) return [];
    return preview.months.map((m, i) => ({
      mes: monthName(m),
      "Objetivo de la curva": parseFloat(preview.metrics["b2b.target_curve"]?.[i] ?? "0"),
      "Clientes reales": parseFloat(preview.metrics["b2b.clients_end"]?.[i] ?? "0"),
    }));
  }, [preview]);

  const bottleneckData = useMemo(() => {
    if (!preview) return [];
    return preview.bottlenecks.map((b) => ({
      mes: preview.months[b.month - 1] ? monthName(preview.months[b.month - 1]) : `Mes ${b.month}`,
      "Altas deseadas": parseFloat(b.altas_deseadas),
      "Altas activadas": parseFloat(b.altas_activadas),
    }));
  }, [preview]);

  if (!projectId || !scenarioId) {
    if (noProjects) {
      return (
        <EmptyState
          title="Aún no hay proyectos"
          description="Crea tu primer proyecto para configurar la curva de adquisición B2B, su presupuesto y la capacidad de onboarding."
          action={<Button href="/projects/new/">Crear proyecto</Button>}
        />
      );
    }
    if (error) return <ErrorState message={error} />;
    return <Skeleton rows={5} />;
  }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!project || !preview) return <Skeleton rows={5} />;

  const currency = project.base_currency;
  const clientsSeries = preview.metrics["b2b.clients_end"] ?? [];
  const lastClients = [...clientsSeries].reverse().find((v) => v != null) ?? null;
  const totalAdds = preview.totals["b2b.adds_activated"] ?? null;
  const initialDerived = preview.derived_inputs["b2b.initial_clients"];

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link>{" / "}
        <Link href={`/project/?id=${project.id}`} className="hover:text-pigui-700">{project.name}</Link>
        {" / "}Adquisición B2B
      </nav>
      <SectionTitle
        title="Adquisición B2B"
        subtitle={`Curva objetivo, churn y restricciones de crecimiento · motor v${preview.engine_version}`}
        right={
          <select
            className={`${inputClass} !w-auto`}
            value={scenarioId}
            onChange={(e) => router.replace(`/growth-b2b/?project=${project.id}&scenario=${e.target.value}`)}
          >
            {project.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg border border-slate-200 bg-white p-1">
        {GROWTH_TABS.map((t) => (
          <Link
            key={t.path}
            href={`${t.path}?project=${projectId}&scenario=${scenarioId}`}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${
              t.path === "/growth-b2b/" ? "bg-pigui-600 text-white" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Clientes al final del horizonte" value={num(lastClients, 0)}
          hint={`Horizonte de ${preview.months.length} meses`} />
        <KpiCard label="Altas activadas (total)" value={num(totalAdds, 0)}
          hint="Suma de altas realmente activadas" />
        <KpiCard label="CAC" value={money(preview.assumptions["b2b.cac"]?.value, currency)}
          hint="Costo de adquisición por cliente" />
        <KpiCard label="Techo de la curva" value={num(preview.assumptions["b2b.curve.max_clients"]?.value, 0)}
          hint="Máximo de clientes de la curva" />
      </div>

      {initialDerived && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <p className="font-semibold">Stock inicial derivado del portafolio real</p>
          <p className="mt-0.5">
            El punto de partida de la curva no es un supuesto: proviene de los clientes activos cargados en el
            proyecto. <span className="font-mono">b2b.initial_clients: {initialDerived.from ?? "—"} → {initialDerived.to}</span>{" "}
            ({initialDerived.source}).
          </p>
        </div>
      )}

      <Card className="mb-6">
        <CardBody>
          <p className="mb-3 text-sm font-semibold text-slate-800">Objetivo de la curva vs clientes reales</p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={curveData}>
                <XAxis dataKey="mes" tick={{ fontSize: 10 }} interval={Math.ceil(preview.months.length / 16)} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => num(v, 0)} width={55} />
                <Tooltip formatter={(v: number) => num(v, 1)} />
                <Legend />
                <Line dataKey="Objetivo de la curva" stroke="#94a3b8" strokeDasharray="5 3" dot={false} strokeWidth={2} />
                <Line dataKey="Clientes reales" stroke="#713dff" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>

      <SectionTitle
        title="Restricciones de crecimiento (pantalla 30)"
        subtitle="Altas deseadas por la curva vs altas realmente activadas; la restricción activa explica la diferencia mes a mes."
      />
      <Card className="mb-4">
        <CardBody>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bottleneckData}>
                <XAxis dataKey="mes" tick={{ fontSize: 10 }} interval={Math.ceil(bottleneckData.length / 16)} />
                <YAxis tick={{ fontSize: 10 }} width={45} />
                <Tooltip formatter={(v: number) => num(v, 1)} />
                <Legend />
                <Bar dataKey="Altas deseadas" fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Altas activadas" fill="#713dff" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>
      <Card className="mb-8">
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="bg-white px-5 py-3">Mes</th>
                <th className="bg-white px-3 py-3 text-right">Objetivo de la curva</th>
                <th className="bg-white px-3 py-3 text-right">Altas deseadas</th>
                <th className="bg-white px-3 py-3 text-right">Altas activadas</th>
                <th className="bg-white px-3 py-3">Restricción activa</th>
              </tr>
            </thead>
            <tbody>
              {preview.bottlenecks.map((b) => {
                const meta = RESTRICTION_META[b.restriccion_activa] ?? { label: b.restriccion_activa, tone: "default" };
                return (
                  <tr key={b.month} className="border-b border-slate-100 last:border-0">
                    <td className="px-5 py-2">
                      {preview.months[b.month - 1] ? monthName(preview.months[b.month - 1]) : `Mes ${b.month}`}
                    </td>
                    <td className="px-3 py-2 text-right">{num(b.objetivo_curva, 1)}</td>
                    <td className="px-3 py-2 text-right">{num(b.altas_deseadas, 1)}</td>
                    <td className="px-3 py-2 text-right">{num(b.altas_activadas, 1)}</td>
                    <td className="px-3 py-2"><Badge tone={meta.tone}>{meta.label}</Badge></td>
                  </tr>
                );
              })}
              {preview.bottlenecks.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-sm text-slate-400">
                    Sin restricciones registradas en el horizonte.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <SectionTitle
        title="Supuestos de adquisición"
        subtitle="Los cambios se guardan como overrides del escenario (nueva versión, nunca sobrescribe) y recalculan el preview."
        right={
          <div className="flex items-center gap-2">
            {savedAt && !dirty && <span className="text-xs text-emerald-600">Guardado {savedAt}</span>}
            <Button onClick={save} disabled={!dirty || saving}>
              {saving ? "Guardando…" : `Guardar cambios${dirty ? ` (${Object.keys(edits).length})` : ""}`}
            </Button>
          </div>
        }
      />
      {saveError && <p className="mb-3 text-sm font-medium text-rose-600">{saveError}</p>}
      <Card>
        <CardBody>
          <div className="grid gap-x-4 gap-y-5 md:grid-cols-3">
            {EDITABLE.map((def) => {
              const a = preview.assumptions[def.key];
              if (!a) return null;
              const value = edits[def.key] ?? a.value;
              const changed = def.key in edits;
              const highlight = changed ? "!border-pigui-500 !ring-1 !ring-pigui-500" : "";
              const onChange = (v: string) => {
                setEdits((prev) => {
                  const next = { ...prev };
                  if (v === a.value) delete next[def.key];
                  else next[def.key] = v;
                  return next;
                });
              };
              return (
                <div key={def.key}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-700">{def.label}</span>
                    <Badge tone={a.origin === "escenario" ? "hipotesis" : a.origin === "proyecto" ? "declarado" : "default"}>
                      {a.origin}
                    </Badge>
                  </div>
                  {def.type === "select" ? (
                    <select className={`${inputClass} ${highlight}`} value={value}
                      onChange={(e) => onChange(e.target.value)}>
                      {!CURVE_TYPES.includes(value as (typeof CURVE_TYPES)[number]) && (
                        <option value={value}>{value}</option>
                      )}
                      {CURVE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  ) : (
                    <input className={`${inputClass} ${highlight}`} value={value}
                      onChange={(e) => onChange(e.target.value)} />
                  )}
                  <p className="mt-1 text-xs text-slate-400">
                    {a.description || def.key}{a.unit && ` · ${a.unit}`}
                  </p>
                  <p className="font-mono text-[11px] text-slate-400">{def.key}</p>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>
      <p className="mt-4 text-xs text-slate-400">
        Porcentajes en decimal (0.02 = 2%). El motor calcula todos los resultados en el servidor; esta pantalla
        solo edita supuestos y visualiza el preview.
      </p>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><GrowthB2B /></Suspense>;
}
