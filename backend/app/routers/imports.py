"""Importación asistida — fase 8, pantallas IA-01…IA-07 (sección 8 del documento).

    IA-01  cargar documentos (dropzone, destino, consentimiento)
           POST /projects/{project_id}/imports
    IA-02  procesamiento y extracción (progreso y logs por archivo)
           POST /imports/{id}/analyze
    IA-03  mapeo fuente→destino con ejemplo, tipo, confianza y acción
    IA-04  faltantes e inconsistencias (duplicados, monedas mezcladas, márgenes)
    IA-05  revisión de propuestas e hipótesis (aceptar / editar / ignorar)
           GET /imports/{id} y PATCH /import-proposals/{id}
    IA-06  confirmar: resumen de entidades y conflictos
           POST /imports/{id}/commit
    IA-07  historial de fuentes (hash, campos afectados, estado)
           GET /projects/{project_id}/imports  ·  POST /imports/{id}/cancel

Regla 1.2 y sección 8: **la IA propone y explica; el usuario confirma antes de
persistir**. El análisis NO escribe una sola fila en las entidades del proyecto:
solo crea `ImportProposal` en estado "propuesta". Únicamente el commit —una sola
transacción, todo o nada— escribe Client, Brand, Branch, ProductService,
ClientBaseline y CostItem, y deja un `FieldProvenance` por cada campo escrito.

Bandas de confianza (8.2): alta ≥ 0.90 (preseleccionable en la UI, nunca
auto-confirmada), media ≥ 0.70 (revisión explícita), baja < 0.70 (no se mapea
por defecto: hipótesis o pendiente). Ninguna propuesta nace aceptada, sea cual
sea su banda; las de banda baja además nacen con una nota que lo advierte.

Los bytes originales se guardan en `import_files/{job_id}/{source_file_id}.{kind}`
—carpeta hermana de `exports_files`— para poder reanalizar y auditar el origen.
"""
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (Project, Client, Brand, Branch, ProductService,
                        ClientBaseline, CostItem, FieldProvenance,
                        ImportJob, SourceFile, ImportProposal, utcnow)
from app.schemas import ImportProposalPatch, ImportActionIn
from app.imports.pipeline import (SUPPORTED, confidence_band, kind_of, normalize,
                                  parse_file, propose_from_parsed, sha256_of, summarize)
from app.engine.money import D, ZERO
from app import audit

router = APIRouter()

# Carpeta hermana de exports_files (mismo criterio que app/exports/excel.py).
IMPORT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "import_files")

MAX_FILE_BYTES = 10 * 1024 * 1024          # 10 MB por archivo (IA-01)
MAX_FILES_PER_JOB = 20

VALID_TARGETS = ("auto", "clients", "catalog", "baseline", "costs")
VALID_SOURCE_TYPES = ("real", "declarado", "estimado", "hipotesis", "meta")  # 7.1
REVIEW_STATUSES = ("aceptada", "editada", "ignorada")
WRITABLE_STATUSES = ("aceptada", "editada")

# Orden de escritura del commit: primero los contenedores, luego lo que cuelga.
COMMIT_ORDER = ("Client", "Branch", "ProductService", "ClientBaseline", "CostItem")

VALID_COST_BEHAVIORS = ("fixed", "per_active_client", "per_transaction", "pct_gmv",
                        "tiered_per_active_client", "tiered_per_transaction",
                        "tiered_pct_gmv")
COST_BEHAVIOR_ALIASES = {
    "fijo": "fixed", "fija": "fixed", "mensual": "fixed", "fixed": "fixed",
    "por cliente": "per_active_client", "por cliente activo": "per_active_client",
    "por transaccion": "per_transaction", "por transaccion procesada": "per_transaction",
    "porcentaje": "pct_gmv", "porcentaje de gmv": "pct_gmv", "variable": "pct_gmv",
}

LOW_CONF_NOTE = ("Confianza baja (<0.70): no se mapea por defecto; requiere "
                 "revisión explícita o registrarse como hipótesis (8.2)")

TRUE_TOKENS = ("true", "1", "si", "sí", "yes", "x", "verdadero")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def project_or_404(db: Session, project_id: str) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Proyecto no encontrado")
    return project


def job_or_404(db: Session, job_id: str) -> ImportJob:
    job = db.get(ImportJob, job_id)
    if not job:
        raise HTTPException(404, "Importación no encontrada")
    return job


def stored_path(job_id: str, source_file: SourceFile) -> str:
    """Ruta determinista del archivo original (SourceFile no guarda la ruta)."""
    return os.path.join(IMPORT_DIR, job_id, f"{source_file.id}.{source_file.kind}")


def conf_pct(confidence) -> int:
    """Confianza 0–1 de una propuesta → entero 0–100 de FieldProvenance."""
    value = int((D(confidence) * D("100")).to_integral_value())
    return max(0, min(100, value))


