"""Exportaciones — pantalla 72. Job con manifest y descarga.

Formatos: `xlsx` (workbook, sección 13.1) y `doc` (documento ejecutivo en HTML
autocontenido e imprimible a PDF, sección 13.2). Ambos comparten el mismo flujo
de ExportJob y siempre referencian el run que los originó.
"""
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import SimulationRun, ExportJob
from app.schemas import ExportCreate
from app.exports.excel import generate_workbook
from app.exports.document import build_document
from app import audit

router = APIRouter()

# Formatos soportados (pantalla 72): workbook 13.1 y documento ejecutivo 13.2.
BUILDERS = {"xlsx": generate_workbook, "doc": build_document}
MEDIA_TYPES = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "doc": "text/html; charset=utf-8",
}


@router.post("/exports", status_code=201)
def create_export(payload: ExportCreate, db: Session = Depends(get_db)):
    run = db.get(SimulationRun, payload.run_id)
    if not run:
        raise HTTPException(404, "Run no encontrado")
    if run.status != "succeeded":
        raise HTTPException(409, "Solo se puede exportar un run exitoso")
    if payload.format not in BUILDERS:
        raise HTTPException(
            422, f"Formato no soportado: '{payload.format}'. "
                 f"Formatos disponibles: {', '.join(sorted(BUILDERS))}")

    job = ExportJob(run_id=run.id, format=payload.format, status="running")
    db.add(job)
    db.flush()
    try:
        path = BUILDERS[payload.format](db, run)
        job.status = "succeeded"
        job.file_path = path
        job.file_name = os.path.basename(path)
        job.finished_at = datetime.now(timezone.utc)
        audit.record(db, "export_completed", "ExportJob", job.id,
                     after={"run_id": run.id, "format": job.format, "file": job.file_name})
    except Exception as exc:  # noqa: BLE001
        job.status = "failed"
        job.error = str(exc)
        raise HTTPException(500, f"Error generando export: {exc}")
    finally:
        db.commit()
    return {"id": job.id, "status": job.status, "file_name": job.file_name,
            "format": job.format, "run_id": run.id}


@router.get("/exports/{job_id}")
def get_export(job_id: str, db: Session = Depends(get_db)):
    job = db.get(ExportJob, job_id)
    if not job:
        raise HTTPException(404, "Export no encontrado")
    return {"id": job.id, "status": job.status, "file_name": job.file_name,
            "format": job.format, "run_id": job.run_id, "error": job.error}


@router.get("/exports/{job_id}/download")
def download_export(job_id: str, db: Session = Depends(get_db)):
    job = db.get(ExportJob, job_id)
    if not job or job.status != "succeeded" or not job.file_path:
        raise HTTPException(404, "Archivo no disponible")
    if not os.path.exists(job.file_path):
        raise HTTPException(410, "El archivo ya no existe; regenerar el export")
    return FileResponse(job.file_path, filename=job.file_name,
                        media_type=MEDIA_TYPES.get(job.format, "application/octet-stream"))
