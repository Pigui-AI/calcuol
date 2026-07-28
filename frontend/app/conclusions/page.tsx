"use client";
/** Pantallas 70–71 — Conclusiones y recomendaciones (fase 7).
 *  Ruta estática: /conclusions?project=&scenario=&run=
 *  El motor propone con reglas explicables; esta pantalla acepta, edita o descarta,
 *  y siempre identifica el run del que provienen las métricas citadas. */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  api, ApiError, ConclusionEvidence, ConclusionT, ConclusionsResponse, Project, ReadinessRow, Run,
} from "@/lib/api";
import { money, num, pct, monthName, STATUS_LABELS } from "@/lib/format";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, Field, KpiCard, SectionTitle, Skeleton,
  inputClass,
} from "@/components/ui";

/** Tipos de conclusión de la pantalla 71 y su encabezado en español. */
const KINDS: { key: string; title: string; subtitle: string }[] = [
  {
    key: "hallazgo",
    title: "Hallazgos",
    subtitle: "Lo que el run muestra sobre equilibrio, capital y economía unitaria.",
  },
  {
    key: "riesgo",
    title: "Riesgos",
    subtitle: "Señales del run que comprometen el plan si no se atienden.",
  },
  {
    key: "accion",
    title: "Acciones",
    subtitle: "Palancas que el propio run identifica como limitantes del crecimiento.",
  },
];

const KIND_LABELS: Record<string, string> = {
  hallazgo: "Hallazgo", riesgo: "Riesgo", accion: "Acción", readiness: "Readiness",
};

/** alta = rojo · media = ámbar · baja = neutro (9.3). */
const SEVERITY_TONE: Record<string, string> = { alta: "failed", media: "queued", baja: "default" };
const SEVERITY_LABEL: Record<string, string> = {
  alta: "Severidad alta", media: "Severidad media", baja: "Severidad baja",
};
const SEVERITIES = ["alta", "media", "baja"] as const;

const CONCLUSION_STATUS: Record<string, { label: string; tone: string }> = {
  propuesta: { label: "Propuesta", tone: "queued" },
  aceptada: { label: "Aceptada", tone: "succeeded" },
  descartada: { label: "Descartada", tone: "archived" },
};

/** Formato de presentación de un valor que ya viene calculado por el motor. */
const PCT_KEYS = new Set(["ue.take_rate", "pnl.ebitda_margin", "assumptions.declared_share", "tokens.margin_pct"]);
const RATIO_KEYS = new Set(["ue.ltv_cac", "ue.payback_months", "kpi.runway_months", "summary.breakeven_month"]);
const MONEY_PREFIXES = [
  "summary.funding_need", "summary.min_cash", "summary.final_cash", "pnl.", "cash.", "rev.", "cost.",
  "tx.", "ar.", "ue.cac", "ue.ltv", "ue.arpa", "ue.cm_per_client", "kpi.burn_net",
];
const COUNT_PREFIXES = ["b2b.", "b2c.", "points.", "tokens.units."];

function formatMetric(key: string, value: string | null | undefined, currency: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (PCT_KEYS.has(key)) return pct(value, 1);
  if (RATIO_KEYS.has(key)) return num(value, 2);
  if (COUNT_PREFIXES.some((p) => key.startsWith(p))) return num(value, 1);
  if (MONEY_PREFIXES.some((p) => key.startsWith(p))) return money(value, currency);
  return Number.isNaN(Number(value)) ? value : num(value, 2);
}

/** Los meses del motor llegan como "YYYY-MM"; cualquier otra etiqueta se muestra tal cual. */
function monthText(label: string | null | undefined): string | null {
  if (!label) return null;
  return /^\d{4}-\d{2}$/.test(label) ? monthName(label) : label;
}

function runLabel(run: Run): string {
  const created = run.created_at ? new Date(run.created_at).toLocaleString("es-MX") : "sin fecha";
  const status = STATUS_LABELS[run.status] ?? run.status;
  return `${created} · ${status} · ${run.id.slice(0, 8)}…`;
}

