"""Esquemas Pydantic de la API."""
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field, EmailStr


class ProjectGeneral(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    owner: str = "ricardo"
    base_currency: str = "MXN"
    secondary_currency: Optional[str] = None
    exchange_rate: Optional[str] = None
    start_month: str = Field(pattern=r"^\d{4}-\d{2}$")
    horizon_months: int = 60


class CostItemIn(BaseModel):
    name: str
    category: str = "tecnologia"
    behavior: str = "fixed"  # fixed|per_active_client|per_transaction|pct_gmv
    amount: str
    effective_from: int = 1
    effective_to: Optional[int] = None
    notes: str = ""


class ProjectCreate(BaseModel):
    general: ProjectGeneral
    assumptions: dict[str, str] = {}
    cost_items: list[CostItemIn] = []
    create_default_scenarios: bool = True


class ProjectPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None


class ScenarioCreate(BaseModel):
    name: str
    type: str = "personalizado"
    overrides: dict[str, str] = {}


class AssumptionsPatch(BaseModel):
    changes: dict[str, str]
    source_type: str = "hipotesis"
    actor: str = "usuario"


class BranchIn(BaseModel):
    name: str
    location: str = ""
    timezone: str = "America/Mexico_City"
    monthly_capacity: Optional[int] = None
    opening_date: Optional[str] = None


class CatalogItemIn(BaseModel):
    branch_id: Optional[str] = None
    type: str = "producto"
    name: str
    sku: str = ""
    category: str = ""
    sale_price: str
    direct_cost: str
    monthly_inventory: Optional[int] = None
    monthly_capacity: Optional[int] = None
    reward_eligible: bool = True


class BaselineIn(BaseModel):
    avg_monthly_sales: str = "0"
    avg_monthly_transactions: str = "0"
    avg_ticket: str = "0"
    margin_pct: str = "0.30"
    registered_consumers: int = 0
    active_consumers: int = 0
    monthly_buyers: int = 0
    purchase_frequency: str = "1.0"
    source_type: str = "declarado"
    confidence: int = 80


class ClientCreate(BaseModel):
    project_id: str
    legal_name: str
    trade_name: str
    industry: str = "otro"
    currency: str = "MXN"
    onboarding_date: Optional[str] = None
    contact_name: str = ""
    contact_email: str = ""
    contact_phone: str = ""
    notes: str = ""
    brand_name: Optional[str] = None
    branches: list[BranchIn] = []
    catalog_items: list[CatalogItemIn] = []
    baseline: Optional[BaselineIn] = None
    activate: bool = False


class ClientPatch(BaseModel):
    trade_name: Optional[str] = None
    legal_name: Optional[str] = None
    industry: Optional[str] = None
    status: Optional[str] = None
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    notes: Optional[str] = None


class CampaignCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    campaign_type: str = "conversion"  # conversion|frecuencia|ticket|puntos_extra|redencion|mixta
    start_month: int
    end_month: int
    effects: dict[str, str] = {}  # claves campaign.* del catálogo
    actor: str = "usuario"


class CampaignPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    campaign_type: Optional[str] = None
    status: Optional[str] = None  # draft|active|archived (sin DELETE: archivar)
    start_month: Optional[int] = None
    end_month: Optional[int] = None


class RunCreate(BaseModel):
    scenario_id: str


class ExportCreate(BaseModel):
    run_id: str
    format: str = "xlsx"


class TransactionIn(BaseModel):
    client_id: str
    branch_id: Optional[str] = None
    campaign_id: Optional[str] = None
    occurred_on: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    amount: str
    payment_route: str = "stripe"
    reward_eligible: bool = True
    points_issued: str = "0"
    points_redeemed: str = "0"
    reference: str = ""
    source_type: str = "declarado"


class SubscriptionPlanCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    price_monthly: str
    currency: str = "MXN"
    trial_kind: str = "none"  # none|sin_tarjeta_15|con_tarjeta_30 (pantalla 47)
    trial_conversion: str = "0.25"
    adoption_rate: str = "0.30"
    start_month: int = 13
    ramp_months: int = 6
    churn_rate: str = "0.02"
    upgrade_to_plan_id: Optional[str] = None
    upgrade_rate: str = "0"
    included_token_credits: str = "0"
    branch_limit: Optional[int] = None
    actor: str = "usuario"


class SubscriptionPlanPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    price_monthly: Optional[str] = None
    currency: Optional[str] = None
    trial_kind: Optional[str] = None
    trial_conversion: Optional[str] = None
    adoption_rate: Optional[str] = None
    start_month: Optional[int] = None
    ramp_months: Optional[int] = None
    churn_rate: Optional[str] = None
    upgrade_to_plan_id: Optional[str] = None
    upgrade_rate: Optional[str] = None
    included_token_credits: Optional[str] = None
    branch_limit: Optional[int] = None


class SubscriptionDeclareIn(BaseModel):
    plan_id: str
    start_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    trial_end: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    source_type: str = "declarado"
    actor: str = "usuario"


class SubscriptionPatch(BaseModel):
    status: str  # trial|activa|pausada|cancelada
    actor: str = "usuario"


class CostTierIn(BaseModel):
    """Tramo escalonado (pantalla 48): mismas claves que el snapshot ({from, to, rate})."""
    model_config = ConfigDict(populate_by_name=True)

    tier_from: str = Field(alias="from")
    tier_to: Optional[str] = Field(default=None, alias="to")
    rate: str


class HiringRoleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    department: str = "nomina"
    headcount: int = 1
    monthly_salary: str
    start_month: int = 1
    end_month: Optional[int] = None
    ramp_months: int = 1
    onboarding_capacity_per_fte: str = "0"
    notes: str = ""
    actor: str = "usuario"


class HiringRolePatch(BaseModel):
    name: Optional[str] = None
    department: Optional[str] = None
    headcount: Optional[int] = None
    monthly_salary: Optional[str] = None
    start_month: Optional[int] = None
    end_month: Optional[int] = None
    ramp_months: Optional[int] = None
    onboarding_capacity_per_fte: Optional[str] = None
    notes: Optional[str] = None
