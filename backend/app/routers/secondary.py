"""Ingresos secundarios y costos — fase 6, pantallas 45–49.

Planes de suscripción (pantalla 45): catálogo del motor detallado; se archivan,
jamás se borran — los runs pasados conservan el plan congelado en su snapshot.
Suscripciones declaradas por cliente (pantallas 45/47): registro operativo con
máquina de estados trial|activa|pausada|cancelada; no alimenta al motor en
fase 6 (patrón TransactionRecord de fase 5) y jamás se hace DELETE — cancelar
fija canceled_at. Tramos escalonados de cost items (pantalla 48): reemplazo
completo del set con tramos marginales contiguos desde 0. Hiring plan
(pantalla 49): roles con salario, fecha efectiva, ramp y capacidad; sin DELETE
("no eliminar histórico"). Ledger de tokens (pantallas 46/63): lectura de las
filas derivadas de un run `succeeded` — el frontend nunca calcula.
"""
from datetime import datetime
from decimal import InvalidOperation

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (Project, Client, CostItem, CostTier, HiringRole,
                        SimulationRun, Subscription, SubscriptionPlan,
                        TokenLedger, FieldProvenance, utcnow)
from app.schemas import (SubscriptionPlanCreate, SubscriptionPlanPatch,
                         SubscriptionDeclareIn, SubscriptionPatch,
                         CostTierIn, HiringRoleCreate, HiringRolePatch)
from app.engine.money import D, ZERO, ONE
from app import audit

router = APIRouter()

VALID_TRIAL_KINDS = ("none", "sin_tarjeta_15", "con_tarjeta_30")

# Tasas del plan que deben ser decimales 0–1 (0.25 = 25%).
PLAN_RATE_FIELDS = ("trial_conversion", "adoption_rate", "churn_rate", "upgrade_rate")

# Transiciones de estado válidas de una suscripción (pantalla 47).
VALID_SUBSCRIPTION_TRANSITIONS = {
    ("trial", "activa"), ("trial", "cancelada"),
    ("activa", "pausada"), ("activa", "cancelada"),
    ("pausada", "activa"), ("pausada", "cancelada"),
}

# Behaviors que admiten tramos escalonados (pantalla 48).
TIERED_BEHAVIORS = ("tiered_per_active_client", "tiered_per_transaction", "tiered_pct_gmv")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def project_or_404(db: Session, project_id: str) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Proyecto no encontrado")
    return project


def plan_or_404(db: Session, plan_id: str) -> SubscriptionPlan:
    plan = db.get(SubscriptionPlan, plan_id)
    if not plan:
        raise HTTPException(404, "Plan no encontrado")
    return plan


def cost_item_or_404(db: Session, cost_item_id: str) -> CostItem:
    item = db.get(CostItem, cost_item_id)
    if not item:
        raise HTTPException(404, "Concepto de costo no encontrado")
    return item


def role_or_404(db: Session, role_id: str) -> HiringRole:
    role = db.get(HiringRole, role_id)
    if not role:
        raise HTTPException(404, "Rol no encontrado")
    return role


def succeeded_run_or_error(db: Session, run_id: str) -> SimulationRun:
    """Guardas de las pantallas 62–63: el run debe existir y haber terminado bien."""
    run = db.get(SimulationRun, run_id)
    if not run:
        raise HTTPException(404, "Run no encontrado")
    if run.status != "succeeded":
        raise HTTPException(409, f"El run está en estado '{run.status}'")
    return run


def _parse_decimal(value, field: str):
    try:
        parsed = D(value)
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(422, f"'{field}' no es un valor numérico válido: {value!r}")
    if not parsed.is_finite():
        raise HTTPException(422, f"'{field}' debe ser un valor finito: {value!r}")
    return parsed


def _parse_date(value: str, field: str) -> None:
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(422, f"Fecha inexistente en '{field}': '{value}'")


# ---------------------------------------------------------------------------
# Serializadores manuales (montos siempre string)
# ---------------------------------------------------------------------------

def serialize_plan(p: SubscriptionPlan) -> dict:
    return {"id": p.id, "project_id": p.project_id, "name": p.name,
            "description": p.description,
            "price_monthly": str(p.price_monthly), "currency": p.currency,
            "trial_kind": p.trial_kind,
            "trial_conversion": str(p.trial_conversion),
            "adoption_rate": str(p.adoption_rate),
            "start_month": p.start_month, "ramp_months": p.ramp_months,
            "churn_rate": str(p.churn_rate),
            "upgrade_to_plan_id": p.upgrade_to_plan_id,
            "upgrade_rate": str(p.upgrade_rate),
            "included_token_credits": str(p.included_token_credits),
            "branch_limit": p.branch_limit, "status": p.status,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None}


