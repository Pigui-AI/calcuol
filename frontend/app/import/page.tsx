"use client";
/** Pantallas IA-01…IA-07 — Importación con IA (fase 8, sección 8 del documento).
 *
 * Ruta estática: /import/?project=&client=
 *
 * Regla 1.2 y sección 8: la IA propone y explica; el usuario confirma antes de
 * persistir. Esta pantalla NO calcula nada: la confianza, las bandas (8.2), las
 * inconsistencias y todos los resúmenes vienen del servidor; aquí solo se cargan
 * archivos, se revisan las propuestas y se confirma el commit transaccional.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  API_URL, api, ApiError, Client, Project,
  ImportAnalyzeResult, ImportCommitResult, ImportDetail, ImportEntityGroup,
  ImportHistoryResponse, ImportHistoryRow, ImportJobT, ImportProposalT, SourceFileT,
} from "@/lib/api";
import { num, pct } from "@/lib/format";
import {
  Badge, Button, Card, CardBody, EmptyState, ErrorState, Field, KpiCard,
  SectionTitle, Skeleton, StepIndicator, inputClass,
} from "@/components/ui";

const STEPS = ["Cargar", "Procesar", "Revisar", "Confirmar", "Historial"];

const ACCEPT = ".xlsx,.csv,.pdf,.docx";
const SUPPORTED_EXT = ["xlsx", "csv", "pdf", "docx"];
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // el servidor rechaza por encima de 10 MB
const MAX_FILES = 20;

const TARGETS: { value: string; label: string; hint: string }[] = [
  { value: "auto", label: "Detección automática", hint: "El servidor clasifica cada tabla por sus encabezados." },
  { value: "clients", label: "Clientes B2B", hint: "Fuerza la entidad Cliente en todas las tablas." },
  { value: "catalog", label: "Catálogo de productos y servicios", hint: "Requiere cliente destino con al menos una sucursal." },
  { value: "baseline", label: "Línea base del cliente", hint: "Requiere cliente destino; la línea base es 1-1 con el cliente." },
  { value: "costs", label: "Costos e infraestructura", hint: "Crea partidas de costo a nivel proyecto." },
];
/** Destinos que el servidor no puede escribir sin `client_id`. */
const CLIENT_REQUIRED = ["catalog", "baseline"];

const BAND_TONE: Record<string, string> = { alta: "real", media: "queued", baja: "failed" };
const BAND_LABEL: Record<string, string> = {
  alta: "Confianza alta", media: "Confianza media", baja: "Confianza baja",
};

const PROPOSAL_TONE: Record<string, string> = {
  propuesta: "default", aceptada: "active", editada: "declarado",
  ignorada: "archived", conflicto: "queued",
};
const PROPOSAL_LABEL: Record<string, string> = {
  propuesta: "Propuesta", aceptada: "Aceptada", editada: "Editada",
  ignorada: "Ignorada", conflicto: "Conflicto",
};

const JOB_TONE: Record<string, string> = {
  borrador: "draft", analizando: "running", revision: "queued",
  commiteado: "succeeded", fallido: "failed", cancelado: "archived",
};
const JOB_LABEL: Record<string, string> = {
  borrador: "Borrador", analizando: "Analizando", revision: "En revisión",
  commiteado: "Confirmada", fallido: "Fallida", cancelado: "Cancelada",
};

const FILE_TONE: Record<string, string> = {
  cargado: "draft", parseado: "succeeded", no_soportado: "archived", error: "failed",
};
const FILE_LABEL: Record<string, string> = {
  cargado: "Cargado", parseado: "Parseado", no_soportado: "No soportado", error: "Error",
};

const SEVERITY_TONE: Record<string, string> = { alta: "failed", media: "queued", baja: "default" };

const ENTITY_LABEL: Record<string, string> = {
  Client: "Cliente", Branch: "Sucursal", ProductService: "Producto o servicio",
  ClientBaseline: "Línea base", CostItem: "Costo",
};

const FIELD_LABEL: Record<string, string> = {
  trade_name: "Nombre comercial", legal_name: "Razón social", industry: "Industria",
  currency: "Moneda", contact_name: "Contacto", contact_email: "Correo", contact_phone: "Teléfono",
  name: "Nombre", location: "Ubicación", timezone: "Zona horaria",
  monthly_capacity: "Capacidad mensual", sku: "SKU", category: "Categoría",
  sale_price: "Precio de venta", direct_cost: "Costo directo",
  monthly_inventory: "Inventario mensual", reward_eligible: "Elegible para rewards",
  avg_monthly_sales: "Ventas mensuales promedio", avg_monthly_transactions: "Transacciones mensuales",
  avg_ticket: "Ticket promedio", margin_pct: "Margen", purchase_frequency: "Frecuencia de compra",
  registered_consumers: "Consumidores registrados", active_consumers: "Consumidores activos",
  monthly_buyers: "Compradores mensuales", amount: "Monto", behavior: "Comportamiento",
  effective_from: "Vigente desde (mes)", effective_to: "Vigente hasta (mes)",
};

const SOURCE_TYPE_LABEL: Record<string, string> = {
  real: "Real", declarado: "Declarado", estimado: "Estimado",
  hipotesis: "Hipótesis", meta: "Meta",
};

const entityLabel = (t: string | null) => (t ? ENTITY_LABEL[t] ?? t : "Sin clasificar");
const fieldLabel = (f: string) => FIELD_LABEL[f] ?? f;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("es-MX");
}

function extOf(filename: string): string {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
}

/** Traduce el `detail` de la API (string, lista de FastAPI u objeto) a un texto legible. */
function detailText(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const item = d as { msg?: string; loc?: unknown[] };
        if (!item.msg) return JSON.stringify(d);
        const where = (item.loc ?? []).slice(1).join(".");
        return where ? `${where}: ${item.msg}` : item.msg;
      })
      .join(" · ");
  }
  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return String(detail ?? "Error desconocido");
}

function errText(e: unknown): string {
  if (e instanceof ApiError) return detailText(e.detail);
  return e instanceof Error ? e.message : String(e);
}

