"""Servicios: resolución de supuestos desde BD, snapshots y ejecución de runs."""
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select, func
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import (
    Project, Scenario, AssumptionSet, Client, CostItem,
    SimulationRun, MonthlyProjection, Campaign, SettlementBatch, ArInvoice,
    Brand, Branch, ProductService,
)
from app.engine import assumptions as A
from app.engine.money import D
from app.engine.snapshot import build_snapshot, ENGINE_VERSION
from app.engine.simulator import simulate, month_label

# Multiplicadores para escenarios derivados (pantalla 51). Se materializan como
# overrides explícitos y quedan visibles/edítables en el centro de supuestos.
SCENARIO_MULTIPLIERS = {
    "conservador": {
        "b2b.churn_rate": "1.25", "b2b.curve.rate": "0.8", "b2b.cac": "1.15",
        "b2c.purchase_conversion": "0.85", "b2c.avg_ticket": "0.95",
        "b2c.consumer_churn_rate": "1.2", "b2c.cohort.retention_m1": "0.85",
    },
    "optimista": {
        "b2b.churn_rate": "0.8", "b2b.curve.rate": "1.2", "b2b.cac": "0.9",
        "b2c.purchase_conversion": "1.1", "b2c.avg_ticket": "1.05",
        "b2c.consumer_churn_rate": "0.85", "b2c.cohort.retention_m1": "1.1",
    },
}


def latest_assumption_rows(db: Session, project_id: str, scenario_id: str | None):
    """Filas vigentes (última versión) por key para el alcance dado.

    Filtra por scope_type para que los efectos de campaña (scope_type="campaign",
    scenario_id=None) no se cuelen en la resolución de nivel proyecto/escenario.
    """
    q = select(AssumptionSet).where(
        AssumptionSet.project_id == project_id,
        AssumptionSet.scenario_id == scenario_id if scenario_id else AssumptionSet.scenario_id.is_(None),
        AssumptionSet.scope_type == ("scenario" if scenario_id else "global"),
    ).order_by(AssumptionSet.key, AssumptionSet.version)
    rows = db.execute(q).scalars().all()
    latest = {}
    for r in rows:
        latest[r.key] = r  # ordenado por versión: la última gana
    return list(latest.values())


def effective_assumptions(db: Session, project_id: str, scenario_id: str | None) -> dict:
    project_rows = latest_assumption_rows(db, project_id, None)
    scenario_rows = latest_assumption_rows(db, project_id, scenario_id) if scenario_id else []
    return A.resolve_effective(project_rows, scenario_rows)


def upsert_assumptions(db: Session, project_id: str, scenario_id: str | None,
                       changes: dict, source_type: str = "hipotesis", actor: str = "usuario"):
    """Crea nuevas versiones (nunca sobrescribe) y devuelve errores de validación."""
    errors = {}
    for key, value in changes.items():
        if key not in A.DEFAULTS:
            errors[key] = "Supuesto desconocido"
            continue
        err = A.validate(key, str(value))
        if err:
            errors[key] = err
    if errors:
        return errors

    # validación del split de comisiones (3.1): debe sumar 100%
    split_keys = {"revenue.commission.pigui_pct", "revenue.commission.points_pct", "revenue.commission.business_pct"}
    if split_keys & set(changes.keys()):
        eff = effective_assumptions(db, project_id, scenario_id)
        merged = {k: v["value"] for k, v in eff.items()}
        merged.update({k: str(v) for k, v in changes.items()})
        err = A.validate_commission_split(
            D(merged["revenue.commission.pigui_pct"]),
            D(merged["revenue.commission.points_pct"]),
            D(merged["revenue.commission.business_pct"]),
        )
        if err:
            return {"revenue.commission.*": err}

    for key, value in changes.items():
        current_version = db.execute(
            select(func.max(AssumptionSet.version)).where(
                AssumptionSet.project_id == project_id,
                AssumptionSet.scenario_id == scenario_id if scenario_id else AssumptionSet.scenario_id.is_(None),
                AssumptionSet.key == key,
            )
        ).scalar() or 0
        db.add(AssumptionSet(
            project_id=project_id,
            scenario_id=scenario_id,
            scope_type="scenario" if scenario_id else "global",
            scope_id=scenario_id,
            key=key,
            value=str(value),
            unit=A.DEFAULTS[key][1],
            source_type=source_type,
            version=current_version + 1,
            created_by=actor,
        ))
    return None