def serialize_subscription(s: Subscription) -> dict:
    return {"id": s.id, "project_id": s.project_id, "client_id": s.client_id,
            "plan_id": s.plan_id, "start_date": s.start_date,
            "trial_end": s.trial_end, "status": s.status, "mrr": str(s.mrr),
            "source_type": s.source_type,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "canceled_at": s.canceled_at.isoformat() if s.canceled_at else None}


def serialize_tier(t: CostTier) -> dict:
    return {"id": t.id, "cost_item_id": t.cost_item_id,
            "from": str(t.tier_from),
            "to": None if t.tier_to is None else str(t.tier_to),
            "rate": str(t.rate)}


def serialize_role(r: HiringRole) -> dict:
    return {"id": r.id, "project_id": r.project_id, "name": r.name,
            "department": r.department, "headcount": r.headcount,
            "monthly_salary": str(r.monthly_salary),
            "start_month": r.start_month, "end_month": r.end_month,
            "ramp_months": r.ramp_months,
            "onboarding_capacity_per_fte": str(r.onboarding_capacity_per_fte),
            "status": r.status, "notes": r.notes,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None}


def serialize_token_movement(t: TokenLedger) -> dict:
    return {"id": t.id, "run_id": t.run_id, "month_index": t.month_index,
            "month_label": t.month_label, "client_id": t.client_id,
            "movement_type": t.movement_type, "units": str(t.units),
            "unit_cost": str(t.unit_cost), "unit_price": str(t.unit_price),
            "amount": str(t.amount), "source": t.source}


# ---------------------------------------------------------------------------
# Planes de suscripción (pantalla 45)
# ---------------------------------------------------------------------------

def _validate_plan_values(db: Session, project: Project, values: dict,
                          plan_id: str | None = None):
    """Validaciones de la pantalla 45 sobre los valores vigentes (alta o merge)."""
    price = _parse_decimal(values["price_monthly"], "price_monthly")
    if price <= ZERO:
        raise HTTPException(422, "El precio mensual debe ser mayor que cero")
    if values["currency"] != project.base_currency:
        raise HTTPException(422, "Moneda inválida")
    if values["trial_kind"] not in VALID_TRIAL_KINDS:
        raise HTTPException(422, f"Tipo de trial inválido: '{values['trial_kind']}' "
                                 "(usar none, sin_tarjeta_15 o con_tarjeta_30)")
    for field in PLAN_RATE_FIELDS:
        rate = _parse_decimal(values[field], field)
        if not ZERO <= rate <= ONE:
            raise HTTPException(422, f"'{field}' debe ser un decimal entre 0 y 1")
    _parse_decimal(values["included_token_credits"], "included_token_credits")
    if values["start_month"] < 1:
        raise HTTPException(422, "start_month debe ser >= 1")
    upgrade_to = values.get("upgrade_to_plan_id")
    if upgrade_to:
        if plan_id is not None and upgrade_to == plan_id:
            raise HTTPException(422, "El plan de upgrade no puede ser el mismo plan")
        target = db.get(SubscriptionPlan, upgrade_to)
        if not target or target.project_id != project.id:
            raise HTTPException(422, f"El plan de upgrade '{upgrade_to}' no pertenece al proyecto")


def _record_plan_provenance(db: Session, plan: SubscriptionPlan, actor: str):
    for field in ("name", "price_monthly", "currency", "trial_kind",
                  "adoption_rate", "churn_rate", "start_month"):
        db.add(FieldProvenance(
            entity_type="SubscriptionPlan", entity_id=plan.id, field_name=field,
            source_type="declarado", declared_by=actor,
            locator="captura manual (pantalla 45)",
        ))


@router.get("/projects/{project_id}/subscription-plans")
def list_subscription_plans(project_id: str, db: Session = Depends(get_db)):
    """Pantalla 45: catálogo completo de planes del proyecto, montos string."""
    project_or_404(db, project_id)
    plans = db.execute(
        select(SubscriptionPlan).where(SubscriptionPlan.project_id == project_id)
        .order_by(SubscriptionPlan.created_at, SubscriptionPlan.id)
    ).scalars().all()
    return [serialize_plan(p) for p in plans]


