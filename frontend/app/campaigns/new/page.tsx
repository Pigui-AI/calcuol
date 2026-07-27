"use client";
/** Pantalla 32 — Nueva campaña (fase 5). Ruta estática: /campaigns/new?project=
 *  Wizard de 3 pasos de captura (identidad, ventana, efectos) + resumen final y POST. */
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, CampaignT, Project } from "@/lib/api";
import { money, monthName, pct } from "@/lib/format";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, Field, SectionTitle, Skeleton,
  StepIndicator, inputClass,
} from "@/components/ui";

const STEPS = ["Identidad", "Ventana", "Efectos", "Resumen"];

const CAMPAIGN_TYPES: { value: string; label: string }[] = [
  { value: "conversion", label: "Conversión" },
  { value: "frecuencia", label: "Frecuencia" },
  { value: "ticket", label: "Ticket" },
  { value: "puntos_extra", label: "Puntos extra" },
  { value: "redencion", label: "Redención" },
  { value: "mixta", label: "Mixta" },
];

/** Catálogo campaign.* transcrito de backend/app/engine/assumptions.py (DEFAULTS, fase 5). */
const EFFECT_CATALOG: { key: string; label: string; def: string; unit: string; description: string }[] = [
  { key: "campaign.uplift.conversion_pct", label: "Uplift de conversión", def: "0", unit: "%",
    description: "Uplift relativo de conversión de compra durante la campaña" },
  { key: "campaign.uplift.frequency_pct", label: "Uplift de frecuencia", def: "0", unit: "%",
    description: "Uplift relativo de frecuencia de compra durante la campaña" },
  { key: "campaign.uplift.ticket_pct", label: "Uplift de ticket", def: "0", unit: "%",
    description: "Uplift relativo de ticket promedio durante la campaña" },
  { key: "campaign.points.extra_pct", label: "Puntos extra", def: "0", unit: "%",
    description: "Puntos extra sobre utilidad elegible, fondeados por Pigui" },
  { key: "campaign.redemption.uplift_pct", label: "Uplift de redención", def: "0", unit: "%",
    description: "Uplift aditivo de la tasa de redención/intención" },
  { key: "campaign.cost_monthly", label: "Costo mensual directo", def: "0", unit: "MXN",
    description: "Costo directo mensual de la campaña" },
];

const typeLabel = (value: string) =>
  CAMPAIGN_TYPES.find((t) => t.value === value)?.label ?? value;

