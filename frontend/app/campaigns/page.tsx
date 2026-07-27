"use client";
/** Pantallas 31, 34–37 — Hub de campañas y recompensas (fase 5). Ruta estática: /campaigns?project=&scenario= */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, Legend,
} from "recharts";
import { api, ApiError, Assumption, CampaignT, CampaignsPreview, Project } from "@/lib/api";
import { money, num, monthName, STATUS_LABELS } from "@/lib/format";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, KpiCard, SectionTitle, Skeleton, inputClass,
} from "@/components/ui";

const TABS = ["Portafolio", "Recompensas", "Redención", "Pasivo de puntos", "Impacto y ROI"] as const;

const TYPE_LABELS: Record<string, string> = {
  conversion: "Conversión",
  frecuencia: "Frecuencia",
  ticket: "Ticket",
  puntos_extra: "Puntos extra",
  redencion: "Redención",
  mixta: "Mixta",
};

const FUNNEL_KEYS: { key: string; label: string; bool?: boolean }[] = [
  { key: "points.funnel.enabled", label: "Embudo de redención activo", bool: true },
  { key: "points.funnel.intent_rate", label: "Intención mensual de redención" },
  { key: "points.funnel.redemption_conversion", label: "Conversión de intentos a redenciones" },
  { key: "points.funnel.expiry_months", label: "Edad de expiración (meses, FIFO)" },
];

function isTrue(v: string): boolean {
  return ["true", "1", "yes", "si", "sí", "on"].includes(v.trim().toLowerCase());
}

function originTone(origin: string): string {
  return origin === "escenario" ? "hipotesis" : origin === "proyecto" ? "declarado" : "default";
}

