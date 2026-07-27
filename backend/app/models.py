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
