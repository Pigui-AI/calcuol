"""Exportaciones — pantalla 72. Job con manifest y descarga."""
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import SimulationRun, ExportJob
from app.schemas import ExportCreate
from app.exports.excel import generate_workbook
from app import audit

router = APIRouter()


@router.post("/exports", status_code=201)
def create_export(payload: ExportCreate, db: Session = Depends(get_db)):
    run = db.get(SimulationRun, payload.run_id)
    if not run:
        raise HTTPException(404, "Run no encontrado")
    if run.status != "succeeded":
        raise HTTPException(409, "Solo se puede exportar un run exitoso")
    if payload.format != "xlsx":
        raise HTTPException(422, "Formato soportado en esta versión: xlsx")

    job = ExportJob(run_id=run.id, format="xlsx", status="running")
    db.add(job)
    db.flush()
    try:
        path = generate_workbook(db, run)
        job.status = "succeeded"
        job.file_path = path
        job.file_name = os.path.basename(path)
        job.finished_at = datetime.now(timezone.utc)
        audit.record(db, "export_completed", "ExportJob", job.id,
                     after={"run_id": run.id, "file": job.file_name})
    except Exception as exc:  # noqa: BLE001
        job.status = "failed"
        job.error = str(exc)
        raise HTTPException(500, f"Error generando export: {exc}")
    finally:
        db.commit()
    return {"id": job.id, "status": job.status, "file_name": job.file_name, "run_id": run.id}


@router.get("/exports/{job_id}")
def get_export(job_id: str, db: Session = Depends(get_db)):
    job = db.get(ExportJob, job_id)
    if not job:
        raise HTTPException(404, "Export no encontrado")
    return {"id": job.id, "status": job.status, "file_name": job.file_name,
            "run_id": job.run_id, "error": job.error}


@router.get("/exports/{job_id}/download")
def download_export(job_id: str, db: Session = Depends(get_db)):
    job = db.get(ExportJob, job_id)
    if not job or job.status != "succeeded" or not job.file_path:
        raise HTTPException(404, "Archivo no disponible")
    if not os.path.exists(job.file_path):
        raise HTTPException(410, "El archivo ya no existe; regenerar el export")
    return FileResponse(job.file_path, filename=job.file_name,
                        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