def branches_of(client: Client) -> list:
    return [br for brand in client.brands for br in brand.branches]


# ---------------------------------------------------------------------------
# Serializadores (manuales, montos como string)
# ---------------------------------------------------------------------------

def serialize_file(f: SourceFile) -> dict:
    return {"id": f.id, "filename": f.filename, "kind": f.kind,
            "content_type": f.content_type, "size_bytes": f.size_bytes,
            "sha256": f.sha256, "status": f.status, "error": f.error,
            "parse_summary": f.parse_summary,
            "created_at": f.created_at.isoformat() if f.created_at else None}


def serialize_proposal(p: ImportProposal) -> dict:
    return {"id": p.id, "import_job_id": p.import_job_id,
            "source_file_id": p.source_file_id, "entity_type": p.entity_type,
            "entity_ref": p.entity_ref, "field_name": p.field_name,
            "locator": p.locator, "raw_value": p.raw_value,
            "proposed_value": p.proposed_value, "unit": p.unit,
            "confidence": str(D(p.confidence)), "band": confidence_band(p.confidence),
            "source_type": p.source_type, "status": p.status,
            "conflict_value": p.conflict_value, "notes": p.notes}


def serialize_job(job: ImportJob) -> dict:
    return {"id": job.id, "project_id": job.project_id, "client_id": job.client_id,
            "target": job.target, "status": job.status, "file_count": job.file_count,
            "confidence": str(D(job.confidence)),
            "band": confidence_band(job.confidence),
            "allow_inference": job.allow_inference,
            "result_summary": job.result_summary, "error": job.error,
            "created_by": job.created_by,
            "created_at": job.created_at.isoformat() if job.created_at else None,
            "analyzed_at": job.analyzed_at.isoformat() if job.analyzed_at else None,
            "committed_at": job.committed_at.isoformat() if job.committed_at else None}


# ---------------------------------------------------------------------------
# IA-01 · carga de documentos
# ---------------------------------------------------------------------------

@router.post("/projects/{project_id}/imports", status_code=201)
def create_import(project_id: str,
                  files: list[UploadFile] = File(...),
                  target: str = Form("auto"),
                  client_id: str | None = Form(None),
                  allow_inference: bool = Form(False),
                  actor: str = Form("usuario"),
                  db: Session = Depends(get_db)):
    """IA-01: sube uno o más documentos y abre el job en estado 'borrador'.

    Se validan extensión y tamaño ANTES de tocar la base de datos; el job nace
    sin propuestas: la extracción ocurre en /analyze y la escritura en /commit.
    """
    project = project_or_404(db, project_id)
    if target not in VALID_TARGETS:
        raise HTTPException(422, f"Destino inválido: '{target}' "
                                 f"(usar {', '.join(VALID_TARGETS)})")

    client = None
    client_id = (client_id or "").strip() or None
    if client_id:
        client = db.get(Client, client_id)
        if not client:
            raise HTTPException(404, "Cliente destino no encontrado")
        if client.project_id != project.id:
            raise HTTPException(422, "El cliente destino pertenece a otro proyecto")

    incoming = [f for f in (files or []) if f.filename]
    if not incoming:
        raise HTTPException(422, "Se requiere al menos un archivo para importar")
    if len(incoming) > MAX_FILES_PER_JOB:
        raise HTTPException(422, f"Máximo {MAX_FILES_PER_JOB} archivos por importación")

    payloads = []
    for upload in incoming:
        name = os.path.basename(upload.filename)
        kind = kind_of(name)
        if not kind:
            raise HTTPException(422, f"Extensión no soportada: {name} "
                                     f"(usar {', '.join(s.upper() for s in SUPPORTED)})")
        data = upload.file.read()
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(422, f"El archivo {name} supera el límite de 10 MB")
        if not data:
            raise HTTPException(422, f"El archivo {name} está vacío")
        payloads.append((name, kind, upload.content_type or "", data))

    job = ImportJob(project_id=project.id, client_id=client_id, target=target,
                    status="borrador", file_count=len(payloads), confidence="0",
                    allow_inference=bool(allow_inference), created_by=actor)
    db.add(job)
    db.flush()

    created = []
    for name, kind, content_type, data in payloads:
        source = SourceFile(import_job_id=job.id, filename=name, kind=kind,
                            content_type=content_type, size_bytes=len(data),
                            sha256=sha256_of(data), status="cargado")
        db.add(source)
        db.flush()
        path = stored_path(job.id, source)
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as fh:
                fh.write(data)
        except OSError as exc:
            db.rollback()
            raise HTTPException(500, f"No se pudo guardar el archivo {name}: {exc}")
        created.append(source)

    audit.record(db, "import_started", "ImportJob", job.id, actor_id=actor,
                 after={"project_id": project.id, "client_id": client_id,
                        "target": target, "allow_inference": bool(allow_inference),
                        "files": [f.filename for f in created]})
    db.commit()
    return {"job": serialize_job(job), "files": [serialize_file(f) for f in created]}


