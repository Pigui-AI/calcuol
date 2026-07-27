"""Pigui Financial Engine — API de aplicación (sección 6.1).

Arranque local:  uvicorn app.main:app --reload --port 8000
Cloud Run:       escucha en $PORT; configura CORS_ORIGINS con el dominio del frontend
                 (p. ej. https://pigui-ai.github.io) separado por comas.
"""
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.database import init_db
from app.routers import projects, clients, simulations, exports, growth
from app.engine.snapshot import ENGINE_VERSION

DEFAULT_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000,https://pigui-ai.github.io"
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", DEFAULT_ORIGINS).split(",") if o.strip()]

app = FastAPI(
    title="Pigui Financial Engine",
    description="Motor de simulaciones financieras de Pigui — especificación v1.0",
    version=ENGINE_VERSION,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router, tags=["proyectos y escenarios"])
app.include_router(clients.router, tags=["clientes B2B"])
app.include_router(simulations.router, tags=["simulación"])
app.include_router(exports.router, tags=["exportación"])
app.include_router(growth.router, tags=["growth y cohortes (fase 4)"])


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={
        "code": "internal_error", "message": str(exc), "retryable": False,
    })


@app.get("/health")
def health():
    return {"status": "ok", "engine_version": ENGINE_VERSION}


@app.on_event("startup")
def startup():
    init_db()
