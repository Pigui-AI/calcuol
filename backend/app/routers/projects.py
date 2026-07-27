"""Proyectos, escenarios, supuestos y costos — pantallas 01–06, 48, 50, 51."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Project, Scenario, AssumptionSet, Client, CostItem, SimulationRun
from app.schemas import (ProjectCreate, ProjectPatch, ScenarioCreate,
                         AssumptionsPatch, CostItemIn)
from app.engine.snapshot import ENGINE_VERSION
from app import services, audit

router = APIRouter()


def project_or_404(db: Session, project_id: str) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Proyecto no encontrado")
    return project


def scenario_or_404(db: Session, scenario_id: str) -> Scenario:
    scenario = db.get(Scenario, scenario_id)
    if not scenario:
        raise HTTPException(404, "Escenario no encontrado")
    return scenario


def serialize_scenario(s: Scenario) -> dict:
    return {"id": s.id, "project_id": s.project_id, "name": s.name, "type": s.type,
            "status": s.status, "engine_version": s.engine_version,
            "created_at": s.created_at.isoformat() if s.created_at else None}


def serialize_project(db: Session, p: Project, with_kpis: bool = True) -> dict:
    scenarios = [serialize_scenario(s) for s in p.scenarios]
    data = {
        "id": p.id, "name": p.name, "description": p.description, "status": p.status,
        "base_currency": p.base_currency, "start_month": p.start_month,
        "horizon_months": p.horizon_months, "owner_id": p.owner_id,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "scenarios": scenarios,
        "clients_count": len([c for c in p.clients if c.status != "archived"]),
    }
    if with_kpis:
        run = services.last_successful_run(db, [s.id for s in p.scenarios])
        if run and run.logs and run.logs.get("summary"):
            s = run.logs["summary"]
            year1 = s["annual"][0] if s.get("annual") else None
            data["kpis"] = {
                "run_id": run.id,
                "scenario_id": run.scenario_id,
                "revenue_y1": year1["revenue"] if year1 else None,
                "ebitda_y1": year1["ebitda"] if year1 else None,
                "breakeven_month": s.get("breakeven_month"),
                "funding_need": s.get("funding_need"),
                "final_cash": s.get("final_cash"),
            }
        else:
            data["kpis"] = None  # la UI muestra "Sin calcular" (pantalla 01)
    return data


@router.post("/projects", status_code=201)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db)):
    g = payload.general
    if g.horizon_months not in (12, 36, 60):
        raise HTTPException(422, "Horizonte permitido: 12, 36 o 60 meses")
    project = Project(
        name=g.name, description=g.description, owner_id=g.owner,
        base_currency=g.base_currency, secondary_currency=g.secondary_currency,
        exchange_rate=g.exchange_rate, start_month=g.start_month,
        horizon_months=g.horizon_months, status="active",
    )
    db.add(project)
    db.flush()

    if payload.assumptions:
        errors = services.upsert_assumptions(db, project.id, None, payload.assumptions,
                                             source_type="declarado", actor=g.owner)
        if errors:
            raise HTTPException(422, detail={"field_errors": errors})

    for ci in payload.cost_items:
        db.add(CostItem(project_id=project.id, **ci.model_dump()))

    base = Scenario(project_id=project.id, name="Base", type="base", engine_version=ENGINE_VERSION)
    db.add(base)
    db.flush()
    scenarios = [base]
    if payload.create_default_scenarios:
        for stype, sname in (("conservador", "Conservador"), ("optimista", "Optimista")):
            sc = Scenario(project_id=project.id, name=sname, type=stype,
                          parent_scenario_id=base.id, engine_version=ENGINE_VERSION)
            db.add(sc)
            db.flush()
            services.apply_scenario_multipliers(db, project.id, sc.id, stype)
            scenarios.append(sc)

    audit.record(db, "project_created", "Project", project.id, actor_id=g.owner,
                 after={"name": project.name, "horizon": project.horizon_months})
    db.commit()
    return serialize_project(db, project)


@router.get("/projects")
def list_projects(status: str | None = None, q: str | None = None, db: Session = Depends(get_db)):
    query = select(Project).order_by(Project.created_at.desc())
    if status:
        query = query.where(Project.status == status)
    projects = db.execute(query).scalars().all()
    if q:
        needle = q.lower()
        projects = [p for p in projects if needle in p.name.lower() or needle in (p.description or "").lower()]
    return [serialize_project(db, p) for p in projects]


@router.get("/projects/{project_id}")
def get_project(project_id: str, db: Session = Depends(get_db)):
    return serialize_project(db, project_or_404(db, project_id))


@router.patch("/projects/{project_id}")
def patch_project(project_id: str, payload: ProjectPatch, db: Session = Depends(get_db)):
    project = project_or_404(db, project_id)
    before = {"name": project.name, "description": project.description, "status": project.status}
    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(project, field, value)
    audit.record(db, "project_updated", "Project", project.id, before=before,
                 after=payload.model_dump(exclude_none=True))
    db.commit()
    return serialize_project(db, project)


@router.post("/projects/{project_id}/scenarios", status_code=201)
def create_scenario(project_id: str, payload: ScenarioCreate, db: Session = Depends(get_db)):
    project = project_or_404(db, project_id)
    scenario = Scenario(project_id=project.id, name=payload.name, type=payload.type,
                        engine_version=ENGINE_VERSION)
    db.add(scenario)
    db.flush()
    if payload.type in services.SCENARIO_MULTIPLIERS and not payload.overrides:
        services.apply_scenario_multipliers(db, project.id, scenario.id, payload.type)
    elif payload.overrides:
        errors = services.upsert_assumptions(db, project.id, scenario.id, payload.overrides)
        if errors:
            raise HTTPException(422, detail={"field_errors": errors})
    audit.record(db, "scenario_created", "Scenario", scenario.id, after={"name": payload.name})
    db.commit()
    return serialize_scenario(scenario)


@router.get("/scenarios/{scenario_id}/assumptions")
def get_assumptions(scenario_id: str, db: Session = Depends(get_db)):
    scenario = scenario_or_404(db, scenario_id)
    eff = services.effective_assumptions(db, scenario.project_id, scenario.id)
    return {"scenario": serialize_scenario(scenario),
            "assumptions": [{"key": k, **v} for k, v in sorted(eff.items())]}


@router.patch("/scenarios/{scenario_id}/assumptions")
def patch_assumptions(scenario_id: str, payload: AssumptionsPatch, db: Session = Depends(get_db)):
    scenario = scenario_or_404(db, scenario_id)
    errors = services.upsert_assumptions(db, scenario.project_id, scenario.id,
                                         payload.changes, payload.source_type, payload.actor)
    if errors:
        raise HTTPException(422, detail={"field_errors": errors})
    audit.record(db, "assumption_changed", "Scenario", scenario.id,
                 actor_id=payload.actor, after=payload.changes)
    db.commit()
    eff = services.effective_assumptions(db, scenario.project_id, scenario.id)
    return {"assumptions": [{"key": k, **v} for k, v in sorted(eff.items())]}


@router.patch("/projects/{project_id}/assumptions")
def patch_project_assumptions(project_id: str, payload: AssumptionsPatch, db: Session = Depends(get_db)):
    project = project_or_404(db, project_id)
    errors = services.upsert_assumptions(db, project.id, None, payload.changes,
                                         payload.source_type, payload.actor)
    if errors:
        raise HTTPException(422, detail={"field_errors": errors})
    audit.record(db, "assumption_changed", "Project", project.id,
                 actor_id=payload.actor, after=payload.changes)
    db.commit()
    eff = services.effective_assumptions(db, project.id, None)
    return {"assumptions": [{"key": k, **v} for k, v in sorted(eff.items())]}


@router.get("/projects/{project_id}/cost-items")
def list_cost_items(project_id: str, db: Session = Depends(get_db)):
    project_or_404(db, project_id)
    items = db.execute(select(CostItem).where(CostItem.project_id == project_id)
                       .order_by(CostItem.category, CostItem.name)).scalars().all()
    return [{"id": i.id, "name": i.name, "category": i.category, "behavior": i.behavior,
             "amount": str(i.amount), "effective_from": i.effective_from,
             "effective_to": i.effective_to, "notes": i.notes} for i in items]


@router.post("/projects/{project_id}/cost-items", status_code=201)
def add_cost_item(project_id: str, payload: CostItemIn, db: Session = Depends(get_db)):
    project_or_404(db, project_id)
    item = CostItem(project_id=project_id, **payload.model_dump())
    db.add(item)
    db.flush()
    audit.record(db, "cost_item_created", "CostItem", item.id, after=payload.model_dump())
    db.commit()
    return {"id": item.id}


@router.delete("/cost-items/{item_id}")
def delete_cost_item(item_id: str, db: Session = Depends(get_db)):
    item = db.get(CostItem, item_id)
    if not item:
        raise HTTPException(404, "Costo no encontrado")
    audit.record(db, "cost_item_deleted", "CostItem", item.id,
                 before={"name": item.name, "amount": str(item.amount)})
    db.delete(item)
    db.commit()
    return {"ok": True}