# ---------------------------------------------------------------------------
# IA-02/03/04 · análisis y propuestas
# ---------------------------------------------------------------------------

def _existing_index(db: Session, project_id: str) -> tuple[dict, dict]:
    """Índice de entidades vigentes del proyecto para detectar conflictos (8.2)."""
    clients = db.execute(select(Client).where(
        Client.project_id == project_id, Client.status != "archived")).scalars().all()
    by_trade_name = {normalize(c.trade_name): c for c in clients if c.trade_name}
    catalog: dict[tuple[str, str], ProductService] = {}
    for client in clients:
        for brand in client.brands:
            for branch in brand.branches:
                for item in branch.catalog_items:
                    if item.status == "archived":
                        continue
                    catalog.setdefault(("name", normalize(item.name)), item)
                    if item.sku:
                        catalog.setdefault(("sku", normalize(item.sku)), item)
    return by_trade_name, catalog


def _find_conflict(entity_type: str, entity_ref: str, values: dict,
                   clients_index: dict, catalog_index: dict):
    """Entidad vigente que colisiona con el grupo propuesto, o None."""
    if entity_type == "ProductService":
        sku = values.get("sku")
        if sku and ("sku", normalize(sku)) in catalog_index:
            return catalog_index[("sku", normalize(sku))]
        name = values.get("name") or entity_ref
        return catalog_index.get(("name", normalize(name)))
    if entity_type == "Client":
        name = values.get("trade_name") or entity_ref
        return clients_index.get(normalize(name))
    return None


def _current_value(existing, field_name: str):
    """Valor vigente de un campo de la entidad en conflicto (para mostrar ambas fuentes)."""
    if existing is None or not hasattr(existing, field_name):
        return None
    value = getattr(existing, field_name)
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


@router.post("/imports/{job_id}/analyze")
def analyze_import(job_id: str, payload: ImportActionIn | None = None,
                   db: Session = Depends(get_db)):
    """IA-02 a IA-04: parsea cada archivo, propone mapeos con confianza y marca
    conflictos. No escribe nada en las entidades del proyecto: solo propuestas."""
    job = job_or_404(db, job_id)
    actor = payload.actor if payload else job.created_by or "usuario"
    if job.status not in ("borrador", "revision"):
        raise HTTPException(409, f"No se puede analizar una importación en estado "
                                 f"'{job.status}' (solo 'borrador' o 'revision')")

    files = db.execute(select(SourceFile).where(SourceFile.import_job_id == job.id)
                       .order_by(SourceFile.created_at)).scalars().all()
    if not files:
        raise HTTPException(422, "La importación no tiene archivos que analizar")

    # Reanálisis: las propuestas anteriores se reemplazan por completo.
    db.execute(delete(ImportProposal).where(ImportProposal.import_job_id == job.id))

    clients_index, catalog_index = _existing_index(db, job.project_id)
    all_proposals, all_issues, all_tables = [], [], []
    conflicts = 0
    low_confidence = 0

    for source in files:
        path = stored_path(job.id, source)
        if not os.path.exists(path):
            source.status = "error"
            source.error = "El archivo original ya no está disponible en el servidor"
            continue
        with open(path, "rb") as fh:
            data = fh.read()
        parsed = parse_file(source.filename, data)
        if parsed.get("error"):
            source.status = "no_soportado" if not kind_of(source.filename) else "error"
            source.error = parsed["error"]
            source.parse_summary = {"tables": [], "text_blocks": 0, "proposals": 0}
            continue

        out = propose_from_parsed(parsed, target=job.target)
        source.status = "parseado"
        source.error = None
        source.parse_summary = {"tables": out["tables"], "text_blocks": out["text_blocks"],
                                "proposals": len(out["proposals"]),
                                "issues": len(out["issues"])}
        for table in out["tables"]:
            all_tables.append({"file": source.filename, **table})
        for issue in out["issues"]:
            all_issues.append({"file": source.filename, **issue})
        all_proposals.extend(out["proposals"])

        # Agrupar por entidad para decidir conflictos con una sola vista del grupo.
        groups: dict[tuple[str, str], list] = {}
        for proposal in out["proposals"]:
            groups.setdefault((proposal["entity_type"], proposal["entity_ref"]), []).append(proposal)

        for (entity_type, entity_ref), rows in groups.items():
            values = {r["field_name"]: r["proposed_value"] for r in rows}
            existing = _find_conflict(entity_type, entity_ref, values,
                                      clients_index, catalog_index)
            for row in rows:
                notes = [row["notes"]] if row["notes"] else []
                status = "propuesta"
                conflict_value = None
                if D(row["confidence"]) < D("0.70"):
                    low_confidence += 1
                    notes.append(LOW_CONF_NOTE)
                if existing is not None:
                    status = "conflicto"
                    conflicts += 1
                    conflict_value = _current_value(existing, row["field_name"])
                    notes.append(f"Conflicto: ya existe «{entity_ref}» en el proyecto"
                                 + (f" con valor vigente '{conflict_value}'"
                                    if conflict_value is not None else ""))
                db.add(ImportProposal(
                    import_job_id=job.id, source_file_id=source.id,
                    entity_type=entity_type, entity_ref=entity_ref,
                    field_name=row["field_name"], locator=row["locator"],
                    raw_value=row["raw_value"], proposed_value=row["proposed_value"],
                    unit=row["unit"], confidence=row["confidence"],
                    source_type=row["source_type"], status=status,
                    conflict_value=conflict_value, notes=" · ".join(notes),
                ))

    summary = summarize(all_proposals, all_issues)
    summary.update({
        "issues_detail": all_issues,
        "tables": all_tables,
        "conflicts": conflicts,
        "low_confidence": low_confidence,
        "files": [{"id": f.id, "filename": f.filename, "status": f.status,
                   "error": f.error} for f in files],
        "note": ("Ninguna propuesta se aplica sin confirmación humana; las de banda "
                 "baja (<0.70) no se mapean por defecto (8.2)"),
    })

    job.status = "revision"
    job.file_count = len(files)
    job.confidence = summary["confidence"]
    job.result_summary = summary
    job.analyzed_at = datetime.now(timezone.utc)
    job.error = None
    audit.record(db, "import_analyzed", "ImportJob", job.id, actor_id=actor,
                 after={"proposals": summary["proposals"], "by_band": summary["by_band"],
                        "conflicts": conflicts, "issues": summary["issues"],
                        "confidence": summary["confidence"]})
    db.commit()
    return {"job": serialize_job(job), "files": [serialize_file(f) for f in files],
            "summary": summary}


