"""Roadmap de activación — ruta guiada de uso de la plataforma.

Devuelve los pasos del tutorial con su estado REAL calculado en el servidor
(qué ya hizo el usuario en el proyecto), nunca inferido en el navegador. Cada
paso apunta a la pantalla donde se completa y explica qué se aprende ahí.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (Project, Scenario, Client, AssumptionSet, SimulationRun,
                        Campaign, SubscriptionPlan, HiringRole, SensitivityAnalysis,
                        ExecutiveConclusion, ExportJob, ImportJob)

router = APIRouter()

# Claves cuya presencia como override indica que el usuario modeló el crecimiento
GROWTH_PREFIXES = ("b2b.curve.", "b2b.churn_rate", "b2b.cac", "b2b.acquisition",
                   "b2b.onboarding", "b2c.cohort.", "b2c.consumer_churn")


def _steps(db: Session, project: Project | None) -> list:
    """Los ocho pasos del roadmap con la señal que los da por cumplidos."""
    pid = project.id if project else None
    scenario_id = None
    if project:
        first = db.execute(select(Scenario).where(Scenario.project_id == pid)
                           .order_by(Scenario.created_at)).scalars().first()
        scenario_id = first.id if first else None

    def count(model, *where):
        if not pid:
            return 0
        return db.execute(select(func.count()).select_from(model).where(*where)).scalar() or 0

    clients = count(Client, Client.project_id == pid, Client.status != "archived")
    overrides = count(AssumptionSet, AssumptionSet.project_id == pid,
                      AssumptionSet.scope_type.in_(("global", "scenario")))
    growth_overrides = 0
    if pid:
        rows = db.execute(select(AssumptionSet.key).where(
            AssumptionSet.project_id == pid,
            AssumptionSet.scope_type.in_(("global", "scenario")))).scalars().all()
        growth_overrides = sum(1 for k in rows if k.startswith(GROWTH_PREFIXES))
    operations = (count(Campaign, Campaign.project_id == pid)
                  + count(SubscriptionPlan, SubscriptionPlan.project_id == pid)
                  + count(HiringRole, HiringRole.project_id == pid))
    runs_ok = 0
    if scenario_id:
        scenario_ids = db.execute(select(Scenario.id).where(Scenario.project_id == pid)).scalars().all()
        runs_ok = db.execute(select(func.count()).select_from(SimulationRun).where(
            SimulationRun.scenario_id.in_(scenario_ids),
            SimulationRun.status == "succeeded")).scalar() or 0
        run_ids = db.execute(select(SimulationRun.id).where(
            SimulationRun.scenario_id.in_(scenario_ids))).scalars().all()
    else:
        run_ids = []
    analyses = count(SensitivityAnalysis, SensitivityAnalysis.project_id == pid)
    conclusions = 0
    exports = 0
    if run_ids:
        conclusions = db.execute(select(func.count()).select_from(ExecutiveConclusion).where(
            ExecutiveConclusion.run_id.in_(run_ids))).scalar() or 0
        exports = db.execute(select(func.count()).select_from(ExportJob).where(
            ExportJob.run_id.in_(run_ids), ExportJob.status == "succeeded")).scalar() or 0
    imports = count(ImportJob, ImportJob.project_id == pid, ImportJob.status == "commiteado")

    q = f"?project={pid}" if pid else ""
    qs = f"?project={pid}&scenario={scenario_id}" if scenario_id else q

    return [
        {
            "key": "proyecto", "title": "Crear tu proyecto",
            "short": "Proyecto", "icon": "folder",
            "done": project is not None,
            "detail": project.name if project else None,
            "href": "/projects/new/",
            "what": "Defines el horizonte (12, 36 o 60 meses), la moneda y la base de partida. "
                    "El asistente te lleva por la base inicial, el crecimiento y el modelo de ingresos.",
            "tip": "Empieza con 60 meses: siempre puedes mirar solo el primer año, pero no puedes "
                   "extender un horizonte ya simulado sin volver a correr.",
        },
        {
            "key": "clientes", "title": "Cargar clientes B2B",
            "short": "Clientes", "icon": "store",
            "done": clients > 0,
            "detail": f"{clients} cliente(s) en el portafolio" if clients else None,
            "href": f"/clients/{q}" if pid else "/",
            "what": "Cada negocio se captura con sus sucursales, su catálogo y su línea base "
                    "financiera (ventas, transacciones, ticket, margen y consumidores).",
            "tip": "Con línea base real el motor deriva ticket, margen, frecuencia y conversión de "
                   "tus propios datos en vez de usar supuestos genéricos. Es lo que más mejora la "
                   "calidad de la simulación.",
        },
        {
            "key": "supuestos", "title": "Ajustar los supuestos",
            "short": "Supuestos", "icon": "sliders",
            "done": overrides > 0,
            "detail": f"{overrides} supuesto(s) declarados" if overrides else None,
            "href": f"/assumptions/{qs}" if scenario_id else "/",
            "what": "El centro de supuestos reúne todas las variables del escenario con su valor "
                    "efectivo y su origen: default del motor, valor del proyecto o del escenario.",
            "tip": "Nada se sobrescribe: cada edición crea una versión nueva con autor y fecha, así "
                   "que puedes experimentar sin miedo a perder el valor anterior.",
        },
        {
            "key": "crecimiento", "title": "Modelar el crecimiento",
            "short": "Crecimiento", "icon": "trending",
            "done": growth_overrides > 0,
            "detail": f"{growth_overrides} palanca(s) de crecimiento ajustadas" if growth_overrides else None,
            "href": f"/growth-b2b/{qs}" if scenario_id else "/",
            "what": "Curva de adquisición (lineal, exponencial, logística o desacelerada), churn, "
                    "CAC, presupuesto y capacidad de onboarding. En Cohortes modelas la retención "
                    "de consumidores por antigüedad en vez de un churn plano.",
            "tip": "Mira la columna «restricción activa»: te dice mes a mes si el freno fue la "
                   "curva, el presupuesto o la capacidad de onboarding.",
        },
        {
            "key": "operaciones", "title": "Configurar operaciones",
            "short": "Operaciones", "icon": "gear",
            "done": operations > 0,
            "detail": f"{operations} elemento(s) configurados" if operations else None,
            "href": f"/campaigns/{qs}" if scenario_id else "/",
            "what": "Campañas y recompensas, transacciones y rutas de pago, planes de suscripción, "
                    "consumo de IA, costos escalonados y el plan de contratación.",
            "tip": "Casi todos estos motores nacen apagados: mientras no los enciendas no afectan "
                   "tus resultados, así que puedes incorporarlos de uno en uno.",
        },
        {
            "key": "simulacion", "title": "Ejecutar la simulación",
            "short": "Simular", "icon": "play",
            "done": runs_ok > 0,
            "detail": f"{runs_ok} corrida(s) exitosa(s)" if runs_ok else None,
            "href": f"/simulate/{qs}" if scenario_id else "/",
            "what": "El motor congela un snapshot con todo lo que capturaste y calcula el horizonte "
                    "completo: plan mensual, estado de resultados, flujo de efectivo y unit economics.",
            "tip": "Mismo snapshot y misma versión del motor producen exactamente los mismos "
                   "números. Por eso un plan exportado siempre se puede reproducir y defender.",
        },
        {
            "key": "analisis", "title": "Analizar y comparar",
            "short": "Análisis", "icon": "chart",
            "done": analyses > 0 or runs_ok >= 2 or conclusions > 0,
            "detail": (f"{analyses} análisis de sensibilidad" if analyses
                       else f"{runs_ok} corridas comparables" if runs_ok >= 2
                       else f"{conclusions} conclusión(es) guardadas" if conclusions else None),
            "href": f"/sensitivity/{qs}" if scenario_id else "/",
            "what": "Sensibilidad te dice qué palanca mueve más la aguja; el comparador enfrenta "
                    "escenarios con sus diferencias; y Conclusiones propone hallazgos, riesgos y "
                    "acciones citando la métrica que los sustenta.",
            "tip": "En sensibilidad cada corrida cambia una sola variable, así los impactos son "
                   "comparables entre sí contra el mismo punto de partida.",
        },
        {
            "key": "entregable", "title": "Exportar el plan",
            "short": "Exportar", "icon": "download",
            "done": exports > 0,
            "detail": f"{exports} exportación(es) generadas" if exports else None,
            "href": f"/run/{q}" if pid else "/",
            "what": "Desde los resultados generas el business plan en Excel (once hojas, sesenta "
                    "meses) o el documento ejecutivo listo para presentar.",
            "tip": "Ambos entregables citan la corrida que los originó, para que ningún número "
                   "circule sin saber de dónde salió.",
        },
    ], {"imports": imports}


@router.get("/onboarding")
def get_onboarding(project_id: str | None = None, db: Session = Depends(get_db)):
    """Estado del roadmap. Sin project_id usa el proyecto más reciente."""
    if project_id:
        project = db.get(Project, project_id)
        if not project:
            raise HTTPException(404, "Proyecto no encontrado")
    else:
        project = db.execute(select(Project).where(Project.status != "archived")
                             .order_by(Project.created_at.desc())).scalars().first()

    steps, extra = _steps(db, project)
    # el primer paso no cumplido es el que está en curso; el resto queda pendiente
    current = next((s for s in steps if not s["done"]), None)
    for step in steps:
        if step["done"]:
            step["status"] = "completado"
        elif current is not None and step["key"] == current["key"]:
            step["status"] = "en_progreso"
        else:
            step["status"] = "pendiente"
        step.pop("done")

    completed = sum(1 for s in steps if s["status"] == "completado")
    return {
        "project": {"id": project.id, "name": project.name} if project else None,
        "steps": [{**s, "order": i + 1} for i, s in enumerate(steps)],
        "completed": completed,
        "total": len(steps),
        "current_key": current["key"] if current else None,
        "imports_committed": extra["imports"],
    }
