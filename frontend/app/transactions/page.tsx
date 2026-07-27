"use client";
/** Pantallas 38–44 — Transacciones y pagos (fase 5). Ruta estática: /transactions?project=&scenario= */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend, ReferenceLine,
} from "recharts";
import {
  api, ApiError, ArInvoicesResponse, Assumption, Client, Project, Run, RunResults,
  SettlementRow, TransactionT, TransactionsSummary,
} from "@/lib/api";
import { money, num, pct, monthName } from "@/lib/format";
import MetricTable, { MetricRowDef } from "@/components/MetricTable";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, Field, KpiCard, SectionTitle, Skeleton, inputClass,
} from "@/components/ui";

const TABS = ["Registro", "Rutas de pago", "Settlements", "AR por factura", "Conciliación"] as const;

/** Series del run que consumen los tabs 2, 3 y 5 (todas emitidas por el motor). */
const RESULT_KEYS = [
  "tx.count_stripe", "tx.count_cash", "tx.gmv_stripe", "tx.gmv_cash",
  "stl.gross_collected", "stl.merchant_due", "stl.paid_out", "stl.payable_end",
  "pnl.revenue", "ar.new", "ar.collections", "cost.processing_fees",
  "cash.points_paid_out", "cash.net",
].join(",");

const ROUTE_ROWS: MetricRowDef[] = [
  { label: "Transacciones vía Stripe", key: "tx.count_stripe", kind: "count" },
  { label: "Transacciones en caja", key: "tx.count_cash", kind: "count" },
  { label: "GMV vía Stripe", key: "tx.gmv_stripe", strong: true },
  { label: "GMV en caja", key: "tx.gmv_cash", strong: true },
];

/** Supuestos payments.* editables (pantalla 40). */
const PAYMENT_EDITABLE: { key: string; label: string; type?: "bool" }[] = [
  { key: "payments.stripe_share", label: "Share de cobro vía Stripe" },
  { key: "payments.processing_fee_pct", label: "Fee de procesamiento" },
  { key: "payments.processing_fee.enabled", label: "Aplicar fee de procesamiento", type: "bool" },
  { key: "payments.settlement.enabled", label: "Motor de settlements", type: "bool" },
  { key: "payments.settlement.lag_months", label: "Rezago de liquidación (meses)" },
  { key: "payments.ar.collection_lag_months", label: "Rezago de cobranza AR (meses)" },
  { key: "payments.ar.collection_rate", label: "Tasa de cobranza AR" },
];

/** Bridge devengo → caja (pantalla 44): cada renglón es una métrica del run tal cual. */
const BRIDGE_ROWS: { key: string; label: string; strong?: boolean }[] = [
  { key: "pnl.revenue", label: "Ingresos del mes (devengo)", strong: true },
  { key: "ar.new", label: "AR nueva (por cobrar en caja)" },
  { key: "ar.collections", label: "Cobranza AR del mes" },
  { key: "stl.gross_collected", label: "Bruto cobrado vía Stripe (settlements)" },
  { key: "stl.paid_out", label: "Liquidaciones pagadas a negocios" },
  { key: "cost.processing_fees", label: "Fees de procesamiento" },
  { key: "cash.points_paid_out", label: "Redenciones de puntos pagadas" },
  { key: "cash.net", label: "Flujo neto de caja", strong: true },
];

const ROUTE_TONE: Record<string, string> = { stripe: "running", caja: "default" };
const SETTLEMENT_STATUS: Record<string, { label: string; tone: string }> = {
  pagado: { label: "Pagado", tone: "succeeded" },
  pendiente: { label: "Pendiente", tone: "queued" },
};
const INVOICE_STATUS: Record<string, { label: string; tone: string }> = {
  cobrada: { label: "Cobrada", tone: "succeeded" },
  por_cobrar: { label: "Por cobrar", tone: "queued" },
};

const EMPTY_FORM = {
  client_id: "", occurred_on: new Date().toISOString().slice(0, 10),
  amount: "", payment_route: "stripe", reference: "",
};

