"use client";
/** Pantallas 28–29 — Adopción B2C (fase 4). Ruta estática: /growth-b2c?project=&scenario= */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
} from "recharts";
import { api, ApiError, Assumption, GrowthPreview, Project } from "@/lib/api";
import { money, num, pct, monthName } from "@/lib/format";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, KpiCard, SectionTitle, Skeleton, inputClass,
} from "@/components/ui";

const GROWTH_TABS = [
  { label: "Adquisición B2B", href: "/growth-b2b/" },
  { label: "Adopción B2C", href: "/growth-b2c/" },
  { label: "Cohortes", href: "/cohorts/" },
] as const;

/** Supuestos editables de adopción B2C (orden de la pantalla 29). */
const ADOPTION_KEYS = [
  "b2c.initial_consumers",
  "b2c.consumers_initial_per_client",
  "b2c.new_consumers_per_client_monthly",
  "b2c.consumer_churn_rate",
  "b2c.purchase_conversion",
  "b2c.purchase_frequency",
  "b2c.avg_ticket",
  "b2c.margin_pct",
];

/** Último valor no nulo de una serie mensual del servidor. */
function lastValue(series: (string | null)[] | undefined): string | null {
  if (!series) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function GrowthB2C() {
  const params = useSearchParams();
  const projectId = params.get("project") ?? "";
  const sid = params.get("scenario") ?? "";
  const router = useRouter();

  const [project, setProject] = useState<Project | null>(null);
  const [preview, setPreview] = useState<GrowthPreview | null>(null);
  const [noProjects, setNoProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Si faltan query params, resuelve el primer proyecto/escenario o invita a crear uno.
  useEffect(() => {
    if (projectId && sid) return;
    api.get<Project[]>("/projects")
      .then((list) => {
        const p = list.find((x) => x.id === projectId) ?? list[0];
        if (p && p.scenarios[0]) {
          router.replace(`/growth-b2c/?project=${p.id}&scenario=${p.scenarios[0].id}`);
        } else {
          setNoProjects(true);
        }
      })
      .catch((e) => setError(String(e.message)));
  }, [projectId, sid, router]);

  const loadPreview = useCallback(() => {
    if (!projectId || !sid) return;
    setError(null);
    api.get<GrowthPreview>(`/projects/${projectId}/scenarios/${sid}/growth-preview`)
      .then(setPreview)
      .catch((e) => setError(String(e.message)));
  }, [projectId, sid]);

  const load = useCallback(() => {
    if (!projectId || !sid) return;
    setError(null);
    api.get<Project>(`/projects/${projectId}`).then(setProject).catch((e) => setError(String(e.message)));
    setPreview(null);
    setEdits({});
    loadPreview();
  }, [projectId, sid, loadPreview]);
  useEffect(load, [load]);

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
      loadPreview();
    } catch (e) {
      setSaveError(e instanceof ApiError ? String(e.message) : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Series para las gráficas (parseFloat solo para graficar; el motor ya calculó todo).
  const chartData = useMemo(() => {
    if (!preview) return [];
    return preview.months.map((m, i) => ({
      mes: monthName(m),
      Consumidores: parseFloat(preview.metrics["b2c.consumers_end"]?.[i] ?? "0"),
      Nuevos: parseFloat(preview.metrics["b2c.consumers_new"]?.[i] ?? "0"),
      Bajas: parseFloat(preview.metrics["b2c.consumers_churned"]?.[i] ?? "0"),
    }));
  }, [preview]);

  if (!projectId || !sid) {
    if (noProjects) {
      return (
        <EmptyState
          title="Aún no hay proyectos"
          description="Crea tu primer proyecto para configurar la adopción de consumidores B2C y previsualizar el embudo de compra."
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
  const lastMonth = preview.months[preview.months.length - 1];

  // Último mes del horizonte (pantalla 28): valores del servidor.
  const consumersStr = lastValue(preview.metrics["b2c.consumers_end"]);
  const buyersStr = lastValue(preview.metrics["b2c.buyers"]);
  const txStr = lastValue(preview.metrics["b2c.transactions"]);
  const gmvStr = lastValue(preview.metrics["tx.gmv"]);

  // Relaciones visuales entre valores del servidor (no cálculo financiero nuevo).
  const consumersN = parseFloat(consumersStr ?? "0");
  const buyersN = parseFloat(buyersStr ?? "0");
  const txN = parseFloat(txStr ?? "0");
  const gmvN = parseFloat(gmvStr ?? "0");
  const maxCount = Math.max(consumersN, buyersN, txN, 1);
  const funnelSteps = [
    { label: "Consumidores activos", value: num(consumersStr, 0), width: (consumersN / maxCount) * 100, color: "bg-pigui-300" },
    { label: "Compradores del mes", value: num(buyersStr, 0), width: (buyersN / maxCount) * 100, color: "bg-pigui-500" },
    { label: "Transacciones del mes", value: num(txStr, 0), width: (txN / maxCount) * 100, color: "bg-pigui-700" },
  ];
  // Entre pasos se muestran los supuestos efectivos del servidor, no razones
  // calculadas en el cliente (el frontend no deriva métricas financieras).
  const effective = (key: string) =>
    preview.derived_inputs[key]?.to ?? preview.assumptions[key]?.value ?? null;
  const relations = [
    `conversión del supuesto: ${pct(effective("b2c.purchase_conversion"))}` +
      (preview.cohorts_enabled ? " (modulada por la actividad de cohortes)" : ""),
    `frecuencia del supuesto: ×${num(effective("b2c.purchase_frequency"), 2)} por comprador`,
    `ticket promedio del supuesto: ${money(effective("b2c.avg_ticket") ?? "0", currency)}`,
  ];

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link>{" / "}
        <Link href={`/project/?id=${projectId}`} className="hover:text-pigui-700">{project.name}</Link>
        {" / "}Adopción B2C
      </nav>
      <SectionTitle
        title="Adopción B2C"
        subtitle={`Consumidores, embudo de compra y supuestos de comportamiento · ${preview.months.length} meses · motor v${preview.engine_version}`}
        right={
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Escenario
            <select
              className={`${inputClass} !w-auto`}
              value={sid}
              onChange={(e) => router.replace(`/growth-b2c/?project=${projectId}&scenario=${e.target.value}`)}
            >
              {project.scenarios.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.type})</option>
              ))}
            </select>
          </label>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg border border-slate-200 bg-white p-1">
        {GROWTH_TABS.map((t) => (
          <Link
            key={t.href}
            href={`${t.href}?project=${projectId}&scenario=${sid}`}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${
              t.href === "/growth-b2c/" ? "bg-pigui-600 text-white" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard label="Consumidores activos" value={num(consumersStr, 0)}
            hint={`Cierre de ${monthName(lastMonth)}`} tone={consumersStr ? "default" : "muted"} />
          <KpiCard label="Compradores/mes" value={num(buyersStr, 0)}
            tone={buyersStr ? "default" : "muted"} />
          <KpiCard label="Transacciones/mes" value={num(txStr, 0)}
            tone={txStr ? "default" : "muted"} />
          <KpiCard label="GMV/mes" value={money(gmvStr, currency, true)}
            tone={gmvStr ? "default" : "muted"} />
        </div>

        {preview.cohorts_enabled && (
          <Card className="!border-pigui-200 bg-pigui-50/50">
            <CardBody className="py-3">
              <p className="text-sm text-pigui-800">
                <span className="font-semibold">Cohortes activas:</span>{" "}
                el churn plano se sustituye por retención por antigüedad.{" "}
                <Link href={`/cohorts/?project=${projectId}&scenario=${sid}`}
                  className="font-medium text-pigui-700 underline hover:text-pigui-900">
                  Ver cohortes
                </Link>
              </p>
            </CardBody>
          </Card>
        )}

        <Card><CardBody>
          <p className="mb-1 text-sm font-semibold text-slate-800">Embudo del último mes (pantalla 28)</p>
          <p className="mb-4 text-xs text-slate-500">
            {monthName(lastMonth)} · valores calculados por el motor; las relaciones entre pasos son solo visuales.
          </p>
          <div className="space-y-1">
            {funnelSteps.map((step, i) => (
              <div key={step.label}>
                <div className="flex items-center gap-3">
                  <span className="w-44 shrink-0 text-xs font-medium text-slate-600">{step.label}</span>
                  <div className="h-8 flex-1 overflow-hidden rounded-md bg-slate-50">
                    <div
                      className={`flex h-full items-center rounded-md px-2 ${step.color}`}
                      style={{ width: `${Math.max(step.width, 2)}%` }}
                    >
                      <span className="whitespace-nowrap text-xs font-semibold text-white">{step.value}</span>
                    </div>
                  </div>
                </div>
                <div className="ml-44 py-1 pl-3 text-[11px] text-slate-400">↓ {relations[i]}</div>
              </div>
            ))}
            <div className="flex items-center gap-3">
              <span className="w-44 shrink-0 text-xs font-medium text-slate-600">GMV del mes</span>
              <div className="flex h-8 flex-1 items-center rounded-md bg-gradient-to-r from-pigui-800 to-pigui-500 px-2">
                <span className="whitespace-nowrap text-xs font-semibold text-white">{money(gmvStr, currency, true)}</span>
              </div>
            </div>
          </div>
        </CardBody></Card>

        <Card><CardBody>
          <p className="mb-3 text-sm font-semibold text-slate-800">Consumidores activos por mes</p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <XAxis dataKey="mes" tick={{ fontSize: 10 }} interval={Math.ceil(preview.months.length / 16)} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => num(v)} width={60} />
                <Tooltip formatter={(v: number) => num(v)} />
                <Area dataKey="Consumidores" stroke="#713dff" fill="#e9e5ff" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardBody></Card>

        <Card><CardBody>
          <p className="mb-3 text-sm font-semibold text-slate-800">Altas y bajas de consumidores por mes</p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <XAxis dataKey="mes" tick={{ fontSize: 10 }} interval={Math.ceil(preview.months.length / 16)} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => num(v)} width={60} />
                <Tooltip formatter={(v: number) => num(v)} />
                <Legend />
                <Bar dataKey="Nuevos" fill="#10b981" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Bajas" fill="#f43f5e" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardBody></Card>

        <div>
          <SectionTitle
            title="Supuestos de adopción (pantalla 29)"
            subtitle="Los cambios se guardan como overrides del escenario actual y crean una nueva versión."
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
                {ADOPTION_KEYS.map((key) => {
                  const a = preview.assumptions[key];
                  if (!a) return null;
                  const derived = preview.derived_inputs[key];
                  const value = edits[key] ?? a.value;
                  const changed = key in edits;
                  return (
                    <tr key={key} className="border-b border-slate-50 last:border-0">
                      <td className="px-5 py-2.5">
                        <p className="font-medium text-slate-800">{a.description || key}</p>
                        <p className="font-mono text-[11px] text-slate-400">{key}{a.unit && ` · ${a.unit}`}</p>
                        {key === "b2c.consumer_churn_rate" && preview.cohorts_enabled && (
                          <p className="text-[11px] text-amber-600">ignorado con cohortes activas</p>
                        )}
                        {derived && (
                          <p className="text-[11px] text-orange-700">
                            Valor efectivo: {num(derived.to, a.unit === "%" ? 4 : 2)} ({derived.source})
                          </p>
                        )}
                      </td>
                      <td className="w-44 px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={a.origin === "escenario" ? "hipotesis" : a.origin === "proyecto" ? "declarado" : "default"}>
                            {a.origin}
                          </Badge>
                          {derived && <Badge tone="estimado">estimado del portafolio</Badge>}
                        </div>
                      </td>
                      <td className="w-44 px-3 py-2.5">
                        <input
                          className={`${inputClass} ${changed ? "!border-pigui-500 !ring-1 !ring-pigui-500" : ""}`}
                          value={value}
                          onChange={(e) => {
                            const v = e.target.value;
                            setEdits((prev) => {
                              const next = { ...prev };
                              if (v === a.value) delete next[key];
                              else next[key] = v;
                              return next;
                            });
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          <p className="mt-4 text-xs text-slate-400">
            Porcentajes en decimal (0.25 = 25%). El servidor valida cada cambio y recalcula el preview;
            el frontend nunca calcula resultados financieros.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><GrowthB2C /></Suspense>;
}
