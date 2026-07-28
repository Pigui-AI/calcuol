"""Sensibilidad, comparación y conclusiones — fase 7, pantallas 54, 55, 70 y 71.

Sensibilidad (pantalla 54): batch de corridas derivadas de UN snapshot base con
un solo cambio controlado por variable. Se ejecuta EN MEMORIA (no crea runs ni
proyecciones) y se persiste una única fila `SensitivityAnalysis` append-only con
el hash del snapshot que la produjo — el tornado queda reproducible.
Comparación (pantalla 55): deltas de KPIs y diferencias de supuestos entre runs
`succeeded` ya persistidos; el servidor reconstruye las series desde
`MonthlyProjection` y el frontend no calcula nada (sección 6).
Conclusiones y readiness (pantallas 70–71): el motor PROPONE con reglas
explicables que siempre citan métrica, mes y valor; el usuario acepta, edita o
descarta. Lo propuesto no se persiste solo: se guarda al aceptarlo o al
capturarlo, y su ciclo de vida es propuesta → aceptada | descartada.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (Project, Scenario, SimulationRun, MonthlyProjection,
                        SensitivityAnalysis, ExecutiveConclusion, utcnow)
from app.schemas import SensitivityRunIn, ConclusionCreate, ConclusionPatch
from app.engine import assumptions as A
from app.engine.analysis import (SENSITIVITY_TARGETS, sensitivity_batch,
                                 compare_runs, derive_conclusions, vc_readiness)
from app.engine.simulator import month_label
from app import services, audit

router = APIRouter()

# Límite de cómputo de la pantalla 54: cada variable son 2 corridas extra.
MAX_SENSITIVITY_VARIABLES = 8

# Límite de columnas legibles del comparador (pantalla 55).
MAX_COMPARE_RUNS = 5

VALID_CONCLUSION_KINDS = ("hallazgo", "riesgo", "accion", "readiness")
VALID_CONCLUSION_SEVERITIES = ("alta", "media", "baja")
VALID_CONCLUSION_STATUSES = ("propuesta", "aceptada", "descartada")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def project_or_404(db: Session, project_id: str) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Proyecto no encontrado")
    return project


def scenario_or_404(db: Session, project_id: str, scenario_id: str) -> Scenario:
    scenario = db.get(Scenario, scenario_id)
    if not scenario or scenario.project_id != project_id:
        raise HTTPException(404, "Escenario no encontrado")
    return scenario


def succeeded_run_or_error(db: Session, run_id: str,
                           missing: str = "Run no encontrado") -> SimulationRun:
    """Guardas de las pantallas 54–55 y 70–71: el run debe existir y haber
    terminado bien (mismo patrón que simulations.run_results)."""
    run = db.get(SimulationRun, run_id)
    if not run:
        raise HTTPException(404, missing)
    if run.status != "succeeded":
        raise HTTPException(409, f"El run está en estado '{run.status}'")
    return run


def _run_metrics(db: Session, run: SimulationRun) -> tuple[list[str], dict[str, list]]:
    """Series del run desde `MonthlyProjection` (mismo patrón que run_results en
    simulations.py) pero conservando Decimal: el análisis hace aritmética y el
    documento prohíbe pasar por float binario en cálculos contables (6.2)."""
    horizon = run.horizon_months
    start = run.snapshot["project"]["start_month"]
    months = [month_label(start, i) for i in range(1, horizon + 1)]

    rows = db.execute(
        select(MonthlyProjection).where(MonthlyProjection.run_id == run.id)
        .order_by(MonthlyProjection.metric_key, MonthlyProjection.month_index)
    ).scalars().all()

    metrics: dict[str, list] = {}
    for r in rows:
        series = metrics.setdefault(r.metric_key, [None] * horizon)
        if 1 <= r.month_index <= horizon:
            series[r.month_index - 1] = r.value  # Decimal (MoneyType)
    return months, metrics


def _run_result(db: Session, run: SimulationRun) -> dict:
    """Resultado del motor reconstruido desde lo persistido: series en Decimal,
    resumen y logs congelados en el run."""
    months, metrics = _run_metrics(db, run)
    logs = run.logs or {}
    return {
        "months": months,
        "metrics": metrics,
        "summary": logs.get("summary") or {},
        "logs": logs,
    }


def _run_label(db: Session, run: SimulationRun) -> str:
    """Etiqueta del comparador: nombre del escenario + fecha corta del run."""
    scenario = db.get(Scenario, run.scenario_id)
    name = scenario.name if scenario else run.scenario_id
    stamp = run.finished_at or run.created_at
    return f"{name} ({stamp.date().isoformat()})" if stamp else name


# ---------------------------------------------------------------------------
# Serializadores manuales (montos siempre string)
# ---------------------------------------------------------------------------

def serialize_sensitivity(s: SensitivityAnalysis, with_results: bool = True) -> dict:
    label, agg = SENSITIVITY_TARGETS.get(s.target_metric, (s.target_metric, "sum"))
    data = {
        "id": s.id, "project_id": s.project_id, "scenario_id": s.scenario_id,
        "base_run_id": s.base_run_id, "engine_version": s.engine_version,
        "input_hash": s.input_hash, "target_metric": s.target_metric,
        "target_label": label, "aggregation": agg,
        "variables": s.variables or [],
        "baseline_value": str(s.baseline_value),
        "created_by": s.created_by,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }
    if with_results:
        data["results"] = s.results or []
    return data


def serialize_conclusion(c: ExecutiveConclusion) -> dict:
    return {
        "id": c.id, "project_id": c.project_id, "run_id": c.run_id,
        "kind": c.kind, "code": c.code, "title": c.title, "body": c.body,
        "severity": c.severity, "evidence": c.evidence or [],
        "status": c.status, "source": c.source, "created_by": c.created_by,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


# ---------------------------------------------------------------------------
# Sensibilidad (pantalla 54)
# ---------------------------------------------------------------------------

@router.get("/sensitivity-targets")
def list_sensitivity_targets():
    """Catálogo de métricas objetivo del tornado (pantalla 54). La agregación
    declarada aquí es la que usa el motor para leer cada métrica."""
    return [{"key": key, "label": label, "aggregation": agg}
            for key, (label, agg) in SENSITIVITY_TARGETS.items()]


def _validate_variables(payload: SensitivityRunIn) -> list[dict]:
    """Reglas de la pantalla 54: entre 1 y 8 variables, claves del catálogo de
    supuestos y extremos que pasan la misma validación que el centro de
    supuestos. Devuelve la lista normalizada [{key, low, high}]."""
    if not 1 <= len(payload.variables) <= MAX_SENSITIVITY_VARIABLES:
        raise HTTPException(422, f"Selecciona entre 1 y {MAX_SENSITIVITY_VARIABLES} variables")

    field_errors: dict[str, str] = {}
    normalized: list[dict] = []
    seen: set[str] = set()
    for var in payload.variables:
        key = var.key
        if key in seen:
            field_errors[key] = "La variable está repetida"
            continue
        seen.add(key)
        if key not in A.DEFAULTS:
            field_errors[key] = "Supuesto desconocido"
            continue
        if var.low is None and var.high is None:
            field_errors[key] = "Se requiere al menos un extremo (low o high)"
            continue
        for side in ("low", "high"):
            raw = getattr(var, side)
            if raw is None:
                continue
            err = A.validate(key, str(raw))
            if err:
                field_errors[f"{key}.{side}"] = err
        normalized.append({
            "key": key,
            "low": None if var.low is None else str(var.low),
            "high": None if var.high is None else str(var.high),
        })

    if field_errors:
        raise HTTPException(422, detail={"field_errors": field_errors})
    return normalized


@router.post("/projects/{project_id}/scenarios/{scenario_id}/sensitivity", status_code=201)
def run_sensitivity(project_id: str, scenario_id: str, payload: SensitivityRunIn,
                    db: Session = Depends(get_db)):
    """Batch de sensibilidad (pantalla 54): simula EN MEMORIA una corrida por
    extremo sobre el mismo snapshot base — no persiste runs ni proyecciones — y
    congela el tornado en una fila `SensitivityAnalysis` append-only."""
    scenario = scenario_or_404(db, project_id, scenario_id)
    if payload.target_metric not in SENSITIVITY_TARGETS:
        raise HTTPException(422, f"Métrica objetivo inválida: '{payload.target_metric}'")
    variables = _validate_variables(payload)

    base_run: SimulationRun | None = None
    if payload.base_run_id:
        base_run = succeeded_run_or_error(db, payload.base_run_id)
        snapshot = base_run.snapshot
    else:
        snapshot = services.snapshot_for_scenario(db, scenario)

    out = sensitivity_batch(snapshot, variables, payload.target_metric)

    row = SensitivityAnalysis(
        project_id=project_id, scenario_id=scenario.id,
        base_run_id=base_run.id if base_run else None,
        engine_version=out["engine_version"], input_hash=out["input_hash"],
        target_metric=payload.target_metric, variables=variables,
        results=out["results"], baseline_value=out["baseline_value"],
        created_by=payload.actor,
    )
    db.add(row)
    db.flush()

    audit.record(db, "sensitivity_run_started", "SensitivityAnalysis", row.id,
                 actor_id=payload.actor,
                 after={"scenario_id": scenario.id, "base_run_id": row.base_run_id,
                        "target_metric": row.target_metric,
                        "variables": [v["key"] for v in variables],
                        "input_hash": row.input_hash,
                        "baseline_value": out["baseline_value"]})
    db.commit()
    return serialize_sensitivity(row)


@router.get("/projects/{project_id}/sensitivity-analyses")
def list_sensitivity_analyses(project_id: str, db: Session = Depends(get_db)):
    """Pantalla 54: análisis del proyecto sin el blob de resultados (el detalle
    se pide por id)."""
    project_or_404(db, project_id)
    rows = db.execute(
        select(SensitivityAnalysis).where(SensitivityAnalysis.project_id == project_id)
        .order_by(SensitivityAnalysis.created_at.desc(), SensitivityAnalysis.id)
    ).scalars().all()
    return [serialize_sensitivity(r, with_results=False) for r in rows]


@router.get("/sensitivity-analyses/{analysis_id}")
def get_sensitivity_analysis(analysis_id: str, db: Session = Depends(get_db)):
    """Pantalla 54: tornado completo tal como quedó congelado."""
    row = db.get(SensitivityAnalysis, analysis_id)
    if not row:
        raise HTTPException(404, "Análisis de sensibilidad no encontrado")
    return serialize_sensitivity(row)


# ---------------------------------------------------------------------------
# Comparador de escenarios (pantalla 55)
# ---------------------------------------------------------------------------

@router.get("/projects/{project_id}/compare")
def compare(project_id: str, runs: str | None = None, db: Session = Depends(get_db)):
    """Pantalla 55: deltas de KPIs y diferencias de supuestos entre 2 y 5 runs
    `succeeded`. El primero de la lista es el baseline; el servidor reconstruye
    las series desde `MonthlyProjection` y advierte cuando la comparación no es
    directa (motor, horizonte o moneda distintos)."""
    project_or_404(db, project_id)
    run_ids = [r.strip() for r in (runs or "").split(",") if r.strip()]
    if len(run_ids) < 2:
        raise HTTPException(422, "Selecciona al menos 2 runs para comparar")
    if len(run_ids) > MAX_COMPARE_RUNS:
        raise HTTPException(422, f"Selecciona como máximo {MAX_COMPARE_RUNS} runs para comparar")
    if len(set(run_ids)) != len(run_ids):
        raise HTTPException(422, "Hay runs repetidos en la comparación")

    payload = []
    for run_id in run_ids:
        run = db.get(SimulationRun, run_id)
        scenario = db.get(Scenario, run.scenario_id) if run else None
        if not run or not scenario or scenario.project_id != project_id:
            raise HTTPException(404, f"Run no encontrado: {run_id}")
        if run.status != "succeeded":
            raise HTTPException(409, f"El run '{run_id}' está en estado '{run.status}'")
        _months, metrics = _run_metrics(db, run)
        payload.append({
            "id": run.id, "label": _run_label(db, run), "snapshot": run.snapshot,
            "summary": (run.logs or {}).get("summary") or {},
            "metrics": metrics,
        })

    return compare_runs(payload)


# ---------------------------------------------------------------------------
# Conclusiones y readiness (pantallas 70–71)
# ---------------------------------------------------------------------------

@router.get("/simulation-runs/{run_id}/conclusions")
def run_conclusions(run_id: str, db: Session = Depends(get_db)):
    """Pantallas 70–71: lo que el motor PROPONE para este run (con la evidencia
    que respalda cada regla), las señales de readiness VC (16.2) y lo que el
    usuario ya guardó. Proponer no persiste: guardar es un POST explícito."""
    run = succeeded_run_or_error(db, run_id)
    result = _run_result(db, run)
    saved = db.execute(
        select(ExecutiveConclusion).where(ExecutiveConclusion.run_id == run.id)
        .order_by(ExecutiveConclusion.created_at, ExecutiveConclusion.id)
    ).scalars().all()
    return {
        "run_id": run.id,
        "generated": derive_conclusions(result, run.snapshot),
        "readiness": vc_readiness(result, run.snapshot),
        "saved": [serialize_conclusion(c) for c in saved],
    }


@router.post("/simulation-runs/{run_id}/conclusions", status_code=201)
def create_conclusion(run_id: str, payload: ConclusionCreate,
                      db: Session = Depends(get_db)):
    """Pantalla 71: guarda una conclusión del usuario (aceptada del motor o
    capturada a mano). Nace en estado 'propuesta' con source='usuario'."""
    run = succeeded_run_or_error(db, run_id)
    scenario = db.get(Scenario, run.scenario_id)
    if not scenario:
        raise HTTPException(404, "Escenario no encontrado")
    if payload.kind not in VALID_CONCLUSION_KINDS:
        raise HTTPException(422, f"Tipo de conclusión inválido: '{payload.kind}' "
                                 f"(usar {', '.join(VALID_CONCLUSION_KINDS)})")
    if payload.severity not in VALID_CONCLUSION_SEVERITIES:
        raise HTTPException(422, f"Severidad inválida: '{payload.severity}' "
                                 f"(usar {', '.join(VALID_CONCLUSION_SEVERITIES)})")
    if not payload.title.strip():
        raise HTTPException(422, "El título de la conclusión es obligatorio")

    conclusion = ExecutiveConclusion(
        project_id=scenario.project_id, run_id=run.id, kind=payload.kind,
        code=payload.code, title=payload.title, body=payload.body,
        severity=payload.severity, evidence=payload.evidence,
        status="propuesta", source="usuario", created_by=payload.actor,
    )
    db.add(conclusion)
    db.flush()
    audit.record(db, "conclusion.create", "ExecutiveConclusion", conclusion.id,
                 actor_id=payload.actor,
                 after={"run_id": run.id, "kind": conclusion.kind,
                        "code": conclusion.code, "title": conclusion.title,
                        "severity": conclusion.severity,
                        "status": conclusion.status, "source": conclusion.source})
    db.commit()
    return serialize_conclusion(conclusion)


@router.patch("/conclusions/{conclusion_id}")
def patch_conclusion(conclusion_id: str, payload: ConclusionPatch,
                     db: Session = Depends(get_db)):
    """Pantalla 71: aceptar, descartar o editar una conclusión, con auditoría
    antes/después. La conclusión no se borra: cambia de estado."""
    conclusion = db.get(ExecutiveConclusion, conclusion_id)
    if not conclusion:
        raise HTTPException(404, "Conclusión no encontrada")

    changes = payload.model_dump(exclude_none=True)
    changes.pop("actor", None)
    if not changes:
        raise HTTPException(422, "No hay cambios que aplicar")
    if "status" in changes and changes["status"] not in VALID_CONCLUSION_STATUSES:
        raise HTTPException(409, f"Estado inválido: '{changes['status']}' "
                                 f"(usar {', '.join(VALID_CONCLUSION_STATUSES)})")
    if "severity" in changes and changes["severity"] not in VALID_CONCLUSION_SEVERITIES:
        raise HTTPException(422, f"Severidad inválida: '{changes['severity']}' "
                                 f"(usar {', '.join(VALID_CONCLUSION_SEVERITIES)})")
    if "title" in changes and not changes["title"].strip():
        raise HTTPException(422, "El título de la conclusión es obligatorio")

    before = {field: getattr(conclusion, field) for field in changes}
    for field, value in changes.items():
        setattr(conclusion, field, value)
    conclusion.updated_at = utcnow()
    audit.record(db, "conclusion.update", "ExecutiveConclusion", conclusion.id,
                 actor_id=payload.actor, before=before, after=changes)
    db.commit()
    return serialize_conclusion(conclusion)
