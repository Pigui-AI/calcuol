"use client";
/** Pantalla 33 — Detalle de campaña. Ruta estática: /campaign?project=&id= */
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, CampaignT, Project } from "@/lib/api";
import { STATUS_LABELS } from "@/lib/format";
import { Badge, Button, Card, ErrorState, SectionTitle, Skeleton, inputClass } from "@/components/ui";

const TYPE_LABELS: Record<string, string> = {
  conversion: "Conversión", frecuencia: "Frecuencia", ticket: "Ticket",
  puntos_extra: "Puntos extra", redencion: "Redención", mixta: "Mixta",
};

/** Catálogo de efectos campaign.* (unidad y descripción de los DEFAULTS del motor). */
const EFFECT_CATALOG: { key: string; unit: string; description: string }[] = [
  { key: "campaign.uplift.conversion_pct", unit: "%", description: "Uplift relativo de conversión de compra durante la campaña" },
  { key: "campaign.uplift.frequency_pct", unit: "%", description: "Uplift relativo de frecuencia de compra durante la campaña" },
  { key: "campaign.uplift.ticket_pct", unit: "%", description: "Uplift relativo de ticket promedio durante la campaña" },
  { key: "campaign.points.extra_pct", unit: "%", description: "Puntos extra sobre utilidad elegible, fondeados por Pigui" },
  { key: "campaign.redemption.uplift_pct", unit: "%", description: "Uplift aditivo de la tasa de redención/intención" },
  { key: "campaign.cost_monthly", unit: "MXN", description: "Costo directo mensual de la campaña" },
];

/** Tono del badge de origen: campaña resalta como hipótesis; el resto como en growth-b2b. */
const originTone = (origin: string) =>
  origin === "campaña" || origin === "escenario" ? "hipotesis"
    : origin === "proyecto" ? "declarado" : "default";

