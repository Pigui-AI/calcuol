"""Modelo de datos — sección 7 del documento (subconjunto Fases 0–3).

Todas las entidades conservan trazabilidad (FieldProvenance) y auditoría
(AuditEvent). Los ledgers y outputs de simulación son append-only.
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import (
    Column, String, Integer, Text, DateTime, ForeignKey, Boolean, JSON, Index,
)
from sqlalchemy.orm import relationship
from app.database import Base
from app.engine.money import MoneyType


def new_id() -> str:
    return uuid.uuid4().hex


def utcnow():
    return datetime.now(timezone.utc)


class Project(Base):
    __tablename__ = "projects"
    id = Column(String(32), primary_key=True, default=new_id)
    name = Column(String(200), nullable=False)
    description = Column(Text, default="")
    owner_id = Column(String(120), default="ricardo")
    base_currency = Column(String(8), nullable=False, default="MXN")
    secondary_currency = Column(String(8), nullable=True)
    exchange_rate = Column(MoneyType, nullable=True)
    start_month = Column(String(7), nullable=False)  # "2026-08"
    horizon_months = Column(Integer, nullable=False, default=60)  # 12 | 36 | 60
    status = Column(String(20), nullable=False, default="draft")  # draft|active|archived
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

    scenarios = relationship("Scenario", back_populates="project", cascade="all, delete-orphan")
    clients = relationship("Client", back_populates="project", cascade="all, delete-orphan")
    cost_items = relationship("CostItem", back_populates="project", cascade="all, delete-orphan")


class Scenario(Base):
    __tablename__ = "scenarios"
    id = Column(String(32), primary_key=True, default=new_id)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False)
    name = Column(String(120), nullable=False)
    type = Column(String(30), nullable=False, default="base")  # base|conservador|optimista|real|personalizado
    parent_scenario_id = Column(String(32), nullable=True)
    engine_version = Column(String(20), nullable=False)
    status = Column(String(20), nullable=False, default="active")
    created_at = Column(DateTime, default=utcnow)

    project = relationship("Project", back_populates="scenarios")
    runs = relationship("SimulationRun", back_populates="scenario", cascade="all, delete-orphan")


class AssumptionSet(Base):
    """Valores versionados por alcance. La fila más reciente por (scope, key) es la vigente."""
    __tablename__ = "assumption_sets"
    id = Column(String(32), primary_key=True, default=new_id)
    scenario_id = Column(String(32), ForeignKey("scenarios.id"), nullable=True)  # None => nivel proyecto
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False)
    scope_type = Column(String(20), nullable=False, default="global")  # global|scenario|client|branch|campaign
    scope_id = Column(String(32), nullable=True)
    key = Column(String(120), nullable=False)
    value = Column(String(200), nullable=False)  # decimal como texto, o JSON para curvas custom
    unit = Column(String(30), default="")        # %|MXN|clientes|meses|bool|...
    source_type = Column(String(20), default="hipotesis")  # real|declarado|estimado|hipotesis|meta
    confidence = Column(Integer, default=100)
    version = Column(Integer, nullable=False, default=1)
    created_by = Column(String(120), default="sistema")
    created_at = Column(DateTime, default=utcnow)

    __table_args__ = (Index("ix_assumption_lookup", "project_id", "scenario_id", "scope_type", "scope_id", "key"),)


class Client(Base):
    __tablename__ = "clients"
    id = Column(String(32), primary_key=True, default=new_id)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False)
    legal_name = Column(String(200), nullable=False)
    trade_name = Column(String(200), nullable=False)
    industry = Column(String(80), nullable=False, default="otro")
    status = Column(String(20), nullable=False, default="draft")  # draft|onboarding|active|churned|archived
    onboarding_date = Column(String(10), nullable=True)
    currency = Column(String(8), nullable=False, default="MXN")
    contact_name = Column(String(120), default="")
    contact_email = Column(String(200), default="")
    contact_phone = Column(String(40), default="")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

    project = relationship("Project", back_populates="clients")
    brands = relationship("Brand", back_populates="client", cascade="all, delete-orphan")
    baseline = relationship("ClientBaseline", back_populates="client", uselist=False, cascade="all, delete-orphan")


class Brand(Base):
    __tablename__ = "brands"
    id = Column(String(32), primary_key=True, default=new_id)
    client_id = Column(String(32), ForeignKey("clients.id"), nullable=False)
    name = Column(String(200), nullable=False)
    category = Column(String(80), default="")
    status = Column(String(20), default="active")

    client = relationship("Client", back_populates="brands")
    branches = relationship("Branch", back_populates="brand", cascade="all, delete-orphan")


class Branch(Base):
    __tablename__ = "branches"
    id = Column(String(32), primary_key=True, default=new_id)
    brand_id = Column(String(32), ForeignKey("brands.id"), nullable=False)
    name = Column(String(200), nullable=False)
    location = Column(String(300), default="")
    timezone = Column(String(60), default="America/Mexico_City")
    monthly_capacity = Column(Integer, nullable=True)  # transacciones/mes atendibles
    opening_date = Column(String(10), nullable=True)
    status = Column(String(20), default="active")  # active|paused|closed

    brand = relationship("Brand", back_populates="branches")
    catalog_items = relationship("ProductService", back_populates="branch", cascade="all, delete-orphan")


class ProductService(Base):
    __tablename__ = "products_services"
    id = Column(String(32), primary_key=True, default=new_id)
    branch_id = Column(String(32), ForeignKey("branches.id"), nullable=False)
    type = Column(String(20), nullable=False, default="producto")  # producto|servicio
    name = Column(String(200), nullable=False)
    sku = Column(String(60), default="")
    category = Column(String(80), default="")
    sale_price = Column(MoneyType, nullable=False)
    direct_cost = Column(MoneyType, nullable=False)
    tax_pct = Column(MoneyType, default="0")
    monthly_inventory = Column(Integer, nullable=True)   # productos
    monthly_capacity = Column(Integer, nullable=True)    # servicios
    reward_eligible = Column(Boolean, default=True)
    status = Column(String(20), default="active")
    created_at = Column(DateTime, default=utcnow)

    branch = relationship("Branch", back_populates="catalog_items")


class ClientBaseline(Base):
    """Línea base financiera del cliente (pantalla 11)."""
    __tablename__ = "client_baselines"
    id = Column(String(32), primary_key=True, default=new_id)
    client_id = Column(String(32), ForeignKey("clients.id"), nullable=False, unique=True)
    avg_monthly_sales = Column(MoneyType, nullable=False, default="0")
    avg_monthly_transactions = Column(MoneyType, nullable=False, default="0")
    avg_ticket = Column(MoneyType, nullable=False, default="0")
    margin_pct = Column(MoneyType, nullable=False, default="0.30")   # decimal (0.30 = 30%)
    registered_consumers = Column(Integer, default=0)
    active_consumers = Column(Integer, default=0)
    monthly_buyers = Column(Integer, default=0)
    purchase_frequency = Column(MoneyType, default="1.0")
    seasonality = Column(JSON, nullable=True)   # {"1":0.9,...,"12":1.2} multiplicadores
    monthly_series = Column(JSON, nullable=True)  # [{"month":"2026-01","sales":...}, ...]
    source_type = Column(String(20), default="declarado")
    confidence = Column(Integer, default=80)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

    client = relationship("Client", back_populates="baseline")


class CostItem(Base):
    """Costos de Pigui (pantalla 48). behavior: fixed|per_active_client|per_transaction|pct_gmv"""
    __tablename__ = "cost_items"
    id = Column(String(32), primary_key=True, default=new_id)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False)
    name = Column(String(200), nullable=False)
    category = Column(String(60), nullable=False, default="tecnologia")
    # nomina|marketing|ventas|tecnologia|administracion|producto|infraestructura|otros
    behavior = Column(String(30), nullable=False, default="fixed")
    amount = Column(MoneyType, nullable=False)  # monto fijo mensual, o tarifa por driver, o % (decimal) para pct_gmv
    effective_from = Column(Integer, nullable=False, default=1)  # mes índice 1..horizonte
    effective_to = Column(Integer, nullable=True)
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=utcnow)

    project = relationship("Project", back_populates="cost_items")


class SimulationRun(Base):
    """Ejecución inmutable (4.3). El snapshot congela todos los inputs."""
    __tablename__ = "simulation_runs"
    id = Column(String(32), primary_key=True, default=new_id)
    scenario_id = Column(String(32), ForeignKey("scenarios.id"), nullable=False)
    engine_version = Column(String(20), nullable=False)
    status = Column(String(20), nullable=False, default="queued")  # queued|running|succeeded|failed
    snapshot = Column(JSON, nullable=False)
    input_hash = Column(String(64), nullable=False)
    output_hash = Column(String(64), nullable=True)
    horizon_months = Column(Integer, nullable=False)
    idempotency_key = Column(String(120), nullable=True, index=True)
    error = Column(Text, nullable=True)
    logs = Column(JSON, nullable=True)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utcnow)

    scenario = relationship("Scenario", back_populates="runs")
    projections = relationship("MonthlyProjection", back_populates="run", cascade="all, delete-orphan")


class MonthlyProjection(Base):
    """Outputs por mes y métrica (append-only, nunca se edita)."""
    __tablename__ = "monthly_projections"
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(32), ForeignKey("simulation_runs.id"), nullable=False)
    month_index = Column(Integer, nullable=False)   # 1..horizonte
    month_label = Column(String(7), nullable=False)  # "2026-08"
    entity_type = Column(String(20), nullable=False, default="project")
    entity_id = Column(String(32), nullable=True)
    metric_key = Column(String(80), nullable=False)
    value = Column(MoneyType, nullable=False)
    unit = Column(String(20), default="")

    run = relationship("SimulationRun", back_populates="projections")
    __table_args__ = (Index("ix_projection_lookup", "run_id", "metric_key", "month_index"),)


class FieldProvenance(Base):
    """Origen de un campo (7): archivo, sección, usuario, confianza."""
    __tablename__ = "field_provenance"
    id = Column(String(32), primary_key=True, default=new_id)
    entity_type = Column(String(40), nullable=False)
    entity_id = Column(String(32), nullable=False)
    field_name = Column(String(80), nullable=False)
    source_type = Column(String(20), nullable=False, default="declarado")
    source_file_id = Column(String(32), nullable=True)
    locator = Column(String(200), default="")  # hoja/celda/sección
    declared_by = Column(String(120), default="")
    confidence = Column(Integer, default=100)
    created_at = Column(DateTime, default=utcnow)


class AuditEvent(Base):
    """Historial de cambios (append-only)."""
    __tablename__ = "audit_events"
    id = Column(String(32), primary_key=True, default=new_id)
    actor_id = Column(String(120), nullable=False, default="sistema")
    action = Column(String(60), nullable=False)
    entity_type = Column(String(40), nullable=False)
    entity_id = Column(String(32), nullable=False)
    before_json = Column(JSON, nullable=True)
    after_json = Column(JSON, nullable=True)
    correlation_id = Column(String(64), nullable=True)
    timestamp = Column(DateTime, default=utcnow)


class Campaign(Base):
    """Campaña de crecimiento/recompensas (pantallas 31–33). Sus efectos numéricos
    viven como AssumptionSet con scope_type='campaign' (versionados, append-only)."""
    __tablename__ = "campaigns"
    id = Column(String(32), primary_key=True, default=new_id)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False)
    name = Column(String(200), nullable=False)
    description = Column(Text, default="")
    campaign_type = Column(String(30), nullable=False, default="conversion")
    # conversion|frecuencia|ticket|puntos_extra|redencion|mixta (etiqueta UI; el motor lee los efectos)
    status = Column(String(20), nullable=False, default="draft")  # draft|active|archived
    start_month = Column(Integer, nullable=False, default=1)   # índice 1..horizonte (como CostItem)
    end_month = Column(Integer, nullable=False, default=1)
    created_by = Column(String(120), default="usuario")
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)


class TransactionRecord(Base):
    """Registro operativo de transacciones reales (pantallas 38–39). Append-only:
    jamás UPDATE/DELETE; una corrección es una fila espejo con montos negados y
    reverses_transaction_id. No alimenta al motor en Fase 5 (conciliación: Fase 7)."""
    __tablename__ = "transaction_records"
    id = Column(String(32), primary_key=True, default=new_id)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False)
    client_id = Column(String(32), ForeignKey("clients.id"), nullable=False)
    branch_id = Column(String(32), ForeignKey("branches.id"), nullable=True)
    campaign_id = Column(String(32), ForeignKey("campaigns.id"), nullable=True)
    occurred_on = Column(String(10), nullable=False)   # "YYYY-MM-DD"
    month_label = Column(String(7), nullable=False)    # derivado de occurred_on en el servidor
    amount = Column(MoneyType, nullable=False)         # ticket bruto MXN
    payment_route = Column(String(10), nullable=False, default="stripe")  # stripe|caja
    reward_eligible = Column(Boolean, nullable=False, default=True)
    points_issued = Column(MoneyType, default="0")
    points_redeemed = Column(MoneyType, default="0")
    reference = Column(String(120), default="")        # folio externo
    reverses_transaction_id = Column(String(32), nullable=True)  # contra-asiento
    source_type = Column(String(20), default="declarado")        # clasificación 7.1
    created_by = Column(String(120), default="usuario")
    created_at = Column(DateTime, default=utcnow)
    __table_args__ = (Index("ix_txrec_lookup", "project_id", "client_id", "month_label"),)


class SettlementBatch(Base):
    """Liquidación mensual a negocios derivada de un run (pantalla 41).
    Append-only, escrita por execute_run; inmutable como MonthlyProjection."""
    __tablename__ = "settlement_batches"
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(32), ForeignKey("simulation_runs.id"), nullable=False)
    month_index = Column(Integer, nullable=False)
    month_label = Column(String(7), nullable=False)
    gross_collected = Column(MoneyType, nullable=False)   # GMV bruto cobrado por Pigui vía Stripe
    processing_fee = Column(MoneyType, nullable=False, default="0")
    pigui_take = Column(MoneyType, nullable=False)        # comisión + puntos base del tramo Stripe
    merchant_due = Column(MoneyType, nullable=False)      # neto a liquidar al negocio
    payout_month_index = Column(Integer, nullable=False)  # month_index + lag
    status = Column(String(20), nullable=False)           # pagado|pendiente (payout <= horizonte o no)
    __table_args__ = (Index("ix_settlement_lookup", "run_id", "month_index"),)


class ArInvoice(Base):
    """AR por factura (pantallas 42–43): factura sintética mensual agregada de la
    ruta en caja, derivada de un run. Append-only, escrita por execute_run."""
    __tablename__ = "ar_invoices"
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(32), ForeignKey("simulation_runs.id"), nullable=False)
    invoice_number = Column(String(20), nullable=False)   # "INV-0001" (determinista: mes de emisión)
    month_index = Column(Integer, nullable=False)         # mes de emisión
    month_label = Column(String(7), nullable=False)
    amount = Column(MoneyType, nullable=False)            # to_ar del mes
    due_month_index = Column(Integer, nullable=False)     # emisión + lag AR existente
    due_month_label = Column(String(7), nullable=False)
    expected_collection = Column(MoneyType, nullable=False)  # amount * tasa de cobranza
    expected_writeoff = Column(MoneyType, nullable=False)    # amount * (1 - tasa)
    status = Column(String(20), nullable=False)           # cobrada|por_cobrar (due <= horizonte o no)
    __table_args__ = (Index("ix_arinv_lookup", "run_id", "month_index"),)


class SubscriptionPlan(Base):
    """Plan de suscripción (pantalla 45, sección 3.4): plan, trial, precio, conversión,
    upgrades/downgrades, churn, sucursales, límites. Config del motor detallado;
    se archiva, jamás se borra. Sus parámetros se congelan en el snapshot."""
    __tablename__ = "subscription_plans"
    id = Column(String(32), primary_key=True, default=new_id)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False)
    name = Column(String(120), nullable=False)
    description = Column(Text, default="")
    price_monthly = Column(MoneyType, nullable=False)
    currency = Column(String(8), nullable=False, default="MXN")   # par moneda-monto (16.1)
    trial_kind = Column(String(20), nullable=False, default="none")
    # none | sin_tarjeta_15 | con_tarjeta_30   (pantalla 47)
    trial_conversion = Column(MoneyType, nullable=False, default="0.25")  # decimal 0–1, por cohorte
    adoption_rate = Column(MoneyType, nullable=False, default="0.30")     # sobre clientes B2B activos
    start_month = Column(Integer, nullable=False, default=13)             # activable desde mes configurado (3.4)
    ramp_months = Column(Integer, nullable=False, default=6)
    churn_rate = Column(MoneyType, nullable=False, default="0.02")        # mensual sobre activos del plan
    upgrade_to_plan_id = Column(String(32), nullable=True)                # upgrades/downgrades (3.4)
    upgrade_rate = Column(MoneyType, nullable=False, default="0")         # mensual sobre activos del plan
    included_token_credits = Column(MoneyType, nullable=False, default="0")  # unidades/mes (pantalla 46)
    branch_limit = Column(Integer, nullable=True)   # "sucursales, límites" (3.4) — informativo v1
    status = Column(String(20), nullable=False, default="active")  # draft|active|archived
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)


class Subscription(Base):
    """Suscripción declarada por cliente — entidad de la sección 7:
    Subscription(client_id, plan_id, start_date, trial_end, status, MRR).
    Registro operativo (pantallas 45/47); NO alimenta al motor en fase 6
    (patrón TransactionRecord de fase 5; conciliación con 'Real observado' en
    fase 7). Append-only: cancelar fija canceled_at, jamás DELETE."""
    __tablename__ = "subscriptions"
    id = Column(String(32), primary_key=True, default=new_id)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False)
    client_id = Column(String(32), ForeignKey("clients.id"), nullable=False)
    plan_id = Column(String(32), ForeignKey("subscription_plans.id"), nullable=False)
    start_date = Column(String(10), nullable=False)     # "YYYY-MM-DD"
    trial_end = Column(String(10), nullable=True)       # None ⇒ sin trial
    status = Column(String(20), nullable=False, default="trial")  # trial|activa|pausada|cancelada
    mrr = Column(MoneyType, nullable=False, default="0")  # congelado del plan al activar
    source_type = Column(String(20), default="declarado")  # clasificación 7.1
    created_at = Column(DateTime, default=utcnow)
    canceled_at = Column(DateTime, nullable=True)
    __table_args__ = (Index("ix_subscription_lookup", "project_id", "client_id"),)


class TokenLedger(Base):
    """Ledger de tokens — entidad de la sección 7:
    TokenLedger(client_id, movement_type, units, cost, price, source).
    Append-only, escrito por execute_run desde logs.token_ledger (mismo patrón
    que SettlementBatch/ArInvoice). client_id NULL = agregado del proyecto
    (el motor v1 modela por segmento, no por consumidor individual)."""
    __tablename__ = "token_ledger"
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(32), ForeignKey("simulation_runs.id"), nullable=False)
    month_index = Column(Integer, nullable=False)
    month_label = Column(String(7), nullable=False)
    client_id = Column(String(32), nullable=True)
    movement_type = Column(String(20), nullable=False)
    # incluido|consumo|overage|recarga|credito_inicial|expiracion  (3.4/46)
    units = Column(MoneyType, nullable=False)
    unit_cost = Column(MoneyType, nullable=False, default="0")   # costo proveedor/unidad
    unit_price = Column(MoneyType, nullable=False, default="0")  # precio cobrado/unidad
    amount = Column(MoneyType, nullable=False, default="0")      # MXN del movimiento
    source = Column(String(20), nullable=False, default="run")
    __table_args__ = (Index("ix_tokenledger_lookup", "run_id", "month_index"),)


class CostTier(Base):
    """Tramos escalonados de un cost item (pantalla 48):
    costo del item = amount (componente fijo) + Σ tramos MARGINALES sobre el driver.
    Solo aplica a items con behavior tiered_* (valores nuevos del String existente:
    la tabla cost_items NO se altera)."""
    __tablename__ = "cost_tiers"
    id = Column(String(32), primary_key=True, default=new_id)
    cost_item_id = Column(String(32), ForeignKey("cost_items.id"), nullable=False)
    tier_from = Column(MoneyType, nullable=False)   # unidades del driver, inclusivo
    tier_to = Column(MoneyType, nullable=True)      # None = tramo abierto (último)
    rate = Column(MoneyType, nullable=False)        # MXN/unidad (decimal 0–1 si driver = GMV)
    __table_args__ = (Index("ix_costtier_lookup", "cost_item_id", "tier_from"),)


class HiringRole(Base):
    """Hiring plan (pantalla 49): roles, salarios, fecha efectiva, ramp-up y
    capacidad. 'No eliminar histórico': jamás DELETE — status archived; los runs
    pasados conservan el rol en su snapshot. La nómina es COMPLETA desde
    start_month; solo la capacidad rampa ('headcount por fecha efectiva;
    capacidad tras ramp')."""
    __tablename__ = "hiring_roles"
    id = Column(String(32), primary_key=True, default=new_id)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False)
    name = Column(String(120), nullable=False)
    department = Column(String(60), nullable=False, default="nomina")  # categoría OPEX (5.5) → cost.cat.*
    headcount = Column(Integer, nullable=False, default=1)
    monthly_salary = Column(MoneyType, nullable=False)   # costo empresa por FTE
    start_month = Column(Integer, nullable=False, default=1)   # fecha efectiva (índice, como CostItem)
    end_month = Column(Integer, nullable=True)
    ramp_months = Column(Integer, nullable=False, default=1)   # ≤1 ⇒ capacidad plena inmediata
    onboarding_capacity_per_fte = Column(MoneyType, nullable=False, default="0")  # clientes/mes tras ramp
    status = Column(String(20), nullable=False, default="active")  # active|archived
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)


