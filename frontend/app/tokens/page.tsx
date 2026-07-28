"use client";
/** Pantallas 46 + 63 — IA, voz, tokens y recargas (fase 6). Ruta estática: /tokens?project=&scenario= */
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, Assumption, Project, Run, RunResults, TokenLedgerRow } from "@/lib/api";
import { money, num, pct, monthName } from "@/lib/format";
import MetricTable, { MetricRowDef } from "@/components/MetricTable";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, KpiCard, SectionTitle, Skeleton, inputClass,
} from "@/components/ui";

/** Supuestos tokens.* editables (pantalla 46): motor agregado + modo detallado. */
const TOKEN_EDITABLE: { key: string; label: string; group: "agregado" | "detalle"; type?: "bool" }[] = [
  { key: "tokens.enabled", label: "Motor de IA/tokens", group: "agregado", type: "bool" },
  { key: "tokens.start_month", label: "Mes de activación", group: "agregado" },
  { key: "tokens.revenue_per_client_monthly", label: "Ingreso IA por adoptante", group: "agregado" },
  { key: "tokens.adoption_rate", label: "Tasa de adopción", group: "agregado" },
  { key: "tokens.cost_pct", label: "Costo del proveedor (% del ingreso)", group: "agregado" },
  { key: "tokens.detail.enabled", label: "Modo detallado", group: "detalle", type: "bool" },
  { key: "tokens.consumption_per_adopter_monthly", label: "Consumo mensual por adoptante", group: "detalle" },
  { key: "tokens.included_per_adopter_monthly", label: "Créditos incluidos por adoptante", group: "detalle" },
  { key: "tokens.overage_price_per_unit", label: "Precio por unidad excedente", group: "detalle" },
  { key: "tokens.provider_cost_per_unit", label: "Costo del proveedor por unidad", group: "detalle" },
  { key: "tokens.recharge_share", label: "Share de recargas sobre overage", group: "detalle" },
  { key: "tokens.recharge_price_per_unit", label: "Precio por unidad en recarga", group: "detalle" },
  { key: "tokens.initial_credit_units", label: "Crédito inicial por adoptante", group: "detalle" },
  { key: "tokens.credit_expiry_months", label: "Expiración del crédito inicial", group: "detalle" },
];

/** Series del run para las secciones 2 y 3 (todas emitidas por el motor). */
const RESULT_KEYS = [
  "tokens.units.consumed", "tokens.units.included", "tokens.units.included_expired",
  "tokens.units.credit_used", "tokens.units.credit_expired", "tokens.units.overage",
  "tokens.units.recharge",
  "rev.tokens", "rev.tokens.overage", "rev.tokens.recharges", "cost.tokens",
  "tokens.unit_margin", "tokens.margin_pct",
].join(",");

/** Series mensuales en unidades (pantalla 63). */
const UNIT_ROWS: MetricRowDef[] = [
  { label: "Unidades consumidas", key: "tokens.units.consumed", kind: "count", strong: true },
  { label: "Unidades incluidas", key: "tokens.units.included", kind: "count" },
  { label: "Incluidas expiradas", key: "tokens.units.included_expired", kind: "count" },
  { label: "Crédito inicial usado", key: "tokens.units.credit_used", kind: "count" },
  { label: "Crédito inicial expirado", key: "tokens.units.credit_expired", kind: "count" },
  { label: "Unidades en overage", key: "tokens.units.overage", kind: "count" },
  { label: "Unidades recargadas", key: "tokens.units.recharge", kind: "count" },
];

/** Series mensuales en dinero (pantalla 63). */
const MONEY_ROWS: MetricRowDef[] = [
  { label: "Ingreso IA total", key: "rev.tokens", strong: true },
  { label: "Ingreso por overage", key: "rev.tokens.overage" },
  { label: "Ingreso por recargas", key: "rev.tokens.recharges" },
  { label: "Costo del proveedor", key: "cost.tokens" },
  { label: "Margen unitario", key: "tokens.unit_margin" },
];

