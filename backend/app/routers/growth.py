"""Growth avanzado y cohortes — fase 4, pantallas 24–30.

Vista previa de crecimiento calculada por el servidor (el frontend nunca
calcula resultados financieros): ejecuta el motor en memoria sobre el
snapshot vigente del escenario, sin persistir run ni proyecciones.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Scenario
from app.engine.simulator import simulate
from app.engine.snapshot import effective_from_snapshot
from app.engine.cohorts import monthly_retention, activity_factor, survival_to
from app.engine.money import D, q_rate, q_count, ZERO
from app.engine.assumptions import as_bool
from app import services

router = APIRouter()

GROWTH_KEYS = (
    "b2b.target_curve", "b2b.adds_desired", "b2b.adds_activated", "b2b.churned",
    "b2b.reactivated", "b2b.clients_end",
    "b2c.consumers_new", "b2c.consumers_churned", "b2c.consumers_end",
    "b2c.buyers", "b2c.transactions", "tx.gmv",
)

RETENTION_CURVE_AGES = 24  # meses de antigüedad mostrados en la curva


@router.get("/projects/{project_id}/scenarios/{scenario_id}/growth-preview")
def growth_preview(project_id: str, scenario_id: str, db: Session = Depends(get_db)):
    scenario = db.get(Scenario, scenario_id)
    if not scenario or scenario.project_id != project_id:
        raise HTTPException(404, "Escenario no encontrado")

    snapshot = services.snapshot_for_scenario(db, scenario)
    result = simulate(snapshot)
    eff = effective_from_snapshot(snapshot)["assumptions"]

    metrics = {
        key: [None if v is None else str(v) for v in result["metrics"][key]]
        for key in GROWTH_KEYS if key in result["metrics"]
    }
    # agregados calculados en el servidor (el frontend no suma series)
    totals = {
        key: str(q_count(sum((v for v in result["metrics"][key] if v is not None), ZERO)))
        for key in ("b2b.adds_activated", "b2b.adds_desired", "b2b.churned", "b2c.consumers_new")
        if key in result["metrics"]
    }

    cohorts_enabled = as_bool(eff["b2c.cohort.enabled"])
    retention_curve = []
    if cohorts_enabled:
        r1 = D(eff["b2c.cohort.retention_m1"])
        stable = D(eff["b2c.cohort.retention_stable"])
        ramp = D(eff["b2c.cohort.retention_ramp"])
        maturation = int(D(eff["b2c.cohort.maturation_months"]))
        init_act = D(eff["b2c.cohort.initial_activity_factor"])
        for age in range(1, RETENTION_CURVE_AGES + 1):
            retention_curve.append({
                "age": age,
                "retention": str(q_rate(monthly_retention(age, r1, stable, ramp))),
                "survival": str(q_rate(survival_to(age, r1, stable, ramp))),
                "activity_factor": str(q_rate(activity_factor(age, init_act, maturation))),
            })

    assumptions = {
        k: {"value": v["value"], "origin": v["origin"], "unit": v["unit"],
            "description": v["description"]}
        for k, v in services.effective_assumptions(db, project_id, scenario_id).items()
        if k.startswith(("b2b.", "b2c."))
    }

    return {
        "months": result["months"],
        "metrics": metrics,
        "totals": totals,
        "bottlenecks": result["logs"]["bottlenecks"],
        "cohorts": result["logs"].get("cohorts", []),
        "cohorts_enabled": cohorts_enabled,
        "retention_curve": retention_curve,
        "ltv_b2c": result["summary"].get("ltv_b2c"),
        "derived_inputs": result["summary"]["derived_inputs"],
        "assumptions": assumptions,
        "input_hash": snapshot["input_hash"],
        "engine_version": result["summary"]["engine_version"],
    }