# ---------------------------------------------------------------------------
# IA-03/04/05 · pantalla de revisión
# ---------------------------------------------------------------------------

@router.get("/imports/{job_id}")
def get_import(job_id: str, db: Session = Depends(get_db)):
    """IA-03/04/05: job, archivos y propuestas agrupadas por entidad, cada campo
    con su banda de confianza, su origen y el valor vigente si hay conflicto."""
    job = job_or_404(db, job_id)
    files = db.execute(select(SourceFile).where(SourceFile.import_job_id == job.id)
                       .order_by(SourceFile.created_at)).scalars().all()
    proposals = db.execute(select(ImportProposal)
                           .where(ImportProposal.import_job_id == job.id)
                           .order_by(ImportProposal.entity_type, ImportProposal.entity_ref,
                                     ImportProposal.created_at)).scalars().all()

    groups: dict[tuple[str, str], list] = {}
    for proposal in proposals:
        groups.setdefault((proposal.entity_type, proposal.entity_ref), []).append(proposal)

    by_status: dict[str, int] = {}
    by_band = {"alta": 0, "media": 0, "baja": 0}
    for proposal in proposals:
        by_status[proposal.status] = by_status.get(proposal.status, 0) + 1
        by_band[confidence_band(proposal.confidence)] += 1

    entities = []
    for (entity_type, entity_ref), rows in groups.items():
        worst = min((D(r.confidence) for r in rows), default=ZERO)
        entities.append({
            "entity_type": entity_type,
            "entity_ref": entity_ref,
            "confidence": str(worst),
            "band": confidence_band(worst),
            "has_conflict": any(r.status == "conflicto" for r in rows),
            "writable": any(r.status in WRITABLE_STATUSES for r in rows),
            "fields": [serialize_proposal(r) for r in rows],
        })
    entities.sort(key=lambda e: (COMMIT_ORDER.index(e["entity_type"])
                                 if e["entity_type"] in COMMIT_ORDER else 99,
                                 e["entity_ref"]))

    summary = job.result_summary or {}
    return {
        "job": serialize_job(job),
        "files": [serialize_file(f) for f in files],
        "entities": entities,
        "totals": {"proposals": len(proposals), "entities": len(entities),
                   "by_status": by_status, "by_band": by_band,
                   "conflicts": by_status.get("conflicto", 0)},
        "issues": summary.get("issues_detail", []),
        "tables": summary.get("tables", []),
        "summary": summary,
    }