def apply_scenario_multipliers(db: Session, project_id: str, scenario_id: str, scenario_type: str):
    """Materializa overrides de conservador/optimista a partir de los valores base."""
    multipliers = SCENARIO_MULTIPLIERS.get(scenario_type)
    if not multipliers:
        return
    eff = effective_assumptions(db, project_id, None)
    changes = {}
    for key, factor in multipliers.items():
        base_value = D(eff[key]["value"])
        adjusted = base_value * D(factor)
        if key in A.PCT_KEYS and adjusted > Decimal("1"):
            adjusted = Decimal("1")
        changes[key] = str(adjusted)
    upsert_assumptions(db, project_id, scenario_id, changes, source_type="hipotesis", actor="sistema")


# --- Campañas (fase 5): efectos como AssumptionSet scope_type="campaign" ---
CAMPAIGN_EFFECT_KEYS = {k for k in A.DEFAULTS if k.startswith("campaign.")}


def latest_campaign_rows(db: Session, project_id: str, campaign_id: str):
    """Filas vigentes (última versión) por key para el alcance de una campaña."""
    q = select(AssumptionSet).where(
        AssumptionSet.project_id == project_id,
        AssumptionSet.scope_type == "campaign",
        AssumptionSet.scope_id == campaign_id,
    ).order_by(AssumptionSet.key, AssumptionSet.version)
    latest = {}
    for r in db.execute(q).scalars().all():
        latest[r.key] = r
    return list(latest.values())


def campaign_effects(db: Session, project_id: str, scenario_id: str | None, campaign_id: str) -> dict:
    """Jerarquía defaults → proyecto → escenario → campaña. Devuelve {key: {value, origin}}."""
    eff = effective_assumptions(db, project_id, scenario_id)
    out = {k: {"value": eff[k]["value"], "origin": eff[k]["origin"]} for k in CAMPAIGN_EFFECT_KEYS}
    for row in latest_campaign_rows(db, project_id, campaign_id):
        if row.key in out:
            out[row.key] = {"value": row.value, "origin": "campaña"}
    return out


def upsert_campaign_effects(db: Session, project_id: str, campaign_id: str,
                            changes: dict, source_type: str = "hipotesis", actor: str = "usuario"):
    """Nuevas versiones de efectos de campaña (nunca sobrescribe). Devuelve errores o None."""
    errors = {}
    for key, value in changes.items():
        if key not in CAMPAIGN_EFFECT_KEYS:
            errors[key] = "Efecto de campaña desconocido"
            continue
        err = A.validate(key, str(value))
        if err:
            errors[key] = err
    if errors:
        return errors
    for key, value in changes.items():
        current_version = db.execute(
            select(func.max(AssumptionSet.version)).where(
                AssumptionSet.project_id == project_id,
                AssumptionSet.scope_type == "campaign",
                AssumptionSet.scope_id == campaign_id,
                AssumptionSet.key == key,
            )
        ).scalar() or 0
        db.add(AssumptionSet(
            project_id=project_id, scenario_id=None, scope_type="campaign",
            scope_id=campaign_id, key=key, value=str(value), unit=A.DEFAULTS[key][1],
            source_type=source_type, version=current_version + 1, created_by=actor,
        ))
    return None


def _reward_eligible_share(db: Session, project_id: str) -> str | None:
    """Share del catálogo elegible para puntos: Σ precio(items elegibles) / Σ precio(items),
    sobre catálogo activo de clientes active|onboarding (pantalla 34)."""
    rows = db.execute(
        select(ProductService.sale_price, ProductService.reward_eligible)
        .join(Branch, ProductService.branch_id == Branch.id)
        .join(Brand, Branch.brand_id == Brand.id)
        .join(Client, Brand.client_id == Client.id)
        .where(Client.project_id == project_id,
               Client.status.in_(("active", "onboarding")),
               ProductService.status == "active")
    ).all()
    total = sum((D(price) for price, _e in rows), Decimal("0"))
    if total <= 0:
        return None
    eligible = sum((D(price) for price, e in rows if e), Decimal("0"))
    return str(eligible / total)