@router.post("/projects/{project_id}/subscription-plans", status_code=201)
def create_subscription_plan(project_id: str, payload: SubscriptionPlanCreate,
                             db: Session = Depends(get_db)):
    """Alta de plan (pantalla 45) con FieldProvenance y auditoría."""
    project = project_or_404(db, project_id)
    values = payload.model_dump()
    _validate_plan_values(db, project, values)

    plan = SubscriptionPlan(
        project_id=project_id, name=payload.name, description=payload.description,
        price_monthly=payload.price_monthly, currency=payload.currency,
        trial_kind=payload.trial_kind, trial_conversion=payload.trial_conversion,
        adoption_rate=payload.adoption_rate, start_month=payload.start_month,
        ramp_months=payload.ramp_months, churn_rate=payload.churn_rate,
        upgrade_to_plan_id=payload.upgrade_to_plan_id,
        upgrade_rate=payload.upgrade_rate,
        included_token_credits=payload.included_token_credits,
        branch_limit=payload.branch_limit,
    )
    db.add(plan)
    db.flush()

    _record_plan_provenance(db, plan, payload.actor)
    audit.record(db, "subscription_plan.create", "SubscriptionPlan", plan.id,
                 actor_id=payload.actor,
                 after={"name": plan.name, "price_monthly": str(plan.price_monthly),
                        "currency": plan.currency, "trial_kind": plan.trial_kind,
                        "adoption_rate": str(plan.adoption_rate),
                        "start_month": plan.start_month})
    db.commit()
    return serialize_plan(plan)


@router.patch("/subscription-plans/{plan_id}")
def patch_subscription_plan(plan_id: str, payload: SubscriptionPlanPatch,
                            db: Session = Depends(get_db)):
    """Edición de plan (pantalla 45): mismas validaciones sobre el merge,
    auditoría con antes/después."""
    plan = plan_or_404(db, plan_id)
    project = project_or_404(db, plan.project_id)
    changes = payload.model_dump(exclude_none=True)

    merged = {**serialize_plan(plan), **changes}
    _validate_plan_values(db, project, merged, plan_id=plan.id)

    before = {}
    for field in changes:
        current = getattr(plan, field)
        before[field] = str(current) if current is not None and field in (
            "price_monthly", "trial_conversion", "adoption_rate", "churn_rate",
            "upgrade_rate", "included_token_credits") else current
    for field, value in changes.items():
        setattr(plan, field, value)
    audit.record(db, "subscription_plan.update", "SubscriptionPlan", plan.id,
                 before=before, after=changes)
    db.commit()
    return serialize_plan(plan)


@router.post("/subscription-plans/{plan_id}/archive")
def archive_subscription_plan(plan_id: str, db: Session = Depends(get_db)):
    """Los planes no se borran (sección 9): se archivan; los runs pasados
    conservan el plan congelado en su snapshot."""
    plan = plan_or_404(db, plan_id)
    if plan.status == "archived":
        raise HTTPException(409, "El plan ya está archivado")
    before = {"status": plan.status}
    plan.status = "archived"
    audit.record(db, "subscription_plan.archive", "SubscriptionPlan", plan.id,
                 before=before, after={"status": "archived"})
    db.commit()
    return serialize_plan(plan)


# ---------------------------------------------------------------------------
# Suscripciones declaradas por cliente (pantallas 45/47)
# ---------------------------------------------------------------------------

@router.get("/projects/{project_id}/subscriptions")
def list_subscriptions(project_id: str, client_id: str | None = None,
                       db: Session = Depends(get_db)):
    """Pantallas 45/47: suscripciones declaradas del proyecto, filtro opcional
    por cliente, montos string."""
    project_or_404(db, project_id)
    rows = db.execute(
        select(Subscription).where(Subscription.project_id == project_id)
        .order_by(Subscription.created_at, Subscription.id)
    ).scalars().all()
    if client_id:
        rows = [s for s in rows if s.client_id == client_id]
    return [serialize_subscription(s) for s in rows]