interface RunData {
  run: Run;
  settlements: SettlementRow[];
  ar: ArInvoicesResponse;
  results: RunResults;
}

function TransactionsHub() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";
  const scenarioId = params.get("scenario") ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [assumptions, setAssumptions] = useState<Record<string, Assumption>>({});
  const [noProjects, setNoProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Registro");

  // Registro (38–39)
  const [fMonth, setFMonth] = useState("");
  const [fClient, setFClient] = useState("");
  const [fRoute, setFRoute] = useState("");
  const [txs, setTxs] = useState<TransactionT[] | null>(null);
  const [summary, setSummary] = useState<TransactionsSummary | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [posting, setPosting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Run exitoso (tabs 40–44)
  const [runData, setRunData] = useState<RunData | null>(null);
  const [runChecked, setRunChecked] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Editor de supuestos payments.* (40)
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Conciliación (44)
  const [bridgeIdx, setBridgeIdx] = useState(0);

  // Sin parámetros: conserva el proyecto de la URL si existe; si no, el primero disponible.
  useEffect(() => {
    if (projectId && scenarioId) return;
    api.get<Project[]>("/projects")
      .then((list) => {
        const p = list.find((x) => x.id === projectId) ?? list[0];
        if (p && p.scenarios.length > 0) {
          router.replace(`/transactions/?project=${p.id}&scenario=${p.scenarios[0].id}`);
        } else {
          setNoProjects(true);
        }
      })
      .catch((e) => setError(String(e.message)));
  }, [projectId, scenarioId, router]);

  const loadBase = useCallback(() => {
    if (!projectId || !scenarioId) return;
    setError(null);
    Promise.all([
      api.get<Project>(`/projects/${projectId}`),
      api.get<{ clients: Client[] }>(`/projects/${projectId}/clients`),
      api.get<{ assumptions: Assumption[] }>(`/scenarios/${scenarioId}/assumptions`),
    ])
      .then(([p, c, a]) => {
        setProject(p);
        setClients(c.clients);
        setAssumptions(Object.fromEntries(a.assumptions.map((x) => [x.key, x])));
      })
      .catch((e) => setError(String(e.message)));
  }, [projectId, scenarioId]);
  useEffect(loadBase, [loadBase]);
  useEffect(() => { setEdits({}); setSaveError(null); }, [scenarioId]);

  const loadTx = useCallback(() => {
    if (!projectId) return;
    setTxError(null);
    const qs = new URLSearchParams();
    if (fClient) qs.set("client_id", fClient);
    if (fMonth) qs.set("month", fMonth);
    if (fRoute) qs.set("route", fRoute);
    Promise.all([
      api.get<{ transactions: TransactionT[] }>(`/projects/${projectId}/transactions${qs.size ? `?${qs.toString()}` : ""}`),
      api.get<TransactionsSummary>(`/projects/${projectId}/transactions/summary${fMonth ? `?month=${fMonth}` : ""}`),
    ])
      .then(([t, s]) => { setTxs(t.transactions); setSummary(s); })
      .catch((e) => setTxError(String(e.message)));
  }, [projectId, fClient, fMonth, fRoute]);
  useEffect(loadTx, [loadTx]);

  const loadRun = useCallback(() => {
    if (!scenarioId) return;
    setRunChecked(false);
    setRunError(null);
    setRunData(null);
    api.get<Run[]>(`/scenarios/${scenarioId}/runs`)
      .then(async (runs) => {
        const ok = runs.find((r) => r.status === "succeeded");
        if (!ok) { setRunChecked(true); return; }
        const [settlements, ar, results] = await Promise.all([
          api.get<SettlementRow[]>(`/simulation-runs/${ok.id}/settlements`),
          api.get<ArInvoicesResponse>(`/simulation-runs/${ok.id}/ar-invoices`),
          api.get<RunResults>(`/simulation-runs/${ok.id}/results?keys=${RESULT_KEYS}`),
        ]);
        setRunData({ run: ok, settlements, ar, results });
        setBridgeIdx(0);
        setRunChecked(true);
      })
      .catch((e) => { setRunError(String(e.message)); setRunChecked(true); });
  }, [scenarioId]);
  useEffect(loadRun, [loadRun]);

  const clientName = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of clients) map[c.id] = c.trade_name || c.legal_name;
    return map;
  }, [clients]);

  /** Ids de transacciones que ya fueron revertidas por otra fila. */
  const reversedIds = useMemo(() => {
    const set = new Set<string>();
    for (const t of txs ?? []) if (t.reverses_transaction_id) set.add(t.reverses_transaction_id);
    return set;
  }, [txs]);

  const dirty = Object.keys(edits).length > 0;

  const saveAssumptions = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch<{ assumptions: Assumption[] }>(`/scenarios/${scenarioId}/assumptions`, {
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

  const createTx = async () => {
    setPosting(true);
    setFormError(null);
    try {
      await api.post(`/projects/${projectId}/transactions`, {
        client_id: form.client_id,
        occurred_on: form.occurred_on,
        amount: form.amount,
        payment_route: form.payment_route,
        reference: form.reference,
      });
      setForm({ ...EMPTY_FORM });
      setShowForm(false);
      loadTx();
    } catch (e) {
      setFormError(e instanceof ApiError ? String(e.message) : String(e));
    } finally {
      setPosting(false);
    }
  };

  const reverseTx = async (t: TransactionT) => {
    const name = clientName[t.client_id] ?? t.client_id;
    if (!window.confirm(`¿Anular la transacción de ${name} por ${money(t.amount)}? Se creará un contra-asiento con montos negados (el registro es append-only).`)) return;
    setActionError(null);
    try {
      await api.post(`/transactions/${t.id}/reversal`, {});
      loadTx();
    } catch (e) {
      setActionError(e instanceof ApiError ? String(e.message) : String(e));
    }
  };

  const payableData = useMemo(() => {
    if (!runData) return [];
    const { months, metrics } = runData.results;
    return months.map((m, i) => ({
      mes: monthName(m),
      "Payable a negocios (saldo)": parseFloat(metrics["stl.payable_end"]?.[i] ?? "0"),
    }));
  }, [runData]);

  if (!projectId || !scenarioId) {
    if (noProjects) {
      return (
        <EmptyState
          title="Aún no hay proyectos"
          description="Crea tu primer proyecto para registrar transacciones reales y analizar rutas de pago, settlements y AR."
          action={<Button href="/projects/new/">Crear proyecto</Button>}
        />
      );
    }
    if (error) return <ErrorState message={error} />;
    return <Skeleton rows={5} />;
  }
  if (error) return <ErrorState message={error} onRetry={loadBase} />;
  if (!project) return <Skeleton rows={5} />;

  const currency = project.base_currency;
  const months = runData?.results.months ?? [];
  const metrics = runData?.results.metrics ?? {};
  const lastIdx = months.length - 1;
  const monthOfIndex = (idx: number) => (months[idx - 1] ? monthName(months[idx - 1]) : `Mes ${idx}`);

  const noRunState = (
    <EmptyState
      title="Aún no hay un run exitoso"
      description="Estas vistas leen métricas y tablas derivadas de la última simulación exitosa del escenario. Ejecuta una simulación para verlas."
      action={<Button href={`/simulate/?project=${projectId}&scenario=${scenarioId}`}>Ir a simular</Button>}
    />
  );

  const assumptionsEditor = (
    <>
      <SectionTitle
        title="Supuestos de rutas de pago y cobranza"
        subtitle="Los cambios se guardan como overrides del escenario (nueva versión, nunca sobrescribe); el siguiente run los toma."
        right={
          <div className="flex items-center gap-2">
            {savedAt && !dirty && <span className="text-xs text-emerald-600">Guardado {savedAt}</span>}
            <Button onClick={saveAssumptions} disabled={!dirty || saving}>
              {saving ? "Guardando…" : `Guardar cambios${dirty ? ` (${Object.keys(edits).length})` : ""}`}
            </Button>
          </div>
        }
      />
      {saveError && <p className="mb-3 text-sm font-medium text-rose-600">{saveError}</p>}
      <Card>
        <CardBody>
          <div className="grid gap-x-4 gap-y-5 md:grid-cols-3">
            {PAYMENT_EDITABLE.map((def) => {
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
        </CardBody>
      </Card>
    </>
  );

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link>{" / "}
        <Link href={`/project/?id=${project.id}`} className="hover:text-pigui-700">{project.name}</Link>
        {" / "}Transacciones y pagos
      </nav>
      <SectionTitle
        title="Transacciones y pagos"
        subtitle="Registro operativo real, rutas de pago, settlements, AR por factura y conciliación devengo vs caja"
        right={
          <select
            className={`${inputClass} !w-auto`}
            value={scenarioId}
            onChange={(e) => router.replace(`/transactions/?project=${project.id}&scenario=${e.target.value}`)}
          >
            {project.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg border border-slate-200 bg-white p-1">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${tab === t ? "bg-pigui-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
            {t}
          </button>
        ))}
      </div>

      {/* ---------- Registro (pantallas 38–39) ---------- */}
      {tab === "Registro" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label="Transacciones" value={summary ? num(summary.count, 0) : "—"}
              hint={fMonth ? `Mes ${fMonth}` : "Todo el registro"} />
            <KpiCard label="GMV registrado" value={summary ? money(summary.gmv, currency, true) : "—"}
              hint="Los reversos ya restan" />
            <KpiCard label="Puntos emitidos" value={summary ? num(summary.points_issued, 0) : "—"}
              hint="Neto de reversos" />
            <KpiCard label="Puntos redimidos" value={summary ? num(summary.points_redeemed, 0) : "—"}
              hint="Neto de reversos" />
          </div>

          <Card>
            <CardBody className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Mes</span>
                <input type="month" className={`${inputClass} !w-auto`} value={fMonth}
                  onChange={(e) => setFMonth(e.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Cliente</span>
                <select className={`${inputClass} !w-auto`} value={fClient}
                  onChange={(e) => setFClient(e.target.value)}>
                  <option value="">Todos los clientes</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.trade_name || c.legal_name}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Ruta</span>
                <select className={`${inputClass} !w-auto`} value={fRoute}
                  onChange={(e) => setFRoute(e.target.value)}>
                  <option value="">Todas las rutas</option>
                  <option value="stripe">stripe</option>
                  <option value="caja">caja</option>
                </select>
              </label>
              <div className="ml-auto">
                <Button variant={showForm ? "secondary" : "primary"} onClick={() => setShowForm((v) => !v)}>
                  {showForm ? "Cerrar formulario" : "Nueva transacción"}
                </Button>
              </div>
            </CardBody>
          </Card>

          {showForm && (
            <Card>
              <CardBody>
                <p className="mb-4 text-sm font-semibold text-slate-800">Alta de transacción (pantalla 39)</p>
                <div className="grid gap-4 md:grid-cols-3">
                  <Field label="Cliente" required>
                    <select className={inputClass} value={form.client_id}
                      onChange={(e) => setForm((f) => ({ ...f, client_id: e.target.value }))}>
                      <option value="">Selecciona un cliente</option>
                      {clients.map((c) => <option key={c.id} value={c.id}>{c.trade_name || c.legal_name}</option>)}
                    </select>
                  </Field>
                  <Field label="Fecha" required>
                    <input type="date" className={inputClass} value={form.occurred_on}
                      onChange={(e) => setForm((f) => ({ ...f, occurred_on: e.target.value }))} />
                  </Field>
                  <Field label="Monto" required hint={`Ticket bruto en ${currency}`}>
                    <input className={inputClass} placeholder="0.00" value={form.amount}
                      onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
                  </Field>
                  <Field label="Ruta de pago">
                    <select className={inputClass} value={form.payment_route}
                      onChange={(e) => setForm((f) => ({ ...f, payment_route: e.target.value }))}>
                      <option value="stripe">stripe</option>
                      <option value="caja">caja</option>
                    </select>
                  </Field>
                  <Field label="Referencia" hint="Folio externo (opcional)">
                    <input className={inputClass} value={form.reference}
                      onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} />
                  </Field>
                </div>
                {formError && <p className="mt-3 text-sm font-medium text-rose-600">{formError}</p>}
                <div className="mt-4 flex gap-2">
                  <Button onClick={createTx}
                    disabled={posting || !form.client_id || !form.occurred_on || !form.amount}>
                    {posting ? "Registrando…" : "Registrar transacción"}
                  </Button>
                  <Button variant="secondary" onClick={() => { setShowForm(false); setFormError(null); }}>
                    Cancelar
                  </Button>
                </div>
              </CardBody>
            </Card>
          )}

          {actionError && <ErrorState message={actionError} />}
          {txError && <ErrorState message={txError} onRetry={loadTx} />}
          {!txError && txs === null && <Skeleton rows={4} />}
          {!txError && txs !== null && txs.length === 0 && (
            <EmptyState
              title="Sin transacciones registradas"
              description="Registra la primera transacción real con el formulario de alta; el registro es append-only y toda corrección se hace por contra-asiento."
            />
          )}
          {!txError && txs !== null && txs.length > 0 && (
            <Card>
              <div className="max-h-[32rem] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="bg-white px-5 py-3">Fecha</th>
                      <th className="bg-white px-3 py-3">Cliente</th>
                      <th className="bg-white px-3 py-3 text-right">Monto</th>
                      <th className="bg-white px-3 py-3">Ruta</th>
                      <th className="bg-white px-3 py-3">Referencia</th>
                      <th className="bg-white px-3 py-3">Clasificación</th>
                      <th className="bg-white px-3 py-3 text-right">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {txs.map((t) => {
                      const isReversal = t.reverses_transaction_id !== null;
                      const wasReversed = reversedIds.has(t.id);
                      const negative = parseFloat(t.amount) < 0;
                      return (
                        <tr key={t.id}
                          className={`border-b border-slate-100 last:border-0 ${isReversal ? "bg-slate-50 text-slate-400" : ""}`}>
                          <td className="px-5 py-2 whitespace-nowrap">{t.occurred_on}</td>
                          <td className="px-3 py-2">{clientName[t.client_id] ?? t.client_id}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${negative ? "text-rose-600" : ""}`}>
                            {money(t.amount, currency)}
                          </td>
                          <td className="px-3 py-2">
                            <Badge tone={ROUTE_TONE[t.payment_route] ?? "default"}>{t.payment_route}</Badge>
                          </td>
                          <td className="px-3 py-2 font-mono text-xs">{t.reference || "—"}</td>
                          <td className="px-3 py-2">
                            <span className="inline-flex flex-wrap items-center gap-1">
                              <Badge tone={t.source_type}>{t.source_type}</Badge>
                              {isReversal && <Badge tone="archived">reverso</Badge>}
                              {wasReversed && <Badge tone="failed">revertida</Badge>}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              onClick={() => reverseTx(t)}
                              disabled={isReversal || wasReversed}
                              className="text-xs font-medium text-rose-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-300"
                            >
                              Anular
                            </button>
                          </td>
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

      {/* ---------- Rutas de pago (pantalla 40) ---------- */}
      {tab === "Rutas de pago" && (
        <div className="space-y-6">
          {runError && <ErrorState message={runError} onRetry={loadRun} />}
          {!runError && !runChecked && <Skeleton rows={4} />}
          {!runError && runChecked && !runData && noRunState}
          {!runError && runChecked && runData && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <KpiCard label="Share Stripe (supuesto)"
                  value={pct(assumptions["payments.stripe_share"]?.value)}
                  hint="El resto se cobra en caja (AR)" />
                <KpiCard label="GMV vía Stripe (último mes)"
                  value={money(metrics["tx.gmv_stripe"]?.[lastIdx], currency, true)} />
                <KpiCard label="GMV en caja (último mes)"
                  value={money(metrics["tx.gmv_cash"]?.[lastIdx], currency, true)} />
                <KpiCard label="Fee de procesamiento"
                  value={pct(assumptions["payments.processing_fee_pct"]?.value)}
                  hint={assumptions["payments.processing_fee.enabled"]?.value === "true"
                    ? "Activo: entra a costos variables" : "Informativo: motor apagado"} />
              </div>
              <MetricTable months={months} metrics={metrics} rows={ROUTE_ROWS} currency={currency} />
            </>
          )}
          {assumptionsEditor}
        </div>
      )}

      {/* ---------- Settlements (pantalla 41) ---------- */}
      {tab === "Settlements" && (
        <div className="space-y-5">
          {runError && <ErrorState message={runError} onRetry={loadRun} />}
          {!runError && !runChecked && <Skeleton rows={4} />}
          {!runError && runChecked && !runData && noRunState}
          {!runError && runChecked && runData && runData.settlements.length === 0 && (
            <EmptyState
              title="Sin liquidaciones a negocios"
              description="El motor de settlements está apagado o no hay run. Activa payments.settlement.enabled en el tab Rutas de pago y vuelve a simular."
              action={<Button href={`/simulate/?project=${projectId}&scenario=${scenarioId}`}>Ir a simular</Button>}
            />
          )}
          {!runError && runChecked && runData && runData.settlements.length > 0 && (
            <>
              <Card>
                <CardBody>
                  <p className="mb-3 text-sm font-semibold text-slate-800">Payable a negocios al cierre de mes</p>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={payableData}>
                        <XAxis dataKey="mes" tick={{ fontSize: 10 }} interval={Math.ceil(months.length / 16)} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => money(v, currency, true)} width={80} />
                        <Tooltip formatter={(v: number) => money(v, currency)} />
                        <Legend />
                        <ReferenceLine y={0} stroke="#cbd5e1" />
                        <Line dataKey="Payable a negocios (saldo)" stroke="#713dff" dot={false} strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardBody>
              </Card>
              <Card>
                <div className="max-h-96 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                        <th className="bg-white px-5 py-3">Mes</th>
                        <th className="bg-white px-3 py-3 text-right">Bruto cobrado</th>
                        <th className="bg-white px-3 py-3 text-right">Fee</th>
                        <th className="bg-white px-3 py-3 text-right">Take de Pigui</th>
                        <th className="bg-white px-3 py-3 text-right">A liquidar</th>
                        <th className="bg-white px-3 py-3">Mes de pago</th>
                        <th className="bg-white px-3 py-3">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runData.settlements.map((s) => {
                        const st = SETTLEMENT_STATUS[s.status] ?? { label: s.status, tone: "default" };
                        return (
                          <tr key={s.id} className="border-b border-slate-100 last:border-0">
                            <td className="px-5 py-2 whitespace-nowrap">{monthName(s.month_label)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{money(s.gross_collected, currency)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{money(s.processing_fee, currency)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{money(s.pigui_take, currency)}</td>
                            <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(s.merchant_due, currency)}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{monthOfIndex(s.payout_month_index)}</td>
                            <td className="px-3 py-2"><Badge tone={st.tone}>{st.label}</Badge></td>
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
      )}

      {/* ---------- AR por factura (pantallas 42–43) ---------- */}
      {tab === "AR por factura" && (
        <div className="space-y-5">
          {runError && <ErrorState message={runError} onRetry={loadRun} />}
          {!runError && !runChecked && <Skeleton rows={4} />}
          {!runError && runChecked && !runData && noRunState}
          {!runError && runChecked && runData && (
            <>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <KpiCard label="Por cobrar corriente"
                  value={money(runData.ar.aging.por_cobrar_corriente, currency, true)}
                  hint="Facturas con vencimiento dentro del horizonte" />
                <KpiCard label="Cobro esperado"
                  value={money(runData.ar.aging.cobrado_esperado, currency, true)}
                  tone="good" hint="Según la tasa de cobranza AR" />
                <KpiCard label="Castigo esperado"
                  value={money(runData.ar.aging.castigo_esperado, currency, true)}
                  tone="bad" hint="Incobrables estimados" />
              </div>
              {runData.ar.invoices.length === 0 ? (
                <EmptyState
                  title="Sin facturas de AR"
                  description="El run no generó facturas: no hubo comisión cobrada en caja (ruta AR) en el horizonte."
                />
              ) : (
                <Card>
                  <div className="max-h-96 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                          <th className="bg-white px-5 py-3">Número</th>
                          <th className="bg-white px-3 py-3">Emisión</th>
                          <th className="bg-white px-3 py-3 text-right">Monto</th>
                          <th className="bg-white px-3 py-3">Vencimiento</th>
                          <th className="bg-white px-3 py-3 text-right">Cobro esperado</th>
                          <th className="bg-white px-3 py-3 text-right">Castigo</th>
                          <th className="bg-white px-3 py-3">Estado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runData.ar.invoices.map((inv) => {
                          const st = INVOICE_STATUS[inv.status] ?? { label: inv.status, tone: "default" };
                          return (
                            <tr key={inv.id} className="border-b border-slate-100 last:border-0">
                              <td className="px-5 py-2 font-mono text-xs">{inv.invoice_number}</td>
                              <td className="px-3 py-2 whitespace-nowrap">{monthName(inv.month_label)}</td>
                              <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(inv.amount, currency)}</td>
                              <td className="px-3 py-2 whitespace-nowrap">{monthName(inv.due_month_label)}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{money(inv.expected_collection, currency)}</td>
                              <td className="px-3 py-2 text-right tabular-nums text-rose-600">{money(inv.expected_writeoff, currency)}</td>
                              <td className="px-3 py-2"><Badge tone={st.tone}>{st.label}</Badge></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      )}

      {/* ---------- Conciliación (pantalla 44) ---------- */}
      {tab === "Conciliación" && (
        <div className="space-y-5">
          {runError && <ErrorState message={runError} onRetry={loadRun} />}
          {!runError && !runChecked && <Skeleton rows={4} />}
          {!runError && runChecked && !runData && noRunState}
          {!runError && runChecked && runData && (
            <>
              <SectionTitle
                title="Conciliación devengo vs caja"
                subtitle="Bridge del mes seleccionado: cada renglón es una métrica emitida por el motor, sin aritmética en el cliente."
                right={
                  <select className={`${inputClass} !w-auto`} value={bridgeIdx}
                    onChange={(e) => setBridgeIdx(Number(e.target.value))}>
                    {months.map((m, i) => <option key={m} value={i}>{monthName(m)}</option>)}
                  </select>
                }
              />
              <Card>
                <div className="divide-y divide-slate-100">
                  {BRIDGE_ROWS.map((r) => {
                    const v = metrics[r.key]?.[bridgeIdx] ?? null;
                    const negative = v !== null && parseFloat(v) < 0;
                    return (
                      <div key={r.key} className="flex items-center justify-between gap-3 px-5 py-3">
                        <div>
                          <p className={`text-sm ${r.strong ? "font-semibold text-slate-900" : "text-slate-600"}`}>{r.label}</p>
                          <p className="font-mono text-[11px] text-slate-400">{r.key}</p>
                        </div>
                        <p className={`text-sm tabular-nums ${negative ? "text-rose-600" : "text-slate-800"} ${r.strong ? "font-semibold" : ""}`}>
                          {money(v, currency)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      <p className="mt-6 text-xs text-slate-400">
        El registro de transacciones es operativo y append-only: no alimenta al motor en fase 5 (la conciliación
        real-vs-plan llega en fase 7). Settlements, facturas de AR y series provienen del último run exitoso;
        esta pantalla no calcula nada, solo muestra valores del servidor.
      </p>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><TransactionsHub /></Suspense>;
}
