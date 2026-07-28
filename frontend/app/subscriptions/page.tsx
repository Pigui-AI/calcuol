"use client";
/** Pantallas 45, 47 y 62 — Suscripciones y planes (fase 6). Ruta estática: /subscriptions?project=&scenario= */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
} from "recharts";
import {
  api, ApiError, Assumption, Client, Project, Run, RunResults, SubsCohortRow,
  SubscriptionPlanT, SubscriptionT,
} from "@/lib/api";
import { money, num, pct, monthName, STATUS_LABELS } from "@/lib/format";
import MetricTable, { MetricRowDef } from "@/components/MetricTable";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, Field, KpiCard, SectionTitle, Skeleton, inputClass,
} from "@/components/ui";

const TABS = ["Planes", "Trials por cohorte", "MRR bridge"] as const;

/** Etiquetas del tipo de trial (pantalla 47). */
const TRIAL_LABELS: Record<string, string> = {
  none: "Sin trial",
  sin_tarjeta_15: "Sin tarjeta · 15 días",
  con_tarjeta_30: "Con tarjeta · 30 días",
};

/** Estados de dominio de una suscripción declarada (pantalla 47). */
const SUB_STATUS: Record<string, { label: string; tone: string }> = {
  trial: { label: "Trial", tone: "queued" },
  activa: { label: "Activa", tone: "active" },
  pausada: { label: "Pausada", tone: "default" },
  cancelada: { label: "Cancelada", tone: "failed" },
};

/** Series del run que consume el tab MRR bridge (todas emitidas por el motor). */
const RESULT_KEYS = [
  "rev.mrr.start", "rev.mrr.new", "rev.mrr.expansion", "rev.mrr.contraction",
  "rev.mrr.churned", "rev.mrr.end", "subs.trial_starts", "subs.conversions",
  "subs.active_total", "rev.subscriptions",
].join(",");

/** Bridge de MRR (pantalla 62): cada renglón es una métrica del run tal cual. */
const BRIDGE_ROWS: MetricRowDef[] = [
  { label: "MRR inicial", key: "rev.mrr.start" },
  { label: "MRR nuevo (altas y conversiones)", key: "rev.mrr.new" },
  { label: "Expansión (upgrades)", key: "rev.mrr.expansion" },
  { label: "Contracción (downgrades)", key: "rev.mrr.contraction" },
  { label: "MRR perdido (churn)", key: "rev.mrr.churned" },
  { label: "MRR final", key: "rev.mrr.end", strong: true },
  { label: "Trials iniciados", key: "subs.trial_starts", kind: "count" },
  { label: "Conversiones", key: "subs.conversions", kind: "count" },
  { label: "Suscriptores activos", key: "subs.active_total", kind: "count" },
];

/** Fallback agregado cuando el motor detallado está apagado. */
const AGG_ROWS: MetricRowDef[] = [
  { label: "Ingresos por suscripciones (agregado)", key: "rev.subscriptions", strong: true },
];

const EMPTY_PLAN_FORM = {
  name: "", description: "", price_monthly: "", trial_kind: "none",
  trial_conversion: "0.25", adoption_rate: "0.30", start_month: "13",
  ramp_months: "6", churn_rate: "0.02", upgrade_to_plan_id: "",
  upgrade_rate: "0", included_token_credits: "0",
};

const EMPTY_SUB_FORM = {
  client_id: "", plan_id: "",
  start_date: new Date().toISOString().slice(0, 10), trial_end: "",
};

function isTrue(v: string): boolean {
  return ["true", "1", "yes", "si", "sí", "on"].includes(v.trim().toLowerCase());
}

function originTone(origin: string): string {
  return origin === "escenario" ? "hipotesis" : origin === "proyecto" ? "declarado" : "default";
}

interface RunData {
  run: Run;
  results: RunResults;
}