@router.patch("/import-proposals/{proposal_id}")
def patch_proposal(proposal_id: str, payload: ImportProposalPatch,
                   db: Session = Depends(get_db)):
    """IA-05: aceptar, editar o ignorar una propuesta. Editar el valor la deja en
    'editada'; el cambio queda auditado antes/después."""
    proposal = db.get(ImportProposal, proposal_id)
    if not proposal:
        raise HTTPException(404, "Propuesta no encontrada")
    job = db.get(ImportJob, proposal.import_job_id)
    if job and job.status == "commiteado":
        raise HTTPException(409, "La importación ya fue confirmada; sus propuestas "
                                 "no se pueden modificar")

    changes = payload.model_dump(exclude_none=True)
    changes.pop("actor", None)
    if not changes:
        raise HTTPException(422, "No hay cambios que aplicar")
    if "status" in changes and changes["status"] not in REVIEW_STATUSES:
        raise HTTPException(422, f"Estado inválido: '{changes['status']}' "
                                 f"(usar {', '.join(REVIEW_STATUSES)})")
    if "source_type" in changes and changes["source_type"] not in VALID_SOURCE_TYPES:
        raise HTTPException(422, f"Origen inválido: '{changes['source_type']}' "
                                 f"(usar {', '.join(VALID_SOURCE_TYPES)})")
    if "proposed_value" in changes:
        changes["status"] = "editada"   # editar el valor implica edición humana

    before = {field: getattr(proposal, field) for field in changes}
    for field, value in changes.items():
        setattr(proposal, field, value)
    proposal.updated_at = utcnow()
    audit.record(db, "import_proposal.update", "ImportProposal", proposal.id,
                 actor_id=payload.actor, before=before, after=changes)
    db.commit()
    return serialize_proposal(proposal)


# ---------------------------------------------------------------------------
# IA-06 · commit transaccional
# ---------------------------------------------------------------------------

def _value(fields: dict, name: str):
    proposal = fields.get(name)
    if proposal is None:
        return None
    value = (proposal.proposed_value or "").strip()
    return value or None


def _money(fields: dict, name: str, ref: str) -> str:
    raw = _value(fields, name)
    try:
        return str(D(raw))
    except Exception:
        raise HTTPException(422, f"Valor no numérico en «{ref}» → {name}: '{raw}'")


def _integer(fields: dict, name: str, ref: str) -> int:
    raw = _value(fields, name)
    try:
        return int(D(raw))
    except Exception:
        raise HTTPException(422, f"Valor no entero en «{ref}» → {name}: '{raw}'")


def _boolean(fields: dict, name: str) -> bool:
    raw = (_value(fields, name) or "").lower()
    return raw in TRUE_TOKENS


def _provenance(db: Session, entity_type: str, entity_id: str,
                written: list, actor: str):
    """Un FieldProvenance por campo escrito (sección 7): archivo, celda y confianza."""
    for field_name, proposal in written:
        db.add(FieldProvenance(
            entity_type=entity_type, entity_id=entity_id, field_name=field_name,
            source_type=proposal.source_type, source_file_id=proposal.source_file_id,
            locator=proposal.locator or "", declared_by=actor,
            confidence=conf_pct(proposal.confidence),
        ))


def _target_client(db: Session, job: ImportJob, entity_label: str) -> Client:
    if not job.client_id:
        raise HTTPException(422, f"La importación de {entity_label} requiere un cliente "
                                 f"destino: vuelve a crear el job con client_id")
    client = db.get(Client, job.client_id)
    if not client:
        raise HTTPException(422, "El cliente destino de la importación ya no existe")
    return client


def _write_client(db: Session, job: ImportJob, ref: str, fields: dict, actor: str) -> str:
    name = _value(fields, "trade_name") or ref
    if not name:
        raise HTTPException(422, "Falta el nombre comercial para crear el cliente")
    client = Client(project_id=job.project_id, trade_name=name,
                    legal_name=_value(fields, "legal_name") or name, status="draft")
    written = [(field, fields[field]) for field in ("trade_name", "legal_name")
               if field in fields]
    for field in ("industry", "currency", "contact_name", "contact_email", "contact_phone"):
        if field in fields and _value(fields, field):
            setattr(client, field, _value(fields, field))
            written.append((field, fields[field]))
    db.add(client)
    db.flush()
    _provenance(db, "Client", client.id, written, actor)
    audit.record(db, "client_created", "Client", client.id, actor_id=actor,
                 after={"trade_name": client.trade_name, "status": client.status,
                        "import_job_id": job.id})
    return client.id


