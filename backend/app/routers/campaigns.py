"""Campañas de crecimiento y recompensas — fase 5, pantallas 31–37.

Los efectos numéricos de cada campaña viven como AssumptionSet con
scope_type="campaign" (versionados, append-only; jamás UPDATE). Las campañas
no se borran: se archivan (status="archived"). La vista previa de impacto
(pantallas 35–37) ejecuta el motor en memoria sobre el snapshot vigente con
campaigns.enabled forzado a "true", sin persistir run ni proyecciones — el
frontend nunca calcula resultados financieros.
"""
import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Project, Scenario, Campaign, AssumptionSet, FieldProvenance
from app.schemas import CampaignCreate, CampaignPatch
from app.engine.simulator import simulate
from app.engine.assumptions import as_bool
from app import services, audit

router = APIRouter()

# Transiciones de estado válidas (pantalla 33): draft→active→archived.
VALID_STATUS_TRANSITIONS = {("draft", "active"), ("active", "archived")}

# Series de la vista previa (pantallas 35-37) además de todas las camp.*.
PREVIEW_KEYS = (
    "points.emitted", "points.funnel.intents", "points.redeemed",
    "points.expired", "points.balance_end", "cost.campaigns",
    "tx.gmv", "rev.total", "pnl.ebitda",
)


def project_or_404(db: Session, project_id: str) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Proyecto no encontrado")
    return project


def campaign_or_404(db: Session, campaign_id: str) -> Campaign:
    campaign = db.get(Campaign, campaign_id)
    if not campaign:
        raise HTTPException(404, "Campaña no encontrada")
    return campaign


def serialize_campaign(c: Campaign, effects: dict | None = None) -> dict:
    data = {
        "id": c.id, "project_id": c.project_id, "name": c.name,
        "description": c.description, "campaign_type": c.campaign_type,
        "status": c.status, "start_month": c.start_month, "end_month": c.end_month,
        "created_by": c.created_by,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }
    if effects is not None:
        data["effects"] = effects  # {clave: {value, origin}}
    return data


def _validate_window(start_month: int, end_month: int):
    if not 1 <= start_month <= end_month:
        raise HTTPException(422, "Ventana inválida: se requiere 1 <= start_month <= end_month")


def _record_campaign_provenance(db: Session, campaign: Campaign):
    for field in ("name", "campaign_type", "start_month", "end_month"):
        db.add(FieldProvenance(
            entity_type="Campaign", entity_id=campaign.id, field_name=field,
            source_type="declarado", declared_by=campaign.created_by,
            locator="captura manual (pantalla 32)",
        ))


@router.get("/projects/{project_id}/campaigns")
def list_campaigns(project_id: str, db: Session = Depends(get_db)):
    project_or_404(db, project_id)
    campaigns = db.execute(
        select(Campaign).where(Campaign.project_id == project_id)
        .order_by(Campaign.created_at, Campaign.id)
    ).scalars().all()
    return [
        serialize_campaign(c, services.campaign_effects(db, project_id, None, c.id))
        for c in campaigns
    ]


@router.post("/projects/{project_id}/campaigns", status_code=201)
def create_campaign(project_id: str, payload: CampaignCreate, db: Session = Depends(get_db)):
    project_or_404(db, project_id)
    if not payload.name.strip():
        raise HTTPException(422, "El nombre de la campaña es obligatorio")
    _validate_window(payload.start_month, payload.end_month)

    campaign = Campaign(
        project_id=project_id, name=payload.name, description=payload.description,
        campaign_type=payload.campaign_type, status="draft",
        start_month=payload.start_month, end_month=payload.end_month,
        created_by=payload.actor,
    )
    db.add(campaign)
    db.flush()

    if payload.effects:
        errors = services.upsert_campaign_effects(db, project_id, campaign.id,
                                                  payload.effects, actor=payload.actor)
        if errors:
            raise HTTPException(422, detail={"field_errors": errors})

    _record_campaign_provenance(db, campaign)
    audit.record(db, "campaign.create", "Campaign", campaign.id, actor_id=payload.actor,
                 after={"name": campaign.name, "campaign_type": campaign.campaign_type,
                        "start_month": campaign.start_month, "end_month": campaign.end_month,
                        "effects": payload.effects})
    db.commit()
    return serialize_campaign(campaign, services.campaign_effects(db, project_id, None, campaign.id))