/** Etiqueta de mes calendario para un índice 1..horizonte según project.start_month (AAAA-MM). */
function calLabel(project: Project, index: number): string {
  const [y, m] = project.start_month.split("-").map(Number);
  if (!y || !m || !Number.isFinite(index)) return `Mes ${index}`;
  const t = y * 12 + (m - 1) + (index - 1);
  return monthName(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`);
}

function NewCampaignWizard() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState(0);
  const [identity, setIdentity] = useState({ name: "", description: "", campaign_type: "conversion" });
  const [ventana, setVentana] = useState({ start_month: "1", end_month: "1" });
  const [effects, setEffects] = useState<Record<string, string>>(
    Object.fromEntries(EFFECT_CATALOG.map((e) => [e.key, e.def])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    if (!projectId) return;
    setLoadError(null);
    api.get<Project>(`/projects/${projectId}`)
      .then(setProject)
      .catch((e) => setLoadError(String((e as Error).message)));
  }, [projectId]);
  useEffect(load, [load]);

  if (!projectId) {
    return (
      <EmptyState
        title="Falta el parámetro ?project="
        description="Para crear una campaña primero selecciona un proyecto desde el listado."
        action={<Button href="/">Ir a proyectos</Button>}
      />
    );
  }
  if (loadError) return <ErrorState message={loadError} onRetry={load} />;
  if (!project) return <Skeleton rows={5} />;

  const horizon = project.horizon_months;
  const startNum = Number(ventana.start_month);
  const endNum = Number(ventana.end_month);

  const isModified = (key: string): boolean => {
    const def = EFFECT_CATALOG.find((e) => e.key === key)?.def ?? "0";
    const raw = (effects[key] ?? "").trim();
    if (raw === "" || raw === def) return false;
    const n = Number(raw);
    return Number.isNaN(n) ? true : n !== Number(def);
  };
  const changedEffects = EFFECT_CATALOG.filter((e) => isModified(e.key));

  const validateStep = (): boolean => {
    const e: Record<string, string> = {};
    if (step === 0) {
      if (!identity.name.trim()) e.name = "El nombre es obligatorio";
    }
    if (step === 1) {
      const inRange = (v: number) => Number.isInteger(v) && v >= 1 && v <= horizon;
      if (!inRange(startNum)) e.start_month = `Debe ser un número de mes entre 1 y ${horizon}`;
      if (!inRange(endNum)) e.end_month = `Debe ser un número de mes entre 1 y ${horizon}`;
      if (inRange(startNum) && inRange(endNum) && startNum > endNum) {
        e.end_month = "El mes final debe ser mayor o igual al mes inicial";
      }
    }
    if (step === 2) {
      for (const spec of EFFECT_CATALOG) {
        const raw = (effects[spec.key] ?? "").trim();
        if (raw === "") continue; // vacío = default
        const v = Number(raw);
        if (Number.isNaN(v)) e[spec.key] = "Valor numérico inválido";
        else if (spec.unit === "%" && !(v >= 0 && v <= 1)) e[spec.key] = "Porcentaje fuera de rango 0–100% (usar decimal 0–1)";
        else if (spec.unit === "MXN" && v < 0) e[spec.key] = "El valor no puede ser negativo";
      }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const next = () => {
    if (!validateStep()) return;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const submit = async () => {
    setSubmitting(true);
    setApiError(null);
    setFieldErrors({});
    try {
      const created = await api.post<CampaignT>(`/projects/${projectId}/campaigns`, {
        name: identity.name.trim(),
        description: identity.description,
        campaign_type: identity.campaign_type,
        start_month: startNum,
        end_month: endNum,
        effects: Object.fromEntries(changedEffects.map((e) => [e.key, effects[e.key].trim()])),
      });
      router.push(`/campaign/?project=${projectId}&id=${created.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        const detail = err.detail as { field_errors?: Record<string, string> } | string | null;
        if (detail && typeof detail === "object" && detail.field_errors) {
          setFieldErrors(detail.field_errors);
          setApiError("El servidor rechazó algunos valores (422). Revisa los campos marcados.");
        } else {
          setApiError(String(err.message));
        }
      } else {
        setApiError(String(err));
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link>{" / "}
        <Link href={`/project/?id=${projectId}`} className="hover:text-pigui-700">{project.name}</Link>
        {" / "}Nueva campaña
      </nav>
      <SectionTitle
        title="Nueva campaña"
        subtitle="Los efectos se guardan como supuestos versionados con alcance de campaña (defaults → proyecto → escenario → campaña)."
      />
      <StepIndicator steps={STEPS} current={step} />

      <Card>
        <CardBody className="space-y-4">
          {step === 0 && (
            <>
              <Field label="Nombre de la campaña" required error={errors.name}>
                <input className={inputClass} value={identity.name}
                  onChange={(e) => setIdentity({ ...identity, name: e.target.value })}
                  placeholder="Ej. Promo de lanzamiento" />
              </Field>
              <Field label="Descripción">
                <textarea className={inputClass} rows={2} value={identity.description}
                  onChange={(e) => setIdentity({ ...identity, description: e.target.value })} />
              </Field>
              <Field label="Tipo de campaña"
                hint="Etiqueta descriptiva para la UI; el motor lee los efectos configurados en el paso 3.">
                <select className={inputClass} value={identity.campaign_type}
                  onChange={(e) => setIdentity({ ...identity, campaign_type: e.target.value })}>
                  {CAMPAIGN_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </Field>
            </>
          )}

          {step === 1 && (
            <>
              <p className="text-sm text-slate-600">
                Ventana de actividad en meses del proyecto (1–{horizon}). Horizonte:{" "}
                <strong>{horizon} meses</strong> — {calLabel(project, 1)} a {calLabel(project, horizon)}.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Mes inicial" required error={errors.start_month}
                  hint={Number.isInteger(startNum) && startNum >= 1 && startNum <= horizon
                    ? `Mes ${startNum} · ${calLabel(project, startNum)}`
                    : `Número de mes entre 1 y ${horizon}`}>
                  <input type="number" min={1} max={horizon} className={inputClass}
                    value={ventana.start_month}
                    onChange={(e) => setVentana({ ...ventana, start_month: e.target.value })} />
                </Field>
                <Field label="Mes final" required error={errors.end_month}
                  hint={Number.isInteger(endNum) && endNum >= 1 && endNum <= horizon
                    ? `Mes ${endNum} · ${calLabel(project, endNum)}`
                    : `Número de mes entre 1 y ${horizon}`}>
                  <input type="number" min={1} max={horizon} className={inputClass}
                    value={ventana.end_month}
                    onChange={(e) => setVentana({ ...ventana, end_month: e.target.value })} />
                </Field>
              </div>
              <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
                Debe cumplirse 1 ≤ mes inicial ≤ mes final ≤ {horizon}. Un programa siempre activo
                usa todo el horizonte (1 a {horizon}).
              </p>
            </>
          )}

          {step === 2 && (
            <>
              <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
                Porcentajes en decimal (0.15 = 15%). Solo se enviarán las claves modificadas
                respecto al default; el resto hereda defaults → proyecto → escenario.
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                {EFFECT_CATALOG.map((spec) => (
                  <Field key={spec.key}
                    label={`${spec.label} (${spec.unit})`}
                    error={errors[spec.key] || fieldErrors[spec.key]}
                    hint={`${spec.description} · default ${spec.def}`}>
                    <div className="flex items-center gap-2">
                      <input className={inputClass} value={effects[spec.key]}
                        placeholder={spec.def}
                        onChange={(e) => setEffects({ ...effects, [spec.key]: e.target.value })} />
                      {isModified(spec.key) && <Badge tone="hipotesis">modificado</Badge>}
                    </div>
                    <span className="mt-1 block font-mono text-[11px] text-slate-400">{spec.key}</span>
                  </Field>
                ))}
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <p className="text-sm text-slate-600">
                Revisa la configuración. La campaña se crea en estado <Badge tone="draft">Borrador</Badge>{" "}
                y sus efectos quedan versionados (versión 1) con procedencia de captura manual.
              </p>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <dl className="space-y-1">
                  {([
                    ["Nombre", identity.name.trim() || "—"],
                    ["Tipo", typeLabel(identity.campaign_type)],
                    ["Descripción", identity.description.trim() || "—"],
                    ["Ventana", `Mes ${startNum} (${calLabel(project, startNum)}) – Mes ${endNum} (${calLabel(project, endNum)})`],
                  ] as [string, string][]).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 text-sm">
                      <dt className="text-slate-500">{k}</dt>
                      <dd className="text-right font-medium text-slate-800">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="mb-2 text-sm font-semibold text-slate-800">
                  Efectos a registrar ({changedEffects.length} de {EFFECT_CATALOG.length})
                </p>
                {changedEffects.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    Sin cambios: la campaña se creará con todos los efectos en su default (0), es decir,
                    sin impacto en el motor hasta que se editen en su detalle.
                  </p>
                ) : (
                  <dl className="space-y-1">
                    {changedEffects.map((spec) => (
                      <div key={spec.key} className="flex justify-between gap-3 text-sm">
                        <dt className="text-slate-500">{spec.label}</dt>
                        <dd className="text-right font-medium text-slate-800">
                          {spec.unit === "%" ? pct(effects[spec.key].trim()) : money(effects[spec.key].trim())}
                          <span className="ml-1 font-mono text-[11px] text-slate-400">{effects[spec.key].trim()}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
              {apiError && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                  <p className="font-medium">{apiError}</p>
                  {Object.keys(fieldErrors).length > 0 && (
                    <ul className="mt-1 list-inside list-disc text-xs">
                      {Object.entries(fieldErrors).map(([k, v]) => (
                        <li key={k}><span className="font-mono">{k}</span>: {v}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>

      <div className="mt-5 flex items-center justify-between">
        <Button variant="secondary" href={`/campaigns/?project=${projectId}`}>Cancelar</Button>
        <div className="flex gap-2">
          {step > 0 && <Button variant="secondary" onClick={back}>Volver</Button>}
          {step < STEPS.length - 1 && <Button onClick={next}>Continuar</Button>}
          {step === STEPS.length - 1 && (
            <Button onClick={submit} disabled={submitting}>
              {submitting ? "Creando…" : "Crear campaña"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><NewCampaignWizard /></Suspense>;
}