function countsText(counts: Record<string, number> | null | undefined): string {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) return "—";
  return entries.map(([k, v]) => `${entityLabel(k)} ×${v}`).join(" · ");
}

function ImportFlow() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project") ?? "";
  const clientParam = params.get("client") ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [clients, setClients] = useState<Client[] | null>(null);
  const [noProjects, setNoProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [step, setStep] = useState(0);

  // IA-01
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [chosen, setChosen] = useState<File[]>([]);
  const [target, setTarget] = useState("auto");
  const [clientId, setClientId] = useState(clientParam);
  const [allowInference, setAllowInference] = useState(false);
  const [consent, setConsent] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // job en curso
  const [job, setJob] = useState<ImportJobT | null>(null);
  const [jobFiles, setJobFiles] = useState<SourceFileT[]>([]);
  const [readOnly, setReadOnly] = useState(false);

  // IA-02
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // IA-03/04/05
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // IA-06
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<ImportCommitResult | null>(null);

  // IA-07
  const [history, setHistory] = useState<ImportHistoryResponse | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Sin ?project=: redirige al primer proyecto disponible (convención del repo).
  useEffect(() => {
    if (projectId) return;
    api.get<Project[]>("/projects")
      .then((list) => {
        if (list.length > 0) router.replace(`/import/?project=${list[0].id}`);
        else setNoProjects(true);
      })
      .catch((e) => setError(errText(e)));
  }, [projectId, router]);

  const loadBase = useCallback(() => {
    if (!projectId) return;
    setError(null);
    Promise.all([
      api.get<Project>(`/projects/${projectId}`),
      api.get<{ clients: Client[] }>(`/projects/${projectId}/clients`),
    ])
      .then(([p, c]) => { setProject(p); setClients(c.clients); })
      .catch((e) => setError(errText(e)));
  }, [projectId]);
  useEffect(loadBase, [loadBase]);

  const loadHistory = useCallback(() => {
    if (!projectId) return;
    setHistoryError(null);
    api.get<ImportHistoryResponse>(`/projects/${projectId}/imports`)
      .then(setHistory)
      .catch((e) => setHistoryError(errText(e)));
  }, [projectId]);
  useEffect(loadHistory, [loadHistory]);

  const loadDetail = useCallback(async (id: string) => {
    const d = await api.get<ImportDetail>(`/imports/${id}`);
    setDetail(d);
    setJob(d.job);
    setJobFiles(d.files);
    return d;
  }, []);

  // ------------------------------------------------------------------ IA-01
  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    setUploadError(null);
    setChosen((prev) => {
      const merged = [...prev];
      Array.from(incoming).forEach((f) => {
        if (!merged.some((x) => x.name === f.name && x.size === f.size)) merged.push(f);
      });
      return merged.slice(0, MAX_FILES);
    });
  };

  const removeFile = (index: number) =>
    setChosen((prev) => prev.filter((_, i) => i !== index));

  const clientRequired = CLIENT_REQUIRED.includes(target);
  const canUpload =
    chosen.length > 0 && consent && (!clientRequired || !!clientId) && !uploading;

  const upload = async () => {
    setUploadError(null);
    if (chosen.length === 0) {
      setUploadError("Elige al menos un archivo XLSX, CSV, PDF o DOCX.");
      return;
    }
    if (clientRequired && !clientId) {
      setUploadError("El catálogo y la línea base se escriben sobre un cliente: elige el cliente destino.");
      return;
    }
    if (!consent) {
      setUploadError("Confirma el aviso de conservación de archivos para continuar.");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      chosen.forEach((f) => form.append("files", f));
      form.append("target", target);
      if (clientId) form.append("client_id", clientId);
      form.append("allow_inference", String(allowInference));
      form.append("actor", "usuario");
      // multipart: fetch nativo (api.post fuerza Content-Type JSON).
      const res = await fetch(`${API_URL}/projects/${projectId}/imports`, {
        method: "POST", body: form, cache: "no-store",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const raw = body as { detail?: unknown; message?: unknown } | null;
        throw new ApiError(res.status, raw?.detail ?? raw?.message ?? res.statusText);
      }
      const created = body as { job: ImportJobT; files: SourceFileT[] };
      setJob(created.job);
      setJobFiles(created.files);
      setDetail(null);
      setCommitResult(null);
      setCommitError(null);
      setAnalyzeError(null);
      setEdits({});
      setReadOnly(false);
      setChosen([]);
      if (fileInput.current) fileInput.current.value = "";
      loadHistory();
      setStep(1);
    } catch (e) {
      setUploadError(errText(e));
    } finally {
      setUploading(false);
    }
  };

  // ------------------------------------------------------------------ IA-02
  const analyze = async () => {
    if (!job) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const result = await api.post<ImportAnalyzeResult>(
        `/imports/${job.id}/analyze`, { actor: "usuario" });
      setJob(result.job);
      setJobFiles(result.files);
      setEdits({});
      await loadDetail(job.id);
      loadHistory();
    } catch (e) {
      setAnalyzeError(errText(e));
    } finally {
      setAnalyzing(false);
    }
  };

  // ------------------------------------------------------------------ IA-05
  const patchProposal = async (proposal: ImportProposalT, changes: Record<string, string>) => {
    if (!job || readOnly) return;
    setRowBusy((b) => ({ ...b, [proposal.id]: true }));
    setActionError(null);
    try {
      await api.patch<ImportProposalT>(`/import-proposals/${proposal.id}`,
        { ...changes, actor: "usuario" });
      setEdits((prev) => {
        const next = { ...prev };
        delete next[proposal.id];
        return next;
      });
      await loadDetail(job.id);
    } catch (e) {
      setActionError(errText(e));
    } finally {
      setRowBusy((b) => {
        const next = { ...b };
        delete next[proposal.id];
        return next;
      });
    }
  };

  /** 8.2: solo la banda alta se puede aceptar en bloque; nunca media, baja ni conflictos. */
  const acceptHighConfidence = async (rows: ImportProposalT[]) => {
    if (!job || readOnly) return;
    const pending = rows.filter(
      (r) => r.band === "alta" && r.status !== "conflicto"
        && r.status !== "aceptada" && r.status !== "editada");
    if (pending.length === 0) return;
    setBulkBusy(true);
    setActionError(null);
    try {
      for (const row of pending) {
        await api.patch<ImportProposalT>(`/import-proposals/${row.id}`,
          { status: "aceptada", actor: "usuario" });
      }
      await loadDetail(job.id);
    } catch (e) {
      setActionError(errText(e));
    } finally {
      setBulkBusy(false);
    }
  };

  // ------------------------------------------------------------------ IA-06
  const commit = async () => {
    if (!job) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const result = await api.post<ImportCommitResult>(
        `/imports/${job.id}/commit`, { actor: "usuario" });
      setCommitResult(result);
      setJob(result.job);
      setReadOnly(true);
      await loadDetail(job.id).catch(() => { /* el resumen ya viene en el commit */ });
      loadHistory();
    } catch (e) {
      setCommitError(errText(e));
      await loadDetail(job.id).catch(() => { /* el job pudo quedar 'fallido' */ });
      loadHistory();
    } finally {
      setCommitting(false);
    }
  };

  const cancelJob = async () => {
    if (!job) return;
    if (!window.confirm("¿Descartar esta importación? Las propuestas se conservan solo como historial.")) return;
    setActionError(null);
    try {
      const updated = await api.post<ImportJobT>(`/imports/${job.id}/cancel`, { actor: "usuario" });
      setJob(updated);
      setReadOnly(true);
      loadHistory();
    } catch (e) {
      setActionError(errText(e));
    }
  };

  // ------------------------------------------------------------------ IA-07
  const openHistoryJob = async (row: ImportHistoryRow) => {
    setJob(row);
    setJobFiles(row.files);
    setDetail(null);
    setDetailError(null);
    setCommitResult(null);
    setCommitError(null);
    setAnalyzeError(null);
    setActionError(null);
    setEdits({});
    setReadOnly(row.status !== "revision");
    setStep(2);
    try {
      await loadDetail(row.id);
    } catch (e) {
      setDetailError(errText(e));
    }
  };

  const startNew = () => {
    setJob(null);
    setJobFiles([]);
    setDetail(null);
    setDetailError(null);
    setCommitResult(null);
    setCommitError(null);
    setAnalyzeError(null);
    setActionError(null);
    setEdits({});
    setChosen([]);
    setConsent(false);
    setReadOnly(false);
    setStep(0);
  };

  /** Lo que el commit escribirá: grupos marcados como escribibles por el servidor. */
  const commitPlan = useMemo(() => {
    if (!detail) return [] as { entity_type: string; entities: number; fields: number }[];
    const acc: Record<string, { entities: number; fields: number }> = {};
    detail.entities.forEach((group) => {
      const writable = group.fields.filter(
        (f) => f.status === "aceptada" || f.status === "editada");
      if (writable.length === 0) return;
      const bucket = acc[group.entity_type] ?? { entities: 0, fields: 0 };
      bucket.entities += 1;
      bucket.fields += writable.length;
      acc[group.entity_type] = bucket;
    });
    return Object.entries(acc).map(([entity_type, v]) => ({ entity_type, ...v }));
  }, [detail]);

  const writableFields = commitPlan.reduce((s, r) => s + r.fields, 0);

  // ------------------------------------------------------------------ guards
  if (!projectId) {
    if (noProjects) {
      return (
        <EmptyState
          title="Aún no hay proyectos"
          description="La importación con IA escribe clientes, catálogo, líneas base y costos dentro de un proyecto. Crea el primero para empezar."
          action={<Button href="/projects/new/">Crear proyecto</Button>}
        />
      );
    }
    if (error) return <ErrorState message={error} />;
    return <Skeleton rows={5} />;
  }
  if (error) return <ErrorState message={error} onRetry={loadBase} />;
  if (!project || !clients) return <Skeleton rows={5} />;

  const summary = detail?.summary ?? job?.result_summary ?? null;
  const targetClient = clients.find((c) => c.id === (job?.client_id ?? clientId)) ?? null;

  // ------------------------------------------------------------------ render
  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link>{" / "}
        <Link href={`/project/?id=${project.id}`} className="hover:text-pigui-700">{project.name}</Link>
        {" / "}Importación con IA
      </nav>

      <SectionTitle
        title="Importación con IA"
        subtitle="Cargar documentos → extraer y mapear → revisar propuesta por propuesta → confirmar en una sola transacción. La IA propone y explica; tú confirmas."
        right={
          <div className="flex flex-wrap items-center gap-2">
            {job && (
              <Badge tone={JOB_TONE[job.status] ?? "default"}>
                {JOB_LABEL[job.status] ?? job.status}
              </Badge>
            )}
            <Button variant="secondary" onClick={() => { loadHistory(); setStep(4); }}>
              Historial
            </Button>
            {job && <Button variant="ghost" onClick={startNew}>Nueva importación</Button>}
          </div>
        }
      />

      <StepIndicator steps={STEPS} current={step} />

      {readOnly && step < 4 && job && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          <p className="font-semibold text-slate-700">Modo lectura</p>
          <p className="mt-0.5">
            La importación está en estado «{JOB_LABEL[job.status] ?? job.status}»: sus propuestas ya no se
            pueden editar. Para corregir algo, crea una importación nueva con los archivos actualizados.
          </p>
        </div>
      )}

      {/* =============================================================== IA-01 */}
      {step === 0 && (
        <div className="space-y-5">
          <Card>
            <CardBody className="space-y-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">IA-01 · Cargar documentos</h3>
                <p className="mt-0.5 text-sm text-slate-500">
                  Formatos soportados: XLSX, CSV, PDF y DOCX. Máximo {MAX_FILES} archivos de 10 MB cada uno.
                </p>
              </div>

              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
                onClick={() => fileInput.current?.click()}
                className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition
                  ${dragging ? "border-pigui-500 bg-pigui-50" : "border-slate-300 bg-slate-50 hover:border-pigui-400 hover:bg-pigui-50/40"}`}
              >
                <p className="text-sm font-semibold text-slate-700">
                  Arrastra tus archivos aquí o haz clic para elegirlos
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Estados de cuenta, catálogos de precios, reportes de ventas, listas de costos…
                </p>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept={ACCEPT}
                  className="hidden"
                  onChange={(e) => addFiles(e.target.files)}
                />
              </div>

              {chosen.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-slate-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <th className="px-4 py-2">Archivo</th>
                        <th className="px-3 py-2">Tipo</th>
                        <th className="px-3 py-2 text-right">Tamaño</th>
                        <th className="px-3 py-2 text-right">Quitar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chosen.map((f, i) => {
                        const ext = extOf(f.name);
                        const badExt = !SUPPORTED_EXT.includes(ext);
                        const tooBig = f.size > MAX_FILE_BYTES;
                        return (
                          <tr key={`${f.name}-${f.size}`} className="border-b border-slate-100 last:border-0">
                            <td className="px-4 py-2">
                              <p className="font-medium text-slate-800">{f.name}</p>
                              {badExt && (
                                <p className="text-xs text-rose-600">
                                  Extensión no soportada; el servidor la rechazará.
                                </p>
                              )}
                              {tooBig && (
                                <p className="text-xs text-rose-600">Supera el límite de 10 MB por archivo.</p>
                              )}
                            </td>
                            <td className="px-3 py-2 uppercase text-slate-500">{ext || "—"}</td>
                            <td className="px-3 py-2 text-right text-slate-600">{formatBytes(f.size)}</td>
                            <td className="px-3 py-2 text-right">
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                                className="text-xs font-medium text-rose-600 hover:underline"
                              >
                                Quitar
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <Field
                  label="Destino de los datos"
                  hint={TARGETS.find((t) => t.value === target)?.hint}
                >
                  <select className={inputClass} value={target}
                    onChange={(e) => setTarget(e.target.value)}>
                    {TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </Field>
                <Field
                  label="Cliente destino"
                  required={clientRequired}
                  hint={clientRequired
                    ? "Obligatorio para catálogo y línea base: son entidades que cuelgan de un cliente."
                    : "Opcional: acota la importación a un cliente del portafolio."}
                >
                  <select className={inputClass} value={clientId}
                    onChange={(e) => setClientId(e.target.value)}>
                    <option value="">— Sin cliente destino —</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>{c.trade_name || c.legal_name}</option>
                    ))}
                  </select>
                </Field>
              </div>

              {clientRequired && clients.length === 0 && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  El proyecto todavía no tiene clientes. Crea uno antes de importar catálogo o línea base.
                </p>
              )}

              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-300 p-3">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-pigui-600"
                  checked={allowInference} onChange={(e) => setAllowInference(e.target.checked)} />
                <span className="text-sm text-slate-700">
                  Permitir inferencias
                  <span className="mt-0.5 block text-xs text-slate-500">
                    Autoriza al motor a derivar campos que no aparecen literalmente en el documento. Toda
                    inferencia llega como propuesta con su banda de confianza y necesita tu revisión: nada
                    se escribe sin confirmación.
                  </span>
                </span>
              </label>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                <p className="font-semibold text-slate-700">Aviso de consentimiento</p>
                <p className="mt-0.5">
                  Los archivos se conservan para trazar el origen de cada campo: cada valor escrito guarda
                  su archivo fuente, su celda o sección y la confianza con la que se extrajo. El hash SHA-256
                  de cada documento queda en el historial de fuentes.
                </p>
                <label className="mt-2 flex cursor-pointer items-center gap-2">
                  <input type="checkbox" className="h-4 w-4 accent-pigui-600"
                    checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span className="text-slate-700">Entiendo y autorizo la carga de estos documentos.</span>
                </label>
              </div>

              {uploadError && (
                <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                  {uploadError}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2">
                <span className="mr-auto text-xs text-slate-400">
                  {chosen.length > 0
                    ? `${num(chosen.length)} archivo(s) listos para subir`
                    : "Ningún archivo seleccionado"}
                </span>
                <Button onClick={upload} disabled={!canUpload}>
                  {uploading ? "Subiendo…" : "Subir y continuar"}
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {/* =============================================================== IA-02 */}
      {step === 1 && (
        !job ? (
          <EmptyState
            title="Todavía no hay una importación abierta"
            description="Sube uno o más documentos en el paso «Cargar» para poder analizarlos."
            action={<Button onClick={() => setStep(0)}>Ir a cargar</Button>}
          />
        ) : (
          <div className="space-y-5">
            <Card>
              <CardBody className="space-y-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-slate-900">IA-02 · Procesar y extraer</h3>
                    <p className="mt-0.5 text-sm text-slate-500">
                      El servidor parsea cada archivo, clasifica sus tablas, propone mapeos con confianza
                      y marca conflictos contra lo que ya existe en el proyecto. No escribe nada todavía.
                    </p>
                  </div>
                  {!readOnly && (
                    <Button onClick={analyze} disabled={analyzing}>
                      {analyzing ? "Analizando…" : job.analyzed_at ? "Volver a analizar" : "Analizar"}
                    </Button>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs text-slate-500 md:grid-cols-4">
                  <div>
                    <p className="font-semibold text-slate-700">Destino</p>
                    <p>{TARGETS.find((t) => t.value === job.target)?.label ?? job.target}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-slate-700">Cliente destino</p>
                    <p>{targetClient ? (targetClient.trade_name || targetClient.legal_name) : "—"}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-slate-700">Inferencias</p>
                    <p>{job.allow_inference ? "Permitidas" : "No permitidas"}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-slate-700">Creada</p>
                    <p>{formatDate(job.created_at)}</p>
                  </div>
                </div>

                {analyzeError && <ErrorState message={analyzeError} onRetry={analyze} />}
                {job.error && !analyzeError && (
                  <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                    {job.error}
                  </p>
                )}
              </CardBody>
            </Card>

            <Card>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-5 py-3">Archivo</th>
                      <th className="px-3 py-3">Estado</th>
                      <th className="px-3 py-3 text-right">Tamaño</th>
                      <th className="px-3 py-3 text-right">Tablas</th>
                      <th className="px-3 py-3 text-right">Propuestas</th>
                      <th className="px-3 py-3">Detalle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobFiles.map((f) => (
                      <tr key={f.id} className="border-b border-slate-100 last:border-0 align-top">
                        <td className="px-5 py-2.5">
                          <p className="font-medium text-slate-800">{f.filename}</p>
                          <p className="font-mono text-[11px] text-slate-400">
                            sha256 {f.sha256.slice(0, 16)}…
                          </p>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge tone={FILE_TONE[f.status] ?? "default"}>
                            {FILE_LABEL[f.status] ?? f.status}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right text-slate-600">{formatBytes(f.size_bytes)}</td>
                        <td className="px-3 py-2.5 text-right text-slate-600">
                          {num(f.parse_summary?.tables?.length ?? 0)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-slate-600">
                          {num(f.parse_summary?.proposals ?? 0)}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-500">
                          {f.error
                            ? <span className="text-rose-600">{f.error}</span>
                            : (f.parse_summary
                              ? `${num(f.parse_summary.text_blocks ?? 0)} bloque(s) de texto · ${num(f.parse_summary.issues ?? 0)} inconsistencia(s)`
                              : "Pendiente de análisis")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {summary && (
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                  <KpiCard label="Propuestas" value={num(summary.proposals)}
                    hint="Campos extraídos por el motor" />
                  <KpiCard label="Confianza media" value={pct(summary.confidence, 1)}
                    hint={`Banda del job: ${job.band}`} />
                  <KpiCard label="Confianza alta" value={num(summary.by_band?.alta ?? 0)}
                    tone="good" hint="≥ 0.90 · preseleccionable" />
                  <KpiCard label="Confianza media" value={num(summary.by_band?.media ?? 0)}
                    hint="0.70–0.89 · revisión explícita" />
                  <KpiCard label="Confianza baja" value={num(summary.by_band?.baja ?? 0)}
                    tone={(summary.by_band?.baja ?? 0) > 0 ? "bad" : "muted"}
                    hint="< 0.70 · no se mapea por defecto" />
                </div>

                <Card>
                  <CardBody>
                    <p className="mb-3 text-sm font-semibold text-slate-800">
                      Tablas detectadas y entidad inferida
                    </p>
                    {(summary.tables ?? []).length === 0 ? (
                      <p className="text-sm text-slate-500">
                        Ninguna tabla reconocible. Revisa que los encabezados tengan nombres de columna
                        (producto, precio, costo, ventas mensuales…) en la primera fila.
                      </p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[560px] text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                              <th className="py-2 pr-3">Archivo</th>
                              <th className="py-2 pr-3">Tabla</th>
                              <th className="py-2 pr-3">Entidad inferida</th>
                              <th className="py-2 pr-3 text-right">Filas</th>
                              <th className="py-2 text-right">Score</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(summary.tables ?? []).map((t, i) => (
                              <tr key={`${t.file}-${t.table}-${i}`} className="border-b border-slate-100 last:border-0">
                                <td className="py-2 pr-3 text-slate-600">{t.file ?? "—"}</td>
                                <td className="py-2 pr-3 font-mono text-xs text-slate-700">{t.table}</td>
                                <td className="py-2 pr-3">
                                  {t.entity_type
                                    ? <Badge tone="declarado">{entityLabel(t.entity_type)}</Badge>
                                    : <Badge tone="archived">Sin clasificar</Badge>}
                                </td>
                                <td className="py-2 pr-3 text-right text-slate-600">{num(t.rows)}</td>
                                <td className="py-2 text-right text-slate-600">{pct(t.score, 0)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardBody>
                </Card>

                {summary.note && (
                  <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                    {summary.note}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="secondary" onClick={() => setStep(0)}>Volver</Button>
              <Button onClick={() => setStep(2)} disabled={!detail}>Revisar propuestas</Button>
            </div>
          </div>
        )
      )}

      {/* ======================================================== IA-03/04/05 */}
      {step === 2 && (
        detailError ? (
          <ErrorState message={detailError} onRetry={() => job && loadDetail(job.id).catch((e) => setDetailError(errText(e)))} />
        ) : !job ? (
          <EmptyState
            title="No hay una importación abierta"
            description="Carga documentos o abre una importación anterior desde el historial."
            action={<Button onClick={() => setStep(0)}>Ir a cargar</Button>}
          />
        ) : !detail ? (
          <Skeleton rows={6} />
        ) : detail.entities.length === 0 ? (
          <EmptyState
            title="El análisis no produjo propuestas"
            description="Ninguna tabla del documento coincidió con las entidades soportadas. Revisa los encabezados o fuerza un destino distinto y vuelve a analizar."
            action={<Button onClick={() => setStep(1)}>Volver a procesar</Button>}
          />
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <KpiCard label="Entidades" value={num(detail.totals.entities)}
                hint="Grupos de campos por entidad" />
              <KpiCard label="Propuestas" value={num(detail.totals.proposals)} />
              <KpiCard label="Aceptadas o editadas"
                value={num((detail.totals.by_status.aceptada ?? 0) + (detail.totals.by_status.editada ?? 0))}
                tone="good" hint="Son las únicas que el commit escribe" />
              <KpiCard label="Conflictos" value={num(detail.totals.conflicts)}
                tone={detail.totals.conflicts > 0 ? "bad" : "muted"}
                hint="Ya existen en el proyecto" />
              <KpiCard label="Inconsistencias" value={num(detail.issues.length)}
                tone={detail.issues.length > 0 ? "bad" : "muted"} />
            </div>

            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <p className="font-semibold">Regla 8.2 — bandas de confianza</p>
              <p className="mt-0.5">
                Alta (≥ 0.90): se puede aceptar en bloque, pero nunca se auto-confirma sin que pulses el
                botón. Media (0.70–0.89): exige revisión explícita campo por campo. Baja (&lt; 0.70): no se
                mapea por defecto — acéptala solo tras verificarla, o márcala como hipótesis. Las propuestas
                en conflicto quedan siempre fuera de las acciones masivas.
              </p>
            </div>

            {actionError && (
              <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                {actionError}
              </p>
            )}

            {!readOnly && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-3">
                <span className="text-sm text-slate-600">
                  Acción masiva sobre toda la importación (solo banda alta, sin conflictos).
                </span>
                <Button
                  variant="secondary"
                  disabled={bulkBusy}
                  onClick={() => acceptHighConfidence(detail.entities.flatMap((g) => g.fields))}
                >
                  {bulkBusy ? "Aplicando…" : "Aceptar todas las de confianza alta"}
                </Button>
              </div>
            )}

            {/* IA-04 · inconsistencias */}
            <Card>
              <CardBody>
                <p className="mb-3 text-sm font-semibold text-slate-800">
                  IA-04 · Inconsistencias detectadas
                </p>
                {detail.issues.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    El servidor no encontró duplicados, monedas mezcladas, márgenes negativos ni tickets
                    inconsistentes en estos archivos.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {detail.issues.map((issue, i) => (
                      <li key={`${issue.code}-${issue.entity_ref}-${i}`}
                        className="flex flex-wrap items-start gap-2 rounded-lg border border-slate-200 p-2.5">
                        <Badge tone={SEVERITY_TONE[issue.severity] ?? "default"}>
                          Severidad {issue.severity}
                        </Badge>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-slate-700">{issue.message}</p>
                          <p className="mt-0.5 font-mono text-[11px] text-slate-400">
                            {issue.code}
                            {issue.entity_ref ? ` · ${issue.entity_ref}` : ""}
                            {issue.file ? ` · ${issue.file}` : ""}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            {/* IA-03/05 · grupos por entidad */}
            {detail.entities.map((group) => (
              <EntityGroupCard
                key={`${group.entity_type}:${group.entity_ref}`}
                group={group}
                files={detail.files}
                readOnly={readOnly}
                edits={edits}
                rowBusy={rowBusy}
                bulkBusy={bulkBusy}
                onEdit={(id, value) => setEdits((prev) => ({ ...prev, [id]: value }))}
                onClearEdit={(id) => setEdits((prev) => {
                  const next = { ...prev };
                  delete next[id];
                  return next;
                })}
                onPatch={patchProposal}
                onAcceptHigh={() => acceptHighConfidence(group.fields)}
              />
            ))}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="secondary" onClick={() => setStep(1)}>Volver a procesar</Button>
              <div className="flex flex-wrap gap-2">
                {!readOnly && job.status !== "commiteado" && (
                  <Button variant="ghost" onClick={cancelJob}>Descartar importación</Button>
                )}
                <Button onClick={() => setStep(3)}>Ir a confirmar</Button>
              </div>
            </div>
          </div>
        )
      )}

      {/* =============================================================== IA-06 */}
      {step === 3 && (
        !job || !detail ? (
          <EmptyState
            title="Nada que confirmar todavía"
            description="Carga documentos, analízalos y revisa las propuestas antes de confirmar."
            action={<Button onClick={() => setStep(0)}>Ir a cargar</Button>}
          />
        ) : (
          <div className="space-y-5">
            <Card>
              <CardBody className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">IA-06 · Confirmar importación</h3>
                  <p className="mt-0.5 text-sm text-slate-500">
                    El commit escribe en una sola transacción únicamente las propuestas aceptadas o
                    editadas, y deja un registro de procedencia por cada campo. Si algo falla, se revierte
                    todo: no se persiste ninguna entidad parcial.
                  </p>
                </div>

                {commitPlan.length === 0 ? (
                  <EmptyState
                    title="No hay propuestas aceptadas"
                    description="El servidor rechaza un commit vacío. Vuelve a la revisión y acepta o edita al menos una propuesta."
                    action={<Button onClick={() => setStep(2)}>Volver a revisar</Button>}
                  />
                ) : (
                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                          <th className="px-4 py-2">Entidad</th>
                          <th className="px-3 py-2 text-right">Se crearán o actualizarán</th>
                          <th className="px-3 py-2 text-right">Campos a escribir</th>
                        </tr>
                      </thead>
                      <tbody>
                        {commitPlan.map((row) => (
                          <tr key={row.entity_type} className="border-b border-slate-100 last:border-0">
                            <td className="px-4 py-2 font-medium text-slate-800">
                              {entityLabel(row.entity_type)}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-700">{num(row.entities)}</td>
                            <td className="px-3 py-2 text-right text-slate-700">{num(row.fields)}</td>
                          </tr>
                        ))}
                        <tr className="bg-slate-50 font-semibold">
                          <td className="px-4 py-2 text-slate-800">Total</td>
                          <td className="px-3 py-2 text-right text-slate-800">
                            {num(commitPlan.reduce((s, r) => s + r.entities, 0))}
                          </td>
                          <td className="px-3 py-2 text-right text-slate-800">{num(writableFields)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}

                {detail.totals.conflicts > 0 && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                    Quedan {num(detail.totals.conflicts)} propuesta(s) en conflicto sin resolver. Las
                    propuestas en conflicto no se escriben: el valor vigente del proyecto se conserva
                    salvo que las aceptes o edites explícitamente en la revisión.
                  </p>
                )}
                {(detail.summary?.issues_by_severity?.alta ?? 0) > 0 && (
                  <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                    Hay {num(detail.summary.issues_by_severity.alta)} inconsistencia(s) de severidad alta.
                    Revísalas antes de confirmar: el servidor rechaza valores imposibles (por ejemplo, un
                    costo directo mayor que el precio de venta).
                  </p>
                )}

                {commitError && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                    <p className="font-semibold">La importación no se pudo confirmar</p>
                    <p className="mt-1">{commitError}</p>
                    <p className="mt-1 text-xs">
                      La transacción se revirtió por completo: <strong>no se persistió nada</strong>. Corrige
                      las propuestas señaladas y vuelve a intentar, o crea una importación nueva.
                    </p>
                  </div>
                )}

                {commitResult ? (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                    <p className="font-semibold">Importación confirmada</p>
                    <p className="mt-1">
                      Se escribieron {num(commitResult.fields_written)} campo(s) en{" "}
                      {num(commitResult.entities.length)} entidad(es).
                    </p>
                    <p className="mt-1 text-xs">
                      Creadas: {countsText(commitResult.created)} · Actualizadas: {countsText(commitResult.updated)}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="secondary" href={`/clients/?project=${projectId}`}>
                        Ver portafolio B2B
                      </Button>
                      {job.client_id && (
                        <Button variant="secondary" href={`/client/?project=${projectId}&id=${job.client_id}`}>
                          Abrir cliente destino
                        </Button>
                      )}
                      <Button variant="ghost" onClick={startNew}>Nueva importación</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="mr-auto text-xs text-slate-400">
                      Job {job.id} · {JOB_LABEL[job.status] ?? job.status}
                    </span>
                    <Button variant="secondary" onClick={() => setStep(2)}>Volver a revisar</Button>
                    <Button
                      onClick={commit}
                      disabled={committing || readOnly || commitPlan.length === 0 || job.status !== "revision"}
                    >
                      {committing ? "Confirmando…" : "Confirmar importación"}
                    </Button>
                  </div>
                )}

                {job.status !== "revision" && !commitResult && (
                  <p className="text-xs text-slate-400">
                    Solo se pueden confirmar importaciones en estado «En revisión»; esta está en
                    «{JOB_LABEL[job.status] ?? job.status}».
                  </p>
                )}
              </CardBody>
            </Card>
          </div>
        )
      )}

      {/* =============================================================== IA-07 */}
      {step === 4 && (
        <div className="space-y-5">
          <SectionTitle
            title="IA-07 · Historial de fuentes"
            subtitle="Cada importación conserva sus archivos con hash, su confianza y las entidades que afectó. Haz clic en una fila para abrirla en modo lectura."
            right={<Button onClick={startNew}>Nueva importación</Button>}
          />

          {historyError && <ErrorState message={historyError} onRetry={loadHistory} />}
          {!history && !historyError && <Skeleton rows={4} />}

          {history && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <KpiCard label="Importaciones" value={num(history.kpis.count)} />
                <KpiCard label="Confirmadas" value={num(history.kpis.committed)} tone="good" />
                <KpiCard label="En revisión" value={num(history.kpis.in_review)} />
                <KpiCard label="Fallidas" value={num(history.kpis.failed)}
                  tone={history.kpis.failed > 0 ? "bad" : "muted"} />
              </div>

              {history.imports.length === 0 ? (
                <EmptyState
                  title="Sin importaciones todavía"
                  description="Cuando subas tu primer documento, aquí quedará el rastro completo: archivos, hash, confianza y entidades afectadas."
                  action={<Button onClick={startNew}>Cargar documentos</Button>}
                />
              ) : (
                <Card>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[860px] text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                          <th className="px-5 py-3">Fecha</th>
                          <th className="px-3 py-3">Archivos</th>
                          <th className="px-3 py-3 text-right">Confianza</th>
                          <th className="px-3 py-3">Estado</th>
                          <th className="px-3 py-3">Entidades</th>
                          <th className="px-3 py-3 text-right">Incidencias</th>
                          <th className="px-3 py-3 text-right"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.imports.map((row) => (
                          <tr
                            key={row.id}
                            onClick={() => openHistoryJob(row)}
                            className={`cursor-pointer border-b border-slate-100 align-top last:border-0 hover:bg-pigui-50/50
                              ${job?.id === row.id ? "bg-pigui-50/60" : ""}`}
                          >
                            <td className="px-5 py-2.5">
                              <p className="font-medium text-slate-800">{formatDate(row.created_at)}</p>
                              <p className="text-xs text-slate-400">
                                {TARGETS.find((t) => t.value === row.target)?.label ?? row.target}
                                {row.allow_inference ? " · inferencias permitidas" : ""}
                              </p>
                            </td>
                            <td className="px-3 py-2.5">
                              {row.files.length === 0
                                ? <span className="text-slate-400">—</span>
                                : (
                                  <ul className="space-y-0.5">
                                    {row.files.map((f) => (
                                      <li key={f.id} className="text-xs">
                                        <span className="text-slate-700">{f.filename}</span>
                                        <span className="ml-1 font-mono text-[10px] text-slate-400">
                                          {f.sha256.slice(0, 10)}…
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <p className="text-slate-700">{pct(row.confidence, 1)}</p>
                              <Badge tone={BAND_TONE[row.band] ?? "default"}>{row.band}</Badge>
                            </td>
                            <td className="px-3 py-2.5">
                              <Badge tone={JOB_TONE[row.status] ?? "default"}>
                                {JOB_LABEL[row.status] ?? row.status}
                              </Badge>
                              {row.error && (
                                <p className="mt-1 max-w-[220px] text-xs text-rose-600">{row.error}</p>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-slate-600">
                              {countsText(row.entities_affected)}
                              <p className="mt-0.5 text-slate-400">
                                {num(row.proposals.total)} propuesta(s)
                              </p>
                            </td>
                            <td className="px-3 py-2.5 text-right text-xs text-slate-600">
                              <p>{num(row.issues)} inconsistencia(s)</p>
                              <p className="text-slate-400">{num(row.conflicts)} conflicto(s)</p>
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <span className="text-xs font-medium text-pigui-700">Abrir</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      )}

      <p className="mt-6 text-xs text-slate-400">
        Nada se persiste sin confirmación humana (regla 1.2). La confianza, las bandas, las inconsistencias
        y los resúmenes los calcula el servidor; esta pantalla solo los presenta y registra tus decisiones.
      </p>
    </div>
  );
}

/** Tarjeta de un grupo (entidad + entity_ref) con su tabla de campos (IA-03/05). */
function EntityGroupCard({
  group, files, readOnly, edits, rowBusy, bulkBusy,
  onEdit, onClearEdit, onPatch, onAcceptHigh,
}: {
  group: ImportEntityGroup;
  files: SourceFileT[];
  readOnly: boolean;
  edits: Record<string, string>;
  rowBusy: Record<string, boolean>;
  bulkBusy: boolean;
  onEdit: (id: string, value: string) => void;
  onClearEdit: (id: string) => void;
  onPatch: (proposal: ImportProposalT, changes: Record<string, string>) => void;
  onAcceptHigh: () => void;
}) {
  const highPending = group.fields.filter(
    (f) => f.band === "alta" && f.status !== "conflicto"
      && f.status !== "aceptada" && f.status !== "editada").length;
  const fileName = (id: string | null) =>
    files.find((f) => f.id === id)?.filename ?? "";

  return (
    <Card className={group.has_conflict ? "border-amber-300" : ""}>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="declarado">{entityLabel(group.entity_type)}</Badge>
              <h4 className="truncate text-base font-semibold text-slate-900">
                {group.entity_ref || "(sin identificador)"}
              </h4>
              <Badge tone={BAND_TONE[group.band] ?? "default"}>
                {BAND_LABEL[group.band] ?? group.band}
              </Badge>
              {group.has_conflict && <Badge tone="queued">Conflicto</Badge>}
              {group.writable && <Badge tone="active">Se escribirá</Badge>}
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Confianza mínima del grupo: {pct(group.confidence, 1)} · {num(group.fields.length)} campo(s)
            </p>
          </div>
          {!readOnly && (
            <Button variant="secondary" disabled={bulkBusy || highPending === 0} onClick={onAcceptHigh}>
              {highPending === 0
                ? "Sin pendientes de confianza alta"
                : `Aceptar las ${highPending} de confianza alta`}
            </Button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3">Campo</th>
                <th className="py-2 pr-3">Valor propuesto</th>
                <th className="py-2 pr-3">Valor crudo</th>
                <th className="py-2 pr-3">Locator</th>
                <th className="py-2 pr-3">Confianza</th>
                <th className="py-2 pr-3">Estado</th>
                <th className="py-2 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {group.fields.map((p) => {
                const dirty = p.id in edits;
                const value = edits[p.id] ?? p.proposed_value;
                const busy = !!rowBusy[p.id];
                const conflict = p.status === "conflicto";
                return (
                  <tr key={p.id}
                    className={`border-b border-slate-100 align-top last:border-0 ${conflict ? "bg-amber-50/60" : ""}`}>
                    <td className="py-2.5 pr-3">
                      <p className="font-medium text-slate-800">{fieldLabel(p.field_name)}</p>
                      <p className="font-mono text-[11px] text-slate-400">
                        {p.field_name}{p.unit ? ` · ${p.unit}` : ""}
                      </p>
                    </td>
                    <td className="py-2.5 pr-3">
                      <input
                        className={`${inputClass} !py-1.5 ${dirty ? "!border-pigui-500 !ring-1 !ring-pigui-500" : ""}`}
                        value={value}
                        disabled={readOnly || busy}
                        onChange={(e) => onEdit(p.id, e.target.value)}
                      />
                      {conflict && (
                        <div className="mt-1.5 grid grid-cols-2 gap-2 rounded-md border border-amber-200 bg-white p-2 text-xs">
                          <div>
                            <p className="font-semibold text-slate-500">Valor vigente</p>
                            <p className="break-words text-slate-800">{p.conflict_value ?? "—"}</p>
                          </div>
                          <div>
                            <p className="font-semibold text-slate-500">Valor propuesto</p>
                            <p className="break-words text-slate-800">{p.proposed_value || "—"}</p>
                          </div>
                        </div>
                      )}
                      {dirty && !readOnly && (
                        <div className="mt-1.5 flex gap-2">
                          <button type="button" disabled={busy}
                            onClick={() => onPatch(p, { proposed_value: value })}
                            className="text-xs font-medium text-pigui-700 hover:underline disabled:opacity-50">
                            Guardar edición
                          </button>
                          <button type="button" onClick={() => onClearEdit(p.id)}
                            className="text-xs font-medium text-slate-500 hover:underline">
                            Cancelar
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 max-w-[160px] break-words text-slate-500">
                      {p.raw_value || "—"}
                    </td>
                    <td className="py-2.5 pr-3">
                      <p className="font-mono text-[11px] text-slate-500">{p.locator || "—"}</p>
                      {p.source_file_id && (
                        <p className="text-[11px] text-slate-400">{fileName(p.source_file_id)}</p>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={BAND_TONE[p.band] ?? "default"}>
                        {BAND_LABEL[p.band] ?? p.band}
                      </Badge>
                      <p className="mt-0.5 text-[11px] text-slate-400">{pct(p.confidence, 1)}</p>
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={PROPOSAL_TONE[p.status] ?? "default"}>
                        {PROPOSAL_LABEL[p.status] ?? p.status}
                      </Badge>
                      <p className="mt-0.5">
                        <Badge tone={p.source_type}>
                          {SOURCE_TYPE_LABEL[p.source_type] ?? p.source_type}
                        </Badge>
                      </p>
                    </td>
                    <td className="py-2.5 text-right">
                      {readOnly ? (
                        <span className="text-xs text-slate-400">Solo lectura</span>
                      ) : (
                        <div className="flex flex-col items-end gap-1">
                          <button type="button" disabled={busy || p.status === "aceptada"}
                            onClick={() => onPatch(p, { status: "aceptada" })}
                            className="text-xs font-medium text-emerald-700 hover:underline disabled:opacity-40">
                            Aceptar
                          </button>
                          <button type="button" disabled={busy || p.status === "ignorada"}
                            onClick={() => onPatch(p, { status: "ignorada" })}
                            className="text-xs font-medium text-slate-500 hover:underline disabled:opacity-40">
                            Ignorar
                          </button>
                          <button type="button" disabled={busy || p.source_type === "hipotesis"}
                            onClick={() => onPatch(p, { source_type: "hipotesis" })}
                            className="text-xs font-medium text-purple-700 hover:underline disabled:opacity-40">
                            Marcar hipótesis
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {group.fields.some((f) => f.notes) && (
          <ul className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            {group.fields.filter((f) => f.notes).map((f) => (
              <li key={`note-${f.id}`} className="text-[11px] text-slate-500">
                <span className="font-mono text-slate-600">{f.field_name}</span>: {f.notes}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><ImportFlow /></Suspense>;
}