/** Etiquetas en español y tono de badge por tipo de movimiento del ledger. */
const MOVEMENT_META: Record<string, { label: string; tone: string }> = {
  incluido: { label: "Incluido", tone: "declarado" },
  consumo: { label: "Consumo", tone: "default" },
  overage: { label: "Overage", tone: "estimado" },
  recarga: { label: "Recarga", tone: "hipotesis" },
  credito_inicial: { label: "Crédito inicial", tone: "succeeded" },
  expiracion: { label: "Expiración", tone: "failed" },
};

/** Último valor no nulo de una serie mensual del servidor. */
function lastValue(series: (string | null)[] | undefined): string | null {
  if (!series) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

interface RunData {
  run: Run;
  results: RunResults;
  ledger: TokenLedgerRow[];
}

function TokensHub() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";
  const sid = params.get("scenario") ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [assumptions, setAssumptions] = useState<Record<string, Assumption> | null>(null);
  const [noProjects, setNoProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editor de supuestos tokens.* (pantalla 46)
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Último run exitoso (secciones 2–4)
  const [runData, setRunData] = useState<RunData | null>(null);
  const [runChecked, setRunChecked] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Sin parámetros: conserva el proyecto de la URL si existe; si no, el primero disponible.
  useEffect(() => {
    if (projectId && sid) return;
    api.get<Project[]>("/projects")
      .then((list) => {
        const p = list.find((x) => x.id === projectId) ?? list[0];
        if (p && p.scenarios.length > 0) {
          router.replace(`/tokens/?project=${p.id}&scenario=${p.scenarios[0].id}`);
        } else {
          setNoProjects(true);
        }
      })
      .catch((e) => setError(String(e.message)));
  }, [projectId, sid, router]);

  const loadBase = useCallback(() => {
    if (!projectId || !sid) return;
    setError(null);
    Promise.all([
      api.get<Project>(`/projects/${projectId}`),
      api.get<{ assumptions: Assumption[] }>(`/scenarios/${sid}/assumptions`),
    ])
      .then(([p, a]) => {
        setProject(p);
        setAssumptions(Object.fromEntries(a.assumptions.map((x) => [x.key, x])));
      })
      .catch((e) => setError(String(e.message)));
  }, [projectId, sid]);
  useEffect(loadBase, [loadBase]);
  useEffect(() => { setEdits({}); setSaveError(null); }, [sid]);

  const loadRun = useCallback(() => {
    if (!sid) return;
    setRunChecked(false);
    setRunError(null);
    setRunData(null);
    api.get<Run[]>(`/scenarios/${sid}/runs`)
      .then(async (runs) => {
        const ok = runs.find((r) => r.status === "succeeded");
        if (!ok) { setRunChecked(true); return; }
        const [results, ledger] = await Promise.all([
          api.get<RunResults>(`/simulation-runs/${ok.id}/results?keys=${RESULT_KEYS}`),
          api.get<TokenLedgerRow[]>(`/simulation-runs/${ok.id}/token-ledger`),
        ]);
        setRunData({ run: ok, results, ledger });
        setRunChecked(true);
      })
      .catch((e) => { setRunError(String(e.message)); setRunChecked(true); });
  }, [sid]);
  useEffect(loadRun, [loadRun]);

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
      loadBase();
    } catch (e) {
      setSaveError(e instanceof ApiError ? String(e.message) : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!projectId || !sid) {
    if (noProjects) {
      return (
        <EmptyState
          title="Aún no hay proyectos"
          description="Crea tu primer proyecto para configurar el motor de IA/tokens, las recargas y el crédito inicial."
          action={<Button href="/projects/new/">Crear proyecto</Button>}
        />
      );
    }
    if (error) return <ErrorState message={error} />;
    return <Skeleton rows={5} />;
  }
  if (error) return <ErrorState message={error} onRetry={loadBase} />;
  if (!project || !assumptions) return <Skeleton rows={5} />;

  const currency = project.base_currency;
  const tokensOn = assumptions["tokens.enabled"]?.value === "true";
  const detailOn = assumptions["tokens.detail.enabled"]?.value === "true";

  // Unit economics del último run (sección 2): valores del servidor, sin cálculos en cliente.
  const metrics = runData?.results.metrics ?? {};
  const months = runData?.results.months ?? [];
  const lastMonth = months.length > 0 ? months[months.length - 1] : null;
  const unitMargin = lastValue(metrics["tokens.unit_margin"]);
  const marginPct = lastValue(metrics["tokens.margin_pct"]);
  const revTokens = lastValue(metrics["rev.tokens"]);
  const costTokens = lastValue(metrics["cost.tokens"]);

  const noRunState = (
    <EmptyState
      title="Aún no hay un run exitoso"
      description="Estas vistas leen métricas del motor derivadas de la última simulación exitosa del escenario. Ejecuta una simulación para verlas."
      action={<Button href={`/simulate/?project=${projectId}&scenario=${sid}`}>Ir a simular</Button>}
    />
  );

  const renderEditorGroup = (group: "agregado" | "detalle") => (
    <div className="grid gap-x-4 gap-y-5 md:grid-cols-3">
      {TOKEN_EDITABLE.filter((d) => d.group === group).map((def) => {
        const a = assumptions[def.key];
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
            {def.type === "bool" ? (
              <select className={`${inputClass} ${highlight}`} value={value}
                onChange={(e) => onChange(e.target.value)}>
                <option value="true">Activado</option>
                <option value="false">Desactivado</option>
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
  );

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link>{" / "}
        <Link href={`/project/?id=${projectId}`} className="hover:text-pigui-700">{project.name}</Link>
        {" / "}IA, voz, tokens y recargas
      </nav>
      <SectionTitle
        title="IA, voz, tokens y recargas"
        subtitle="Unit economics de IA, consumo de tokens, créditos incluidos, recargas y ledger del último run"
        right={
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Escenario
            <select
              className={`${inputClass} !w-auto`}
              value={sid}
              onChange={(e) => router.replace(`/tokens/?project=${projectId}&scenario=${e.target.value}`)}
            >
              {project.scenarios.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.type})</option>
              ))}
            </select>
          </label>
        }
      />

      <div className="space-y-6">
        {!tokensOn && (
          <Card className="!border-amber-200 bg-amber-50/60">
            <CardBody className="py-3">
              <p className="text-sm text-amber-800">
                <span className="font-semibold">Motor de IA apagado:</span>{" "}
                activa <span className="font-mono text-[12px]">tokens.enabled</span> y ejecuta una simulación
                para ver ingresos, costos y ledger de tokens.
              </p>
            </CardBody>
          </Card>
        )}

        {/* 1. Supuestos tokens.* (pantalla 46) */}
        <div>
          <SectionTitle
            title="Supuestos de IA y tokens (pantalla 46)"
            subtitle="Los cambios se guardan como overrides del escenario (nueva versión, nunca sobrescribe); el siguiente run los toma."
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
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Motor agregado</p>
              {renderEditorGroup("agregado")}
              <p className="mb-3 mt-6 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Modo detallado — consumo, recargas y créditos
              </p>
              {renderEditorGroup("detalle")}
            </CardBody>
          </Card>
        </div>

        {/* 2. Unit economics IA del último run */}
        <div>
          <SectionTitle
            title="Unit economics IA"
            subtitle={runData
              ? `Último run exitoso · motor v${runData.run.engine_version}${lastMonth ? ` · cierre de ${monthName(lastMonth)}` : ""}`
              : "Del último run exitoso del escenario"}
          />
          {runError && <ErrorState message={runError} onRetry={loadRun} />}
          {!runError && !runChecked && <Skeleton rows={2} />}
          {!runError && runChecked && !runData && noRunState}
          {!runError && runData && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <KpiCard label="Margen unitario" value={money(unitMargin, currency)}
                hint="tokens.unit_margin · precio overage − costo proveedor"
                tone={unitMargin ? "default" : "muted"} />
              <KpiCard label="Margen IA %" value={pct(marginPct)}
                hint="tokens.margin_pct · se reporta 0 sin ingreso de IA"
                tone={marginPct ? "default" : "muted"} />
              <KpiCard label="Ingreso IA/mes" value={money(revTokens, currency)}
                hint={lastMonth ? `rev.tokens · ${monthName(lastMonth)}` : "rev.tokens"}
                tone={revTokens ? "default" : "muted"} />
              <KpiCard label="Costo IA/mes" value={money(costTokens, currency)}
                hint={lastMonth ? `cost.tokens · ${monthName(lastMonth)}` : "cost.tokens"}
                tone={costTokens ? "default" : "muted"} />
            </div>
          )}
        </div>

        {/* 3. Series mensuales (pantalla 63) */}
        <div>
          <SectionTitle
            title="Series mensuales (pantalla 63)"
            subtitle="Unidades y dinero calculados por el motor; el frontend no deriva métricas."
          />
          {!runError && !runChecked && <Skeleton rows={3} />}
          {!runError && runChecked && !runData && noRunState}
          {!runError && runData && (
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-sm font-semibold text-slate-800">Unidades de tokens</p>
                <MetricTable months={months} metrics={metrics} rows={UNIT_ROWS} currency={currency} />
              </div>
              <div>
                <p className="mb-2 text-sm font-semibold text-slate-800">Ingresos y costos de IA</p>
                <MetricTable months={months} metrics={metrics} rows={MONEY_ROWS} currency={currency} />
              </div>
            </div>
          )}
        </div>

        {/* 4. Ledger de tokens */}
        <div>
          <SectionTitle
            title="Ledger de tokens"
            subtitle="Movimientos mensuales persistidos por el run (incluidos, consumo, overage, recargas, créditos y expiraciones)."
          />
          {!runError && !runChecked && <Skeleton rows={3} />}
          {!runError && runChecked && !runData && noRunState}
          {!runError && runData && runData.ledger.length === 0 && (
            !detailOn ? (
              <EmptyState
                title="Modo agregado activo"
                description={`El modo detallado (tokens.detail.enabled) está apagado: el motor calcula el ingreso de IA agregado sin ledger de movimientos. Ingreso IA del último mes (rev.tokens): ${money(revTokens, currency)}. Activa el modo detallado y vuelve a simular para ver el ledger.`}
              />
            ) : (
              <EmptyState
                title="Sin movimientos de tokens"
                description="El último run exitoso no registró movimientos: verifica que el motor de IA y el modo detallado estuvieran activos al simular, y vuelve a ejecutar la simulación."
                action={<Button href={`/simulate/?project=${projectId}&scenario=${sid}`}>Ir a simular</Button>}
              />
            )
          )}
          {!runError && runData && runData.ledger.length > 0 && (
            <>
              {!detailOn && (
                <p className="mb-2 text-xs text-amber-600">
                  El modo detallado está apagado en el escenario actual; este ledger proviene del último run exitoso.
                </p>
              )}
              <Card>
                <div className="max-h-[28rem] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                        <th className="px-4 py-2.5 font-semibold">Mes</th>
                        <th className="px-4 py-2.5 font-semibold">Movimiento</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Unidades</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Costo unitario</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Precio unitario</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Monto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runData.ledger.map((t) => {
                        const meta = MOVEMENT_META[t.movement_type] ?? { label: t.movement_type, tone: "default" };
                        return (
                          <tr key={t.id} className="border-b border-slate-100 last:border-0 hover:bg-pigui-50/30">
                            <td className="px-4 py-2 text-slate-700">{monthName(t.month_label)}</td>
                            <td className="px-4 py-2"><Badge tone={meta.tone}>{meta.label}</Badge></td>
                            <td className="px-4 py-2 text-right tabular-nums text-slate-700">{num(t.units, 1)}</td>
                            <td className="px-4 py-2 text-right tabular-nums text-slate-700">{money(t.unit_cost, currency)}</td>
                            <td className="px-4 py-2 text-right tabular-nums text-slate-700">{money(t.unit_price, currency)}</td>
                            <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-900">{money(t.amount, currency)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </div>
      </div>

      <p className="mt-4 text-xs text-slate-400">
        Porcentajes en decimal (0.25 = 25%). Los defaults del modo detallado replican el motor agregado
        (100 × $1.50 = $150 por adoptante). El servidor valida cada cambio y el motor recalcula en el
        siguiente run; el frontend nunca calcula resultados financieros.
      </p>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><TokensHub /></Suspense>;
}