function fecha(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-MX", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function CampaignDetail() {
  const params = useSearchParams();
  const projectId = params.get("project") ?? "";
  const campaignId = params.get("id") ?? "";
  const [campaign, setCampaign] = useState<CampaignT | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!projectId || !campaignId) return;
    Promise.all([
      api.get<CampaignT>(`/campaigns/${campaignId}`),
      api.get<Project>(`/projects/${projectId}`),
    ])
      .then(([c, p]) => { setCampaign(c); setProject(p); })
      .catch((e) => setError(String((e as Error).message)));
  }, [projectId, campaignId]);
  useEffect(load, [load]);

  const dirty = Object.keys(edits).length > 0;

  /** Transición de estado (draft→active→archived) con confirmación; el 409 se muestra tal cual. */
  const transition = async (status: "active" | "archived") => {
    if (!campaign) return;
    const msg = status === "active"
      ? `¿Activar la campaña “${campaign.name}”? Sus efectos entrarán congelados al snapshot de las nuevas simulaciones.`
      : `¿Archivar la campaña “${campaign.name}”? Dejará de participar en nuevas simulaciones (no se elimina).`;
    if (!window.confirm(msg)) return;
    setActionError(null);
    try {
      await api.patch<CampaignT>(`/campaigns/${campaignId}`, { status });
      load();
    } catch (e) {
      setActionError(e instanceof ApiError ? String(e.message) : String(e));
    }
  };

  /** Guardar efectos: PATCH todo-o-nada; el servidor crea una nueva versión por clave. */
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setFieldErrors({});
    try {
      await api.patch(`/campaigns/${campaignId}/effects`, edits);
      setEdits({});
      setSavedAt(new Date().toLocaleTimeString("es-MX"));
      load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && e.detail && typeof e.detail === "object"
        && "field_errors" in e.detail) {
        setFieldErrors((e.detail as { field_errors: Record<string, string> }).field_errors);
        setSaveError("Corrige los efectos marcados: el guardado es todo o nada.");
      } else {
        setSaveError(e instanceof ApiError ? String(e.message) : String(e));
      }
    } finally {
      setSaving(false);
    }
  };

  if (!projectId) return <ErrorState message="Falta el parámetro ?project= del proyecto" />;
  if (!campaignId) return <ErrorState message="Falta el parámetro ?id= de la campaña" />;
  if (error) return <ErrorState message={error} onRetry={() => { setError(null); load(); }} />;
  if (!campaign || !project) return <Skeleton rows={6} />;

  const effects = campaign.effects ?? {};
  const history = campaign.history ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link>
        {" / "}
        <Link href={`/project/?id=${projectId}`} className="hover:text-pigui-700">{project.name}</Link>
        {" / "}
        <Link href={`/campaigns/?project=${projectId}`} className="hover:text-pigui-700">Campañas</Link>
        {" / "}{campaign.name}
      </nav>

      <SectionTitle
        title={campaign.name}
        subtitle={campaign.description || "Sin descripción"}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="meta">{TYPE_LABELS[campaign.campaign_type] || campaign.campaign_type}</Badge>
            <Badge tone={campaign.status}>{STATUS_LABELS[campaign.status] || campaign.status}</Badge>
            <span className="text-xs text-slate-500">mes {campaign.start_month}–{campaign.end_month}</span>
            {campaign.status === "draft" && <Button onClick={() => transition("active")}>Activar</Button>}
            {campaign.status === "active" && (
              <Button variant="secondary" onClick={() => transition("archived")}>Archivar</Button>
            )}
          </div>
        }
      />
      {actionError && <p className="mb-3 text-sm font-medium text-rose-600">{actionError}</p>}

      {/* Editor de efectos (jerarquía defaults → proyecto → escenario → campaña) */}
      <Card className="mb-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-800">Efectos de la campaña</p>
            <p className="text-xs text-slate-500">
              Resolución por jerarquía: default del motor → proyecto → escenario → campaña.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {savedAt && !dirty && <span className="text-xs text-emerald-600">Guardado {savedAt}</span>}
            <Button onClick={save} disabled={!dirty || saving}>
              {saving ? "Guardando…" : `Guardar efectos${dirty ? ` (${Object.keys(edits).length})` : ""}`}
            </Button>
          </div>
        </div>
        {saveError && <p className="px-5 pt-3 text-sm font-medium text-rose-600">{saveError}</p>}
        <table className="w-full text-sm">
          <tbody>
            {EFFECT_CATALOG.map(({ key, unit, description }) => {
              const current = effects[key];
              const baseValue = current?.value ?? "";
              const origin = current?.origin ?? "default";
              const value = edits[key] ?? baseValue;
              const changed = key in edits;
              const fieldError = fieldErrors[key];
              return (
                <tr key={key} className="border-b border-slate-50 last:border-0">
                  <td className="px-5 py-2.5">
                    <p className="font-medium text-slate-800">{description}</p>
                    <p className="font-mono text-[11px] text-slate-400">{key} · {unit}</p>
                  </td>
                  <td className="w-28 px-3 py-2.5">
                    <Badge tone={originTone(origin)}>{origin}</Badge>
                  </td>
                  <td className="w-44 px-3 py-2.5">
                    <input
                      className={`${inputClass} ${fieldError ? "!border-rose-500 !ring-1 !ring-rose-500"
                        : changed ? "!border-pigui-500 !ring-1 !ring-pigui-500" : ""}`}
                      value={value}
                      onChange={(e) => {
                        const v = e.target.value;
                        setEdits((prev) => {
                          const next = { ...prev };
                          if (v === baseValue) delete next[key];
                          else next[key] = v;
                          return next;
                        });
                      }}
                    />
                    {fieldError && <p className="mt-1 text-xs text-rose-600">{fieldError}</p>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="px-5 pb-4 pt-2 text-xs text-slate-400">
          Porcentajes en decimal (0.20 = 20%). El servidor valida cada clave; un guardado inválido no aplica ningún cambio.
        </p>
      </Card>

      {/* Historial de versiones (append-only) */}
      <Card className="mb-5">
        <div className="border-b border-slate-100 px-5 py-3">
          <p className="text-sm font-semibold text-slate-800">Historial de versiones</p>
          <p className="text-xs text-slate-500">
            Los efectos nunca se sobrescriben: cada cambio crea una nueva versión.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
              <th className="px-5 py-2">Clave</th>
              <th className="px-3 py-2 text-right">Valor</th>
              <th className="px-3 py-2">Unidad</th>
              <th className="px-3 py-2 text-right">Versión</th>
              <th className="px-3 py-2">Clasificación</th>
              <th className="px-3 py-2">Autor</th>
              <th className="px-3 py-2">Fecha</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h, i) => (
              <tr key={`${h.key}-${h.version}-${i}`} className="border-b border-slate-100 last:border-0">
                <td className="px-5 py-2 font-mono text-[11px] text-slate-600">{h.key}</td>
                <td className="px-3 py-2 text-right font-medium text-slate-800">{h.value}</td>
                <td className="px-3 py-2 text-slate-500">{h.unit || "—"}</td>
                <td className="px-3 py-2 text-right text-slate-600">v{h.version}</td>
                <td className="px-3 py-2"><Badge tone={h.source_type}>{h.source_type}</Badge></td>
                <td className="px-3 py-2 text-slate-500">{h.created_by || "—"}</td>
                <td className="px-3 py-2 text-slate-500">{fecha(h.created_at)}</td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-8 text-center text-slate-400">
                  Sin versiones propias: la campaña hereda los valores del escenario, el proyecto o los defaults del motor.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
        Los cambios de efectos afectan a las <span className="font-medium">nuevas simulaciones</span> únicamente cuando
        la campaña está <span className="font-medium">activa</span> y el supuesto{" "}
        <span className="font-mono">campaigns.enabled</span> del escenario está encendido. Cada run congela las campañas
        activas con sus efectos ya resueltos dentro del snapshot, por lo que los resultados históricos nunca cambian.
      </p>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={6} />}><CampaignDetail /></Suspense>;
}