class SensitivityAnalysis(Base):
    """Análisis de sensibilidad (pantalla 54): batch de corridas derivadas del
    snapshot de un run base, cada una con UN cambio controlado. Append-only:
    los resultados quedan congelados junto al hash del snapshot que los produjo."""
    __tablename__ = "sensitivity_analyses"
    id = Column(String(32), primary_key=True, default=new_id)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False)
    scenario_id = Column(String(32), ForeignKey("scenarios.id"), nullable=False)
    base_run_id = Column(String(32), ForeignKey("simulation_runs.id"), nullable=True)
    engine_version = Column(String(20), nullable=False)
    input_hash = Column(String(64), nullable=False)   # snapshot base congelado
    target_metric = Column(String(80), nullable=False)  # métrica objetivo del tornado
    variables = Column(JSON, nullable=False)   # [{key, low, high, baseline}]
    results = Column(JSON, nullable=False)     # [{key, ..., delta_low, delta_high, elasticity}]
    baseline_value = Column(MoneyType, nullable=False, default="0")
    created_by = Column(String(120), default="usuario")
    created_at = Column(DateTime, default=utcnow)
    __table_args__ = (Index("ix_sensitivity_lookup", "project_id", "scenario_id"),)


class ExecutiveConclusion(Base):
    """Conclusiones y recomendaciones (pantalla 71). Cada conclusión enlaza a la
    evidencia (métrica, mes y valor del run) que la respalda: el motor propone
    con reglas explicables y el usuario acepta, edita o descarta."""
    __tablename__ = "executive_conclusions"
    id = Column(String(32), primary_key=True, default=new_id)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False)
    run_id = Column(String(32), ForeignKey("simulation_runs.id"), nullable=False)
    kind = Column(String(20), nullable=False, default="hallazgo")
    # hallazgo | riesgo | accion | readiness
    code = Column(String(60), nullable=False, default="")   # regla que la originó
    title = Column(String(200), nullable=False)
    body = Column(Text, default="")
    severity = Column(String(20), nullable=False, default="media")  # alta|media|baja
    evidence = Column(JSON, nullable=True)   # [{metric_key, month_label, value, label}]
    status = Column(String(20), nullable=False, default="propuesta")
    # propuesta | aceptada | descartada
    source = Column(String(20), nullable=False, default="motor")   # motor | usuario
    created_by = Column(String(120), default="usuario")
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)
    __table_args__ = (Index("ix_conclusion_lookup", "run_id", "kind"),)


