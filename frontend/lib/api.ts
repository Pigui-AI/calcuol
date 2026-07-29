/** Cliente de la API del motor financiero. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? body.message ?? body;
    } catch { /* sin cuerpo */ }
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body), headers }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ---------- tipos ----------
export interface Scenario {
  id: string; project_id: string; name: string; type: string; status: string;
}
export interface ProjectKpis {
  run_id: string; scenario_id: string; revenue_y1: string | null; ebitda_y1: string | null;
  breakeven_month: number | null; funding_need: string | null; final_cash: string | null;
}
export interface Project {
  id: string; name: string; description: string; status: string; base_currency: string;
  start_month: string; horizon_months: number; scenarios: Scenario[];
  clients_count: number; kpis: ProjectKpis | null; created_at: string;
}
export interface Baseline {
  avg_monthly_sales: string; avg_monthly_transactions: string; avg_ticket: string;
  margin_pct: string; registered_consumers: number; active_consumers: number;
  monthly_buyers: number; purchase_frequency: string; source_type: string; confidence: number;
}
export interface CatalogItem {
  id: string; branch_id: string; type: string; name: string; sku: string; category: string;
  sale_price: string; direct_cost: string; margin: string; margin_pct: string | null;
  reward_eligible: boolean; status: string;
}
export interface BranchInfo {
  id: string; name: string; location: string; timezone: string; status: string;
  monthly_capacity: number | null; catalog_count: number;
}
export interface Client {
  id: string; project_id: string; legal_name: string; trade_name: string; industry: string;
  status: string; currency: string; contact_name: string; contact_email: string;
  contact_phone: string; notes: string; brands_count: number; branches_count: number;
  baseline: Baseline | null;
  brands?: { id: string; name: string; branches: BranchInfo[] }[];
  catalog?: CatalogItem[];
  warning?: string;
}
export interface Assumption {
  key: string; value: string; origin: string; source_type: string; unit: string; description: string;
}
export interface RunSummary {
  breakeven_month: number | null; breakeven_label: string | null; min_cash: string;
  funding_need: string; final_cash: string; final_clients: string; final_consumers: string;
  annual: { year: number; revenue: string; gmv: string; ebitda: string; opex: string;
            clients_end: string; consumers_end: string; cash_end: string }[];
  derived_inputs: Record<string, { from: string; to: string; source: string }>;
  ltv_b2c?: string;
}
export interface BottleneckRow {
  month: number; objetivo_curva: string; altas_deseadas: string;
  altas_activadas: string; restriccion_activa: string;
}
export interface CohortRow {
  cohort_month: number; cohort_label: string; initial_size: string; sizes: (string | null)[];
}
export interface RetentionPoint {
  age: number; retention: string; survival: string; activity_factor: string;
}
export interface GrowthPreview {
  months: string[];
  metrics: Record<string, (string | null)[]>;
  totals: Record<string, string>;
  bottlenecks: BottleneckRow[];
  cohorts: CohortRow[];
  cohorts_enabled: boolean;
  retention_curve: RetentionPoint[];
  ltv_b2c: string | null;
  derived_inputs: Record<string, { from: string; to: string; source: string }>;
  assumptions: Record<string, { value: string; origin: string; unit: string; description: string }>;
  input_hash: string;
  engine_version: string;
}
export interface Run {
  id: string; scenario_id: string; status: string; engine_version: string;
  horizon_months: number; input_hash: string; output_hash: string | null; error: string | null;
  created_at: string; finished_at: string | null;
  summary?: RunSummary;
  bottlenecks?: BottleneckRow[];
  cohorts?: CohortRow[];
  subs_cohorts?: SubsCohortRow[];
  token_ledger?: TokenMovementLog[];
}
export interface TokenMovementLog {
  month: number; movement_type: string; units: string;
  unit_cost?: string; unit_price?: string; amount?: string;
}
export interface RunResults {
  run: Run; months: string[]; metrics: Record<string, (string | null)[]>;
  project: { id: string; name: string; base_currency: string; start_month: string; horizon_months: number };
  scenario: { id: string; name: string; type: string };
}
export interface CostItemT {
  id: string; name: string; category: string; behavior: string; amount: string;
  effective_from: number; effective_to: number | null; notes: string;
}