@router.post("/clients/{client_id}/subscriptions", status_code=201)
def create_subscription(client_id: str, payload: SubscriptionDeclareIn,
                        db: Session = Depends(get_db)):
    """Alta de suscripción declarada (pantallas 45/47). Sin trial nace activa
    con mrr congelado del plan; con trial nace en 'trial' y los periodos de
    trial de un mismo cliente no pueden solaparse (pantalla 47)."""
    client = db.get(Client, client_id)
    if not client:
        raise HTTPException(404, "Cliente no encontrado")
    plan = db.get(SubscriptionPlan, payload.plan_id)
    if not plan or plan.project_id != client.project_id:
        raise HTTPException(422, f"El plan '{payload.plan_id}' no pertenece al proyecto del cliente")

    _parse_date(payload.start_date, "start_date")
    if payload.trial_end:
        _parse_date(payload.trial_end, "trial_end")
        if not payload.start_date < payload.trial_end:
            raise HTTPException(422, "Fechas inválidas: se requiere start_date < trial_end")
        others = db.execute(select(Subscription).where(
            Subscription.client_id == client_id)).scalars().all()
        for other in others:
            if other.trial_end is None or other.status == "cancelada":
                continue
            if payload.start_date <= other.trial_end and other.start_date <= payload.trial_end:
                raise HTTPException(409, "El cliente ya tiene un trial que se solapa con ese periodo")

    status = "trial" if payload.trial_end else "activa"
    subscription = Subscription(
        project_id=client.project_id, client_id=client_id, plan_id=plan.id,
        start_date=payload.start_date, trial_end=payload.trial_end,
        status=status,
        mrr=plan.price_monthly if status == "activa" else "0",
        source_type=payload.source_type,
    )
    db.add(subscription)
    db.flush()
    audit.record(db, "subscription.create", "Subscription", subscription.id,
                 actor_id=payload.actor,
                 after={"client_id": client_id, "plan_id": plan.id,
                        "start_date": payload.start_date,
                        "trial_end": payload.trial_end, "status": status,
                        "mrr": str(subscription.mrr)})
    if status == "activa":
        # Evento de dominio SubscriptionActivated (sección 11)
        audit.record(db, "subscription_activated", "Subscription", subscription.id,
                     actor_id=payload.actor,
                     after={"plan_id": plan.id, "mrr": str(subscription.mrr)})
    db.commit()
    return serialize_subscription(subscription)


@router.patch("/subscriptions/{subscription_id}")
def patch_subscription(subscription_id: str, payload: SubscriptionPatch,
                       db: Session = Depends(get_db)):
    """Máquina de estados (pantalla 47): trial→activa|cancelada,
    activa→pausada|cancelada, pausada→activa|cancelada; otras → 409.
    Activar desde trial congela mrr = plan.price_monthly; cancelar fija
    canceled_at — jamás DELETE (append-only)."""
    subscription = db.get(Subscription, subscription_id)
    if not subscription:
        raise HTTPException(404, "Suscripción no encontrada")
    new_status = payload.status
    if (subscription.status, new_status) not in VALID_SUBSCRIPTION_TRANSITIONS:
        raise HTTPException(
            409, f"Transición de estado inválida: '{subscription.status}' → '{new_status}'")

    before = {"status": subscription.status, "mrr": str(subscription.mrr)}
    activated_from_trial = subscription.status == "trial" and new_status == "activa"
    subscription.status = new_status
    if activated_from_trial:
        plan = plan_or_404(db, subscription.plan_id)
        subscription.mrr = plan.price_monthly  # congelado del plan al activar
    if new_status == "cancelada":
        subscription.canceled_at = utcnow()

    audit.record(db, "subscription.update", "Subscription", subscription.id,
                 actor_id=payload.actor, before=before,
                 after={"status": new_status, "mrr": str(subscription.mrr)})
    if activated_from_trial:
        # Evento de dominio SubscriptionActivated (sección 11)
        audit.record(db, "subscription_activated", "Subscription", subscription.id,
                     actor_id=payload.actor,
                     after={"plan_id": subscription.plan_id,
                            "mrr": str(subscription.mrr)})
    db.commit()
    return serialize_subscription(subscription)


# ---------------------------------------------------------------------------
# Tramos escalonados de cost items (pantalla 48)
# ---------------------------------------------------------------------------

def _sorted_tiers(db: Session, cost_item_id: str) -> list[CostTier]:
    # tier_from se guarda como texto (MoneyType): ordenar por valor Decimal.
    rows = db.execute(select(CostTier).where(
        CostTier.cost_item_id == cost_item_id)).scalars().all()
    return sorted(rows, key=lambda t: D(t.tier_from))