class ImportJob(Base):
    """Proceso de carga asistida (sección 8, IA-01…IA-07). Nada se persiste en
    las entidades del proyecto hasta que el usuario confirma: el job vive en
    estado de revisión hasta el commit transaccional."""
    __tablename__ = "import_jobs"
    id = Column(String(32), primary_key=True, default=new_id)
    project_id = Column(String(32), ForeignKey("projects.id"), nullable=False)
    client_id = Column(String(32), ForeignKey("clients.id"), nullable=True)  # destino opcional
    target = Column(String(20), nullable=False, default="auto")
    # auto | clients | catalog | baseline | costs
    status = Column(String(20), nullable=False, default="borrador")
    # borrador | analizando | revision | commiteado | fallido | cancelado
    file_count = Column(Integer, nullable=False, default=0)
    confidence = Column(MoneyType, nullable=False, default="0")  # promedio de las propuestas
    allow_inference = Column(Boolean, nullable=False, default=False)  # 8.1 paso 5
    result_summary = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)
    created_by = Column(String(120), default="usuario")
    created_at = Column(DateTime, default=utcnow)
    analyzed_at = Column(DateTime, nullable=True)
    committed_at = Column(DateTime, nullable=True)
    __table_args__ = (Index("ix_importjob_lookup", "project_id", "status"),)