// ---------- fase 5: campañas, transacciones, settlements ----------
export interface CampaignEffect { value: string; origin: string; }
export interface CampaignT {
  id: string; project_id: string; name: string; description: string;
  campaign_type: string; status: string; start_month: number; end_month: number;
  created_by: string; created_at: string | null; updated_at: string | null;
  effects?: Record<string, CampaignEffect>;
  history?: { key: string; value: string; unit: string; version: number;
              source_type: string; created_by: string; created_at: string | null }[];
}
export interface CampaignsSummaryTotals {
  total_spend: string; total_extra_points: string; total_gmv_incremental: string;
  total_revenue_incremental: string; roi_total: string;
}
export interface CampaignsPreview {
  months: string[];
  metrics: Record<string, (string | null)[]>;
  campaigns: { id: string; name: string; campaign_type: string; status: string;
               start_month: number; end_month: number; effects: Record<string, string> }[];
  campaigns_enabled: boolean;
  summary_campaigns: CampaignsSummaryTotals;
  derived_inputs?: Record<string, { from: string; to: string; source: string }>;
  input_hash: string;
  engine_version: string;
}
export interface TransactionT {
  id: string; project_id: string; client_id: string; branch_id: string | null;
  campaign_id: string | null; occurred_on: string; month_label: string; amount: string;
  payment_route: string; reward_eligible: boolean; points_issued: string;
  points_redeemed: string; reference: string; reverses_transaction_id: string | null;
  source_type: string; created_by: string; created_at: string | null;
}
export interface TransactionsRouteSummary {
  count: number; gmv: string; points_issued: string; points_redeemed: string;
}
export interface TransactionsSummary extends TransactionsRouteSummary {
  by_route: Record<string, TransactionsRouteSummary>;
}
export interface SettlementRow {
  id: number; run_id: string; month_index: number; month_label: string;
  gross_collected: string; processing_fee: string; pigui_take: string;
  merchant_due: string; payout_month_index: number; status: string;
}
export interface ArInvoiceRow {
  id: number; run_id: string; invoice_number: string; month_index: number;
  month_label: string; amount: string; due_month_index: number; due_month_label: string;
  expected_collection: string; expected_writeoff: string; status: string;
}
export interface ArInvoicesResponse {
  invoices: ArInvoiceRow[];
  aging: { por_cobrar_corriente: string; cobrado_esperado: string; castigo_esperado: string };
}