def _write_branch(db: Session, job: ImportJob, ref: str, fields: dict, actor: str) -> str:
    client = _target_client(db, job, "sucursales")
    name = _value(fields, "name") or ref
    if not name:
        raise HTTPException(422, "Falta el nombre de la sucursal")
    if client.brands:
        brand = client.brands[0]
    else:
        brand = Brand(client_id=client.id, name=client.trade_name)
        db.add(brand)
        db.flush()
    branch = Branch(brand_id=brand.id, name=name)
    written = [("name", fields["name"])] if "name" in fields else []
    for field in ("location", "timezone"):
        if field in fields and _value(fields, field):
            setattr(branch, field, _value(fields, field))
            written.append((field, fields[field]))
    if "monthly_capacity" in fields:
        branch.monthly_capacity = _integer(fields, "monthly_capacity", ref)
        written.append(("monthly_capacity", fields["monthly_capacity"]))
    db.add(branch)
    db.flush()
    _provenance(db, "Branch", branch.id, written, actor)
    audit.record(db, "branch_added", "Branch", branch.id, actor_id=actor,
                 after={"name": branch.name, "client_id": client.id,
                        "import_job_id": job.id})
    return branch.id


def _write_product(db: Session, job: ImportJob, ref: str, fields: dict,
                   actor: str, branch_id: str) -> str:
    name = _value(fields, "name") or ref
    if not name:
        raise HTTPException(422, "Falta el nombre del producto o servicio")
    if _value(fields, "sale_price") is None:
        raise HTTPException(422, f"El artículo «{name}» requiere precio de venta "
                                 f"para poder confirmarse")
    item = ProductService(branch_id=branch_id, name=name,
                          sale_price=_money(fields, "sale_price", name),
                          direct_cost="0")
    written = [("name", fields["name"])] if "name" in fields else []
    written.append(("sale_price", fields["sale_price"]))
    if "direct_cost" in fields:
        item.direct_cost = _money(fields, "direct_cost", name)
        written.append(("direct_cost", fields["direct_cost"]))
    if D(item.direct_cost) > D(item.sale_price):
        raise HTTPException(422, f"El costo directo de «{name}» supera a su precio "
                                 f"de venta; corrige la propuesta antes de confirmar")
    for field in ("sku", "category"):
        if field in fields and _value(fields, field):
            setattr(item, field, _value(fields, field))
            written.append((field, fields[field]))
    for field in ("monthly_inventory", "monthly_capacity"):
        if field in fields:
            setattr(item, field, _integer(fields, field, name))
            written.append((field, fields[field]))
    if "reward_eligible" in fields:
        item.reward_eligible = _boolean(fields, "reward_eligible")
        written.append(("reward_eligible", fields["reward_eligible"]))
    db.add(item)
    db.flush()
    _provenance(db, "ProductService", item.id, written, actor)
    audit.record(db, "catalog_item_created", "ProductService", item.id, actor_id=actor,
                 after={"name": item.name, "sale_price": str(item.sale_price),
                       "branch_id": branch_id, "import_job_id": job.id})
    return item.id


BASELINE_MONEY = ("avg_monthly_sales", "avg_monthly_transactions", "avg_ticket",
                  "margin_pct", "purchase_frequency")
BASELINE_INT = ("registered_consumers", "active_consumers", "monthly_buyers")


def _write_baseline(db: Session, job: ImportJob, ref: str, fields: dict,
                    actor: str) -> tuple[str, bool]:
    """La línea base es 1-1 con el cliente: se crea o se actualiza campo a campo."""
    client = _target_client(db, job, "líneas base")
    baseline = client.baseline
    created = baseline is None
    if created:
        baseline = ClientBaseline(client_id=client.id)
        db.add(baseline)
        db.flush()
    before, after, written = {}, {}, []
    for field in BASELINE_MONEY:
        if field in fields:
            before[field] = str(getattr(baseline, field) or "")
            setattr(baseline, field, _money(fields, field, ref))
            after[field] = str(getattr(baseline, field))
            written.append((field, fields[field]))
    for field in BASELINE_INT:
        if field in fields:
            before[field] = getattr(baseline, field)
            setattr(baseline, field, _integer(fields, field, ref))
            after[field] = getattr(baseline, field)
            written.append((field, fields[field]))
    if not written:
        raise HTTPException(422, "La línea base propuesta no tiene campos que escribir")
    confidences = [D(p.confidence) for _f, p in written]
    baseline.source_type = written[0][1].source_type
    baseline.confidence = conf_pct(sum(confidences, ZERO) / D(len(confidences)))
    baseline.updated_at = utcnow()
    _provenance(db, "ClientBaseline", client.id, written, actor)
    audit.record(db, "baseline_updated", "ClientBaseline", client.id, actor_id=actor,
                 before=None if created else before,
                 after={**after, "import_job_id": job.id})
    return client.id, created