def _validate_tiers(item: CostItem, payload: list[CostTierIn]) -> dict:
    """Reglas de la pantalla 48: behavior tiered_* y tramos marginales
    contiguos desde 0 (primer from = 0, to de uno = from del siguiente,
    último to = null, rate >= 0)."""
    field_errors: dict[str, str] = {}
    if item.behavior not in TIERED_BEHAVIORS:
        field_errors["behavior"] = (
            f"El behavior '{item.behavior}' no admite tramos escalonados "
            "(usar tiered_per_active_client, tiered_per_transaction o tiered_pct_gmv)")
    if not payload:
        field_errors["tiers"] = "Se requiere al menos un tramo"
        return field_errors

    parsed: list[tuple] = []
    for i, tier in enumerate(payload, start=1):
        try:
            lo = D(tier.tier_from)
            hi = None if tier.tier_to is None else D(tier.tier_to)
            rate = D(tier.rate)
        except (InvalidOperation, ValueError, TypeError):
            field_errors["tiers"] = f"Tramo {i}: valores no numéricos"
            return field_errors
        if rate < ZERO:
            field_errors["tiers"] = f"Tramo {i}: la tarifa debe ser >= 0"
            return field_errors
        parsed.append((lo, hi, rate))

    if parsed[0][0] != ZERO:
        field_errors["tiers"] = "El primer tramo debe iniciar en 0"
        return field_errors
    for i, (lo, hi, _) in enumerate(parsed, start=1):
        last = i == len(parsed)
        if last:
            if hi is not None:
                field_errors["tiers"] = "El último tramo debe ser abierto (to = null)"
                return field_errors
        else:
            if hi is None:
                field_errors["tiers"] = f"Tramo {i}: solo el último tramo puede ser abierto (to = null)"
                return field_errors
            if hi <= lo:
                field_errors["tiers"] = f"Tramo {i}: se requiere to > from"
                return field_errors
            if hi != parsed[i][0]:
                field_errors["tiers"] = (f"Tramos no contiguos: el 'to' del tramo {i} "
                                         f"debe igualar el 'from' del tramo {i + 1}")
                return field_errors
    return field_errors


@router.get("/cost-items/{cost_item_id}/tiers")
def list_cost_tiers(cost_item_id: str, db: Session = Depends(get_db)):
    """Pantalla 48: tramos del cost item ordenados por 'from', montos string."""
    cost_item_or_404(db, cost_item_id)
    return [serialize_tier(t) for t in _sorted_tiers(db, cost_item_id)]


@router.put("/cost-items/{cost_item_id}/tiers")
def replace_cost_tiers(cost_item_id: str, payload: list[CostTierIn],
                       db: Session = Depends(get_db)):
    """Reemplazo completo del set de tramos (pantalla 48) con auditoría
    antes/después. 422 con field_errors si el behavior no es tiered_* o los
    tramos no son contiguos desde 0."""
    item = cost_item_or_404(db, cost_item_id)
    field_errors = _validate_tiers(item, payload)
    if field_errors:
        raise HTTPException(422, detail={"field_errors": field_errors})

    existing = _sorted_tiers(db, cost_item_id)
    before = [serialize_tier(t) for t in existing]
    for tier in existing:
        db.delete(tier)
    db.flush()

    created: list[CostTier] = []
    for tier in payload:
        row = CostTier(
            cost_item_id=cost_item_id,
            tier_from=str(D(tier.tier_from)),
            tier_to=None if tier.tier_to is None else str(D(tier.tier_to)),
            rate=str(D(tier.rate)),
        )
        db.add(row)
        created.append(row)
    db.flush()

    after = [serialize_tier(t) for t in created]
    audit.record(db, "cost_tiers.replace", "CostItem", item.id,
                 before={"tiers": before}, after={"tiers": after})
    db.commit()
    return after


# ---------------------------------------------------------------------------
# Hiring plan (pantalla 49)
# ---------------------------------------------------------------------------

def _validate_role_values(values: dict):
    """Validaciones de la pantalla 49 sobre los valores vigentes (alta o merge)."""
    salary = _parse_decimal(values["monthly_salary"], "monthly_salary")
    if salary < ZERO:
        raise HTTPException(422, "El salario mensual debe ser >= 0")
    if values["headcount"] < 1:
        raise HTTPException(422, "headcount debe ser >= 1")
    if values["start_month"] < 1:
        raise HTTPException(422, "start_month debe ser >= 1")
    if values["ramp_months"] < 1:
        raise HTTPException(422, "ramp_months debe ser >= 1")
    capacity = _parse_decimal(values["onboarding_capacity_per_fte"],
                              "onboarding_capacity_per_fte")
    if capacity < ZERO:
        raise HTTPException(422, "onboarding_capacity_per_fte debe ser >= 0")