function EvidenceList({ evidence, currency }: { evidence: ConclusionEvidence[] | null; currency: string }) {
  if (!evidence || evidence.length === 0) {
    return (
      <p className="mt-3 text-xs text-slate-400">
        Sin evidencia asociada: esta conclusión no cita métricas del run.
      </p>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Evidencia del run</p>
      <ul className="mt-1.5 space-y-1.5">
        {evidence.map((e, i) => (
          <li key={`${e.metric_key}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
            <span className="font-mono text-slate-700">{e.metric_key}</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-500">{monthText(e.month_label) ?? "sin mes"}</span>
            <span className="text-slate-400">·</span>
            <span className="font-semibold text-slate-800">{formatMetric(e.metric_key, e.value, currency)}</span>
            {e.label && <span className="text-slate-500">— {e.label}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Draft { title: string; body: string; severity: string }

function ConclusionsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";
  const scenarioId = params.get("scenario") ?? "";
  const runId = params.get("run") ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [data, setData] = useState<ConclusionsResponse | null>(null);
  const [noProjects, setNoProjects] = useState(false);
  const [noRun, setNoRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Edición de la narrativa de las conclusiones guardadas
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  // Formulario de conclusión propia
  const [form, setForm] = useState({ kind: "hallazgo", title: "", body: "", severity: "media" });
  const [formError, setFormError] = useState<string | null>(null);

  // Auto-redirect: sin run toma el último run exitoso del escenario; sin escenario, el primero del proyecto.
  useEffect(() => {
    if (projectId && scenarioId && runId) return;
    let cancelled = false;
    setNoRun(false);
    (async () => {
      try {
        let pid = projectId;
        let sid = scenarioId;
        if (!pid || !sid) {
          const list = await api.get<Project[]>("/projects");
          const p = list.find((x) => x.id === pid) ?? list[0];
          if (!p || p.scenarios.length === 0) {
            if (!cancelled) setNoProjects(true);
            return;
          }
          pid = p.id;
          sid = sid && p.scenarios.some((s) => s.id === sid) ? sid : p.scenarios[0].id;
        }
        const scenarioRuns = await api.get<Run[]>(`/scenarios/${sid}/runs`);
        const ok = scenarioRuns.find((r) => r.status === "succeeded");
        if (cancelled) return;
        if (!ok) {
          if (pid !== projectId || sid !== scenarioId) {
            router.replace(`/conclusions/?project=${pid}&scenario=${sid}`);
          } else {
            setNoRun(true);
          }
          return;
        }
        router.replace(`/conclusions/?project=${pid}&scenario=${sid}&run=${ok.id}`);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message));
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, scenarioId, runId, router]);

  // Proyecto (selector de escenario y moneda base)
  useEffect(() => {
    if (!projectId) return;
    api.get<Project>(`/projects/${projectId}`).then(setProject)
      .catch((e) => setError(String((e as Error).message)));
  }, [projectId]);

  // Runs del escenario (selector de run)
  useEffect(() => {
    if (!scenarioId) return;
    api.get<Run[]>(`/scenarios/${scenarioId}/runs`).then(setRuns)
      .catch((e) => setError(String((e as Error).message)));
  }, [scenarioId]);

  const load = useCallback(() => {
    if (!runId) return;
    setError(null);
    Promise.all([
      api.get<Run>(`/simulation-runs/${runId}`),
      api.get<ConclusionsResponse>(`/simulation-runs/${runId}/conclusions`),
    ])
      .then(([r, c]) => { setRun(r); setData(c); setDrafts({}); })
      .catch((e) => setError(String((e as Error).message)));
  }, [runId]);
  useEffect(load, [load]);
  useEffect(() => { setActionError(null); setFormError(null); }, [runId]);

  const savedByCode = useMemo(() => {
    const map = new Map<string, ConclusionT>();
    for (const c of data?.saved ?? []) if (c.code) map.set(c.code, c);
    return map;
  }, [data]);

  const readinessByDimension = useMemo(() => {
    const groups: { dimension: string; rows: ReadinessRow[] }[] = [];
    for (const row of data?.readiness ?? []) {
      const found = groups.find((g) => g.dimension === row.dimension);
      if (found) found.rows.push(row);
      else groups.push({ dimension: row.dimension, rows: [row] });
    }
    return groups;
  }, [data]);

  const runError = (e: unknown) => setActionError(e instanceof ApiError ? String(e.message) : String(e));

  /** Aceptar/descartar una conclusión propuesta por el motor (pantalla 71). */
  const decide = async (c: ConclusionT, status: "aceptada" | "descartada") => {
    setBusy(`${c.code}-${status}`);
    setActionError(null);
    try {
      const existing = c.code ? savedByCode.get(c.code) : undefined;
      if (existing?.id) {
        await api.patch<ConclusionT>(`/conclusions/${existing.id}`, { status, actor: "usuario" });
      } else {
        const created = await api.post<ConclusionT>(`/simulation-runs/${runId}/conclusions`, {
          kind: c.kind, code: c.code, title: c.title, body: c.body, severity: c.severity,
          evidence: c.evidence, source: c.source ?? "motor", actor: "usuario",
        });
        if (created?.id) {
          await api.patch<ConclusionT>(`/conclusions/${created.id}`, { status, actor: "usuario" });
        }
      }
      load();
    } catch (e) {
      runError(e);
    } finally {
      setBusy(null);
    }
  };

  /** Cambio de estado de una conclusión ya guardada. */
  const setStatus = async (c: ConclusionT, status: string) => {
    if (!c.id) return;
    setBusy(`${c.id}-${status}`);
    setActionError(null);
    try {
      await api.patch<ConclusionT>(`/conclusions/${c.id}`, { status, actor: "usuario" });
      load();
    } catch (e) {
      runError(e);
    } finally {
      setBusy(null);
    }
  };

  /** Edición de la narrativa (título, cuerpo y severidad) de una conclusión guardada. */
  const saveDraft = async (c: ConclusionT) => {
    if (!c.id) return;
    const draft = drafts[c.id];
    if (!draft) return;
    setBusy(`${c.id}-edit`);
    setActionError(null);
    try {
      await api.patch<ConclusionT>(`/conclusions/${c.id}`, {
        title: draft.title, body: draft.body, severity: draft.severity, actor: "usuario",
      });
      load();
    } catch (e) {
      runError(e);
    } finally {
      setBusy(null);
    }
  };

  /** Conclusión escrita por el usuario (source "usuario"). */
  const createOwn = async () => {
    if (!form.title.trim()) {
      setFormError("El título es obligatorio.");
      return;
    }
    setBusy("nueva");
    setFormError(null);
    setActionError(null);
    try {
      await api.post<ConclusionT>(`/simulation-runs/${runId}/conclusions`, {
        kind: form.kind, code: "", title: form.title.trim(), body: form.body.trim(),
        severity: form.severity, evidence: null, source: "usuario", actor: "usuario",
      });
      setForm({ kind: "hallazgo", title: "", body: "", severity: "media" });
      load();
    } catch (e) {
      setFormError(e instanceof ApiError ? String(e.message) : String(e));
    } finally {
      setBusy(null);
    }
  };

  // ---------- estados de carga ----------
  if (noProjects) {
    return (
      <EmptyState
        title="Aún no hay proyectos"
        description="Crea tu primer proyecto y ejecuta una simulación para obtener hallazgos, riesgos, acciones y el readiness para VC."
        action={<Button href="/projects/new/">Crear proyecto</Button>}
      />
    );
  }
  if (error && !data) return <ErrorState message={error} onRetry={() => { setError(null); load(); }} />;

  const currency = project?.base_currency ?? "MXN";
  const scenarioName = project?.scenarios.find((s) => s.id === scenarioId)?.name ?? "";

  const scenarioSelect = project && project.scenarios.length > 0 && (
    <select
      className={`${inputClass} !w-auto`}
      value={scenarioId}
      onChange={(e) => router.replace(`/conclusions/?project=${projectId}&scenario=${e.target.value}`)}
    >
      {project.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );

  const runSelect = runs.length > 0 && (
    <select
      className={`${inputClass} !w-auto`}
      value={runId}
      onChange={(e) => router.replace(`/conclusions/?project=${projectId}&scenario=${scenarioId}&run=${e.target.value}`)}
    >
      {runs.map((r) => (
        <option key={r.id} value={r.id} disabled={r.status !== "succeeded"}>{runLabel(r)}</option>
      ))}
    </select>
  );

  const breadcrumb = (
    <nav className="mb-2 text-xs text-slate-400">
      <Link href="/" className="hover:text-pigui-700">Proyectos</Link>{" / "}
      {project
        ? <Link href={`/project/?id=${project.id}`} className="hover:text-pigui-700">{project.name}</Link>
        : "Proyecto"}
      {" / "}Conclusiones y recomendaciones
    </nav>
  );

  if (noRun) {
    return (
      <div>
        {breadcrumb}
        <SectionTitle
          title="Conclusiones y recomendaciones"
          subtitle={scenarioName ? `Escenario ${scenarioName}` : undefined}
          right={scenarioSelect || undefined}
        />
        <EmptyState
          title="Aún no hay un run exitoso en este escenario"
          description="Las conclusiones, su evidencia y el readiness para VC se derivan de las métricas de un run. Ejecuta una simulación o elige otro escenario."
          action={<Button href={`/simulate/?project=${projectId}&scenario=${scenarioId}`}>Ir a simular</Button>}
        />
      </div>
    );
  }

  if (!runId || !run || !data) return <Skeleton rows={6} />;

  const summary = run.summary;
  const generatedByKind = KINDS.map((k) => ({
    ...k, items: data.generated.filter((c) => c.kind === k.key),
  }));
  const otherGenerated = data.generated.filter((c) => !KINDS.some((k) => k.key === c.kind));

  return (
    <div>
      {breadcrumb}
      <SectionTitle
        title="Conclusiones y recomendaciones"
        subtitle={`Run ${run.id.slice(0, 12)}… · motor v${run.engine_version} · hash ${run.input_hash.slice(0, 12)}…${
          scenarioName ? ` · escenario ${scenarioName}` : ""} · ${run.horizon_months} meses`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            {scenarioSelect}
            {runSelect}
            <Button variant="secondary" href={`/run/?project=${projectId}&id=${run.id}`}>
              Ver resultados del run
            </Button>
          </div>
        }
      />

      {/* 1. Resumen del run — la pantalla siempre identifica el run (pantalla 70) */}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="Punto de equilibrio"
          value={summary?.breakeven_label ?? "No alcanzado"}
          tone={summary?.breakeven_label ? "good" : "bad"}
          hint={summary?.breakeven_month ? `Mes ${summary.breakeven_month}` : "EBITDA nunca ≥ 0 en el horizonte"}
        />
        <KpiCard
          label="Necesidad de capital"
          value={money(summary?.funding_need, currency, true)}
          hint="Caja mínima negativa + buffer + one-time"
        />
        <KpiCard
          label="Caja mínima"
          value={money(summary?.min_cash, currency, true)}
          tone={summary && parseFloat(summary.min_cash) < 0 ? "bad" : "default"}
          hint="Mes más bajo del horizonte"
        />
        <KpiCard
          label="Caja final"
          value={money(summary?.final_cash, currency, true)}
          tone={summary && parseFloat(summary.final_cash) >= 0 ? "good" : "bad"}
          hint={`Al cierre de los ${run.horizon_months} meses`}
        />
      </div>

      {actionError && (
        <div className="mb-4">
          <ErrorState message={actionError} />
        </div>
      )}

      {/* 2. Hallazgos, riesgos y acciones (pantalla 71) */}
      <SectionTitle
        title="Hallazgos, riesgos y acciones"
        subtitle="Propuestas por el motor con reglas explicables sobre las métricas de este run. Cada conclusión enlaza a su evidencia."
      />
      {data.generated.length === 0 ? (
        <EmptyState
          title="El motor no generó conclusiones para este run"
          description="Ninguna regla se activó con las métricas de este run. Puedes escribir una conclusión propia más abajo."
        />
      ) : (
        <div className="space-y-6">
          {generatedByKind.filter((g) => g.items.length > 0).map((group) => (
            <div key={group.key}>
              <div className="mb-2">
                <p className="text-sm font-semibold text-slate-800">
                  {group.title} <span className="font-normal text-slate-400">({group.items.length})</span>
                </p>
                <p className="text-xs text-slate-500">{group.subtitle}</p>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {group.items.map((c) => {
                  const existing = c.code ? savedByCode.get(c.code) : undefined;
                  const status = existing?.status;
                  return (
                    <Card key={`${group.key}-${c.code}-${c.title}`}>
                      <CardBody>
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          <Badge tone={SEVERITY_TONE[c.severity] ?? "default"}>
                            {SEVERITY_LABEL[c.severity] ?? c.severity}
                          </Badge>
                          {status && (
                            <Badge tone={CONCLUSION_STATUS[status]?.tone ?? "default"}>
                              {CONCLUSION_STATUS[status]?.label ?? status}
                            </Badge>
                          )}
                          {c.code && <span className="font-mono text-[11px] text-slate-400">{c.code}</span>}
                        </div>
                        <p className="text-sm font-semibold text-slate-900">{c.title}</p>
                        <p className="mt-1 text-sm text-slate-600">{c.body}</p>
                        <EvidenceList evidence={c.evidence} currency={currency} />
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            onClick={() => decide(c, "aceptada")}
                            disabled={busy !== null || status === "aceptada"}
                          >
                            {busy === `${c.code}-aceptada` ? "Guardando…" : "Aceptar"}
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => decide(c, "descartada")}
                            disabled={busy !== null || status === "descartada"}
                          >
                            {busy === `${c.code}-descartada` ? "Guardando…" : "Descartar"}
                          </Button>
                        </div>
                      </CardBody>
                    </Card>
                  );
                })}
              </div>
            </div>
          ))}
          {otherGenerated.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-800">Otras conclusiones del motor</p>
              <div className="grid gap-3 lg:grid-cols-2">
                {otherGenerated.map((c) => (
                  <Card key={`otro-${c.code}-${c.title}`}>
                    <CardBody>
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <Badge tone={SEVERITY_TONE[c.severity] ?? "default"}>
                          {SEVERITY_LABEL[c.severity] ?? c.severity}
                        </Badge>
                        <Badge>{KIND_LABELS[c.kind] ?? c.kind}</Badge>
                      </div>
                      <p className="text-sm font-semibold text-slate-900">{c.title}</p>
                      <p className="mt-1 text-sm text-slate-600">{c.body}</p>
                      <EvidenceList evidence={c.evidence} currency={currency} />
                    </CardBody>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Conclusiones guardadas: estado y edición de la narrativa */}
      <div className="mt-8">
        <SectionTitle
          title="Conclusiones guardadas"
          subtitle="Aceptadas, descartadas o propias de este run. Puedes cambiar su estado y editar la narrativa sin tocar la evidencia."
        />
        {data.saved.length === 0 ? (
          <EmptyState
            title="Todavía no guardas ninguna conclusión"
            description="Acepta o descarta las propuestas del motor, o escribe una conclusión propia; el historial queda asociado a este run."
          />
        ) : (
          <div className="space-y-3">
            {data.saved.map((c) => {
              const id = c.id ?? "";
              const draft: Draft = drafts[id] ?? { title: c.title, body: c.body, severity: c.severity };
              const dirty = draft.title !== c.title || draft.body !== c.body || draft.severity !== c.severity;
              const update = (patch: Partial<Draft>) =>
                setDrafts((prev) => ({ ...prev, [id]: { ...draft, ...patch } }));
              const st = c.status ? CONCLUSION_STATUS[c.status] : undefined;
              return (
                <Card key={id || c.title}>
                  <CardBody>
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <Badge tone={SEVERITY_TONE[draft.severity] ?? "default"}>
                        {SEVERITY_LABEL[draft.severity] ?? draft.severity}
                      </Badge>
                      <Badge>{KIND_LABELS[c.kind] ?? c.kind}</Badge>
                      <Badge tone={st?.tone ?? "default"}>{st?.label ?? c.status ?? "propuesta"}</Badge>
                      <Badge tone={c.source === "usuario" ? "declarado" : "default"}>
                        {c.source === "usuario" ? "Escrita por el usuario" : "Propuesta por el motor"}
                      </Badge>
                      {c.code && <span className="font-mono text-[11px] text-slate-400">{c.code}</span>}
                    </div>
                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="md:col-span-2">
                        <Field label="Título">
                          <input className={inputClass} value={draft.title}
                            onChange={(e) => update({ title: e.target.value })} />
                        </Field>
                      </div>
                      <Field label="Severidad">
                        <select className={inputClass} value={draft.severity}
                          onChange={(e) => update({ severity: e.target.value })}>
                          {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </Field>
                    </div>
                    <div className="mt-3">
                      <Field label="Narrativa" hint="Describe lo que el run muestra; la evidencia citada no cambia.">
                        <textarea className={inputClass} rows={3} value={draft.body}
                          onChange={(e) => update({ body: e.target.value })} />
                      </Field>
                    </div>
                    <EvidenceList evidence={c.evidence} currency={currency} />
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button onClick={() => saveDraft(c)} disabled={!dirty || busy !== null}>
                        {busy === `${id}-edit` ? "Guardando…" : "Guardar narrativa"}
                      </Button>
                      <Button variant="secondary" onClick={() => setStatus(c, "aceptada")}
                        disabled={busy !== null || c.status === "aceptada"}>
                        {busy === `${id}-aceptada` ? "Guardando…" : "Marcar aceptada"}
                      </Button>
                      <Button variant="secondary" onClick={() => setStatus(c, "descartada")}
                        disabled={busy !== null || c.status === "descartada"}>
                        {busy === `${id}-descartada` ? "Guardando…" : "Marcar descartada"}
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* 3. Conclusión propia */}
      <div className="mt-8">
        <SectionTitle
          title="Añadir conclusión propia"
          subtitle="Queda guardada con origen “usuario” y asociada a este run; no reemplaza a las conclusiones del motor."
        />
        <Card>
          <CardBody>
            <div className="grid gap-3 md:grid-cols-4">
              <Field label="Tipo">
                <select className={inputClass} value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {KINDS.map((k) => <option key={k.key} value={k.key}>{KIND_LABELS[k.key]}</option>)}
                </select>
              </Field>
              <div className="md:col-span-2">
                <Field label="Título" required>
                  <input className={inputClass} value={form.title} placeholder="Qué muestra el run"
                    onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </Field>
              </div>
              <Field label="Severidad">
                <select className={inputClass} value={form.severity}
                  onChange={(e) => setForm({ ...form, severity: e.target.value })}>
                  {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
            </div>
            <div className="mt-3">
              <Field label="Narrativa" hint="Cita las métricas del run en las que te apoyas; el motor no infiere causalidad.">
                <textarea className={inputClass} rows={3} value={form.body}
                  placeholder="Descripción de la conclusión"
                  onChange={(e) => setForm({ ...form, body: e.target.value })} />
              </Field>
            </div>
            {formError && <p className="mt-2 text-sm font-medium text-rose-600">{formError}</p>}
            <div className="mt-3">
              <Button onClick={createOwn} disabled={busy !== null}>
                {busy === "nueva" ? "Guardando…" : "Guardar conclusión"}
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>

      {/* 4. Readiness para VC (apéndice 16.2) */}
      <div className="mt-8">
        <SectionTitle
          title="Readiness para VC"
          subtitle="Señales por dimensión: mercado y crecimiento, economía, retención, producto, finanzas y calidad de la evidencia."
        />
        {readinessByDimension.length === 0 ? (
          <EmptyState
            title="Sin señales de readiness para este run"
            description="El motor no devolvió señales respaldadas por métricas de este run."
          />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-5 py-3">Dimensión</th>
                    <th className="px-3 py-3">Métrica</th>
                    <th className="px-3 py-3 text-right">Valor</th>
                    <th className="px-3 py-3">Mes</th>
                    <th className="px-3 py-3">Señal</th>
                  </tr>
                </thead>
                <tbody>
                  {readinessByDimension.map((group) =>
                    group.rows.map((row, i) => (
                      <tr key={`${group.dimension}-${row.metric_key}-${i}`} className="border-b border-slate-100 last:border-0">
                        <td className="px-5 py-2.5 align-top text-slate-700">
                          {i === 0 ? <span className="font-medium">{group.dimension}</span> : null}
                        </td>
                        <td className="px-3 py-2.5 align-top font-mono text-xs text-slate-600">{row.metric_key}</td>
                        <td className="px-3 py-2.5 align-top text-right font-semibold text-slate-800">
                          {formatMetric(row.metric_key, row.value, currency)}
                        </td>
                        <td className="px-3 py-2.5 align-top text-slate-500">{monthText(row.month_label) ?? "—"}</td>
                        <td className="px-3 py-2.5 align-top text-slate-600">{row.signal}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Cada señal cita la métrica del run que la respalda; no se muestran métricas sin fuente. Un valor “—”
          significa que el motor no pudo calcular esa métrica en este run (por ejemplo, punto de equilibrio no
          alcanzado).
        </p>
      </div>

      {/* 5. Nota al pie */}
      <p className="mt-8 text-xs text-slate-400">
        Las conclusiones se derivan de reglas explicables sobre las métricas del run; describen lo que el run
        muestra y no afirman causalidad. Toda la evidencia proviene del run {run.id.slice(0, 12)}… (motor
        v{run.engine_version}, hash {run.input_hash.slice(0, 12)}…): esta pantalla no calcula nada.
      </p>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={6} />}><ConclusionsPage /></Suspense>;
}
