"use client";
/** Pantallas 24–30 (fase 4) — Cohortes B2C: retención por antigüedad, matriz y LTV.
 *  Ruta estática: /cohorts?project=&scenario= */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend,
} from "recharts";
import { api, ApiError, Assumption, GrowthPreview, Project } from "@/lib/api";
import { money, monthName, num, pct } from "@/lib/format";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, KpiCard, SectionTitle, Skeleton, inputClass,
} from "@/components/ui";

const GROWTH_TABS: { label: string; path: string }[] = [
  { label: "Adquisición B2B", path: "/growth-b2b/" },
  { label: "Adopción B2C", path: "/growth-b2c/" },
  { label: "Cohortes", path: "/cohorts/" },
];

const COHORT_KEYS = [
  "b2c.cohort.enabled",
  "b2c.cohort.retention_m1",
  "b2c.cohort.retention_stable",
  "b2c.cohort.retention_ramp",
  "b2c.cohort.maturation_months",
  "b2c.cohort.initial_activity_factor",
  "b2c.cohort.ltv_horizon_months",
];

const MAX_VISIBLE_MONTHS = 24;

function CohortsScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";
  const sid = params.get("scenario") ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [preview, setPreview] = useState<GrowthPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noProjects, setNoProjects] = useState(false);
  const [showAllMonths, setShowAllMonths] = useState(false);

  // Editor de supuestos: patrón exacto de assumptions/page.tsx (dirty-tracking + PATCH batch).
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Sin query params: resuelve el primer proyecto/escenario disponible o muestra vacío.
  useEffect(() => {
    if (projectId && sid) return;
    api.get<Project[]>("/projects")
      .then((ps) => {
        const p = ps.find((x) => x.id === projectId) ?? ps[0];
        if (p && p.scenarios[0]) {
          router.replace(`/cohorts/?project=${p.id}&scenario=${p.scenarios[0].id}`);
        } else {
          setNoProjects(true);
        }
      })
      .catch((e) => setError(String((e as Error).message)));
  }, [projectId, sid, router]);

  const load = useCallback(() => {
    if (!projectId || !sid) return;
    setError(null);
    setPreview(null);
    Promise.all([
      api.get<Project>(`/projects/${projectId}`),
      api.get<GrowthPreview>(`/projects/${projectId}/scenarios/${sid}/growth-preview`),
    ])
      .then(([p, gp]) => { setProject(p); setPreview(gp); })
      .catch((e) => setError(String((e as Error).message)));
  }, [projectId, sid]);
  useEffect(load, [load]);
  // al cambiar de escenario se descartan los cambios pendientes del editor
  useEffect(() => { setEdits({}); setSaveError(null); }, [sid]);

  const dirty = Object.keys(edits).length > 0;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch<{ assumptions: Assumption[] }>(`/scenarios/${sid}/assumptions`, {
        changes: edits, source_type: "hipotesis", actor: "usuario",
      });
      setEdits({});
      setSavedAt(new Date().toLocaleTimeString("es-MX"));
      load(); // el preview se recalcula en el servidor con el snapshot vigente
    } catch (e) {
      setSaveError(e instanceof ApiError ? String(e.message) : String(e));
    } finally {
      setSaving(false);
    }
  };

  const enableCohorts = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch<{ assumptions: Assumption[] }>(`/scenarios/${sid}/assumptions`, {
        changes: { "b2c.cohort.enabled": "true" }, source_type: "hipotesis", actor: "usuario",
      });
      load();
    } catch (e) {
      setSaveError(e instanceof ApiError ? String(e.message) : String(e));
    } finally {
      setSaving(false);
    }
  };

  const retentionData = useMemo(() => {
    if (!preview) return [];
    return preview.retention_curve.map((p) => ({
      age: p.age,
      "Retención mensual": parseFloat(p.retention),
      "Supervivencia acumulada": parseFloat(p.survival),
      "Factor de actividad": parseFloat(p.activity_factor),
    }));
  }, [preview]);

  const cohortAssumptions = useMemo(() => {
    if (!preview) return [];
    return COHORT_KEYS.flatMap((k) => {
      const a = preview.assumptions[k];
      return a ? [{ key: k, ...a }] : [];
    });
  }, [preview]);

  if (!projectId || !sid) {
    if (noProjects) {
      return (
        <EmptyState
          title="Sin proyectos"
          description="Crea un proyecto con al menos un escenario para explorar el modelo de cohortes B2C."
          action={<Button href="/projects/new">+ Nuevo proyecto</Button>}
        />
      );
    }
    if (error) return <ErrorState message={error} />;
    return <Skeleton rows={5} />;
  }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!preview || !project) return <Skeleton rows={5} />;

  const currency = project.base_currency;
  const truncated = preview.months.length > MAX_VISIBLE_MONTHS && !showAllMonths;
  const visibleMonths = truncated ? preview.months.slice(0, MAX_VISIBLE_MONTHS) : preview.months;
  const retM1 = preview.assumptions["b2c.cohort.retention_m1"];
  const retStable = preview.assumptions["b2c.cohort.retention_stable"];

  const setEdit = (key: string, v: string, original: string) => {
    setEdits((prev) => {
      const next = { ...prev };
      if (v === original) delete next[key];
      else next[key] = v;
      return next;
    });
  };

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link>{" / "}
        <Link href={`/project/?id=${project.id}`} className="hover:text-pigui-700">{project.name}</Link>
        {" / Cohortes"}
      </nav>
      <SectionTitle
        title="Cohortes B2C"
        subtitle="Retención por antigüedad, supervivencia de cohortes y LTV por consumidor. Vista previa determinística calculada por el motor."
        right={
          <select
            className={`${inputClass} !w-auto`}
            value={sid}
            onChange={(e) => router.replace(`/cohorts/?project=${projectId}&scenario=${e.target.value}`)}
          >
            {project.scenarios.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        }
      />

      <div className="mb-5 flex w-fit gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {GROWTH_TABS.map((t) =>
          t.path === "/cohorts/" ? (
            <span key={t.path} className="whitespace-nowrap rounded-md bg-pigui-600 px-3 py-1.5 text-sm text-white">
              {t.label}
            </span>
          ) : (
            <Link key={t.path} href={`${t.path}?project=${projectId}&scenario=${sid}`}
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
              {t.label}
            </Link>
          )
        )}
      </div>

      {!preview.cohorts_enabled ? (
        <>
          {saveError && <p className="mb-3 text-sm font-medium text-rose-600">{saveError}</p>}
          <EmptyState
            title="El modelo de cohortes B2C está desactivado"
            description={
              "Con cohortes activas, el churn plano de consumidores se sustituye por una curva de retención por antigüedad: " +
              "cada cohorte mensual decae según su edad hasta la retención madura. Activarlas cambia los resultados de las " +
              "nuevas simulaciones de este escenario (las ejecutadas no se modifican)."
            }
            action={
              <Button onClick={enableCohorts} disabled={saving}>
                {saving ? "Activando…" : "Activar cohortes"}
              </Button>
            }
          />
        </>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard
              label="LTV por cohorte"
              value={preview.ltv_b2c ? money(preview.ltv_b2c, currency) : "—"}
              tone={preview.ltv_b2c ? "default" : "muted"}
              hint="Comisión esperada de Pigui por consumidor nuevo"
            />
            <KpiCard
              label="Retención mes 1"
              value={retM1 ? pct(retM1.value) : "—"}
              hint="Consumidores que siguen activos tras su primer mes"
            />
            <KpiCard
              label="Retención madura"
              value={retStable ? pct(retStable.value) : "—"}
              hint="Retención mensual de cohortes ya maduras"
            />
            <KpiCard
              label="Cohortes vivas"
              value={preview.cohorts.length}
              hint="Cohortes con actividad dentro del horizonte"
            />
          </div>

          <Card><CardBody>
            <p className="mb-3 text-sm font-semibold text-slate-800">Curva de retención por antigüedad</p>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={retentionData}>
                  <XAxis dataKey="age" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => pct(v, 0)} width={44} domain={[0, 1]} />
                  <Tooltip formatter={(v: number) => pct(v)} labelFormatter={(age) => `Antigüedad: ${age} meses`} />
                  <Legend />
                  <Line dataKey="Retención mensual" stroke="#713dff" dot={false} strokeWidth={2} />
                  <Line dataKey="Supervivencia acumulada" stroke="#10b981" dot={false} strokeWidth={2} />
                  <Line dataKey="Factor de actividad" stroke="#0ea5e9" dot={false} strokeWidth={2} strokeDasharray="4 3" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Eje X: antigüedad de la cohorte en meses. La retención de rampa converge a la retención madura al completar la maduración.
            </p>
          </CardBody></Card>

          <div>
            <SectionTitle
              title="Matriz de cohortes"
              subtitle={`Tamaño de cada cohorte mes a mes${truncated ? ` · mostrando ${MAX_VISIBLE_MONTHS} de ${preview.months.length} meses` : ""}`}
              right={
                preview.months.length > MAX_VISIBLE_MONTHS ? (
                  <Button variant="secondary" onClick={() => setShowAllMonths((v) => !v)} className="!px-3 !py-1.5">
                    {showAllMonths ? "Ver menos" : "Ver todo"}
                  </Button>
                ) : undefined
              }
            />
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="min-w-max text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="sticky left-0 z-10 bg-slate-50 px-4 py-2.5 text-left font-semibold text-slate-600">
                      Cohorte
                    </th>
                    <th className="px-2.5 py-2.5 text-right font-medium text-slate-500">Tamaño inicial</th>
                    {visibleMonths.map((m, i) => (
                      <th key={m}
                        className={`px-2.5 py-2.5 text-right font-medium text-slate-500 ${(i + 1) % 12 === 0 ? "border-r border-slate-200" : ""}`}>
                        {monthName(m)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.cohorts.map((c) => {
                    const initial = parseFloat(c.initial_size);
                    return (
                      <tr key={c.cohort_month} className="border-b border-slate-100 last:border-0">
                        <td className="sticky left-0 z-10 bg-white px-4 py-2 text-left font-medium text-slate-800">
                          {c.cohort_month <= 0 ? "inicial" : c.cohort_label}
                        </td>
                        <td className="px-2.5 py-2 text-right font-semibold tabular-nums text-slate-700">
                          {num(c.initial_size, 0)}
                        </td>
                        {visibleMonths.map((m, i) => {
                          const v = c.sizes[i];
                          if (v === null || v === undefined) {
                            return <td key={m} className={(i + 1) % 12 === 0 ? "border-r border-slate-100" : ""} />;
                          }
                          const n = parseFloat(v);
                          // Proporción visual size/initial (solo presentación; el motor calcula los valores).
                          const ratio = initial > 0 ? Math.max(0, Math.min(1, n / initial)) : 0;
                          return (
                            <td key={m}
                              className={`px-2.5 py-2 text-right tabular-nums ${(i + 1) % 12 === 0 ? "border-r border-slate-100" : ""}`}
                              style={{
                                backgroundColor: `rgba(113, 61, 255, ${(0.06 + 0.7 * ratio).toFixed(3)})`,
                                color: ratio > 0.55 ? "#ffffff" : "#1e293b",
                              }}>
                              {n.toLocaleString("es-MX", { maximumFractionDigits: 0 })}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  {preview.cohorts.length === 0 && (
                    <tr>
                      <td colSpan={visibleMonths.length + 2} className="px-5 py-8 text-center text-sm text-slate-400">
                        Sin cohortes en el horizonte. Revisa los supuestos de adopción B2C.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <SectionTitle
              title="Supuestos de cohortes"
              subtitle="Ediciones al alcance del escenario. Cada cambio crea una nueva versión (nunca sobrescribe)."
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
              <table className="w-full text-sm">
                <tbody>
                  {cohortAssumptions.map((a) => {
                    const value = edits[a.key] ?? a.value;
                    const changed = a.key in edits;
                    return (
                      <tr key={a.key} className="border-b border-slate-50 last:border-0">
                        <td className="px-5 py-2.5">
                          <p className="font-medium text-slate-800">{a.description || a.key}</p>
                          <p className="font-mono text-[11px] text-slate-400">{a.key}{a.unit && ` · ${a.unit}`}</p>
                        </td>
                        <td className="w-28 px-3 py-2.5">
                          <Badge tone={a.origin === "escenario" ? "hipotesis" : a.origin === "proyecto" ? "declarado" : "default"}>
                            {a.origin}
                          </Badge>
                        </td>
                        <td className="w-44 px-3 py-2.5">
                          {a.key === "b2c.cohort.enabled" ? (
                            <select
                              className={`${inputClass} ${changed ? "!border-pigui-500 !ring-1 !ring-pigui-500" : ""}`}
                              value={value}
                              onChange={(e) => setEdit(a.key, e.target.value, a.value)}
                            >
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>
                          ) : (
                            <input
                              className={`${inputClass} ${changed ? "!border-pigui-500 !ring-1 !ring-pigui-500" : ""}`}
                              value={value}
                              onChange={(e) => setEdit(a.key, e.target.value, a.value)}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          </div>

          <p className="text-xs text-slate-400">
            La matriz proviene del motor en el servidor: vista previa determinística del snapshot vigente de supuestos
            (hash {preview.input_hash.slice(0, 12)}… · motor v{preview.engine_version}). Las simulaciones formales e
            inmutables se ejecutan desde &quot;Simular&quot;.
          </p>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><CohortsScreen /></Suspense>;
}
