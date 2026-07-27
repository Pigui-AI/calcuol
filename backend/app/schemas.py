"""Esquemas Pydantic de la API."""
from typing import Optional
from pydantic import BaseModel, Field, EmailStr


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
