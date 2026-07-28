"use client";
/** Pantalla 49 — Equipo, capacidad y hiring plan (fase 6). Ruta estática: /hiring?project=&scenario= */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, Cell, XAxis, YAxis, Tooltip, Legend,
} from "recharts";
import {
  api, ApiError, Assumption, BottleneckRow, CostItemT, HiringRoleT, Project, Run, RunResults,
} from "@/lib/api";
import { money, num, monthName, STATUS_LABELS } from "@/lib/format";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, Field, KpiCard, SectionTitle, Skeleton, inputClass,
} from "@/components/ui";

const CAP_KEY = "hiring.capacity.enabled";
const RESULT_KEYS =
  "hiring.headcount,cost.hiring,hiring.onboarding_capacity,b2b.onboarding_capacity,b2b.adds_activated";

/** El motor 1.3.0 agrega al log de bottlenecks la capacidad efectiva y su fuente. */
type BottleneckExt = BottleneckRow & { capacidad_onboarding?: string; fuente_capacidad?: string };

const EMPTY_FORM = {
  name: "", department: "nomina", headcount: "1", monthly_salary: "",
  start_month: "1", end_month: "", ramp_months: "1",
  onboarding_capacity_per_fte: "0", notes: "",
};

function isTrue(v: string): boolean {
  return ["true", "1", "yes", "si", "sí", "on"].includes(v.trim().toLowerCase());
}

/** Errores de la API en español: usa field_errors si el backend los manda. */
function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.detail as { field_errors?: Record<string, string> } | string | null;
    if (d && typeof d === "object" && d.field_errors) {
      return Object.values(d.field_errors).join(" · ");
    }
    return String(e.message);
  }
  return String(e);
}

