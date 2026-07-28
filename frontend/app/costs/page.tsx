"use client";
/** Pantalla 48 — Costos e infraestructura (fase 6). Ruta estática: /costs?project= (&scenario= opcional).
 *  Captura de cost items (incluidos los behaviors tiered_*) y tramos escalonados vía
 *  PUT /cost-items/{id}/tiers; las métricas mostradas provienen del último run exitoso
 *  (el frontend nunca calcula — solo filtra visualmente las claves cost.*). */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, API_URL, ApiError, CostItemT, CostTierT, Project, Run, RunResults } from "@/lib/api";
import { money, num, pct, monthName } from "@/lib/format";
import MetricTable, { MetricRowDef } from "@/components/MetricTable";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, Field, KpiCard, SectionTitle, Skeleton, inputClass,
} from "@/components/ui";

/** Behaviors soportados por el motor (los cuatro existentes + los tres tiered_* de fase 6). */
const BEHAVIORS = [
  "fixed", "per_active_client", "per_transaction", "pct_gmv",
  "tiered_per_active_client", "tiered_per_transaction", "tiered_pct_gmv",
] as const;

const BEHAVIOR_LABELS: Record<string, string> = {
  fixed: "Fijo",
  per_active_client: "Por cliente activo",
  per_transaction: "Por transacción",
  pct_gmv: "% del GMV",
  tiered_per_active_client: "Escalonado por cliente",
  tiered_per_transaction: "Escalonado por transacción",
  tiered_pct_gmv: "Escalonado % GMV",
};

const DRIVER_LABELS: Record<string, string> = {
  tiered_per_active_client: "clientes activos",
  tiered_per_transaction: "transacciones",
  tiered_pct_gmv: "GMV del mes",
};

const AMOUNT_LABELS: Record<string, string> = {
  fixed: "Monto fijo mensual",
  per_active_client: "Tarifa por cliente activo",
  per_transaction: "Tarifa por transacción",
  pct_gmv: "Porcentaje del GMV (decimal, 0.003 = 0.3%)",
};

const CATEGORIES = [
  "nomina", "marketing", "ventas", "tecnologia", "administracion", "producto", "infraestructura", "otros",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  nomina: "Nómina", marketing: "Marketing", ventas: "Ventas", tecnologia: "Tecnología",
  administracion: "Administración", producto: "Producto", infraestructura: "Infraestructura", otros: "Otros",
};

/** KpiCards del último mes del run (todas las series las emite el motor). */
const KPI_DEFS: { key: string; label: string; hint: string }[] = [
  { key: "cost.fixed", label: "Costos fijos (OPEX)", hint: "Items fixed + componente fijo de los tiered_*" },
  { key: "cost.variable_items", label: "Costos variables por item", hint: "Por driver + tramos marginales" },
  { key: "cost.acquisition", label: "Adquisición (CAC)", hint: "Altas activadas × CAC" },
  { key: "cost.campaigns", label: "Campañas", hint: "Gasto de campañas del mes" },
  { key: "cost.processing_fees", label: "Fees de procesamiento", hint: "Rutas de pago (fase 5)" },
  { key: "cost.hiring", label: "Nómina (hiring plan)", hint: "Roles del hiring plan (pantalla 49)" },
];

const isTiered = (behavior: string) => behavior.startsWith("tiered_");

const amountLabel = (behavior: string) =>
  AMOUNT_LABELS[behavior] ?? "Componente fijo mensual (OPEX)";

/** El cliente compartido no expone PUT; se replica su contrato (ApiError con detail). */
async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      const parsed = await res.json();
      detail = parsed.detail ?? parsed.message ?? parsed;
    } catch { /* sin cuerpo */ }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

/** field_errors del 422 del backend (ya vienen en español). */
function extractErrors(e: unknown): { message: string; fields: Record<string, string> } {
  if (e instanceof ApiError) {
    const d = e.detail as { field_errors?: Record<string, string> } | string | null;
    if (d && typeof d === "object" && d.field_errors) {
      return { message: "El servidor rechazó los tramos; revisa los campos marcados.", fields: d.field_errors };
    }
    return { message: String(e.message), fields: {} };
  }
  return { message: String(e), fields: {} };
}