function SubscriptionsHub() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";
  const scenarioId = params.get("scenario") ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [plans, setPlans] = useState<SubscriptionPlanT[] | null>(null);
  const [subscriptions, setSubscriptions] = useState<SubscriptionT[] | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [assumptions, setAssumptions] = useState<Assumption[] | null>(null);
  const [noProjects, setNoProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Planes");

  // Editor de supuestos subs.* con dirty-tracking (patrón campañas)
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // CRUD de planes (pantalla 45)
  const [showPlanForm, setShowPlanForm] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [planForm, setPlanForm] = useState({ ...EMPTY_PLAN_FORM });
  const [planPosting, setPlanPosting] = useState(false);
  const [planFormError, setPlanFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Alta de suscripciones declaradas (pantalla 47)
  const [showSubForm, setShowSubForm] = useState(false);
  const [subForm, setSubForm] = useState({ ...EMPTY_SUB_FORM });
  const [subPosting, setSubPosting] = useState(false);
  const [subFormError, setSubFormError] = useState<string | null>(null);

  // Último run exitoso (tabs 47 y 62)
  const [runData, setRunData] = useState<RunData | null>(null);
  const [runChecked, setRunChecked] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Sin parámetros: conserva el proyecto de la URL si existe; si no, el primero disponible.
  useEffect(() => {
    if (projectId && scenarioId) return;
    api.get<Project[]>("/projects")
      .then((list) => {
        const p = list.find((x) => x.id === projectId) ?? list[0];
        if (p && p.scenarios.length > 0) {
          router.replace(`/subscriptions/?project=${p.id}&scenario=${p.scenarios[0].id}`);
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
      api.get<SubscriptionPlanT[]>(`/projects/${projectId}/subscription-plans`),
      api.get<SubscriptionT[]>(`/projects/${projectId}/subscriptions`),
      api.get<{ clients: Client[] }>(`/projects/${projectId}/clients`),
      api.get<{ assumptions: Assumption[] }>(`/scenarios/${scenarioId}/assumptions`),
    ])
      .then(([p, pl, subs, c, asm]) => {
        setProject(p); setPlans(pl); setSubscriptions(subs);
        setClients(c.clients); setAssumptions(asm.assumptions);
      })
      .catch((e) => setError(String(e.message)));
  }, [projectId, scenarioId]);
  useEffect(load, [load]);
  useEffect(() => { setEdits({}); setSaveError(null); }, [scenarioId]);

  const loadRun = useCallback(() => {
    if (!scenarioId) return;
    setRunChecked(false);
    setRunError(null);
    setRunData(null);
    api.get<Run[]>(`/scenarios/${scenarioId}/runs`)
      .then(async (runs) => {
        const ok = runs.find((r) => r.status === "succeeded");
        if (!ok) { setRunChecked(true); return; }
        const [run, results] = await Promise.all([
          api.get<Run>(`/simulation-runs/${ok.id}`),
          api.get<RunResults>(`/simulation-runs/${ok.id}/results?keys=${RESULT_KEYS}`),
        ]);
        setRunData({ run, results });
        setRunChecked(true);
      })
      .catch((e) => { setRunError(String(e.message)); setRunChecked(true); });
  }, [scenarioId]);
  useEffect(loadRun, [loadRun]);

  const amap = useMemo(() => {
    const out: Record<string, Assumption> = {};
    (assumptions ?? []).forEach((a) => { out[a.key] = a; });
    return out;
  }, [assumptions]);

  const planName = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of plans ?? []) map[p.id] = p.name;
    return map;
  }, [plans]);

  const clientName = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of clients) map[c.id] = c.trade_name || c.legal_name;
    return map;
  }, [clients]);

  const dirty = Object.keys(edits).length > 0;

  const setEdit = (key: string, v: string, original: string) => {
    setEdits((prev) => {
      const next = { ...prev };
      if (v === original) delete next[key];
      else next[key] = v;
      return next;
    });
  };

  const saveAssumptions = async () => {
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

  const planPayload = (baseCurrency: string) => ({
    name: planForm.name,
    description: planForm.description,
    price_monthly: planForm.price_monthly,
    currency: baseCurrency,
    trial_kind: planForm.trial_kind,
    trial_conversion: planForm.trial_conversion,
    adoption_rate: planForm.adoption_rate,
    start_month: parseInt(planForm.start_month, 10) || 0,
    ramp_months: parseInt(planForm.ramp_months, 10) || 0,
    churn_rate: planForm.churn_rate,
    upgrade_to_plan_id: planForm.upgrade_to_plan_id || null,
    upgrade_rate: planForm.upgrade_rate,
    included_token_credits: planForm.included_token_credits,
  });

  const closePlanForm = () => {
    setShowPlanForm(false);
    setEditingPlanId(null);
    setPlanForm({ ...EMPTY_PLAN_FORM });
    setPlanFormError(null);
  };

  const savePlan = async () => {
    if (!project) return;
    setPlanPosting(true);
    setPlanFormError(null);
    try {
      if (editingPlanId) {
        await api.patch<SubscriptionPlanT>(`/subscription-plans/${editingPlanId}`, planPayload(project.base_currency));
      } else {
        await api.post<SubscriptionPlanT>(`/projects/${projectId}/subscription-plans`, {
          ...planPayload(project.base_currency), actor: "usuario",
        });
      }
      closePlanForm();
      load();
    } catch (e) {
      // El backend responde 422 con el mensaje en español; se muestra tal cual.
      setPlanFormError(e instanceof ApiError ? String(e.message) : String(e));
    } finally {
      setPlanPosting(false);
    }
  };

  const startEditPlan = (p: SubscriptionPlanT) => {
    setEditingPlanId(p.id);
    setPlanForm({
      name: p.name, description: p.description, price_monthly: p.price_monthly,
      trial_kind: p.trial_kind, trial_conversion: p.trial_conversion,
      adoption_rate: p.adoption_rate, start_month: String(p.start_month),
      ramp_months: String(p.ramp_months), churn_rate: p.churn_rate,
      upgrade_to_plan_id: p.upgrade_to_plan_id ?? "",
      upgrade_rate: p.upgrade_rate, included_token_credits: p.included_token_credits,
    });
    setPlanFormError(null);
    setShowPlanForm(true);
  };

  const archivePlan = async (p: SubscriptionPlanT) => {
    if (!window.confirm(`¿Archivar el plan “${p.name}”? Los planes no se borran: los runs pasados conservan el plan congelado en su snapshot.`)) return;
    setActionError(null);
    try {
      await api.post<SubscriptionPlanT>(`/subscription-plans/${p.id}/archive`, {});
      load();
    } catch (e) {
      setActionError(e instanceof ApiError ? String(e.message) : String(e));
    }
  };

  const createSubscription = async () => {
    setSubPosting(true);
    setSubFormError(null);
    try {
      await api.post<SubscriptionT>(`/clients/${subForm.client_id}/subscriptions`, {
        plan_id: subForm.plan_id,
        start_date: subForm.start_date,
        trial_end: subForm.trial_end || null,
        actor: "usuario",
      });
      setSubForm({ ...EMPTY_SUB_FORM });
      setShowSubForm(false);
      load();
    } catch (e) {
      // El 409 de solape de trials se muestra tal cual (pantalla 47).
      setSubFormError(e instanceof ApiError ? String(e.message) : String(e));
    } finally {
      setSubPosting(false);
    }
  };

  const months = runData?.results.months ?? [];
  const metrics = runData?.results.metrics ?? {};

  const bridgeData = useMemo(() => {
    if (!runData) return [];
    const { months: ms, metrics: mx } = runData.results;
    return ms.map((m, i) => ({
      mes: monthName(m),
      Nuevo: parseFloat(mx["rev.mrr.new"]?.[i] ?? "0"),
      "Expansión": parseFloat(mx["rev.mrr.expansion"]?.[i] ?? "0"),
      "Contracción": parseFloat(mx["rev.mrr.contraction"]?.[i] ?? "0"),
      Perdido: parseFloat(mx["rev.mrr.churned"]?.[i] ?? "0"),
    }));
  }, [runData]);

  if (!projectId || !scenarioId) {
    if (noProjects) {
      return (
        <EmptyState
          title="Aún no hay proyectos"
          description="Crea tu primer proyecto para configurar planes de suscripción, trials por cohorte y el puente de MRR."
          action={<Button href="/projects/new/">Crear proyecto</Button>}
        />
      );
    }
    if (error) return <ErrorState message={error} />;
    return <Skeleton rows={5} />;
  }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!project || !plans || !subscriptions || !assumptions) return <Skeleton rows={5} />;

  const currency = project.base_currency;
  const detailOn = isTrue(edits["subs.detail.enabled"] ?? amap["subs.detail.enabled"]?.value ?? "false");
  const cohorts: SubsCohortRow[] = runData?.run.subs_cohorts ?? [];
  const availablePlans = plans.filter((p) => p.status !== "archived");
  const monthOfIndex = (idx: number) => (months[idx - 1] ? monthName(months[idx - 1]) : `Mes ${idx}`);
  const lastOf = (key: string) => [...(metrics[key] ?? [])].reverse().find((v) => v != null) ?? null;
  const tickInterval = Math.ceil(Math.max(months.length, 1) / 16);

  const noRunState = (
    <EmptyState
      title="Aún no hay un run exitoso"
      description="Estas vistas leen cohortes y series del último run exitoso del escenario; esta pantalla no calcula nada. Ejecuta una simulación para verlas."
      action={<Button href={`/simulate/?project=${projectId}&scenario=${scenarioId}`}>Ir a simular</Button>}
    />
  );

  /** Editor de un supuesto del escenario con dirty-tracking (patrón del centro de supuestos). */
  const renderAssumption = (key: string, label: string, bool = false) => {
    const a = amap[key];
    if (!a) return null;
    const value = edits[key] ?? a.value;
    const changed = key in edits;
    const highlight = changed ? "!border-pigui-500 !ring-1 !ring-pigui-500" : "";
    return (
      <div key={key}>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-slate-700">{label}</span>
          <Badge tone={originTone(a.origin)}>{a.origin}</Badge>
        </div>
        {bool ? (
          <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 ${changed ? "border-pigui-500 ring-1 ring-pigui-500" : "border-slate-300"}`}>
            <input
              type="checkbox"
              className="h-4 w-4 accent-pigui-600"
              checked={isTrue(value)}
              onChange={(e) => setEdit(key, e.target.checked ? "true" : "false", a.value)}
            />
            <span className="text-sm text-slate-700">{isTrue(value) ? "Encendido" : "Apagado"}</span>
          </label>
        ) : (
          <input className={`${inputClass} ${highlight}`} value={value}
            onChange={(e) => setEdit(key, e.target.value, a.value)} />
        )}
        <p className="mt-1 text-xs text-slate-400">{a.description || key}{a.unit && ` · ${a.unit}`}</p>
        <p className="font-mono text-[11px] text-slate-400">{key}</p>
      </div>
    );
  };

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link>{" / "}
        <Link href={`/project/?id=${project.id}`} className="hover:text-pigui-700">{project.name}</Link>
        {" / "}Suscripciones y planes
      </nav>
      <SectionTitle
        title="Suscripciones y planes"
        subtitle="Catálogo de planes, trials por cohorte y puente de MRR — cohortes y series provienen del último run exitoso"
        right={
          <div className="flex flex-wrap items-center gap-2">
            {savedAt && !dirty && <span className="text-xs text-emerald-600">Guardado {savedAt}</span>}
            <Button onClick={saveAssumptions} disabled={!dirty || saving}>
              {saving ? "Guardando…" : `Guardar cambios${dirty ? ` (${Object.keys(edits).length})` : ""}`}
            </Button>
            <select
              className={`${inputClass} !w-auto`}
              value={scenarioId}
              onChange={(e) => router.replace(`/subscriptions/?project=${project.id}&scenario=${e.target.value}`)}
            >
              {project.scenarios.map((sc) => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
            </select>
          </div>
        }
      />
      {saveError && <p className="mb-3 text-sm font-medium text-rose-600">{saveError}</p>}

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg border border-slate-200 bg-white p-1">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${tab === t ? "bg-pigui-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
            {t}
          </button>
        ))}
      </div>

      {/* ---------- Planes (pantalla 45) ---------- */}
      {tab === "Planes" && (
        <div className="space-y-5">
          <SectionTitle
            title="Catálogo de planes (pantalla 45)"
            subtitle="Plan, trial, precio, conversión, adopción, churn y upgrades; los planes se archivan, jamás se borran."
            right={
              <Button
                variant={showPlanForm ? "secondary" : "primary"}
                onClick={() => (showPlanForm ? closePlanForm() : setShowPlanForm(true))}
              >
                {showPlanForm ? "Cerrar formulario" : "+ Nuevo plan"}
              </Button>
            }
          />

          {showPlanForm && (
            <Card>
              <CardBody>
                <p className="mb-4 text-sm font-semibold text-slate-800">
                  {editingPlanId ? `Editar plan “${planName[editingPlanId] ?? editingPlanId}”` : "Alta de plan"}
                </p>
                <div className="grid gap-4 md:grid-cols-3">
                  <Field label="Nombre" required>
                    <input className={inputClass} value={planForm.name}
                      onChange={(e) => setPlanForm((f) => ({ ...f, name: e.target.value }))} />
                  </Field>
                  <Field label="Precio mensual" required hint={`En ${currency} (moneda base del proyecto)`}>
                    <input className={inputClass} placeholder="0.00" value={planForm.price_monthly}
                      onChange={(e) => setPlanForm((f) => ({ ...f, price_monthly: e.target.value }))} />
                  </Field>
                  <Field label="Tipo de trial">
                    <select className={inputClass} value={planForm.trial_kind}
                      onChange={(e) => setPlanForm((f) => ({ ...f, trial_kind: e.target.value }))}>
                      <option value="none">{TRIAL_LABELS.none}</option>
                      <option value="sin_tarjeta_15">{TRIAL_LABELS.sin_tarjeta_15}</option>
                      <option value="con_tarjeta_30">{TRIAL_LABELS.con_tarjeta_30}</option>
                    </select>
                  </Field>
                  <Field label="Conversión del trial" hint="Decimal 0–1 por cohorte (0.25 = 25%)">
                    <input className={inputClass} value={planForm.trial_conversion}
                      onChange={(e) => setPlanForm((f) => ({ ...f, trial_conversion: e.target.value }))} />
                  </Field>
                  <Field label="Adopción" hint="Decimal 0–1 sobre clientes B2B activos">
                    <input className={inputClass} value={planForm.adoption_rate}
                      onChange={(e) => setPlanForm((f) => ({ ...f, adoption_rate: e.target.value }))} />
                  </Field>
                  <Field label="Mes de inicio" hint="Índice del mes (1 = primer mes del horizonte)">
                    <input type="number" min={1} className={inputClass} value={planForm.start_month}
                      onChange={(e) => setPlanForm((f) => ({ ...f, start_month: e.target.value }))} />
                  </Field>
                  <Field label="Ramp (meses)">
                    <input type="number" min={1} className={inputClass} value={planForm.ramp_months}
                      onChange={(e) => setPlanForm((f) => ({ ...f, ramp_months: e.target.value }))} />
                  </Field>
                  <Field label="Churn mensual" hint="Decimal 0–1 sobre activos del plan">
                    <input className={inputClass} value={planForm.churn_rate}
                      onChange={(e) => setPlanForm((f) => ({ ...f, churn_rate: e.target.value }))} />
                  </Field>
                  <Field label="Upgrade hacia" hint="Plan destino de upgrades/downgrades (opcional)">
                    <select className={inputClass} value={planForm.upgrade_to_plan_id}
                      onChange={(e) => setPlanForm((f) => ({ ...f, upgrade_to_plan_id: e.target.value }))}>
                      <option value="">Sin upgrade</option>
                      {availablePlans.filter((p) => p.id !== editingPlanId).map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Tasa de upgrade" hint="Decimal 0–1 mensual sobre activos del plan">
                    <input className={inputClass} value={planForm.upgrade_rate}
                      onChange={(e) => setPlanForm((f) => ({ ...f, upgrade_rate: e.target.value }))} />
                  </Field>
                  <Field label="Créditos de tokens incluidos" hint="Unidades por mes (pantalla 46)">
                    <input className={inputClass} value={planForm.included_token_credits}
                      onChange={(e) => setPlanForm((f) => ({ ...f, included_token_credits: e.target.value }))} />
                  </Field>
                  <Field label="Descripción">
                    <input className={inputClass} value={planForm.description}
                      onChange={(e) => setPlanForm((f) => ({ ...f, description: e.target.value }))} />
                  </Field>
                </div>
                {planFormError && <p className="mt-3 text-sm font-medium text-rose-600">{planFormError}</p>}
                <div className="mt-4 flex gap-2">
                  <Button onClick={savePlan}
                    disabled={planPosting || !planForm.name || !planForm.price_monthly}>
                    {planPosting ? "Guardando…" : editingPlanId ? "Guardar plan" : "Crear plan"}
                  </Button>
                  <Button variant="secondary" onClick={closePlanForm}>Cancelar</Button>
                </div>
              </CardBody>
            </Card>
          )}

          {actionError && <ErrorState message={actionError} />}

          {plans.length === 0 ? (
            <EmptyState
              title="Aún no hay planes"
              description="Crea el primer plan de suscripción para modelar trials, conversiones, churn y upgrades por plan."
              action={<Button onClick={() => setShowPlanForm(true)}>+ Nuevo plan</Button>}
            />
          ) : (
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full min-w-max text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-5 py-3">Plan</th>
                      <th className="px-3 py-3 text-right">Precio</th>
                      <th className="px-3 py-3">Trial</th>
                      <th className="px-3 py-3 text-right">Conversión</th>
                      <th className="px-3 py-3 text-right">Adopción</th>
                      <th className="px-3 py-3 text-right">Inicio</th>
                      <th className="px-3 py-3 text-right">Ramp</th>
                      <th className="px-3 py-3 text-right">Churn</th>
                      <th className="px-3 py-3">Upgrade →</th>
                      <th className="px-3 py-3 text-right">Créditos</th>
                      <th className="px-3 py-3">Estado</th>
                      <th className="px-3 py-3 text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plans.map((p) => (
                      <tr key={p.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-5 py-2.5">
                          <p className="font-medium text-slate-800">{p.name}</p>
                          {p.description && <p className="text-xs text-slate-400">{p.description}</p>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{money(p.price_monthly, currency)}</td>
                        <td className="px-3 py-2.5">
                          <Badge>{TRIAL_LABELS[p.trial_kind] ?? p.trial_kind}</Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {p.trial_kind === "none" ? "—" : pct(p.trial_conversion)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{pct(p.adoption_rate)}</td>
                        <td className="px-3 py-2.5 text-right">mes {p.start_month}</td>
                        <td className="px-3 py-2.5 text-right">{p.ramp_months} m</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{pct(p.churn_rate)}</td>
                        <td className="px-3 py-2.5">
                          {p.upgrade_to_plan_id
                            ? <span>{planName[p.upgrade_to_plan_id] ?? p.upgrade_to_plan_id}
                                <span className="text-xs text-slate-400"> · {pct(p.upgrade_rate)}</span></span>
                            : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{num(p.included_token_credits, 0)}</td>
                        <td className="px-3 py-2.5">
                          <Badge tone={p.status}>{STATUS_LABELS[p.status] ?? p.status}</Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" onClick={() => startEditPlan(p)}>Editar</Button>
                            {p.status !== "archived" && (
                              <Button variant="ghost" onClick={() => archivePlan(p)}>Archivar</Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <p className="text-xs text-slate-400">
            MRR y suscriptores activos reconcilian con el último run: el motor congela los planes activos en el
            snapshot y emite las series; esta pantalla no calcula nada.
          </p>

          <Card>
            <CardBody>
              <p className="mb-3 text-sm font-semibold text-slate-800">Motor de suscripciones</p>
              <div className="grid gap-x-4 gap-y-5 md:grid-cols-2">
                {renderAssumption("subs.enabled", "Suscripciones (subs.enabled)", true)}
                {renderAssumption("subs.detail.enabled", "Modo detallado por plan y trial (subs.detail.enabled)", true)}
              </div>
              <p className="mt-3 text-xs text-slate-400">
                Con el modo detallado apagado, el motor usa la rama agregada (adopción única sin trials ni churn por
                plan); encendido y con planes activos, cada plan aporta trials, conversiones, churn y upgrades al
                puente de MRR. Guarda y vuelve a simular para que el cambio entre a los runs.
              </p>
            </CardBody>
          </Card>
        </div>
      )}

      {/* ---------- Trials por cohorte (pantalla 47) ---------- */}
      {tab === "Trials por cohorte" && (
        <div className="space-y-5">
          <SectionTitle
            title="Trials por cohorte (pantalla 47)"
            subtitle="Cohortes de trial del último run exitoso: inicios, mes de decisión, conversiones y tasa por plan."
          />
          {runError && <ErrorState message={runError} onRetry={loadRun} />}
          {!runError && !runChecked && <Skeleton rows={4} />}
          {!runError && runChecked && !runData && noRunState}
          {!runError && runChecked && runData && cohorts.length === 0 && (
            <EmptyState
              title="Sin cohortes de trial"
              description="El último run no generó cohortes: activa subs.enabled y subs.detail.enabled en el tab Planes, configura planes con trial y vuelve a simular."
              action={<Button href={`/simulate/?project=${projectId}&scenario=${scenarioId}`}>Ir a simular</Button>}
            />
          )}
          {!runError && runChecked && runData && cohorts.length > 0 && (
            <Card>
              <div className="max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="bg-white px-5 py-3">Plan</th>
                      <th className="bg-white px-3 py-3">Tipo de trial</th>
                      <th className="bg-white px-3 py-3">Mes de cohorte</th>
                      <th className="bg-white px-3 py-3 text-right">Inicios</th>
                      <th className="bg-white px-3 py-3">Mes de decisión</th>
                      <th className="bg-white px-3 py-3 text-right">Conversiones</th>
                      <th className="bg-white px-3 py-3 text-right">Tasa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cohorts.map((c, i) => (
                      <tr key={`${c.plan_id}-${c.cohort_month}-${i}`} className="border-b border-slate-100 last:border-0">
                        <td className="px-5 py-2">{c.plan_name}</td>
                        <td className="px-3 py-2">
                          <Badge>{TRIAL_LABELS[c.trial_kind] ?? c.trial_kind}</Badge>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{monthOfIndex(c.cohort_month)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(c.starts, 1)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{monthOfIndex(c.decision_month)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(c.conversions, 1)}</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">{pct(c.conversion_rate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <p className="text-xs text-slate-400">
            sin tarjeta: 15 días (decide el mismo mes; el converso paga media mensualidad) · con tarjeta: 30 días
            (decide el mes siguiente; paga mensualidad completa)
          </p>

          <SectionTitle
            title="Suscripciones declaradas"
            subtitle="Registro operativo por cliente: no alimenta al motor en fase 6; la conciliación real-vs-plan llega en fase 7."
            right={
              <Button
                variant={showSubForm ? "secondary" : "primary"}
                onClick={() => { setShowSubForm((v) => !v); setSubFormError(null); }}
              >
                {showSubForm ? "Cerrar formulario" : "Nueva suscripción"}
              </Button>
            }
          />

          {showSubForm && (
            <Card>
              <CardBody>
                <p className="mb-4 text-sm font-semibold text-slate-800">Alta de suscripción declarada</p>
                <div className="grid gap-4 md:grid-cols-4">
                  <Field label="Cliente" required>
                    <select className={inputClass} value={subForm.client_id}
                      onChange={(e) => setSubForm((f) => ({ ...f, client_id: e.target.value }))}>
                      <option value="">Selecciona un cliente</option>
                      {clients.map((c) => <option key={c.id} value={c.id}>{c.trade_name || c.legal_name}</option>)}
                    </select>
                  </Field>
                  <Field label="Plan" required>
                    <select className={inputClass} value={subForm.plan_id}
                      onChange={(e) => setSubForm((f) => ({ ...f, plan_id: e.target.value }))}>
                      <option value="">Selecciona un plan</option>
                      {availablePlans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Fecha de inicio" required>
                    <input type="date" className={inputClass} value={subForm.start_date}
                      onChange={(e) => setSubForm((f) => ({ ...f, start_date: e.target.value }))} />
                  </Field>
                  <Field label="Fin del trial" hint="Vacío = sin trial (nace activa con MRR del plan)">
                    <input type="date" className={inputClass} value={subForm.trial_end}
                      onChange={(e) => setSubForm((f) => ({ ...f, trial_end: e.target.value }))} />
                  </Field>
                </div>
                {subFormError && <p className="mt-3 text-sm font-medium text-rose-600">{subFormError}</p>}
                <div className="mt-4 flex gap-2">
                  <Button onClick={createSubscription}
                    disabled={subPosting || !subForm.client_id || !subForm.plan_id || !subForm.start_date}>
                    {subPosting ? "Registrando…" : "Registrar suscripción"}
                  </Button>
                  <Button variant="secondary" onClick={() => { setShowSubForm(false); setSubFormError(null); }}>
                    Cancelar
                  </Button>
                </div>
              </CardBody>
            </Card>
          )}

          {subscriptions.length === 0 ? (
            <EmptyState
              title="Sin suscripciones declaradas"
              description="Registra la primera suscripción real por cliente; los periodos de trial de un mismo cliente no pueden solaparse."
            />
          ) : (
            <Card>
              <div className="max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="bg-white px-5 py-3">Cliente</th>
                      <th className="bg-white px-3 py-3">Plan</th>
                      <th className="bg-white px-3 py-3">Inicio</th>
                      <th className="bg-white px-3 py-3">Fin del trial</th>
                      <th className="bg-white px-3 py-3">Estado</th>
                      <th className="bg-white px-3 py-3 text-right">MRR</th>
                      <th className="bg-white px-3 py-3">Clasificación</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subscriptions.map((s) => {
                      const st = SUB_STATUS[s.status] ?? { label: s.status, tone: "default" };
                      return (
                        <tr key={s.id} className="border-b border-slate-100 last:border-0">
                          <td className="px-5 py-2">{clientName[s.client_id] ?? s.client_id}</td>
                          <td className="px-3 py-2">{planName[s.plan_id] ?? s.plan_id}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{s.start_date}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{s.trial_end ?? "—"}</td>
                          <td className="px-3 py-2"><Badge tone={st.tone}>{st.label}</Badge></td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(s.mrr, currency)}</td>
                          <td className="px-3 py-2"><Badge tone={s.source_type}>{s.source_type}</Badge></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ---------- MRR bridge (pantalla 62) ---------- */}
      {tab === "MRR bridge" && (
        <div className="space-y-5">
          <SectionTitle
            title="MRR bridge (pantalla 62)"
            subtitle="Puente mensual de MRR del último run exitoso: inicial + nuevo + expansión − contracción − perdido = final."
          />
          {runError && <ErrorState message={runError} onRetry={loadRun} />}
          {!runError && !runChecked && <Skeleton rows={4} />}
          {!runError && runChecked && !runData && noRunState}
          {!runError && runChecked && runData && !detailOn && (
            <>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                <p className="font-semibold">El motor detallado de suscripciones está apagado</p>
                <p className="mt-0.5">
                  Sin <span className="font-mono">subs.detail.enabled</span> el run solo emite el ingreso agregado
                  de suscripciones; el puente de MRR por plan (nuevo, expansión, contracción, churn) requiere el
                  modo detallado y al menos un plan activo.
                </p>
                <div className="mt-2">
                  <Button variant="secondary" onClick={() => setTab("Planes")}>
                    Activar en el tab Planes
                  </Button>
                </div>
              </div>
              <MetricTable months={months} metrics={metrics} rows={AGG_ROWS} currency={currency} />
            </>
          )}
          {!runError && runChecked && runData && detailOn && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <KpiCard label="MRR al cierre" value={money(lastOf("rev.mrr.end"), currency, true)}
                  hint={`rev.mrr.end al mes ${months.length}`} />
                <KpiCard label="Suscriptores activos" value={num(lastOf("subs.active_total"), 1)}
                  hint="subs.active_total (último mes)" />
                <KpiCard label="Conversiones (último mes)" value={num(lastOf("subs.conversions"), 1)}
                  hint="subs.conversions" />
              </div>
              <Card>
                <CardBody>
                  <p className="mb-3 text-sm font-semibold text-slate-800">
                    Altas de MRR (nuevo + expansión) vs bajas (contracción + perdido)
                  </p>
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={bridgeData}>
                        <XAxis dataKey="mes" tick={{ fontSize: 10 }} interval={tickInterval} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => money(v, currency, true)} width={80} />
                        <Tooltip formatter={(v: number) => money(v, currency)} />
                        <Legend />
                        <Bar dataKey="Nuevo" stackId="altas" fill="#713dff" />
                        <Bar dataKey="Expansión" stackId="altas" fill="#10b981" radius={[3, 3, 0, 0]} />
                        <Bar dataKey="Contracción" stackId="bajas" fill="#f59e0b" />
                        <Bar dataKey="Perdido" stackId="bajas" fill="#f43f5e" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardBody>
              </Card>
              <MetricTable months={months} metrics={metrics} rows={BRIDGE_ROWS} currency={currency} />
              <p className="text-xs text-slate-400">
                end = start + new + expansion − contracción − churned (valores del run): la identidad la garantiza
                el motor mes a mes; esta pantalla solo muestra las series.
              </p>
            </>
          )}
        </div>
      )}

      <p className="mt-6 text-xs text-slate-400">
        Porcentajes en decimal (0.25 = 25%). Las suscripciones declaradas son registro operativo append-only y no
        alimentan al motor en fase 6; cohortes, MRR y suscriptores provienen del último run exitoso — esta pantalla
        no calcula nada, solo muestra valores del servidor.
      </p>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><SubscriptionsHub /></Suspense>;
}