function HiringPlan() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";
  const scenarioId = params.get("scenario") ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [roles, setRoles] = useState<HiringRoleT[] | null>(null);
  const [assumptions, setAssumptions] = useState<Assumption[] | null>(null);
  const [costItems, setCostItems] = useState<CostItemT[] | null>(null);
  const [results, setResults] = useState<RunResults | null>(null);
  const [runChecked, setRunChecked] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [noProjects, setNoProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Formulario plegable de alta/edición de roles.
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [posting, setPosting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);

  // Supuesto hiring.capacity.enabled con dirty-tracking (patrón del centro de supuestos).
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
          router.replace(`/hiring/?project=${p.id}&scenario=${p.scenarios[0].id}`);
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
      api.get<HiringRoleT[]>(`/projects/${projectId}/hiring-roles`),
      api.get<{ assumptions: Assumption[] }>(`/scenarios/${scenarioId}/assumptions`),
      api.get<CostItemT[]>(`/projects/${projectId}/cost-items`),
    ])
      .then(([p, r, a, ci]) => {
        setProject(p); setRoles(r); setAssumptions(a.assumptions); setCostItems(ci);
      })
      .catch((e) => setError(String(e.message)));
  }, [projectId, scenarioId]);
  useEffect(loadBase, [loadBase]);
  useEffect(() => { setEdits({}); setSaveError(null); }, [scenarioId]);

  // Último run succeeded del escenario: KPIs, gráfica y bottlenecks (el frontend no calcula).
  const loadRun = useCallback(() => {
    if (!scenarioId) return;
    setRunChecked(false);
    setRunError(null);
    setResults(null);
    api.get<Run[]>(`/scenarios/${scenarioId}/runs`)
      .then(async (runs) => {
        const ok = runs.find((r) => r.status === "succeeded");
        if (!ok) { setRunChecked(true); return; }
        const res = await api.get<RunResults>(`/simulation-runs/${ok.id}/results?keys=${RESULT_KEYS}`);
        setResults(res);
        setRunChecked(true);
      })
      .catch((e) => { setRunError(String((e as Error).message)); setRunChecked(true); });
  }, [scenarioId]);
  useEffect(loadRun, [loadRun]);

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
      setSaveError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const startCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setFormError(null);
    setShowForm(true);
  };

  const startEdit = (r: HiringRoleT) => {
    setEditingId(r.id);
    setForm({
      name: r.name, department: r.department, headcount: String(r.headcount),
      monthly_salary: r.monthly_salary, start_month: String(r.start_month),
      end_month: r.end_month === null ? "" : String(r.end_month),
      ramp_months: String(r.ramp_months),
      onboarding_capacity_per_fte: r.onboarding_capacity_per_fte, notes: r.notes,
    });
    setFormError(null);
    setShowForm(true);
  };

  const submitRole = async () => {
    setPosting(true);
    setFormError(null);
    const payload = {
      name: form.name.trim(),
      department: form.department.trim() || "nomina",
      headcount: Number(form.headcount) || 0,
      monthly_salary: form.monthly_salary.trim(),
      start_month: Number(form.start_month) || 0,
      end_month: form.end_month.trim() === "" ? null : Number(form.end_month),
      ramp_months: Number(form.ramp_months) || 0,
      onboarding_capacity_per_fte: form.onboarding_capacity_per_fte.trim() || "0",
      notes: form.notes,
    };
    try {
      if (editingId) {
        await api.patch<HiringRoleT>(`/hiring-roles/${editingId}`, payload);
      } else {
        await api.post<HiringRoleT>(`/projects/${projectId}/hiring-roles`, payload);
      }
      setForm({ ...EMPTY_FORM });
      setShowForm(false);
      setEditingId(null);
      loadBase();
    } catch (e) {
      setFormError(errText(e));
    } finally {
      setPosting(false);
    }
  };

  const archiveRole = async (r: HiringRoleT) => {
    if (!window.confirm(
      `¿Archivar el rol “${r.name}”? No se elimina el histórico: los runs pasados conservan el rol congelado en su snapshot.`,
    )) return;
    setTableError(null);
    try {
      await api.post<HiringRoleT>(`/hiring-roles/${r.id}/archive`, {});
      loadBase();
    } catch (e) {
      setTableError(errText(e));
    }
  };

  const bottlenecks = useMemo(
    () => ((results?.run.bottlenecks ?? []) as BottleneckExt[]),
    [results],
  );

  const chartData = useMemo(() => {
    if (!results) return [];
    const byMonth = new Map<number, BottleneckExt>();
    for (const b of bottlenecks) byMonth.set(b.month, b);
    return results.months.map((m, i) => ({
      mes: monthName(m),
      "Capacidad de onboarding": parseFloat(results.metrics["b2b.onboarding_capacity"]?.[i] ?? "0"),
      "Altas activadas": parseFloat(results.metrics["b2b.adds_activated"]?.[i] ?? "0"),
      limitado: byMonth.get(i + 1)?.restriccion_activa === "capacidad_onboarding",
    }));
  }, [results, bottlenecks]);

  const capacityMonths = useMemo(
    () => bottlenecks.filter((b) => b.restriccion_activa === "capacidad_onboarding"),
    [bottlenecks],
  );
  const hiringIsSource = capacityMonths.some((b) => b.fuente_capacidad === "hiring");

  if (!projectId || !scenarioId) {
    if (noProjects) {
      return (
        <EmptyState
          title="Aún no hay proyectos"
          description="Crea tu primer proyecto para capturar el hiring plan: roles, salarios, rampa y capacidad de onboarding."
          action={<Button href="/projects/new/">Crear proyecto</Button>}
        />
      );
    }
    if (error) return <ErrorState message={error} />;
    return <Skeleton rows={5} />;
  }
  if (error) return <ErrorState message={error} onRetry={loadBase} />;
  if (!project || !roles || !assumptions || !costItems) return <Skeleton rows={5} />;

  const currency = project.base_currency;
  const activeRoles = roles.filter((r) => r.status === "active");
  const nominaItems = costItems.filter((c) => c.category === "nomina");
  const capAssumption = amap[CAP_KEY];
  const capValue = edits[CAP_KEY] ?? capAssumption?.value ?? "false";
  const capOnSaved = isTrue(capAssumption?.value ?? "false");
  const capChanged = CAP_KEY in edits;

  const lastVal = (key: string): string | null => {
    const s = results?.metrics[key] ?? [];
    return [...s].reverse().find((v) => v != null) ?? null;
  };

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link>{" / "}
        <Link href={`/project/?id=${project.id}`} className="hover:text-pigui-700">{project.name}</Link>
        {" / "}Equipo e hiring
      </nav>
      <SectionTitle
        title="Equipo, capacidad y hiring plan"
        subtitle="Roles, salarios, fecha efectiva y rampa; la capacidad de onboarding puede sustituir al supuesto agregado (pantalla 49)."
        right={
          <select
            className={`${inputClass} !w-auto`}
            value={scenarioId}
            onChange={(e) => router.replace(`/hiring/?project=${project.id}&scenario=${e.target.value}`)}
          >
            {project.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        }
      />

      {activeRoles.length > 0 && nominaItems.length > 0 && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <p className="font-semibold">Posible doble conteo de nómina</p>
          <p className="mt-0.5">
            Este proyecto tiene {activeRoles.length} rol(es) activo(s) en el hiring plan y{" "}
            {nominaItems.length} cost item(s) de categoría <span className="font-mono">nomina</span>{" "}
            ({nominaItems.map((c) => c.name).join(", ")}): revisa posible doble conteo de nómina entre el
            hiring plan y los cost items — ambos fluyen al OPEX del run.
          </p>
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-3">
        <KpiCard
          label="Headcount vigente"
          value={num(lastVal("hiring.headcount"), 0)}
          hint="Último mes del run (roles activos en su ventana)"
        />
        <KpiCard
          label="Nómina mensual (cost.hiring)"
          value={money(lastVal("cost.hiring"), currency)}
          hint="Salario completo desde el mes efectivo; la rampa no la reduce"
        />
        <KpiCard
          label="Capacidad de onboarding"
          value={num(lastVal("hiring.onboarding_capacity"), 1)}
          hint={capOnSaved
            ? "Sustituye a b2b.onboarding_capacity_monthly en el run"
            : "Informativa: el run usa b2b.onboarding_capacity_monthly"}
        />
      </div>

      <SectionTitle
        title="Roles del hiring plan"
        subtitle="Los roles se archivan, jamás se eliminan (no eliminar histórico): los runs pasados conservan el rol congelado en su snapshot."
        right={
          <Button onClick={showForm ? () => { setShowForm(false); setEditingId(null); } : startCreate}
            variant={showForm ? "secondary" : "primary"}>
            {showForm ? "Cerrar formulario" : "Nuevo rol"}
          </Button>
        }
      />

      {showForm && (
        <Card className="mb-4">
          <CardBody>
            <p className="mb-3 text-sm font-semibold text-slate-800">
              {editingId ? "Editar rol" : "Alta de rol"}
            </p>
            <div className="grid gap-x-4 gap-y-4 md:grid-cols-3">
              <Field label="Nombre del rol" required>
                <input className={inputClass} value={form.name} placeholder="Onboarding specialist"
                  onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="Departamento" hint="Fluye a cost.cat.* como categoría de OPEX">
                <input className={inputClass} value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })} />
              </Field>
              <Field label="Headcount" required>
                <input className={inputClass} type="number" min={1} value={form.headcount}
                  onChange={(e) => setForm({ ...form, headcount: e.target.value })} />
              </Field>
              <Field label={`Salario mensual por FTE (${currency})`} required
                hint="Costo empresa; se paga completo desde el mes efectivo">
                <input className={inputClass} value={form.monthly_salary} placeholder="30000"
                  onChange={(e) => setForm({ ...form, monthly_salary: e.target.value })} />
              </Field>
              <Field label="Mes efectivo" required>
                <input className={inputClass} type="number" min={1} value={form.start_month}
                  onChange={(e) => setForm({ ...form, start_month: e.target.value })} />
              </Field>
              <Field label="Mes de fin" hint="Vacío = sin fin">
                <input className={inputClass} type="number" min={1} value={form.end_month}
                  onChange={(e) => setForm({ ...form, end_month: e.target.value })} />
              </Field>
              <Field label="Ramp (meses)" hint="Solo modula la capacidad, no la nómina">
                <input className={inputClass} type="number" min={1} value={form.ramp_months}
                  onChange={(e) => setForm({ ...form, ramp_months: e.target.value })} />
              </Field>
              <Field label="Capacidad de onboarding por FTE" hint="Clientes/mes tras la rampa; 0 = no aporta capacidad">
                <input className={inputClass} value={form.onboarding_capacity_per_fte}
                  onChange={(e) => setForm({ ...form, onboarding_capacity_per_fte: e.target.value })} />
              </Field>
              <Field label="Notas">
                <input className={inputClass} value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </Field>
            </div>
            {formError && <p className="mt-3 text-sm font-medium text-rose-600">{formError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => { setShowForm(false); setEditingId(null); }}>
                Cancelar
              </Button>
              <Button onClick={submitRole}
                disabled={posting || !form.name.trim() || !form.monthly_salary.trim()}>
                {posting ? "Guardando…" : editingId ? "Guardar cambios" : "Crear rol"}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {tableError && <p className="mb-3 text-sm font-medium text-rose-600">{tableError}</p>}
      <Card className="mb-8">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3">Rol</th>
                <th className="px-3 py-3">Departamento</th>
                <th className="px-3 py-3 text-right">Headcount</th>
                <th className="px-3 py-3 text-right">Salario mensual</th>
                <th className="px-3 py-3 text-right">Mes efectivo – fin</th>
                <th className="px-3 py-3 text-right">Ramp (meses)</th>
                <th className="px-3 py-3 text-right">Capacidad/FTE</th>
                <th className="px-3 py-3">Estado</th>
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-5 py-2">
                    <p className="font-medium text-slate-800">{r.name}</p>
                    {r.notes && <p className="text-xs text-slate-400">{r.notes}</p>}
                  </td>
                  <td className="px-3 py-2"><Badge>{r.department}</Badge></td>
                  <td className="px-3 py-2 text-right">{num(r.headcount)}</td>
                  <td className="px-3 py-2 text-right">{money(r.monthly_salary, currency)}</td>
                  <td className="px-3 py-2 text-right">
                    {r.start_month} – {r.end_month ?? "∞"}
                  </td>
                  <td className="px-3 py-2 text-right">{num(r.ramp_months)}</td>
                  <td className="px-3 py-2 text-right">{num(r.onboarding_capacity_per_fte, 1)}</td>
                  <td className="px-3 py-2">
                    <Badge tone={r.status}>{STATUS_LABELS[r.status] ?? r.status}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.status === "active" && (
                      <span className="inline-flex gap-1">
                        <Button variant="ghost" onClick={() => startEdit(r)}>Editar</Button>
                        <Button variant="secondary" onClick={() => archiveRole(r)}>Archivar</Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {roles.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-5 py-10 text-center text-sm text-slate-400">
                    Sin roles en el hiring plan. Crea el primero con “Nuevo rol”: la nómina entra al OPEX
                    desde el mes efectivo y la capacidad rampa hasta su valor pleno.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <SectionTitle
        title="Capacidad de onboarding desde el hiring plan"
        subtitle="Los cambios se guardan como overrides del escenario (nueva versión, nunca sobrescribe)."
        right={
          <div className="flex items-center gap-2">
            {savedAt && !dirty && <span className="text-xs text-emerald-600">Guardado {savedAt}</span>}
            <Button onClick={saveAssumptions} disabled={!dirty || saving}>
              {saving ? "Guardando…" : "Guardar cambios"}
            </Button>
          </div>
        }
      />
      {saveError && <p className="mb-3 text-sm font-medium text-rose-600">{saveError}</p>}
      <Card className="mb-8">
        <CardBody>
          {capAssumption ? (
            <div className="grid gap-x-4 gap-y-4 md:grid-cols-2">
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-700">
                    Capacidad de onboarding desde roles
                  </span>
                  <Badge tone={capAssumption.origin === "escenario" ? "hipotesis"
                    : capAssumption.origin === "proyecto" ? "declarado" : "default"}>
                    {capAssumption.origin}
                  </Badge>
                </div>
                <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 ${
                  capChanged ? "border-pigui-500 ring-1 ring-pigui-500" : "border-slate-300"}`}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-pigui-600"
                    checked={isTrue(capValue)}
                    onChange={(e) => setEdit(CAP_KEY, e.target.checked ? "true" : "false",
                      capAssumption.value)}
                  />
                  <span className="text-sm text-slate-700">{isTrue(capValue) ? "Encendido" : "Apagado"}</span>
                </label>
                <p className="mt-1 text-xs text-slate-400">
                  {capAssumption.description || CAP_KEY}{capAssumption.unit && ` · ${capAssumption.unit}`}
                </p>
                <p className="font-mono text-[11px] text-slate-400">{CAP_KEY}</p>
              </div>
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600">
                <p className="font-semibold text-slate-700">¿Qué hace este supuesto?</p>
                <p className="mt-1">
                  Encendido, la capacidad de onboarding de los roles (con rampa) SUSTITUYE el supuesto{" "}
                  <span className="font-mono">b2b.onboarding_capacity_monthly</span> en el motor: las altas
                  B2B quedan limitadas por lo que el equipo puede onboardear cada mes. Si ningún rol aporta
                  capacidad, las altas serán 0 con restricción <span className="font-mono">capacidad_onboarding</span>.
                  Apagado, los roles solo aportan nómina y la capacidad de los roles es informativa.
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              El supuesto <span className="font-mono">{CAP_KEY}</span> no está disponible en el catálogo del
              escenario; actualiza el motor a v1.3.0.
            </p>
          )}
        </CardBody>
      </Card>

      <SectionTitle
        title="Capacidad vs altas activadas"
        subtitle="b2b.onboarding_capacity (línea) contra b2b.adds_activated (barras) del último run exitoso; en rojo los meses con restricción capacidad_onboarding."
        right={results && (
          <Button variant="ghost" href={`/run/?project=${projectId}&id=${results.run.id}`}>
            Restricciones de crecimiento
          </Button>
        )}
      />
      {runError && <ErrorState message={runError} onRetry={loadRun} />}
      {!runError && !runChecked && <Skeleton rows={3} />}
      {!runError && runChecked && !results && (
        <EmptyState
          title="Sin runs exitosos del escenario"
          description="Ejecuta una simulación para ver headcount, nómina y el efecto de la capacidad del hiring plan sobre las altas B2B."
          action={<Button href={`/simulate/?project=${projectId}&scenario=${scenarioId}`}>Ejecutar simulación</Button>}
        />
      )}
      {!runError && results && (
        <Card className="mb-4">
          <CardBody>
            {capacityMonths.length > 0 ? (
              <p className="mb-3 text-xs text-amber-700">
                {capacityMonths.length} mes(es) limitados por capacidad de onboarding
                {hiringIsSource && " — la capacidad proviene del hiring plan"}.
              </p>
            ) : (
              <p className="mb-3 text-xs text-slate-400">
                Ningún mes del run quedó limitado por capacidad de onboarding.
              </p>
            )}
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData}>
                  <XAxis dataKey="mes" tick={{ fontSize: 10 }}
                    interval={Math.ceil(results.months.length / 16)} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => num(v, 0)} width={55} />
                  <Tooltip formatter={(v: number) => num(v, 1)} />
                  <Legend />
                  <Bar dataKey="Altas activadas" radius={[3, 3, 0, 0]} fill="#713dff">
                    {chartData.map((d, i) => (
                      <Cell key={i} fill={d.limitado ? "#f43f5e" : "#713dff"} />
                    ))}
                  </Bar>
                  <Line dataKey="Capacidad de onboarding" stroke="#94a3b8" strokeDasharray="5 3"
                    dot={false} strokeWidth={2} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Run {results.run.id.slice(0, 12)}… · motor v{results.run.engine_version} · las barras en rojo
              marcan meses con <span className="font-mono">restriccion_activa = capacidad_onboarding</span>.
            </p>
          </CardBody>
        </Card>
      )}

      <p className="mt-4 text-xs text-slate-400">
        La nómina es completa desde el mes efectivo; la rampa solo modula la capacidad de onboarding. El motor
        calcula todos los resultados en el servidor; esta pantalla solo captura el hiring plan, edita el
        supuesto de capacidad y visualiza el último run.
      </p>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><HiringPlan /></Suspense>;
}