def snapshot_for_scenario(db: Session, scenario: Scenario) -> dict:
    project: Project = db.get(Project, scenario.project_id)
    eff = effective_assumptions(db, project.id, scenario.id)
    cost_items = [{
        "name": ci.name, "category": ci.category, "behavior": ci.behavior,
        "amount": str(ci.amount), "effective_from": ci.effective_from, "effective_to": ci.effective_to,
    } for ci in db.execute(select(CostItem).where(CostItem.project_id == project.id)).scalars()]
    clients = []
    for c in db.execute(select(Client).where(Client.project_id == project.id,
                                             Client.status != "archived")).scalars():
        baseline = None
        if c.baseline:
            baseline = {
                "avg_monthly_sales": str(c.baseline.avg_monthly_sales),
                "avg_monthly_transactions": str(c.baseline.avg_monthly_transactions),
                "avg_ticket": str(c.baseline.avg_ticket),
                "margin_pct": str(c.baseline.margin_pct),
                "registered_consumers": c.baseline.registered_consumers,
                "active_consumers": c.baseline.active_consumers,
                "monthly_buyers": c.baseline.monthly_buyers,
                "purchase_frequency": str(c.baseline.purchase_frequency),
            }
        clients.append({
            "id": c.id, "trade_name": c.trade_name, "industry": c.industry,
            "status": c.status, "baseline": baseline,
        })
    campaigns = [{
        "id": c.id, "name": c.name, "campaign_type": c.campaign_type, "status": c.status,
        "start_month": c.start_month, "end_month": c.end_month,
        "effects": {k: v["value"] for k, v in
                    campaign_effects(db, project.id, scenario.id, c.id).items()},
    } for c in db.execute(select(Campaign).where(Campaign.project_id == project.id,
                                                 Campaign.status == "active")).scalars()]
    return build_snapshot(
        {"id": project.id, "name": project.name, "base_currency": project.base_currency,
         "start_month": project.start_month, "horizon_months": project.horizon_months},
        {"id": scenario.id, "name": scenario.name, "type": scenario.type},
        eff, cost_items, clients,
        campaigns=campaigns,
        reward_eligible_share=_reward_eligible_share(db, project.id),
    )


def execute_run(run_id: str):
    """Ejecuta un run (llamado desde BackgroundTasks). Sesión propia por hilo."""
    db = SessionLocal()
    try:
        run: SimulationRun = db.get(SimulationRun, run_id)
        if run is None or run.status not in ("queued",):
            return
        run.status = "running"
        run.started_at = datetime.now(timezone.utc)
        db.commit()

        result = simulate(run.snapshot)

        rows = []
        months = result["months"]
        for key, series in result["metrics"].items():
            unit = "MXN" if key.startswith(("tx.gmv", "tx.direct", "tx.eligible", "tx.business",
                                            "rev.", "cash.", "ar.", "cost.", "pnl.", "stl.",
                                            "camp.gmv", "camp.revenue",
                                            "ue.arpa", "ue.cm", "ue.cac", "ue.ltv", "kpi.burn")) else ""
            for i, value in enumerate(series):
                if value is None:
                    continue
                rows.append(MonthlyProjection(
                    run_id=run.id, month_index=i + 1, month_label=months[i],
                    entity_type="project", entity_id=run.snapshot["project"]["id"],
                    metric_key=key, value=value, unit=unit,
                ))
        db.add_all(rows)

        # fase 5: persistir settlements y facturas AR derivadas del run (append-only)
        horizon = run.horizon_months
        for s in result["logs"].get("settlements", []):
            db.add(SettlementBatch(
                run_id=run.id, month_index=s["month"], month_label=months[s["month"] - 1],
                gross_collected=s["gross_collected"], processing_fee=s["processing_fee"],
                pigui_take=s["pigui_take"], merchant_due=s["merchant_due"],
                payout_month_index=s["payout_month"],
                status="pagado" if s["payout_month"] <= horizon else "pendiente",
            ))
        for inv in result["logs"].get("ar_invoices", []):
            due = inv["due_month"]
            db.add(ArInvoice(
                run_id=run.id, invoice_number=inv["number"], month_index=inv["month"],
                month_label=months[inv["month"] - 1], amount=inv["amount"],
                due_month_index=due,
                due_month_label=months[due - 1] if due <= horizon
                else month_label(run.snapshot["project"]["start_month"], due),
                expected_collection=inv["expected_collection"],
                expected_writeoff=inv["expected_writeoff"],
                status="cobrada" if due <= horizon else "por_cobrar",
            ))

        run.status = "succeeded"
        run.output_hash = result["output_hash"]
        run.logs = {"bottlenecks": result["logs"]["bottlenecks"],
                    "cohorts": result["logs"].get("cohorts", []),
                    "settlements": result["logs"].get("settlements", []),
                    "ar_invoices": result["logs"].get("ar_invoices", []),
                    "summary": result["summary"]}
        run.finished_at = datetime.now(timezone.utc)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        run = db.get(SimulationRun, run_id)
        if run:
            run.status = "failed"
            run.error = str(exc)
            run.finished_at = datetime.now(timezone.utc)
            db.commit()
    finally:
        db.close()


def last_successful_run(db: Session, scenario_ids: list[str]) -> SimulationRun | None:
    if not scenario_ids:
        return None
    return db.execute(
        select(SimulationRun)
        .where(SimulationRun.scenario_id.in_(scenario_ids), SimulationRun.status == "succeeded")
        .order_by(SimulationRun.finished_at.desc())
    ).scalars().first()