def _write_cost(db: Session, job: ImportJob, ref: str, fields: dict, actor: str) -> str:
    name = _value(fields, "name") or ref
    if not name:
        raise HTTPException(422, "Falta el nombre del costo")
    if _value(fields, "amount") is None:
        raise HTTPException(422, f"El costo «{name}» requiere un monto para confirmarse")
    item = CostItem(project_id=job.project_id, name=name,
                    amount=_money(fields, "amount", name), behavior="fixed")
    written = [("name", fields["name"])] if "name" in fields else []
    written.append(("amount", fields["amount"]))
    if "category" in fields and _value(fields, "category"):
        item.category = _value(fields, "category")
        written.append(("category", fields["category"]))
    if "behavior" in fields and _value(fields, "behavior"):
        raw = _value(fields, "behavior")
        behavior = raw if raw in VALID_COST_BEHAVIORS else \
            COST_BEHAVIOR_ALIASES.get(normalize(raw), "fixed")
        item.behavior = behavior
        written.append(("behavior", fields["behavior"]))
    for field in ("effective_from", "effective_to"):
        if field in fields:
            setattr(item, field, _integer(fields, field, name))
            written.append((field, fields[field]))
    db.add(item)
    db.flush()
    _provenance(db, "CostItem", item.id, written, actor)
    audit.record(db, "cost_item_created", "CostItem", item.id, actor_id=actor,
                 after={"name": item.name, "amount": str(item.amount),
                       "behavior": item.behavior, "import_job_id": job.id})
    return item.id


def _fail_job(db: Session, job_id: str, message: str, actor: str):
    """Rollback total: no queda NADA a medias (8.1 paso 7)."""
    db.rollback()
    job = db.get(ImportJob, job_id)
    if job:
        job.status = "fallido"
        job.error = message
        audit.record(db, "import_failed", "ImportJob", job.id, actor_id=actor,
                     after={"error": message})
        db.commit()


@router.post("/imports/{job_id}/commit")
def commit_import(job_id: str, payload: ImportActionIn | None = None,
                  db: Session = Depends(get_db)):
    """IA-06: escribe en UNA transacción solo las propuestas aceptadas o editadas.

    Cada campo escrito deja FieldProvenance. Si algo falla se revierte todo, el
    job queda 'fallido' y no se persiste ninguna entidad parcial.
    """
    job = job_or_404(db, job_id)
    actor = payload.actor if payload else job.created_by or "usuario"
    if job.status != "revision":
        raise HTTPException(409, f"No se puede confirmar una importación en estado "
                                 f"'{job.status}' (debe estar en 'revision')")

    proposals = db.execute(select(ImportProposal).where(
        ImportProposal.import_job_id == job.id,
        ImportProposal.status.in_(WRITABLE_STATUSES)).order_by(
        ImportProposal.entity_type, ImportProposal.entity_ref,
        ImportProposal.created_at)).scalars().all()
    if not proposals:
        raise HTTPException(422, "No hay propuestas aceptadas o editadas que confirmar; "
                                 "revisa el mapeo antes de continuar")

    groups: dict[tuple[str, str], dict] = {}
    for proposal in proposals:
        groups.setdefault((proposal.entity_type, proposal.entity_ref), {})[
            proposal.field_name] = proposal

    created: dict[str, int] = {}
    updated: dict[str, int] = {}
    entity_ids: list[dict] = []
    try:
        ordered = sorted(groups.items(),
                         key=lambda kv: (COMMIT_ORDER.index(kv[0][0])
                                         if kv[0][0] in COMMIT_ORDER else 99, kv[0][1]))
        branch_id = None
        if any(entity_type == "ProductService" for (entity_type, _ref), _f in ordered):
            client = _target_client(db, job, "catálogo")
            branches = branches_of(client)
            if not branches:
                raise HTTPException(422, f"El cliente «{client.trade_name}» no tiene "
                                         f"sucursales: crea una antes de confirmar el catálogo")
            branch_id = branches[0].id

        for (entity_type, entity_ref), fields in ordered:
            if entity_type == "Client":
                new_id = _write_client(db, job, entity_ref, fields, actor)
                created["Client"] = created.get("Client", 0) + 1
            elif entity_type == "Branch":
                new_id = _write_branch(db, job, entity_ref, fields, actor)
                created["Branch"] = created.get("Branch", 0) + 1
            elif entity_type == "ProductService":
                new_id = _write_product(db, job, entity_ref, fields, actor, branch_id)
                created["ProductService"] = created.get("ProductService", 0) + 1
            elif entity_type == "ClientBaseline":
                new_id, was_created = _write_baseline(db, job, entity_ref, fields, actor)
                bucket = created if was_created else updated
                bucket["ClientBaseline"] = bucket.get("ClientBaseline", 0) + 1
            elif entity_type == "CostItem":
                new_id = _write_cost(db, job, entity_ref, fields, actor)
                created["CostItem"] = created.get("CostItem", 0) + 1
            else:
                raise HTTPException(422, f"Entidad no soportada en el commit: {entity_type}")
            entity_ids.append({"entity_type": entity_type, "entity_ref": entity_ref,
                               "entity_id": new_id, "fields": len(fields)})

        summary = dict(job.result_summary or {})
        summary.update({
            "committed": {"created": created, "updated": updated,
                          "entities": len(entity_ids), "fields": len(proposals)},
            "entities_written": entity_ids,
        })
        job.result_summary = summary
        job.status = "commiteado"
        job.committed_at = datetime.now(timezone.utc)
        job.error = None
        audit.record(db, "import_committed", "ImportJob", job.id, actor_id=actor,
                     after={"created": created, "updated": updated,
                            "entities": len(entity_ids), "fields": len(proposals)})
        db.commit()
    except HTTPException as exc:
        _fail_job(db, job_id, str(exc.detail), actor)
        raise HTTPException(422, exc.detail)
    except Exception as exc:  # noqa: BLE001 — cualquier fallo revierte todo
        message = f"No se pudo confirmar la importación: {exc}"
        _fail_job(db, job_id, message, actor)
        raise HTTPException(422, message)

    return {"job": serialize_job(job), "created": created, "updated": updated,
            "entities": entity_ids, "fields_written": len(proposals)}


