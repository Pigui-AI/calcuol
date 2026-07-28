"""Runs de simulación — pantallas 52–53. Job asíncrono, snapshot inmutable, idempotencia."""
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Scenario, SimulationRun, MonthlyProjection
from app.schemas import RunCreate
from app.engine.snapshot import ENGINE_VERSION
from app import services, audit

router = APIRouter()


def serialize_run(run: SimulationRun, with_summary: bool = True) -> dict:
    data = {
        "id": run.id, "scenario_id": run.scenario_id, "status": run.status,
        "engine_version": run.engine_version, "horizon_months": run.horizon_months,
        "input_hash": run.input_hash, "output_hash": run.output_hash,
        "error": run.error,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }
    if with_summary and run.logs:
        data["summary"] = run.logs.get("summary")
        data["bottlenecks"] = run.logs.get("bottlenecks")
        data["cohorts"] = run.logs.get("cohorts") or []
        data["subs_cohorts"] = run.logs.get("subs_cohorts") or []
        data["token_ledger"] = run.logs.get("token_ledger") or []
    return data


@router.post("/simulation-runs", status_code=202)
def create_run(payload: RunCreate, background: BackgroundTasks,
               idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
               db: Session = Depends(get_db)):
    scenario = db.get(Scenario, payload.scenario_id)
    if not scenario:
        raise HTTPException(404, "Escenario no encontrado")

    if idempotency_key:
        existing = db.execute(select(SimulationRun).where(
            SimulationRun.idempotency_key == idempotency_key,
            SimulationRun.scenario_id == scenario.id,
        )).scalars().first()
        if existing:
            return serialize_run(existing)

    snapshot = services.snapshot_for_scenario(db, scenario)
    run = SimulationRun(
        scenario_id=scenario.id, engine_version=ENGINE_VERSION, status="queued",
        snapshot=snapshot, input_hash=snapshot["input_hash"],
        horizon_months=snapshot["project"]["horizon_months"],
        idempotency_key=idempotency_key,
    )
    db.add(run)
    db.flush()
    audit.record(db, "simulation_started", "SimulationRun", run.id,
                 after={"scenario_id": scenario.id, "input_hash": run.input_hash})
    db.commit()
    background.add_task(services.execute_run, run.id)
    return serialize_run(run, with_summary=False)


@router.get("/simulation-runs/{run_id}")
def get_run(run_id: str, db: Session = Depends(get_db)):
    run = db.get(SimulationRun, run_id)
    if not run:
        raise HTTPException(404, "Run no encontrado")
    return serialize_run(run)


@router.get("/scenarios/{scenario_id}/runs")
def list_runs(scenario_id: str, db: Session = Depends(get_db)):
    runs = db.execute(select(SimulationRun).where(SimulationRun.scenario_id == scenario_id)
                      .order_by(SimulationRun.created_at.desc())).scalars().all()
    return [serialize_run(r, with_summary=False) for r in runs]


@router.get("/simulation-runs/{run_id}/results")
def run_results(run_id: str, keys: str | None = None, db: Session = Depends(get_db)):
    run = db.get(SimulationRun, run_id)
    if not run:
        raise HTTPException(404, "Run no encontrado")
    if run.status != "succeeded":
        raise HTTPException(409, f"El run está en estado '{run.status}'")

    query = select(MonthlyProjection).where(MonthlyProjection.run_id == run_id)
    if keys:
        wanted = [k.strip() for k in keys.split(",") if k.strip()]
        query = query.where(MonthlyProjection.metric_key.in_(wanted))
    rows = db.execute(query.order_by(MonthlyProjection.metric_key,
                                     MonthlyProjection.month_index)).scalars().all()

    months: list[str] = []
    seen = set()
    for r in rows:
        if r.month_index not in seen:
            seen.add(r.month_index)
    horizon = run.horizon_months
    from app.engine.simulator import month_label
    start = run.snapshot["project"]["start_month"]
    months = [month_label(start, i) for i in range(1, horizon + 1)]

    metrics: dict[str, list] = {}
    for r in rows:
        series = metrics.setdefault(r.metric_key, [None] * horizon)
        series[r.month_index - 1] = str(r.value)

    return {
        "run": serialize_run(run),
        "months": months,
        "metrics": metrics,
        "project": run.snapshot["project"],
        "scenario": run.snapshot["scenario"],
    }
