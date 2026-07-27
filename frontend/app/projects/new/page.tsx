"use client";
/** Pantallas 02–06 — Asistente de creación de proyecto (5 pasos). */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, Project } from "@/lib/api";
import { money, pct } from "@/lib/format";
import { Badge, Button, Card, CardBody, Field, SectionTitle, StepIndicator, inputClass } from "@/components/ui";

const STEPS = ["Información general", "Base inicial", "Crecimiento y retención", "Modelo de ingresos", "Revisión"];
const DRAFT_KEY = "pigui.project.draft.v1";

const defaultState = {
  general: {
    name: "", description: "", owner: "ricardo", base_currency: "MXN",
    start_month: "2026-09", horizon_months: 60,
  },
  base: {
    initial_clients: "10", consumers_per_client: "120", initial_consumers: "",
    onboarding_capacity: "15",
  },
  growth: {
    curve_type: "logistic", curve_max: "300", curve_rate: "0.25", curve_inflection: "18",
    churn: "0.03", reactivation: "0.05", cac: "3500", budget: "60000",
    consumer_new_per_client: "18", consumer_churn: "0.06",
    conversion: "0.45", frequency: "1.8", ticket: "180", margin: "0.35",
  },
  revenue: {
    commission_enabled: true, pigui_pct: "0.25", points_pct: "0.05", business_pct: "0.70",
    stripe_share: "0.60", ar_lag: "1", ar_rate: "0.98",
    subs_enabled: false, subs_start: "13", subs_price: "499", subs_adoption: "0.30", subs_ramp: "6",
    tokens_enabled: false, tokens_start: "13", tokens_rev: "150", tokens_adoption: "0.40", tokens_cost: "0.40",
    opening_cash: "1000000", buffer: "0",
  },
};

type WizardState = typeof defaultState;

function toAssumptions(s: WizardState): Record<string, string> {
  const a: Record<string, string> = {
    "b2b.initial_clients": s.base.initial_clients || "0",
    "b2c.consumers_initial_per_client": s.base.consumers_per_client || "0",
    "b2b.onboarding_capacity_monthly": s.base.onboarding_capacity || "0",
    "b2b.curve.type": s.growth.curve_type,
    "b2b.curve.max_clients": s.growth.curve_max,
    "b2b.curve.rate": s.growth.curve_rate,
    "b2b.curve.inflection_month": s.growth.curve_inflection,
    "b2b.churn_rate": s.growth.churn,
    "b2b.reactivation_rate": s.growth.reactivation,
    "b2b.cac": s.growth.cac,
    "b2b.acquisition_budget_monthly": s.growth.budget,
    "b2c.new_consumers_per_client_monthly": s.growth.consumer_new_per_client,
    "b2c.consumer_churn_rate": s.growth.consumer_churn,
    "b2c.purchase_conversion": s.growth.conversion,
    "b2c.purchase_frequency": s.growth.frequency,
    "b2c.avg_ticket": s.growth.ticket,
    "b2c.margin_pct": s.growth.margin,
    "revenue.commission.enabled": String(s.revenue.commission_enabled),
    "revenue.commission.pigui_pct": s.revenue.pigui_pct,
    "revenue.commission.points_pct": s.revenue.points_pct,
    "revenue.commission.business_pct": s.revenue.business_pct,
    "payments.stripe_share": s.revenue.stripe_share,
    "payments.ar.collection_lag_months": s.revenue.ar_lag,
    "payments.ar.collection_rate": s.revenue.ar_rate,
    "subs.enabled": String(s.revenue.subs_enabled),
    "tokens.enabled": String(s.revenue.tokens_enabled),
    "finance.opening_cash": s.revenue.opening_cash || "0",
    "finance.operating_buffer": s.revenue.buffer || "0",
  };
  if (s.base.initial_consumers) a["b2c.initial_consumers"] = s.base.initial_consumers;
  if (s.revenue.subs_enabled) {
    a["subs.start_month"] = s.revenue.subs_start;
    a["subs.price_monthly"] = s.revenue.subs_price;
    a["subs.adoption_rate"] = s.revenue.subs_adoption;
    a["subs.ramp_months"] = s.revenue.subs_ramp;
  }
  if (s.revenue.tokens_enabled) {
    a["tokens.start_month"] = s.revenue.tokens_start;
    a["tokens.revenue_per_client_monthly"] = s.revenue.tokens_rev;
    a["tokens.adoption_rate"] = s.revenue.tokens_adoption;
    a["tokens.cost_pct"] = s.revenue.tokens_cost;
  }
  return a;
}