class SourceFile(Base):
    """Archivo fuente de una importación (pantalla 22 e IA-07). Conserva hash y
    resumen de parseo para trazar cada campo hasta su origen."""
    __tablename__ = "source_files"
    id = Column(String(32), primary_key=True, default=new_id)
    import_job_id = Column(String(32), ForeignKey("import_jobs.id"), nullable=False)
    filename = Column(String(300), nullable=False)
    content_type = Column(String(120), default="")
    size_bytes = Column(Integer, nullable=False, default=0)
    sha256 = Column(String(64), nullable=False, default="")
    kind = Column(String(10), nullable=False, default="xlsx")  # xlsx|csv|pdf|docx
    status = Column(String(20), nullable=False, default="cargado")
    # cargado | parseado | no_soportado | error
    parse_summary = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utcnow)
    __table_args__ = (Index("ix_sourcefile_lookup", "import_job_id"),)


class ImportProposal(Base):
    """Propuesta de un valor extraído (IA-03 a IA-05). El usuario acepta, edita,
    ignora o la marca como hipótesis; solo las aceptadas o editadas se escriben
    en el commit, y cada una deja FieldProvenance."""
    __tablename__ = "import_proposals"
    id = Column(String(32), primary_key=True, default=new_id)
    import_job_id = Column(String(32), ForeignKey("import_jobs.id"), nullable=False)
    source_file_id = Column(String(32), ForeignKey("source_files.id"), nullable=True)
    entity_type = Column(String(40), nullable=False)  # Client|Branch|ProductService|ClientBaseline|CostItem
    entity_ref = Column(String(120), nullable=False, default="")  # agrupa las filas de una misma entidad
    field_name = Column(String(80), nullable=False)
    locator = Column(String(200), default="")   # hoja/celda o sección del documento
    raw_value = Column(Text, default="")
    proposed_value = Column(Text, default="")
    unit = Column(String(30), default="")
    confidence = Column(MoneyType, nullable=False, default="0")   # 0–1
    source_type = Column(String(20), nullable=False, default="declarado")  # 7.1
    status = Column(String(20), nullable=False, default="propuesta")
    # propuesta | aceptada | editada | ignorada | conflicto
    conflict_value = Column(Text, nullable=True)   # valor vigente cuando hay conflicto
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)
    __table_args__ = (Index("ix_proposal_lookup", "import_job_id", "entity_type", "entity_ref"),)


class ExportJob(Base):
    __tablename__ = "export_jobs"
    id = Column(String(32), primary_key=True, default=new_id)
    run_id = Column(String(32), ForeignKey("simulation_runs.id"), nullable=False)
    format = Column(String(10), nullable=False, default="xlsx")
    status = Column(String(20), nullable=False, default="queued")
    file_path = Column(String(500), nullable=True)
    file_name = Column(String(200), nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utcnow)
    finished_at = Column(DateTime, nullable=True)