/** Preview textual de la estructura de tramos: '0–500 @ $0.50 · 500–2,000 @ $0.30 · 2,000+ @ $0.10'. */
function tierText(
  tiers: { from: string; to: string | null; rate: string }[],
  behavior: string,
  currency: string,
): string {
  return tiers
    .map((t) => {
      const rate = behavior === "tiered_pct_gmv" ? pct(t.rate, 2) : money(t.rate, currency);
      const from = num(t.from, 0);
      return t.to === null ? `${from}+ @ ${rate}` : `${from}–${num(t.to, 0)} @ ${rate}`;
    })
    .join(" · ");
}

interface TierRow { from: string; to: string; rate: string }

interface CostForm {
  name: string; category: string; behavior: string; amount: string;
  effective_from: string; effective_to: string; notes: string;
}

const EMPTY_FORM: CostForm = {
  name: "", category: "tecnologia", behavior: "fixed", amount: "",
  effective_from: "1", effective_to: "", notes: "",
};

function CostsScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";
  // El escenario no es obligatorio en esta pantalla (los costos son por proyecto),
  // pero si viene en la URL se conserva y se usa para elegir el run.
  const scenarioId = params.get("scenario") ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [items, setItems] = useState<CostItemT[] | null>(null);
  const [tiersMap, setTiersMap] = useState<Record<string, CostTierT[]>>({});
  const [noProjects, setNoProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Último run exitoso (sección de resultados)
  const [results, setResults] = useState<RunResults | null>(null);
  const [runChecked, setRunChecked] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Formulario de alta/edición
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CostForm>({ ...EMPTY_FORM });
  const [tierRows, setTierRows] = useState<TierRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Sin proyecto en la URL: redirige al primero disponible (esta pantalla es por proyecto).
  useEffect(() => {
    if (projectId) return;
    api.get<Project[]>("/projects")
      .then((list) => {
        const p = list[0];
        if (p) router.replace(`/costs/?project=${p.id}`);
        else setNoProjects(true);
      })
      .catch((e) => setError(String(e.message)));
  }, [projectId, router]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const [p, list] = await Promise.all([
        api.get<Project>(`/projects/${projectId}`),
        api.get<CostItemT[]>(`/projects/${projectId}/cost-items`),
      ]);
      setProject(p);
      setItems(list);
      const tiered = list.filter((i) => isTiered(i.behavior));
      const entries = await Promise.all(
        tiered.map(async (i) => [i.id, await api.get<CostTierT[]>(`/cost-items/${i.id}/tiers`)] as const),
      );
      setTiersMap(Object.fromEntries(entries));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const loadRun = useCallback(async () => {
    if (!projectId) return;
    setRunChecked(false);
    setRunError(null);
    setResults(null);
    try {
      let runId: string | null = null;
      if (scenarioId) {
        const runs = await api.get<Run[]>(`/scenarios/${scenarioId}/runs`);
        runId = runs.find((r) => r.status === "succeeded")?.id ?? null;
      } else {
        const p = await api.get<Project>(`/projects/${projectId}`);
        runId = p.kpis?.run_id ?? null; // último run exitoso del proyecto
      }
      if (runId) {
        // Resultados completos SIN filtro de keys: las claves cost.* (incluidas todas las
        // cost.cat.* que emita el motor) se filtran únicamente en la presentación.
        setResults(await api.get<RunResults>(`/simulation-runs/${runId}/results`));
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunChecked(true);
    }
  }, [projectId, scenarioId]);
  useEffect(() => { void loadRun(); }, [loadRun]);

  const catRows: MetricRowDef[] = useMemo(() => {
    if (!results) return [];
    return Object.keys(results.metrics)
      .filter((k) => k.startsWith("cost.cat."))
      .sort()
      .map((k) => {
        const cat = k.slice("cost.cat.".length);
        return { label: CATEGORY_LABELS[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1), key: k };
      });
  }, [results]);

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setTierRows([]);
    setFormError(null);
    setFieldErrors({});
    setShowForm(true);
  };

  const openEdit = (item: CostItemT) => {
    setEditingId(item.id);
    setForm({
      name: item.name, category: item.category, behavior: item.behavior, amount: item.amount,
      effective_from: String(item.effective_from),
      effective_to: item.effective_to === null ? "" : String(item.effective_to),
      notes: item.notes,
    });
    const existing = (tiersMap[item.id] ?? []).map((t) => ({ from: t.from, to: t.to ?? "", rate: t.rate }));
    setTierRows(isTiered(item.behavior) && existing.length === 0 ? [{ from: "0", to: "", rate: "" }] : existing);
    setFormError(null);
    setFieldErrors({});
    setShowForm(true);
  };

  const onBehaviorChange = (behavior: string) => {
    setForm((f) => ({ ...f, behavior }));
    if (isTiered(behavior)) {
      setTierRows((rows) => (rows.length > 0 ? rows : [{ from: "0", to: "", rate: "" }]));
    }
  };

  const updateTier = (idx: number, patch: Partial<TierRow>) => {
    setTierRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const addTier = () => {
    setTierRows((rows) => {
      const last = rows[rows.length - 1];
      return [...rows, { from: last?.to.trim() ? last.to.trim() : "", to: "", rate: "" }];
    });
  };

  const removeTier = (idx: number) => {
    setTierRows((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== idx) : rows));
  };

  const save = async () => {
    setFormError(null);
    setFieldErrors({});
    const effFrom = parseInt(form.effective_from, 10);
    const effToRaw = form.effective_to.trim();
    const effTo = effToRaw === "" ? null : parseInt(effToRaw, 10);
    if (!form.name.trim() || !form.amount.trim()) {
      setFormError("Nombre y monto son obligatorios."); return;
    }
    if (!Number.isFinite(effFrom) || effFrom < 1) {
      setFormError("El mes inicial debe ser un entero ≥ 1."); return;
    }
    if (effTo !== null && (!Number.isFinite(effTo) || effTo < effFrom)) {
      setFormError("El mes final debe ser un entero ≥ al mes inicial (o dejarse vacío)."); return;
    }
    const payload = {
      name: form.name.trim(), category: form.category, behavior: form.behavior,
      amount: form.amount.trim(), effective_from: effFrom, effective_to: effTo,
      notes: form.notes,
    };
    setSaving(true);
    try {
      // La API de costos no expone PATCH: la edición se resuelve con los endpoints
      // existentes como reemplazo (POST del nuevo + PUT de tramos + DELETE del anterior).
      const created = await api.post<{ id: string }>(`/projects/${projectId}/cost-items`, payload);
      if (isTiered(form.behavior)) {
        const tiersPayload = tierRows.map((r) => ({
          from: r.from.trim(),
          to: r.to.trim() === "" ? null : r.to.trim(),
          rate: r.rate.trim(),
        }));
        try {
          await apiPut<CostTierT[]>(`/cost-items/${created.id}/tiers`, tiersPayload);
        } catch (te) {
          // Rollback del alta para no dejar un item escalonado sin tramos válidos.
          await api.del<{ ok: boolean }>(`/cost-items/${created.id}`).catch(() => undefined);
          const { message, fields } = extractErrors(te);
          setFormError(message);
          setFieldErrors(fields);
          return;
        }
      }
      if (editingId) {
        try {
          await api.del<{ ok: boolean }>(`/cost-items/${editingId}`);
        } catch (de) {
          setActionError(
            "El concepto editado se guardó como alta nueva, pero no se pudo eliminar la versión anterior: "
            + (de instanceof ApiError ? String(de.message) : String(de)),
          );
        }
      }
      setShowForm(false);
      setEditingId(null);
      await load();
    } catch (e) {
      const { message, fields } = extractErrors(e);
      setFormError(message);
      setFieldErrors(fields);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: CostItemT) => {
    if (!window.confirm(`¿Eliminar el concepto "${item.name}"? Sus tramos dejan de aplicar en el siguiente run; los runs pasados conservan su snapshot congelado.`)) return;
    setActionError(null);
    try {
      await api.del<{ ok: boolean }>(`/cost-items/${item.id}`);
      await load();
    } catch (e) {
      setActionError(e instanceof ApiError ? String(e.message) : String(e));
    }
  };

  if (!projectId) {
    if (noProjects) {
      return (
        <EmptyState
          title="Aún no hay proyectos"
          description="Crea tu primer proyecto para capturar los costos e infraestructura de Pigui: fijos, variables por driver y escalonados por tramos."
          action={<Button href="/projects/new/">Crear proyecto</Button>}
        />
      );
    }
    if (error) return <ErrorState message={error} />;
    return <Skeleton rows={5} />;
  }
  if (error) return <ErrorState message={error} onRetry={() => { void load(); }} />;
  if (!project || items === null) return <Skeleton rows={5} />;

  const currency = project.base_currency;
  const months = results?.months ?? [];
  const metrics = results?.metrics ?? {};
  const lastIdx = months.length - 1;
  const scenarioQS = scenarioId ? `&scenario=${scenarioId}` : "";
  const formIsTiered = isTiered(form.behavior);
  const formPreview = tierText(
    tierRows.map((r) => ({ from: r.from, to: r.to.trim() === "" ? null : r.to, rate: r.rate })),
    form.behavior, currency,
  );

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link>{" / "}
        <Link href={`/project/?id=${project.id}`} className="hover:text-pigui-700">{project.name}</Link>
        {" / "}Costos e infraestructura
      </nav>
      <SectionTitle
        title="Costos e infraestructura"
        subtitle="Pantalla 48 · costos fijos, variables por driver y escalonados por tramos marginales"
        right={
          <Button onClick={showForm ? () => setShowForm(false) : openCreate} variant={showForm ? "secondary" : "primary"}>
            {showForm ? "Cerrar formulario" : "Nuevo costo"}
          </Button>
        }
      />

      <div className="mb-5 rounded-lg border border-pigui-200 bg-pigui-50 p-3 text-xs text-pigui-900">
        <p className="font-semibold">
          Costo mensual del item = componente fijo (OPEX) + Σ tramos marginales sobre el driver (costos variables)
        </p>
        <p className="mt-0.5">
          Los tramos son marginales y contiguos desde 0; el último queda abierto (sin &quot;hasta&quot;). Ejemplo de
          estructura: 0–500 @ {money("0.50", currency)} · 500–2,000 @ {money("0.30", currency)} · 2,000+ @ {money("0.10", currency)}.
          El motor clasifica el componente fijo en OPEX y los tramos en costos variables; esta pantalla solo captura
          la estructura y nunca calcula resultados.
        </p>
      </div>

      {actionError && <div className="mb-4"><ErrorState message={actionError} /></div>}

      {/* ---------- Formulario de alta/edición ---------- */}
      {showForm && (
        <Card className="mb-6">
          <CardBody>
            <p className="mb-4 text-sm font-semibold text-slate-800">
              {editingId ? "Editar concepto de costo" : "Alta de concepto de costo"}
            </p>
            {editingId && (
              <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
                La API de costos no expone edición in situ: al guardar se crea el concepto con los valores nuevos
                (y sus tramos) y se elimina la versión anterior.
              </p>
            )}
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Nombre" required>
                <input className={inputClass} value={form.name} placeholder="Infraestructura cloud"
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </Field>
              <Field label="Categoría" hint="Fluye al P&L como cost.cat.*">
                <select className={inputClass} value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                </select>
              </Field>
              <Field label="Comportamiento" error={fieldErrors.behavior}>
                <select className={inputClass} value={form.behavior}
                  onChange={(e) => onBehaviorChange(e.target.value)}>
                  {BEHAVIORS.map((b) => <option key={b} value={b}>{BEHAVIOR_LABELS[b]}</option>)}
                </select>
              </Field>
              <Field label={amountLabel(form.behavior)} required
                hint={formIsTiered ? "Va a OPEX; los tramos van a costos variables"
                  : form.behavior === "pct_gmv" ? "Decimal 0–1 sobre el GMV (0.003 = 0.3%)" : `En ${currency}`}>
                <input className={inputClass} value={form.amount} placeholder="0.00"
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
              </Field>
              <Field label="Mes inicial" hint="Ventana efectiva desde este mes (índice 1..N)">
                <input className={inputClass} value={form.effective_from}
                  onChange={(e) => setForm((f) => ({ ...f, effective_from: e.target.value }))} />
              </Field>
              <Field label="Mes final" hint="Vacío = sin fin dentro del horizonte">
                <input className={inputClass} value={form.effective_to} placeholder="—"
                  onChange={(e) => setForm((f) => ({ ...f, effective_to: e.target.value }))} />
              </Field>
              <div className="md:col-span-3">
                <Field label="Notas">
                  <input className={inputClass} value={form.notes}
                    onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
                </Field>
              </div>
            </div>

            {formIsTiered && (
              <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">
                    Tramos marginales sobre {DRIVER_LABELS[form.behavior] ?? "el driver"}
                  </p>
                  <Button variant="secondary" onClick={addTier}>Agregar tramo</Button>
                </div>
                <p className="mb-3 text-xs text-slate-500">
                  El primer &quot;desde&quot; debe ser 0 y cada &quot;hasta&quot; debe igualar el &quot;desde&quot; del
                  siguiente tramo; &quot;hasta&quot; vacío = tramo abierto final.
                  {form.behavior === "tiered_pct_gmv" && " La tarifa es decimal 0–1 sobre el GMV del tramo."}
                </p>
                <div className="space-y-2">
                  {tierRows.map((r, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <span className="w-14 text-xs text-slate-500">Tramo {i + 1}</span>
                      <input className={`${inputClass} !w-28`} value={r.from} placeholder="desde"
                        onChange={(e) => updateTier(i, { from: e.target.value })} />
                      <span className="text-xs text-slate-400">–</span>
                      <input className={`${inputClass} !w-28`} value={r.to}
                        placeholder={i === tierRows.length - 1 ? "abierto" : "hasta"}
                        onChange={(e) => updateTier(i, { to: e.target.value })} />
                      <span className="text-xs text-slate-400">@</span>
                      <input className={`${inputClass} !w-28`} value={r.rate}
                        placeholder={form.behavior === "tiered_pct_gmv" ? "0.005" : "tarifa"}
                        onChange={(e) => updateTier(i, { rate: e.target.value })} />
                      <button onClick={() => removeTier(i)} disabled={tierRows.length === 1}
                        className="text-xs font-medium text-rose-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-300">
                        Quitar
                      </button>
                    </div>
                  ))}
                </div>
                {fieldErrors.tiers && <p className="mt-2 text-xs font-medium text-rose-600">{fieldErrors.tiers}</p>}
                <p className="mt-3 text-xs text-slate-600">
                  <span className="font-semibold">Estructura capturada:</span>{" "}
                  <span className="font-mono">{formPreview || "—"}</span>
                  <span className="text-slate-400"> · driver: {DRIVER_LABELS[form.behavior]}</span>
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Es solo la estructura declarada: el costo resultante lo calcula el motor en el siguiente run.
                </p>
              </div>
            )}

            {formError && <p className="mt-3 text-sm font-medium text-rose-600">{formError}</p>}
            <div className="mt-4 flex gap-2">
              <Button onClick={() => { void save(); }} disabled={saving}>
                {saving ? "Guardando…" : editingId ? "Guardar cambios" : "Crear concepto"}
              </Button>
              <Button variant="secondary" onClick={() => { setShowForm(false); setFormError(null); }}>
                Cancelar
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ---------- Tabla de cost items ---------- */}
      {items.length === 0 ? (
        <EmptyState
          title="Sin conceptos de costo"
          description="Captura los costos fijos, variables por driver y escalonados por tramos del proyecto; todos llegan al P&L del siguiente run."
          action={<Button onClick={openCreate}>Nuevo costo</Button>}
        />
      ) : (
        <Card className="mb-8">
          <div className="max-h-[32rem] overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="bg-white px-5 py-3">Concepto</th>
                  <th className="bg-white px-3 py-3">Categoría</th>
                  <th className="bg-white px-3 py-3">Comportamiento</th>
                  <th className="bg-white px-3 py-3 text-right">Monto</th>
                  <th className="bg-white px-3 py-3">Ventana efectiva</th>
                  <th className="bg-white px-3 py-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const tiered = isTiered(item.behavior);
                  const tiers = tiersMap[item.id] ?? [];
                  return (
                    <tr key={item.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-5 py-2.5">
                        <p className="font-medium text-slate-800">{item.name}</p>
                        {item.notes && <p className="text-xs text-slate-400">{item.notes}</p>}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge>{CATEGORY_LABELS[item.category] ?? item.category}</Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={tiered ? "hipotesis" : "default"}>
                          {BEHAVIOR_LABELS[item.behavior] ?? item.behavior}
                        </Badge>
                        {tiered && (
                          tiers.length > 0 ? (
                            <p className="mt-1 font-mono text-[11px] text-slate-400">
                              {tierText(tiers, item.behavior, currency)}
                            </p>
                          ) : (
                            <p className="mt-1 text-[11px] font-medium text-amber-600">
                              Sin tramos capturados: el item es inerte para el motor.
                            </p>
                          )
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {item.behavior === "pct_gmv" ? pct(item.amount, 2) : money(item.amount, currency)}
                        {tiered && <p className="text-[11px] text-slate-400">fijo + tramos</p>}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">
                        {item.effective_to === null
                          ? `Mes ${item.effective_from} en adelante`
                          : `Mes ${item.effective_from}–${item.effective_to}`}
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <button onClick={() => openEdit(item)}
                          className="text-xs font-medium text-pigui-700 hover:underline">
                          Editar
                        </button>
                        <button onClick={() => { void remove(item); }}
                          className="ml-3 text-xs font-medium text-rose-600 hover:underline">
                          Eliminar
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

      {/* ---------- Costos del último run exitoso ---------- */}
      <SectionTitle
        title="Costos del último run exitoso"
        subtitle="Solo lectura: series cost.* emitidas por el motor; el filtrado por prefijo es visual, sin aritmética en el cliente."
      />
      {runError && <ErrorState message={runError} onRetry={() => { void loadRun(); }} />}
      {!runError && !runChecked && <Skeleton rows={4} />}
      {!runError && runChecked && !results && (
        <EmptyState
          title="Aún no hay un run exitoso"
          description="Los montos de esta sección provienen de la última simulación exitosa. Ejecuta una simulación para ver los costos por categoría mes a mes."
          action={<Button href={`/simulate/?project=${projectId}${scenarioQS}`}>Ir a simular</Button>}
        />
      )}
      {!runError && runChecked && results && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3">
            {KPI_DEFS.map((d) => (
              <KpiCard key={d.key} label={d.label}
                value={money(metrics[d.key]?.[lastIdx], currency, true)}
                hint={`${d.hint} · ${months[lastIdx] ? monthName(months[lastIdx]) : "último mes"}`} />
            ))}
          </div>
          {catRows.length > 0 ? (
            <>
              <p className="mb-2 text-sm font-semibold text-slate-800">Costos por categoría (cost.cat.*) mes a mes</p>
              <MetricTable months={months} metrics={metrics} rows={catRows} currency={currency} />
            </>
          ) : (
            <EmptyState
              title="El run no emitió series cost.cat.*"
              description="Simula de nuevo con conceptos de costo capturados para ver el desglose por categoría."
            />
          )}
        </>
      )}

      <p className="mt-6 text-xs text-slate-400">
        Costo mensual del item = componente fijo (OPEX) + Σ tramos marginales sobre el driver (costos variables).
        Los tramos se guardan con reemplazo completo del set (PUT) y se congelan en el snapshot de cada run;
        el motor calcula todos los resultados en el servidor — esta pantalla solo captura la estructura y muestra
        las series del último run exitoso.
      </p>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><CostsScreen /></Suspense>;
}
