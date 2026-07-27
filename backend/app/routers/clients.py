"""Clientes B2B, marcas, sucursales, catálogo y línea base — pantallas 07–16."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (Project, Client, Brand, Branch, ProductService,
                        ClientBaseline, FieldProvenance)
from app.schemas import ClientCreate, ClientPatch, BranchIn, CatalogItemIn, BaselineIn
from app.engine.money import D
from app import audit

router = APIRouter()


def client_or_404(db: Session, client_id: str) -> Client:
    client = db.get(Client, client_id)
    if not client:
        raise HTTPException(404, "Cliente no encontrado")
    return client


def serialize_branch(b: Branch) -> dict:
    return {"id": b.id, "brand_id": b.brand_id, "name": b.name, "location": b.location,
            "timezone": b.timezone, "monthly_capacity": b.monthly_capacity,
            "opening_date": b.opening_date, "status": b.status,
            "catalog_count": len(b.catalog_items)}


def serialize_item(i: ProductService) -> dict:
    price, cost = D(i.sale_price), D(i.direct_cost)
    margin = price - cost
    return {"id": i.id, "branch_id": i.branch_id, "type": i.type, "name": i.name,
            "sku": i.sku, "category": i.category, "sale_price": str(price),
            "direct_cost": str(cost), "margin": str(margin),
            "margin_pct": str((margin / price).quantize(D("0.0001"))) if price > 0 else None,
            "monthly_inventory": i.monthly_inventory, "monthly_capacity": i.monthly_capacity,
            "reward_eligible": i.reward_eligible, "status": i.status}


def serialize_client(c: Client, full: bool = False) -> dict:
    baseline = None
    if c.baseline:
        b = c.baseline
        baseline = {
            "avg_monthly_sales": str(b.avg_monthly_sales),
            "avg_monthly_transactions": str(b.avg_monthly_transactions),
            "avg_ticket": str(b.avg_ticket), "margin_pct": str(b.margin_pct),
            "registered_consumers": b.registered_consumers,
            "active_consumers": b.active_consumers, "monthly_buyers": b.monthly_buyers,
            "purchase_frequency": str(b.purchase_frequency),
            "source_type": b.source_type, "confidence": b.confidence,
        }
    data = {
        "id": c.id, "project_id": c.project_id, "legal_name": c.legal_name,
        "trade_name": c.trade_name, "industry": c.industry, "status": c.status,
        "currency": c.currency, "onboarding_date": c.onboarding_date,
        "contact_name": c.contact_name, "contact_email": c.contact_email,
        "contact_phone": c.contact_phone, "notes": c.notes,
        "brands_count": len(c.brands),
        "branches_count": sum(len(b.branches) for b in c.brands),
        "baseline": baseline,
    }
    if full:
        data["brands"] = [{
            "id": b.id, "name": b.name, "category": b.category, "status": b.status,
            "branches": [serialize_branch(br) for br in b.branches],
        } for b in c.brands]
        data["catalog"] = [serialize_item(i) for b in c.brands for br in b.branches
                           for i in br.catalog_items]
    return data


def _record_baseline_provenance(db: Session, client: Client, payload: BaselineIn):
    for field in ("avg_monthly_sales", "avg_monthly_transactions", "avg_ticket",
                  "margin_pct", "active_consumers", "monthly_buyers"):
        db.add(FieldProvenance(
            entity_type="ClientBaseline", entity_id=client.id, field_name=field,
            source_type=payload.source_type, declared_by=client.contact_name or "usuario",
            confidence=payload.confidence, locator="captura manual (pantalla 11)",
        ))


@router.post("/clients", status_code=201)
def create_client(payload: ClientCreate, db: Session = Depends(get_db)):
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "Proyecto no encontrado")
    if not payload.trade_name.strip() or not payload.legal_name.strip():
        raise HTTPException(422, "Nombre comercial y legal son obligatorios")

    duplicate = db.execute(select(Client).where(
        Client.project_id == payload.project_id,
        Client.trade_name == payload.trade_name, Client.status != "archived",
    )).scalars().first()

    client = Client(
        project_id=payload.project_id, legal_name=payload.legal_name,
        trade_name=payload.trade_name, industry=payload.industry,
        currency=payload.currency, onboarding_date=payload.onboarding_date,
        contact_name=payload.contact_name, contact_email=payload.contact_email,
        contact_phone=payload.contact_phone, notes=payload.notes,
        status="draft",
    )
    db.add(client)
    db.flush()

    brand = Brand(client_id=client.id, name=payload.brand_name or payload.trade_name)
    db.add(brand)
    db.flush()

    for br in payload.branches:
        db.add(Branch(brand_id=brand.id, **br.model_dump()))
    db.flush()

    branches = db.execute(select(Branch).where(Branch.brand_id == brand.id)).scalars().all()
    default_branch = branches[0] if branches else None
    for item in payload.catalog_items:
        if D(item.sale_price) <= 0:
            raise HTTPException(422, f"Precio inválido en artículo '{item.name}'")
        if D(item.direct_cost) < 0:
            raise HTTPException(422, f"Costo inválido en artículo '{item.name}'")
        branch_id = item.branch_id or (default_branch.id if default_branch else None)
        if not branch_id:
            raise HTTPException(422, "Los artículos requieren una sucursal")
        db.add(ProductService(branch_id=branch_id,
                              **item.model_dump(exclude={"branch_id"})))

    if payload.baseline:
        db.add(ClientBaseline(client_id=client.id, **payload.baseline.model_dump()))
        _record_baseline_provenance(db, client, payload.baseline)

    if payload.activate:
        _validate_activation(client, payload)
        client.status = "active"

    audit.record(db, "client_created", "Client", client.id,
                 after={"trade_name": client.trade_name, "status": client.status})
    db.commit()
    result = serialize_client(client, full=True)
    if duplicate:
        result["warning"] = f"Ya existe un cliente con nombre '{payload.trade_name}' en este proyecto"
    return result


def _validate_activation(client: Client, payload: ClientCreate | None = None):
    """Pantalla 12: bloquear si no hay sucursal, catálogo o línea base mínima."""
    has_branch = any(b.branches for b in client.brands) or (payload and payload.branches)
    has_catalog = any(br.catalog_items for b in client.brands for br in b.branches) \
        or (payload and payload.catalog_items)
    has_baseline = client.baseline is not None or (payload and payload.baseline)
    missing = []
    if not has_branch:
        missing.append("al menos una sucursal")
    if not has_catalog:
        missing.append("catálogo de productos/servicios")
    if not has_baseline:
        missing.append("línea base financiera")
    if missing:
        raise HTTPException(422, f"No se puede activar el cliente: falta {', '.join(missing)}")


@router.get("/projects/{project_id}/clients")
def list_clients(project_id: str, status: str | None = None, industry: str | None = None,
                 q: str | None = None, db: Session = Depends(get_db)):
    clients = db.execute(select(Client).where(Client.project_id == project_id,
                                              Client.status != "archived")
                         .order_by(Client.created_at.desc())).scalars().all()
    if status:
        clients = [c for c in clients if c.status == status]
    if industry:
        clients = [c for c in clients if c.industry == industry]
    if q:
        needle = q.lower()
        clients = [c for c in clients if needle in c.trade_name.lower() or needle in c.legal_name.lower()]
    rows = [serialize_client(c) for c in clients]
    total_gmv = sum(D(r["baseline"]["avg_monthly_sales"]) for r in rows if r["baseline"])
    total_consumers = sum(r["baseline"]["active_consumers"] for r in rows if r["baseline"])
    return {"clients": rows, "kpis": {
        "count": len(rows),
        "active": len([r for r in rows if r["status"] == "active"]),
        "gmv_base_monthly": str(total_gmv),
        "active_consumers": total_consumers,
    }}


@router.get("/clients/{client_id}")
def get_client(client_id: str, db: Session = Depends(get_db)):
    return serialize_client(client_or_404(db, client_id), full=True)


@router.patch("/clients/{client_id}")
def patch_client(client_id: str, payload: ClientPatch, db: Session = Depends(get_db)):
    client = client_or_404(db, client_id)
    changes = payload.model_dump(exclude_none=True)
    if changes.get("status") == "active":
        _validate_activation(client)
    before = {k: getattr(client, k) for k in changes}
    for field, value in changes.items():
        setattr(client, field, value)
    audit.record(db, "client_updated", "Client", client.id, before=before, after=changes)
    db.commit()
    return serialize_client(client, full=True)


@router.post("/clients/{client_id}/branches", status_code=201)
def add_branch(client_id: str, payload: BranchIn, db: Session = Depends(get_db)):
    client = client_or_404(db, client_id)
    if not client.brands:
        raise HTTPException(422, "El cliente no tiene marca")
    branch = Branch(brand_id=client.brands[0].id, **payload.model_dump())
    db.add(branch)
    db.flush()
    audit.record(db, "branch_added", "Branch", branch.id, after=payload.model_dump())
    db.commit()
    return serialize_branch(branch)


@router.post("/clients/{client_id}/catalog/items", status_code=201)
def add_catalog_item(client_id: str, payload: CatalogItemIn, db: Session = Depends(get_db)):
    client = client_or_404(db, client_id)
    if D(payload.sale_price) <= 0:
        raise HTTPException(422, "El precio debe ser mayor a 0")
    if D(payload.direct_cost) < 0:
        raise HTTPException(422, "El costo no puede ser negativo")
    branch_id = payload.branch_id
    if not branch_id:
        branches = [br for b in client.brands for br in b.branches]
        if not branches:
            raise HTTPException(422, "El cliente no tiene sucursales")
        branch_id = branches[0].id
    item = ProductService(branch_id=branch_id, **payload.model_dump(exclude={"branch_id"}))
    db.add(item)
    db.flush()
    audit.record(db, "catalog_item_created", "ProductService", item.id,
                 after={"name": payload.name, "price": payload.sale_price})
    db.commit()
    return serialize_item(item)


@router.post("/clients/{client_id}/baseline")
def upsert_baseline(client_id: str, payload: BaselineIn, db: Session = Depends(get_db)):
    client = client_or_404(db, client_id)
    if payload.active_consumers > payload.registered_consumers > 0:
        raise HTTPException(422, "Los consumidores activos no pueden superar a los registrados")
    if payload.monthly_buyers > payload.active_consumers > 0:
        raise HTTPException(422, "Los compradores no pueden superar a los consumidores activos")
    before = None
    if client.baseline:
        before = {"avg_monthly_sales": str(client.baseline.avg_monthly_sales)}
        for field, value in payload.model_dump().items():
            setattr(client.baseline, field, value)
    else:
        db.add(ClientBaseline(client_id=client.id, **payload.model_dump()))
    _record_baseline_provenance(db, client, payload)
    audit.record(db, "baseline_updated", "ClientBaseline", client.id,
                 before=before, after={"avg_monthly_sales": payload.avg_monthly_sales})
    db.commit()
    return {"ok": True}