// ---------- fase 6: suscripciones, tokens, costos escalonados, hiring ----------
export interface SubscriptionPlanT {
  id: string; project_id: string; name: string; description: string;
  price_monthly: string; currency: string; trial_kind: string; trial_conversion: string;
  adoption_rate: string; start_month: number; ramp_months: number; churn_rate: string;
  upgrade_to_plan_id: string | null; upgrade_rate: string; included_token_credits: string;
  branch_limit: number | null; status: string; created_at: string | null;
}
export interface SubscriptionT {
  id: string; project_id: string; client_id: string; plan_id: string;
  start_date: string; trial_end: string | null; status: string; mrr: string;
  source_type: string; created_at: string | null; canceled_at: string | null;
}
export interface SubsCohortRow {
  plan_id: string; plan_name: string; trial_kind: string; cohort_month: number;
  starts: string; decision_month: number; conversions: string; conversion_rate: string;
}
export interface TokenLedgerRow {
  id: number; run_id: string; month_index: number; month_label: string;
  client_id: string | null; movement_type: string; units: string;
  unit_cost: string; unit_price: string; amount: string; source: string;
}
export interface CostTierT { from: string; to: string | null; rate: string; }
// ---------- fase 7: sensibilidad, comparación y conclusiones ----------
export interface SensitivityTarget { key: string; label: string; aggregation: string; }
export interface SensitivityRow {
  key: string; baseline_input: string; impact: string;
  /** presente si el portafolio sobrescribe el supuesto: variarlo no mueve el resultado */
  overridden_by?: string; effective_value?: string;
  low_input?: string; high_input?: string;
  low_value: string | null; high_value: string | null;
  delta_low: string | null; delta_high: string | null;
  elasticity_low: string | null; elasticity_high: string | null;
}
export interface SensitivityResult {
  id?: string; target_metric: string; target_label: string; aggregation: string;
  baseline_value: string; engine_version: string; input_hash: string;
  results: SensitivityRow[]; created_at?: string | null;
}
export interface CompareKpiValue {
  run_id: string; label: string; value: string | null;
  delta?: string; delta_pct?: string | null;
}
export interface CompareResult {
  kpis: { key: string; label: string; aggregation: string; values: CompareKpiValue[] }[];
  assumption_diffs: { key: string; values: { run_id: string; label: string; value: string | null }[] }[];
  warnings: string[];
  runs: { id: string; label: string; engine_version: string; horizon_months: number }[];
}
export interface ConclusionEvidence {
  metric_key: string; month_label: string | null; value: string; label: string;
}
export interface ConclusionT {
  id?: string; kind: string; code: string; title: string; body: string;
  severity: string; evidence: ConclusionEvidence[] | null;
  status?: string; source?: string; created_at?: string | null;
}
export interface ReadinessRow {
  dimension: string; metric_key: string; value: string | null;
  month_label: string | null; signal: string;
}
export interface ConclusionsResponse {
  generated: ConclusionT[]; readiness: ReadinessRow[]; saved: ConclusionT[];
}

// ---------- roadmap de activación (tutorial guiado) ----------
/** Datos reales del proyecto para una escena, ya formateados y truncados por
 *  el servidor. Todos opcionales: cada escena cae a su utilería por dato. */
export interface TutorialSceneData {
  is_real: boolean;
  project_name?: string; currency?: string; horizon_label?: string;
  client_name?: string; branches?: string[];
  products?: { name: string; price: string }[];
  baseline_line?: string;
  old_value?: string; new_value?: string; v_old_label?: string; v_new_label?: string;
  capacity_label?: string;
  campaign_name?: string; campaign_window?: string;
  campaign_start?: number; campaign_end?: number;
  hash_short?: string;
  top_lever?: string;
  run_ref?: string;
}
/** Opción del quiz «Compruébalo»: el feedback de cada distractor nombra el
 *  malentendido; review_step apunta al paso que conviene repasar. */
export interface QuizOption {
  text: string; correct: boolean; feedback: string; review_step?: string;
}
export interface QuizQuestion {
  id: string; text: string; options: QuizOption[];
  /** true cuando la pregunta usa números reales del proyecto (calculados server-side) */
  uses_real_data: boolean;
}
export interface OnboardingStep {
  key: string; order: number; title: string; short: string; icon: string;
  status: "completado" | "en_progreso" | "pendiente";
  detail: string | null; href: string; what: string; tip: string;
  eli5: string; hands_on: string[];
  /** opcionales: el backend puede ser más viejo que el frontend */
  scene_data?: TutorialSceneData | null;
  quiz?: QuizQuestion[];
}
export interface OnboardingRoadmap {
  project: { id: string; name: string } | null;
  steps: OnboardingStep[];
  completed: number; total: number; current_key: string | null;
  imports_committed: number;
}

export interface HiringRoleT {
  id: string; project_id: string; name: string; department: string; headcount: number;
  monthly_salary: string; start_month: number; end_month: number | null;
  ramp_months: number; onboarding_capacity_per_fte: string; status: string;
  notes: string; created_at: string | null;
}