# ---------------------------------------------------------------------------
# IA-07 · historial y cancelación
# ---------------------------------------------------------------------------

@router.get("/projects/{project_id}/imports")
def list_imports(project_id: str, status: str | None = None,
                 db: Session = Depends(get_db)):
    """IA-07: historial de fuentes — fecha, archivos con hash, confianza, estado
    y entidades afectadas por cada importación."""
    project_or_404(db, project_id)
    jobs = db.execute(select(ImportJob).where(ImportJob.project_id == project_id)
                      .order_by(ImportJob.created_at.desc())).scalars().all()
    if status:
        jobs = [j for j in jobs if j.status == status]
    job_ids = [j.id for j in jobs]

    files_by_job: dict[str, list] = {}
    proposals_by_job: dict[str, dict] = {}
    if job_ids:
        for source in db.execute(select(SourceFile).where(
                SourceFile.import_job_id.in_(job_ids))
                .order_by(SourceFile.created_at)).scalars().all():
            files_by_job.setdefault(source.import_job_id, []).append(source)
        rows = db.execute(select(ImportProposal.import_job_id, ImportProposal.entity_type,
                                 ImportProposal.entity_ref, ImportProposal.status).where(
            ImportProposal.import_job_id.in_(job_ids))).all()
        for import_job_id, entity_type, entity_ref, proposal_status in rows:
            bucket = proposals_by_job.setdefault(
                import_job_id, {"total": 0, "by_status": {}, "by_entity": {}, "_refs": set()})
            bucket["total"] += 1
            bucket["by_status"][proposal_status] = bucket["by_status"].get(proposal_status, 0) + 1
            if (entity_type, entity_ref) not in bucket["_refs"]:
                bucket["_refs"].add((entity_type, entity_ref))
                bucket["by_entity"][entity_type] = bucket["by_entity"].get(entity_type, 0) + 1

    rows_out = []
    for job in jobs:
        summary = job.result_summary or {}
        counts = proposals_by_job.get(job.id, {"total": 0, "by_status": {}, "by_entity": {}})
        counts.pop("_refs", None)   # detalle interno de conteo, no se serializa
        rows_out.append({
            **serialize_job(job),
            "files": [serialize_file(f) for f in files_by_job.get(job.id, [])],
            "proposals": counts,
            "entities_affected": (summary.get("committed", {}).get("created")
                                  if job.status == "commiteado" else counts["by_entity"]),
            "issues": summary.get("issues", 0),
            "conflicts": summary.get("conflicts", counts["by_status"].get("conflicto", 0)),
        })
    return {"imports": rows_out, "kpis": {
        "count": len(rows_out),
        "committed": len([r for r in rows_out if r["status"] == "commiteado"]),
        "in_review": len([r for r in rows_out if r["status"] == "revision"]),
        "failed": len([r for r in rows_out if r["status"] == "fallido"]),
    }}


@router.post("/imports/{job_id}/cancel")
def cancel_import(job_id: str, payload: ImportActionIn | None = None,
                  db: Session = Depends(get_db)):
    """IA-07: descartar una importación. Lo ya confirmado no se cancela: se
    corrige con una nueva importación o edición manual."""
    job = job_or_404(db, job_id)
    actor = payload.actor if payload else job.created_by or "usuario"
    if job.status == "commiteado":
        raise HTTPException(409, "La importación ya fue confirmada; no se puede cancelar")
    if job.status == "cancelado":
        return serialize_job(job)
    before = {"status": job.status}
    job.status = "cancelado"
    audit.record(db, "import_cancelled", "ImportJob", job.id, actor_id=actor,
                 before=before, after={"status": "cancelado"})
    db.commit()
    return serialize_job(job)
