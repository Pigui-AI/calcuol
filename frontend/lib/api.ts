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