def _record_role_provenance(db: Session, role: HiringRole, actor: str):
    for field in ("name", "department", "headcount", "monthly_salary",
                  "start_month", "ramp_months", "onboarding_capacity_per_fte"):
        db.add(FieldProvenance(
            entity_type="HiringRole", entity_id=role.id, field_name=field,
            source_type="declarado", declared_by=actor,
            locator="captura manual (pantalla 49)",
        ))


@router.get("/projects/{project_id}/hiring-roles")
def list_hiring_roles(project_id: str, db: Session = Depends(get_db)):
    """Pantalla 49: roles del hiring plan del proyecto, montos string."""
    project_or_404(db, project_id)
    roles = db.execute(
        select(HiringRole).where(HiringRole.project_id == project_id)
        .order_by(HiringRole.created_at, HiringRole.id)
    ).scalars().all()
    return [serialize_role(r) for r in roles]


@router.post("/projects/{project_id}/hiring-roles", status_code=201)
def create_hiring_role(project_id: str, payload: HiringRoleCreate,
                       db: Session = Depends(get_db)):
    """Alta de rol (pantalla 49) con FieldProvenance y auditoría. La nómina es
    completa desde start_month; el ramp solo modula la capacidad."""
    project_or_404(db, project_id)
    values = payload.model_dump()
    _validate_role_values(values)

    role = HiringRole(
        project_id=project_id, name=payload.name, department=payload.department,
        headcount=payload.headcount, monthly_salary=payload.monthly_salary,
        start_month=payload.start_month, end_month=payload.end_month,
        ramp_months=payload.ramp_months,
        onboarding_capacity_per_fte=payload.onboarding_capacity_per_fte,
        notes=payload.notes,
    )
    db.add(role)
    db.flush()

    _record_role_provenance(db, role, payload.actor)
    audit.record(db, "hiring_role.create", "HiringRole", role.id,
                 actor_id=payload.actor,
                 after={"name": role.name, "department": role.department,
                        "headcount": role.headcount,
                        "monthly_salary": str(role.monthly_salary),
                        "start_month": role.start_month,
                        "ramp_months": role.ramp_months,
                        "onboarding_capacity_per_fte": str(role.onboarding_capacity_per_fte)})
    db.commit()
    return serialize_role(role)


@router.patch("/hiring-roles/{role_id}")
def patch_hiring_role(role_id: str, payload: HiringRolePatch,
                      db: Session = Depends(get_db)):
    """Edición de rol (pantalla 49): todos los campos, mismas validaciones
    sobre el merge, auditoría antes/después. La inmutabilidad histórica la
    garantizan los snapshots congelados de los runs."""
    role = role_or_404(db, role_id)
    changes = payload.model_dump(exclude_none=True)

    merged = {**serialize_role(role), **changes}
    _validate_role_values(merged)

    before = {}
    for field in changes:
        current = getattr(role, field)
        before[field] = str(current) if current is not None and field in (
            "monthly_salary", "onboarding_capacity_per_fte") else current
    for field, value in changes.items():
        setattr(role, field, value)
    audit.record(db, "hiring_role.update", "HiringRole", role.id,
                 before=before, after=changes)
    db.commit()
    return serialize_role(role)


@router.post("/hiring-roles/{role_id}/archive")
def archive_hiring_role(role_id: str, db: Session = Depends(get_db)):
    """'No eliminar histórico' (pantalla 49): jamás DELETE — se archiva; los
    runs pasados conservan el rol congelado en su snapshot."""
    role = role_or_404(db, role_id)
    if role.status == "archived":
        raise HTTPException(409, "El rol ya está archivado")
    before = {"status": role.status}
    role.status = "archived"
    audit.record(db, "hiring_role.archive", "HiringRole", role.id,
                 before=before, after={"status": "archived"})
    db.commit()
    return serialize_role(role)


# ---------------------------------------------------------------------------
# Ledger de tokens derivado de un run (pantallas 46/63)
# ---------------------------------------------------------------------------

@router.get("/simulation-runs/{run_id}/token-ledger")
def run_token_ledger(run_id: str, db: Session = Depends(get_db)):
    """Pantalla 63: filas `TokenLedger` del run, ordenadas por mes — el
    frontend no calcula nada (sección 6)."""
    succeeded_run_or_error(db, run_id)
    rows = db.execute(select(TokenLedger)
                      .where(TokenLedger.run_id == run_id)
                      .order_by(TokenLedger.month_index, TokenLedger.id)).scalars().all()
    return [serialize_token_movement(t) for t in rows]