function CampaignsHub() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";
  const scenarioId = params.get("scenario") ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [preview, setPreview] = useState<CampaignsPreview | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignT[] | null>(null);
  const [assumptions, setAssumptions] = useState<Assumption[] | null>(null);
  const [noProjects, setNoProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Portafolio");
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
          router.replace(`/campaigns/?project=${p.id}&scenario=${p.scenarios[0].id}`);
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
      api.get<CampaignT[]>(`/projects/${projectId}/campaigns`),
      api.get<CampaignsPreview>(`/projects/${projectId}/scenarios/${scenarioId}/campaigns-preview`),
      api.get<{ assumptions: Assumption[] }>(`/scenarios/${scenarioId}/assumptions`),
    ])
      .then(([p, cs, pv, asm]) => {
        setProject(p); setCampaigns(cs); setPreview(pv); setAssumptions(asm.assumptions);
      })
      .catch((e) => setError(String(e.message)));
  }, [projectId, scenarioId]);
  useEffect(load, [load]);
  useEffect(() => { setEdits({}); setSaveError(null); }, [scenarioId]);

  const amap = useMemo(() => {
    const out: Record<string, Assumption> = {};
    (assumptions ?? []).forEach((a) => { out[a.key] = a; });
    return out;
  }, [assumptions]);

  const dirty = Object.keys(edits).length > 0;

  const setEdit = (key: string, v: string, original: string) => {
    setEdits((prev) => {
      const next = { ...prev };
      if (v === original) delete next[key];
      else next[key] = v;
      return next;
    });
  };

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

  const changeStatus = async (c: CampaignT, status: string) => {
    if (status === "archived" && !window.confirm(`¿Archivar la campaña “${c.name}”? No podrá volver a activarse.`)) return;
    setSaveError(null);
    try {
      await api.patch<CampaignT>(`/campaigns/${c.id}`, { status });
      load();
    } catch (e) {
      setSaveError(e instanceof ApiError ? String(e.message) : String(e));
    }
  };

  const redemptionData = useMemo(() => {
    if (!preview) return [];
    return preview.months.map((m, i) => ({
      mes: monthName(m),
      Emitidos: parseFloat(preview.metrics["points.emitted"]?.[i] ?? "0"),
      Intentos: parseFloat(preview.metrics["points.funnel.intents"]?.[i] ?? "0"),
      Redimidos: parseFloat(preview.metrics["points.redeemed"]?.[i] ?? "0"),
      Expirados: parseFloat(preview.metrics["points.expired"]?.[i] ?? "0"),
    }));
  }, [preview]);

  const liabilityData = useMemo(() => {
    if (!preview) return [];
    return preview.months.map((m, i) => ({
      mes: monthName(m),
      "Saldo de puntos": parseFloat(preview.metrics["points.balance_end"]?.[i] ?? "0"),
    }));
  }, [preview]);

  const impactData = useMemo(() => {
    if (!preview) return [];
    return preview.months.map((m, i) => ({
      mes: monthName(m),
      "GMV incremental": parseFloat(preview.metrics["camp.gmv_incremental"]?.[i] ?? "0"),
      "Costo de campañas": parseFloat(preview.metrics["cost.campaigns"]?.[i] ?? "0"),
    }));
  }, [preview]);

  const roiData = useMemo(() => {
    if (!preview) return [];
    return preview.months.map((m, i) => ({
      mes: monthName(m),
      ROI: parseFloat(preview.metrics["camp.roi"]?.[i] ?? "0"),
    }));
  }, [preview]);

  if (!projectId || !scenarioId) {
    if (noProjects) {
      return (
        <EmptyState
          title="Aún no hay proyectos"
          description="Crea tu primer proyecto para configurar campañas, recompensas y el embudo de redención de puntos."
          action={<Button href="/projects/new/">Crear proyecto</Button>}
        />
      );
    }
    if (error) return <ErrorState message={error} />;
    return <Skeleton rows={5} />;
  }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!project || !preview || !campaigns || !assumptions) return <Skeleton rows={5} />;

  const currency = project.base_currency;
  const activeCampaigns = campaigns.filter((c) => c.status === "active");
  const s = preview.summary_campaigns;
  const balanceSeries = preview.metrics["points.balance_end"] ?? [];
  const finalBalance = [...balanceSeries].reverse().find((v) => v != null) ?? null;
  const eligibleShare = amap["rewards.eligible_share"];
  const gatingOn = isTrue(edits["rewards.catalog_gating.enabled"] ?? amap["rewards.catalog_gating.enabled"]?.value ?? "false");
  const tickInterval = Math.ceil(preview.months.length / 16);

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
        {" / "}Campañas y recompensas
      </nav>
      <SectionTitle
        title="Campañas y recompensas"
        subtitle={`Portafolio, catálogo elegible, embudo de redención y ROI · motor v${preview.engine_version}`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            {savedAt && !dirty && <span className="text-xs text-emerald-600">Guardado {savedAt}</span>}
            <Button onClick={save} disabled={!dirty || saving}>
              {saving ? "Guardando…" : `Guardar cambios${dirty ? ` (${Object.keys(edits).length})` : ""}`}
            </Button>
            <select
              className={`${inputClass} !w-auto`}
              value={scenarioId}
              onChange={(e) => router.replace(`/campaigns/?project=${project.id}&scenario=${e.target.value}`)}
            >
              {project.scenarios.map((sc) => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
            </select>
          </div>
        }
      />
      {saveError && <p className="mb-3 text-sm font-medium text-rose-600">{saveError}</p>}

      {!preview.campaigns_enabled && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <p className="font-semibold">El motor de campañas está apagado</p>
          <p className="mt-0.5">
            Las campañas no afectan las simulaciones formales; este preview lo fuerza encendido.
            Activa el toggle maestro <span className="font-mono">campaigns.enabled</span> en la pestaña Portafolio
            y guarda para que las campañas entren a los runs.
          </p>
        </div>
      )}

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg border border-slate-200 bg-white p-1">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${tab === t ? "bg-pigui-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === "Portafolio" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label="GMV incremental total" value={money(s.total_gmv_incremental, currency, true)}
              hint="Suma del horizonte (preview)" />
            <KpiCard label="Gasto total en campañas" value={money(s.total_spend, currency, true)}
              hint="Costo directo + puntos extra" />
            <KpiCard label="ROI total" value={num(s.roi_total, 2)}
              hint="Comisión incremental / gasto total" />
            <KpiCard label="Campañas activas" value={num(activeCampaigns.length, 0)}
              hint={`${campaigns.length} en el portafolio`} />
          </div>

          <SectionTitle
            title="Portafolio de campañas (pantalla 31)"
            subtitle="Los efectos numéricos de cada campaña viven como supuestos versionados con alcance de campaña."
            right={<Button href={`/campaigns/new/?project=${projectId}`}>+ Nueva campaña</Button>}
          />

          {campaigns.length === 0 ? (
            <EmptyState
              title="Aún no hay campañas"
              description="Crea la primera campaña para modelar uplifts de conversión, frecuencia, ticket, puntos extra o redención."
              action={<Button href={`/campaigns/new/?project=${projectId}`}>+ Nueva campaña</Button>}
            />
          ) : (
            <Card>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-5 py-3">Campaña</th>
                    <th className="px-3 py-3">Tipo</th>
                    <th className="px-3 py-3">Ventana</th>
                    <th className="px-3 py-3">Estado</th>
                    <th className="px-3 py-3 text-right">Costo mensual</th>
                    <th className="px-3 py-3 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-5 py-2.5">
                        <p className="font-medium text-slate-800">{c.name}</p>
                        {c.description && <p className="text-xs text-slate-400">{c.description}</p>}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge>{TYPE_LABELS[c.campaign_type] ?? c.campaign_type}</Badge>
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">mes {c.start_month}–{c.end_month}</td>
                      <td className="px-3 py-2.5">
                        <Badge tone={c.status}>{STATUS_LABELS[c.status] ?? c.status}</Badge>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {money(c.effects?.["campaign.cost_monthly"]?.value, currency)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {c.status === "draft" && (
                            <Button variant="ghost" onClick={() => changeStatus(c, "active")}>Activar</Button>
                          )}
                          {c.status === "active" && (
                            <Button variant="ghost" onClick={() => changeStatus(c, "archived")}>Archivar</Button>
                          )}
                          <Button variant="secondary" href={`/campaign/?project=${projectId}&id=${c.id}`}>Abrir</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <Card>
            <CardBody>
              <p className="mb-3 text-sm font-semibold text-slate-800">Toggle maestro del motor de campañas</p>
              <div className="grid gap-x-4 gap-y-5 md:grid-cols-3">
                {renderAssumption("campaigns.enabled", "Motor de campañas (campaigns.enabled)", true)}
              </div>
              <p className="mt-3 text-xs text-slate-400">
                Solo las campañas con estado “Activo” entran al snapshot del run; con el motor apagado ninguna
                campaña afecta los resultados (todas las métricas camp.* se emiten en cero).
              </p>
            </CardBody>
          </Card>
        </div>
      )}

      {tab === "Recompensas" && (
        <div className="space-y-5">
          <SectionTitle
            title="Recompensas y catálogo elegible (pantalla 34)"
            subtitle="Limita la emisión de puntos a la utilidad de los productos marcados como elegibles para rewards."
          />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <KpiCard label="Share elegible efectivo"
              value={num(preview.derived_inputs?.["rewards.eligible_share"]?.to ?? eligibleShare?.value, 2)}
              hint={preview.derived_inputs?.["rewards.eligible_share"]
                ? "Derivado del catálogo (portafolio real)" : "Proporción de la utilidad elegible que emite puntos"} />
            <KpiCard label="Gating de catálogo" value={gatingOn ? "Encendido" : "Apagado"}
              tone={gatingOn ? "good" : "muted"} />
            <KpiCard label="Puntos emitidos (último mes del preview)"
              value={num([...(preview.metrics["points.emitted"] ?? [])].reverse().find((v) => v != null) ?? null, 0)}
              hint="Valor del motor; el total del horizonte se ve en la pestaña Redención" />
          </div>
          <Card>
            <CardBody>
              <div className="grid gap-x-4 gap-y-5 md:grid-cols-3">
                {renderAssumption("rewards.catalog_gating.enabled", "Gating por catálogo elegible", true)}
                {renderAssumption("rewards.eligible_share", "Share de utilidad elegible")}
              </div>
            </CardBody>
          </Card>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            <p className="font-semibold text-slate-700">¿De dónde sale el share elegible?</p>
            <p className="mt-0.5">
              Con el gating activo, el motor puede derivar <span className="font-mono">rewards.eligible_share</span> del
              catálogo real: la proporción de precio de venta de los productos marcados
              como <span className="font-mono">reward_eligible</span> sobre el catálogo activo de los clientes del
              proyecto (aparece como valor derivado con fuente “portafolio (real)”). El valor editado aquí actúa como
              hipótesis manual; el residuo no elegible regresa al negocio y la
              distribución comisión + puntos + negocio se conserva exacta.
            </p>
          </div>
        </div>
      )}

      {tab === "Redención" && (
        <div className="space-y-5">
          <SectionTitle
            title="Embudo de redención (pantalla 35)"
            subtitle="Emitidos → intentos → redimidos → expirados, mes a mes, según el preview del motor."
          />
          <Card>
            <CardBody>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={redemptionData}>
                    <XAxis dataKey="mes" tick={{ fontSize: 10 }} interval={tickInterval} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => num(v, 0)} width={60} />
                    <Tooltip formatter={(v: number) => num(v, 1)} />
                    <Legend />
                    <Bar dataKey="Emitidos" fill="#713dff" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Intentos" fill="#94a3b8" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Redimidos" fill="#10b981" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Expirados" fill="#f43f5e" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <p className="mb-3 text-sm font-semibold text-slate-800">Supuestos del embudo</p>
              <div className="grid gap-x-4 gap-y-5 md:grid-cols-2">
                {FUNNEL_KEYS.map((def) => renderAssumption(def.key, def.label, def.bool))}
              </div>
              <p className="mt-3 text-xs text-slate-500">
                0.50 × 0.70 = 0.35 (la tasa plana actual): activar el embudo con los defaults preserva la redención
                esperada mes a mes; con el embudo la expiración pasa a régimen FIFO por edad (expiran primero los
                puntos más antiguos que superan la edad configurada).
              </p>
            </CardBody>
          </Card>
        </div>
      )}

      {tab === "Pasivo de puntos" && (
        <div className="space-y-5">
          <SectionTitle
            title="Pasivo de puntos (pantalla 36)"
            subtitle="Saldo de puntos vivos al cierre de cada mes: la obligación pendiente con los consumidores."
          />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label="Pasivo final de puntos" value={num(finalBalance, 0)}
              hint={`points.balance_end al mes ${preview.months.length}`} />
          </div>
          <Card>
            <CardBody>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={liabilityData}>
                    <XAxis dataKey="mes" tick={{ fontSize: 10 }} interval={tickInterval} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => num(v, 0)} width={60} />
                    <Tooltip formatter={(v: number) => num(v, 1)} />
                    <Legend />
                    <Area dataKey="Saldo de puntos" stroke="#713dff" fill="#713dff" fillOpacity={0.15} strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardBody>
          </Card>
          <p className="text-xs text-slate-400">
            Reconciliación del ledger: saldo anterior + emitidos + puntos extra de campaña − redimidos − expirados.
            El servidor calcula toda la serie; esta pantalla solo la pinta.
          </p>
        </div>
      )}

      {tab === "Impacto y ROI" && (
        <div className="space-y-5">
          <SectionTitle
            title="Impacto y ROI de campañas (pantalla 37)"
            subtitle="GMV incremental contra costo de campañas y ROI mensual, según el preview del motor."
          />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <KpiCard label="Gasto total" value={money(s.total_spend, currency, true)} />
            <KpiCard label="Puntos extra emitidos" value={num(s.total_extra_points, 0)} />
            <KpiCard label="GMV incremental" value={money(s.total_gmv_incremental, currency, true)} />
            <KpiCard label="Comisión incremental" value={money(s.total_revenue_incremental, currency, true)} />
            <KpiCard label="ROI total" value={num(s.roi_total, 2)}
              tone={parseFloat(s.roi_total) >= 1 ? "good" : "default"} />
          </div>
          <Card>
            <CardBody>
              <p className="mb-3 text-sm font-semibold text-slate-800">GMV incremental vs costo de campañas</p>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={impactData}>
                    <XAxis dataKey="mes" tick={{ fontSize: 10 }} interval={tickInterval} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => money(v, currency, true)} width={80} />
                    <Tooltip formatter={(v: number) => money(v, currency)} />
                    <Legend />
                    <Bar dataKey="GMV incremental" fill="#713dff" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Costo de campañas" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <p className="mb-3 text-sm font-semibold text-slate-800">ROI mensual (comisión incremental / gasto)</p>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={roiData}>
                    <XAxis dataKey="mes" tick={{ fontSize: 10 }} interval={tickInterval} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => num(v, 2)} width={50} />
                    <Tooltip formatter={(v: number) => num(v, 2)} />
                    <Legend />
                    <Line dataKey="ROI" stroke="#10b981" dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardBody>
          </Card>
          <p className="text-xs text-slate-400">
            El incremental y el ROI son agregados del mes: la atribución por campaña individual no se calcula porque
            los uplifts entre campañas son aditivos y cualquier reparto sería una convención arbitraria.
          </p>
        </div>
      )}

      <p className="mt-6 text-xs text-slate-400">
        Porcentajes en decimal (0.20 = 20%). Todos los resultados se calculan en el servidor; esta pantalla
        solo edita supuestos y visualiza el preview del escenario.
      </p>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><CampaignsHub /></Suspense>;
}