@router.get("/campaigns/{campaign_id}")
def get_campaign(campaign_id: str, db: Session = Depends(get_db)):
    campaign = campaign_or_404(db, campaign_id)
    effects = services.campaign_effects(db, campaign.project_id, None, campaign.id)
    rows = db.execute(
        select(AssumptionSet).where(
            AssumptionSet.project_id == campaign.project_id,
            AssumptionSet.scope_type == "campaign",
            AssumptionSet.scope_id == campaign.id,
        ).order_by(AssumptionSet.key, AssumptionSet.version)
    ).scalars().all()
    history = [{
        "key": r.key, "value": r.value, "unit": r.unit, "version": r.version,
        "source_type": r.source_type, "created_by": r.created_by,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    } for r in rows]
    return {**serialize_campaign(campaign, effects), "history": history}


@router.patch("/campaigns/{campaign_id}")
def patch_campaign(campaign_id: str, payload: CampaignPatch, db: Session = Depends(get_db)):
    campaign = campaign_or_404(db, campaign_id)
    changes = payload.model_dump(exclude_none=True)
    if "status" in changes and changes["status"] != campaign.status:
        if (campaign.status, changes["status"]) not in VALID_STATUS_TRANSITIONS:
            raise HTTPException(409, "Transición de estado inválida")
    _validate_window(changes.get("start_month", campaign.start_month),
                     changes.get("end_month", campaign.end_month))
    before = {field: getattr(campaign, field) for field in changes}
    for field, value in changes.items():
        setattr(campaign, field, value)
    audit.record(db, "campaign.update", "Campaign", campaign.id, before=before, after=changes)
    db.commit()
    return serialize_campaign(campaign,
                              services.campaign_effects(db, campaign.project_id, None, campaign.id))


@router.patch("/campaigns/{campaign_id}/effects")
def patch_campaign_effects(campaign_id: str, changes: dict[str, str],
                           db: Session = Depends(get_db)):
    campaign = campaign_or_404(db, campaign_id)
    errors = services.upsert_campaign_effects(db, campaign.project_id, campaign.id, changes)
    if errors:
        raise HTTPException(422, detail={"field_errors": errors})
    audit.record(db, "campaign.effects.update", "Campaign", campaign.id, after=changes)
    db.commit()
    effects = services.campaign_effects(db, campaign.project_id, None, campaign.id)
    return {"campaign": serialize_campaign(campaign), "effects": effects}


@router.get("/projects/{project_id}/scenarios/{scenario_id}/campaigns-preview")
def campaigns_preview(project_id: str, scenario_id: str, db: Session = Depends(get_db)):
    """Impacto de campañas calculado por el servidor (pantallas 35-37): simula en
    memoria el snapshot vigente con campaigns.enabled forzado, sin persistir nada."""
    scenario = db.get(Scenario, scenario_id)
    if not scenario or scenario.project_id != project_id:
        raise HTTPException(404, "Escenario no encontrado")

    snapshot = services.snapshot_for_scenario(db, scenario)
    forced = json.loads(json.dumps(snapshot))  # copia profunda: el original no se toca
    forced["assumptions"]["campaigns.enabled"] = "true"
    result = simulate(forced)  # en memoria: sin run, sin proyecciones

    metrics = {
        key: [None if v is None else str(v) for v in series]
        for key, series in result["metrics"].items()
        if key.startswith("camp.") or key in PREVIEW_KEYS
    }

    return {
        "months": result["months"],
        "metrics": metrics,
        "campaigns": snapshot["campaigns"],
        # valor REAL del escenario (el forzado solo vive en la copia en memoria)
        "campaigns_enabled": as_bool(snapshot["assumptions"].get("campaigns.enabled", "false")),
        "summary_campaigns": result["summary"]["campaigns"],
        "derived_inputs": result["summary"]["derived_inputs"],
        "input_hash": snapshot["input_hash"],
        "engine_version": result["summary"]["engine_version"],
    }