// ---------- fase 8: importación con IA (IA-01…IA-07, sección 8) ----------
/** Tabla detectada en un archivo y la entidad que el servidor le infirió. */
export interface ImportTableInfo {
  file?: string; table: string; entity_type: string | null; score: string; rows: number;
}
/** Inconsistencia detectada por la validación del servidor (IA-04). */
export interface ImportIssue {
  file?: string; entity_ref: string; code: string; severity: string; message: string;
}
/** Archivo fuente de una importación, con hash y resumen de parseo (IA-01/IA-02). */
export interface SourceFileT {
  id: string; filename: string; kind: string; content_type: string;
  size_bytes: number; sha256: string; status: string; error: string | null;
  parse_summary: {
    tables?: ImportTableInfo[]; text_blocks?: number; proposals?: number; issues?: number;
  } | null;
  created_at: string | null;
}
/** Propuesta de un campo extraído; `band` y `confidence` los calcula el servidor (8.2). */
export interface ImportProposalT {
  id: string; import_job_id: string; source_file_id: string | null;
  entity_type: string; entity_ref: string; field_name: string; locator: string;
  raw_value: string; proposed_value: string; unit: string;
  confidence: string; band: string; source_type: string; status: string;
  conflict_value: string | null; notes: string;
}
/** Resumen del análisis servido en `result_summary` (IA-02 a IA-06). */
export interface ImportAnalysisSummary {
  confidence: string;
  proposals: number;
  by_band: { alta: number; media: number; baja: number };
  by_entity: Record<string, number>;
  issues: number;
  issues_by_severity: { alta: number; media: number };
  issues_detail?: ImportIssue[];
  tables?: ImportTableInfo[];
  conflicts?: number;
  low_confidence?: number;
  files?: { id: string; filename: string; status: string; error: string | null }[];
  note?: string;
  committed?: {
    created: Record<string, number>; updated: Record<string, number>;
    entities: number; fields: number;
  };
  entities_written?: {
    entity_type: string; entity_ref: string; entity_id: string; fields: number;
  }[];
}
/** Job de importación (ImportJob de la sección 7). */
export interface ImportJobT {
  id: string; project_id: string; client_id: string | null; target: string;
  status: string; file_count: number; confidence: string; band: string;
  allow_inference: boolean; result_summary: ImportAnalysisSummary | null;
  error: string | null; created_by: string;
  created_at: string | null; analyzed_at: string | null; committed_at: string | null;
}
/** Propuestas agrupadas por entidad y entity_ref (IA-03/04/05). */
export interface ImportEntityGroup {
  entity_type: string; entity_ref: string; confidence: string; band: string;
  has_conflict: boolean; writable: boolean; fields: ImportProposalT[];
}
export interface ImportTotals {
  proposals: number; entities: number; by_status: Record<string, number>;
  by_band: { alta: number; media: number; baja: number }; conflicts: number;
}
/** Respuesta de GET /imports/{id}. */
export interface ImportDetail {
  job: ImportJobT; files: SourceFileT[]; entities: ImportEntityGroup[];
  totals: ImportTotals; issues: ImportIssue[]; tables: ImportTableInfo[];
  summary: ImportAnalysisSummary;
}
/** Respuesta de POST /imports/{id}/analyze. */
export interface ImportAnalyzeResult {
  job: ImportJobT; files: SourceFileT[]; summary: ImportAnalysisSummary;
}
/** Respuesta de POST /imports/{id}/commit. */
export interface ImportCommitResult {
  job: ImportJobT; created: Record<string, number>; updated: Record<string, number>;
  entities: { entity_type: string; entity_ref: string; entity_id: string; fields: number }[];
  fields_written: number;
}
/** Fila del historial de importaciones (IA-07). */
export interface ImportHistoryRow extends ImportJobT {
  files: SourceFileT[];
  proposals: { total: number; by_status: Record<string, number>; by_entity: Record<string, number> };
  entities_affected: Record<string, number> | null;
  issues: number; conflicts: number;
}
export interface ImportHistoryResponse {
  imports: ImportHistoryRow[];
  kpis: { count: number; committed: number; in_review: number; failed: number };
}