export default function NewProjectWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(defaultState);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setState({ ...defaultState, ...parsed.state });
        setStep(parsed.step ?? 0);
        setDraftSavedAt(parsed.savedAt ?? null);
      }
    } catch { /* borrador corrupto: ignorar */ }
  }, []);

  const saveDraft = (nextState = state, nextStep = step) => {
    const savedAt = new Date().toLocaleString("es-MX");
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ state: nextState, step: nextStep, savedAt }));
    setDraftSavedAt(savedAt);
  };

  const set = <K extends keyof WizardState>(section: K, patch: Partial<WizardState[K]>) => {
    setState((prev) => ({ ...prev, [section]: { ...prev[section], ...patch } }));
  };

  const validateStep = (): boolean => {
    const e: Record<string, string> = {};
    if (step === 0) {
      if (!state.general.name.trim()) e.name = "El nombre es obligatorio";
      if (!/^\d{4}-\d{2}$/.test(state.general.start_month)) e.start_month = "Formato AAAA-MM";
      if (![12, 36, 60].includes(Number(state.general.horizon_months))) e.horizon = "Horizonte permitido: 12, 36 o 60";
      if (!state.general.base_currency) e.currency = "Moneda requerida";
    }
    if (step === 1) {
      for (const [k, label] of [["initial_clients", "Clientes"], ["consumers_per_client", "Consumidores por cliente"], ["onboarding_capacity", "Capacidad"]] as const) {
        if (Number(state.base[k]) < 0 || state.base[k] === "") e[k] = `${label}: valor no negativo requerido`;
      }
    }
    if (step === 2) {
      const g = state.growth;
      for (const k of ["churn", "reactivation", "conversion", "margin", "consumer_churn"] as const) {
        const v = Number(g[k]);
        if (!(v >= 0 && v <= 1)) e[k] = "Debe estar entre 0 y 1 (0.05 = 5%)";
      }
      if (Number(g.curve_max) <= Number(state.base.initial_clients)) e.curve_max = "El máximo debe superar la base inicial";
      if (Number(g.cac) < 0) e.cac = "CAC no puede ser negativo";
      if (Number(g.curve_inflection) > Number(state.general.horizon_months)) e.curve_inflection = "La inflexión debe caer dentro del horizonte";
      if (Number(g.ticket) <= 0) e.ticket = "Ticket debe ser mayor a 0";
      if (Number(g.frequency) <= 0) e.frequency = "Frecuencia positiva requerida";
    }
    if (step === 3) {
      const r = state.revenue;
      const total = Number(r.pigui_pct) + Number(r.points_pct) + Number(r.business_pct);
      if (Math.abs(total - 1) > 1e-9) e.split = `Pigui + puntos + negocio deben sumar 100% (actual ${(total * 100).toFixed(1)}%)`;
      const ss = Number(r.stripe_share);
      if (!(ss >= 0 && ss <= 1)) e.stripe_share = "Entre 0 y 1";
      if (r.subs_enabled && Number(r.subs_start) < 1) e.subs_start = "Mes de activación requerido";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const next = () => {
    if (!validateStep()) return;
    saveDraft(state, Math.min(step + 1, STEPS.length - 1));
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const submit = async () => {
    setSubmitting(true);
    setApiError(null);
    try {
      const project = await api.post<Project>("/projects", {
        general: {
          name: state.general.name, description: state.general.description,
          owner: state.general.owner, base_currency: state.general.base_currency,
          start_month: state.general.start_month,
          horizon_months: Number(state.general.horizon_months),
        },
        assumptions: toAssumptions(state),
        create_default_scenarios: true,
      });
      localStorage.removeItem(DRAFT_KEY);
      router.push(`/project/?id=${project.id}`);
    } catch (err) {
      setApiError(err instanceof ApiError ? JSON.stringify(err.detail) : String(err));
      setSubmitting(false);
    }
  };

  const a = toAssumptions(state);

  return (
    <div className="mx-auto max-w-3xl">
      <SectionTitle title="Crear proyecto"
        subtitle="Asistente de configuración — los valores se guardan como supuestos versionados." />
      <StepIndicator steps={STEPS} current={step} />

      <Card>
        <CardBody className="space-y-4">
          {step === 0 && (
            <>
              <Field label="Nombre del proyecto" required error={errors.name}>
                <input className={inputClass} value={state.general.name}
                  onChange={(e) => set("general", { name: e.target.value })}
                  placeholder="Ej. Pigui — Plan 2027" />
              </Field>
              <Field label="Descripción">
                <textarea className={inputClass} rows={2} value={state.general.description}
                  onChange={(e) => set("general", { description: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <Field label="Responsable">
                  <input className={inputClass} value={state.general.owner}
                    onChange={(e) => set("general", { owner: e.target.value })} />
                </Field>
                <Field label="Mes de inicio" required error={errors.start_month} hint="AAAA-MM">
                  <input className={inputClass} value={state.general.start_month}
                    onChange={(e) => set("general", { start_month: e.target.value })} />
                </Field>
                <Field label="Horizonte" required error={errors.horizon}>
                  <select className={inputClass} value={state.general.horizon_months}
                    onChange={(e) => set("general", { horizon_months: Number(e.target.value) })}>
                    <option value={12}>12 meses</option>
                    <option value={36}>36 meses</option>
                    <option value={60}>60 meses</option>
                  </select>
                </Field>
                <Field label="Moneda" required error={errors.currency}>
                  <select className={inputClass} value={state.general.base_currency}
                    onChange={(e) => set("general", { base_currency: e.target.value })}>
                    <option>MXN</option><option>USD</option>
                  </select>
                </Field>
              </div>
              <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
                Ruta de captura: este asistente crea el proyecto desde cero. La importación con IA
                (XLSX/CSV/PDF/DOCX) está planeada en la Fase 8 del roadmap y la arquitectura ya la contempla.
              </p>
            </>
          )}

          {step === 1 && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Clientes B2B activos al inicio" required error={errors.initial_clients}
                  hint="Si el proyecto ya tiene clientes reales cargados, el motor usa el mayor de los dos.">
                  <input type="number" min={0} className={inputClass} value={state.base.initial_clients}
                    onChange={(e) => set("base", { initial_clients: e.target.value })} />
                </Field>
                <Field label="Consumidores activos por cliente" required error={errors.consumers_per_client}>
                  <input type="number" min={0} className={inputClass} value={state.base.consumers_per_client}
                    onChange={(e) => set("base", { consumers_per_client: e.target.value })} />
                </Field>
                <Field label="Consumidores activos totales (opcional)"
                  hint="Si se deja vacío: clientes × consumidores por cliente.">
                  <input type="number" min={0} className={inputClass} value={state.base.initial_consumers}
                    onChange={(e) => set("base", { initial_consumers: e.target.value })} />
                </Field>
                <Field label="Capacidad de onboarding (clientes/mes)" required error={errors.onboarding_capacity}>
                  <input type="number" min={0} className={inputClass} value={state.base.onboarding_capacity}
                    onChange={(e) => set("base", { onboarding_capacity: e.target.value })} />
                </Field>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-sm font-semibold text-slate-700">Crecimiento B2B</p>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <Field label="Tipo de curva">
                  <select className={inputClass} value={state.growth.curve_type}
                    onChange={(e) => set("growth", { curve_type: e.target.value })}>
                    <option value="linear">Lineal</option>
                    <option value="exponential">Exponencial</option>
                    <option value="logistic">Logística</option>
                    <option value="decelerated">Desacelerada</option>
                  </select>
                </Field>
                <Field label="Máximo de clientes" error={errors.curve_max}>
                  <input type="number" className={inputClass} value={state.growth.curve_max}
                    onChange={(e) => set("growth", { curve_max: e.target.value })} />
                </Field>
                <Field label="Tasa / velocidad" hint="Lineal: altas por mes">
                  <input className={inputClass} value={state.growth.curve_rate}
                    onChange={(e) => set("growth", { curve_rate: e.target.value })} />
                </Field>
                <Field label="Mes de inflexión" error={errors.curve_inflection}>
                  <input type="number" className={inputClass} value={state.growth.curve_inflection}
                    onChange={(e) => set("growth", { curve_inflection: e.target.value })} />
                </Field>
                <Field label="Churn mensual B2B" error={errors.churn} hint="0.03 = 3%">
                  <input className={inputClass} value={state.growth.churn}
                    onChange={(e) => set("growth", { churn: e.target.value })} />
                </Field>
                <Field label="Reactivación mensual" error={errors.reactivation}>
                  <input className={inputClass} value={state.growth.reactivation}
                    onChange={(e) => set("growth", { reactivation: e.target.value })} />
                </Field>
                <Field label="CAC (por cliente activado)" error={errors.cac}>
                  <input type="number" className={inputClass} value={state.growth.cac}
                    onChange={(e) => set("growth", { cac: e.target.value })} />
                </Field>
                <Field label="Presupuesto adquisición/mes">
                  <input type="number" className={inputClass} value={state.growth.budget}
                    onChange={(e) => set("growth", { budget: e.target.value })} />
                </Field>
              </div>
              <p className="mt-2 text-sm font-semibold text-slate-700">Adopción y comportamiento B2C</p>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <Field label="Nuevos consumidores por cliente/mes">
                  <input className={inputClass} value={state.growth.consumer_new_per_client}
                    onChange={(e) => set("growth", { consumer_new_per_client: e.target.value })} />
                </Field>
                <Field label="Churn mensual consumidores" error={errors.consumer_churn}>
                  <input className={inputClass} value={state.growth.consumer_churn}
                    onChange={(e) => set("growth", { consumer_churn: e.target.value })} />
                </Field>
                <Field label="Conversión a compra" error={errors.conversion} hint="0.45 = 45%">
                  <input className={inputClass} value={state.growth.conversion}
                    onChange={(e) => set("growth", { conversion: e.target.value })} />
                </Field>
                <Field label="Frecuencia (tx/comprador/mes)" error={errors.frequency}>
                  <input className={inputClass} value={state.growth.frequency}
                    onChange={(e) => set("growth", { frequency: e.target.value })} />
                </Field>
                <Field label="Ticket promedio" error={errors.ticket}>
                  <input className={inputClass} value={state.growth.ticket}
                    onChange={(e) => set("growth", { ticket: e.target.value })} />
                </Field>
                <Field label="Margen elegible" error={errors.margin} hint="0.35 = 35% sobre venta">
                  <input className={inputClass} value={state.growth.margin}
                    onChange={(e) => set("growth", { margin: e.target.value })} />
                </Field>
              </div>
              <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
                Nota: si el portafolio del proyecto tiene clientes con línea base, el motor estima ticket,
                margen, frecuencia y consumidores por cliente a partir del portafolio (dato “estimado”)
                y estos supuestos quedan como respaldo.
              </p>
            </>
          )}

          {step === 3 && (
            <>
              <div className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div>
                  <p className="text-sm font-semibold text-slate-800">Motor de comisiones sobre utilidad</p>
                  <p className="text-xs text-slate-500">Distribución de la utilidad elegible de cada transacción.</p>
                </div>
                <input type="checkbox" checked={state.revenue.commission_enabled}
                  onChange={(e) => set("revenue", { commission_enabled: e.target.checked })}
                  className="h-5 w-5 accent-pigui-600" />
              </div>
              {errors.split && <p className="text-xs font-medium text-rose-600">{errors.split}</p>}
              <div className="grid grid-cols-3 gap-4">
                <Field label="Pigui %" hint="0.25 = 25%">
                  <input className={inputClass} value={state.revenue.pigui_pct}
                    onChange={(e) => set("revenue", { pigui_pct: e.target.value })} />
                </Field>
                <Field label="Puntos al consumidor %">
                  <input className={inputClass} value={state.revenue.points_pct}
                    onChange={(e) => set("revenue", { points_pct: e.target.value })} />
                </Field>
                <Field label="Negocio %">
                  <input className={inputClass} value={state.revenue.business_pct}
                    onChange={(e) => set("revenue", { business_pct: e.target.value })} />
                </Field>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <Field label="Parte cobrada vía Pigui Scan/Stripe" error={errors.stripe_share} hint="El resto genera cuentas por cobrar">
                  <input className={inputClass} value={state.revenue.stripe_share}
                    onChange={(e) => set("revenue", { stripe_share: e.target.value })} />
                </Field>
                <Field label="Rezago de cobro AR (meses)">
                  <input type="number" min={0} className={inputClass} value={state.revenue.ar_lag}
                    onChange={(e) => set("revenue", { ar_lag: e.target.value })} />
                </Field>
                <Field label="Tasa de cobro AR" hint="0.98 = 2% incobrable">
                  <input className={inputClass} value={state.revenue.ar_rate}
                    onChange={(e) => set("revenue", { ar_rate: e.target.value })} />
                </Field>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div>
                  <p className="text-sm font-semibold text-slate-800">Suscripciones (motor futuro activable)</p>
                  <p className="text-xs text-slate-500">MRR desde el mes configurado, con rampa de adopción.</p>
                </div>
                <input type="checkbox" checked={state.revenue.subs_enabled}
                  onChange={(e) => set("revenue", { subs_enabled: e.target.checked })}
                  className="h-5 w-5 accent-pigui-600" />
              </div>
              {state.revenue.subs_enabled && (
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <Field label="Mes de activación" error={errors.subs_start}>
                    <input type="number" min={1} className={inputClass} value={state.revenue.subs_start}
                      onChange={(e) => set("revenue", { subs_start: e.target.value })} />
                  </Field>
                  <Field label="Precio mensual">
                    <input type="number" className={inputClass} value={state.revenue.subs_price}
                      onChange={(e) => set("revenue", { subs_price: e.target.value })} />
                  </Field>
                  <Field label="Adopción (0–1)">
                    <input className={inputClass} value={state.revenue.subs_adoption}
                      onChange={(e) => set("revenue", { subs_adoption: e.target.value })} />
                  </Field>
                  <Field label="Rampa (meses)">
                    <input type="number" min={1} className={inputClass} value={state.revenue.subs_ramp}
                      onChange={(e) => set("revenue", { subs_ramp: e.target.value })} />
                  </Field>
                </div>
              )}

              <div className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div>
                  <p className="text-sm font-semibold text-slate-800">IA y tokens (motor futuro activable)</p>
                  <p className="text-xs text-slate-500">Ingreso por consumo de IA con costo de proveedor.</p>
                </div>
                <input type="checkbox" checked={state.revenue.tokens_enabled}
                  onChange={(e) => set("revenue", { tokens_enabled: e.target.checked })}
                  className="h-5 w-5 accent-pigui-600" />
              </div>
              {state.revenue.tokens_enabled && (
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <Field label="Mes de activación">
                    <input type="number" min={1} className={inputClass} value={state.revenue.tokens_start}
                      onChange={(e) => set("revenue", { tokens_start: e.target.value })} />
                  </Field>
                  <Field label="Ingreso por cliente/mes">
                    <input type="number" className={inputClass} value={state.revenue.tokens_rev}
                      onChange={(e) => set("revenue", { tokens_rev: e.target.value })} />
                  </Field>
                  <Field label="Adopción (0–1)">
                    <input className={inputClass} value={state.revenue.tokens_adoption}
                      onChange={(e) => set("revenue", { tokens_adoption: e.target.value })} />
                  </Field>
                  <Field label="Costo proveedor (0–1)">
                    <input className={inputClass} value={state.revenue.tokens_cost}
                      onChange={(e) => set("revenue", { tokens_cost: e.target.value })} />
                  </Field>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <Field label="Caja inicial">
                  <input type="number" className={inputClass} value={state.revenue.opening_cash}
                    onChange={(e) => set("revenue", { opening_cash: e.target.value })} />
                </Field>
                <Field label="Buffer operativo (funding need)">
                  <input type="number" className={inputClass} value={state.revenue.buffer}
                    onChange={(e) => set("revenue", { buffer: e.target.value })} />
                </Field>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <p className="text-sm text-slate-600">
                Revisa la configuración. Al crear, el proyecto congela una versión inicial del escenario
                <strong> Base</strong> y genera <strong>Conservador</strong> y <strong>Optimista</strong> como
                derivados con overrides explícitos. El preview aún no es un run oficial.
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                <ReviewCard title="1 · Información general" onEdit={() => setStep(0)} items={[
                  ["Nombre", state.general.name || "—"],
                  ["Inicio / horizonte", `${state.general.start_month} · ${state.general.horizon_months} meses`],
                  ["Moneda", state.general.base_currency],
                ]} />
                <ReviewCard title="2 · Base inicial" onEdit={() => setStep(1)} items={[
                  ["Clientes B2B", state.base.initial_clients],
                  ["Consumidores/cliente", state.base.consumers_per_client],
                  ["Capacidad onboarding", `${state.base.onboarding_capacity}/mes`],
                ]} />
                <ReviewCard title="3 · Crecimiento y retención" onEdit={() => setStep(2)} items={[
                  ["Curva", `${state.growth.curve_type} → máx ${state.growth.curve_max}`],
                  ["Churn B2B / B2C", `${pct(state.growth.churn)} / ${pct(state.growth.consumer_churn)}`],
                  ["CAC / presupuesto", `${money(state.growth.cac)} / ${money(state.growth.budget)} mes`],
                  ["Ticket · conversión · frecuencia", `${money(state.growth.ticket)} · ${pct(state.growth.conversion)} · ${state.growth.frequency}`],
                ]} />
                <ReviewCard title="4 · Modelo de ingresos" onEdit={() => setStep(3)} items={[
                  ["Comisiones", state.revenue.commission_enabled
                    ? `Pigui ${pct(state.revenue.pigui_pct)} · puntos ${pct(state.revenue.points_pct)} · negocio ${pct(state.revenue.business_pct)}`
                    : "Desactivadas"],
                  ["Ruta Stripe / caja", `${pct(state.revenue.stripe_share)} / ${pct(String(1 - Number(state.revenue.stripe_share)))}`],
                  ["Suscripciones", state.revenue.subs_enabled ? `Desde mes ${state.revenue.subs_start} · ${money(state.revenue.subs_price)}` : "Desactivadas"],
                  ["IA/tokens", state.revenue.tokens_enabled ? `Desde mes ${state.revenue.tokens_start}` : "Desactivado"],
                  ["Caja inicial", money(state.revenue.opening_cash)],
                ]} />
              </div>
              <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
                Se registrarán {Object.keys(a).length} supuestos como <Badge tone="declarado">declarado</Badge> a nivel
                proyecto, con versionado y auditoría. Siguiente paso sugerido: agregar clientes B2B al portafolio.
              </div>
              {apiError && <p className="text-sm font-medium text-rose-600">{apiError}</p>}
            </>
          )}
        </CardBody>
      </Card>

      <div className="mt-5 flex items-center justify-between">
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => { saveDraft(); }}>Guardar borrador</Button>
          {draftSavedAt && <span className="self-center text-xs text-slate-400">Borrador guardado: {draftSavedAt}</span>}
        </div>
        <div className="flex gap-2">
          {step > 0 && <Button variant="secondary" onClick={back}>Volver</Button>}
          {step < STEPS.length - 1 && <Button onClick={next}>Guardar y continuar</Button>}
          {step === STEPS.length - 1 && (
            <Button onClick={submit} disabled={submitting}>
              {submitting ? "Creando…" : "Crear proyecto y continuar"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewCard({ title, items, onEdit }:
  { title: string; items: [string, string][]; onEdit: () => void }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        <button onClick={onEdit} className="text-xs font-medium text-pigui-700 hover:underline">Editar</button>
      </div>
      <dl className="space-y-1">
        {items.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 text-sm">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-right font-medium text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
