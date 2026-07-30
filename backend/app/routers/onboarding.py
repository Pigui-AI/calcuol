"""Roadmap de activación — ruta guiada de uso de la plataforma.

Devuelve los pasos del tutorial con su estado REAL calculado en el servidor
(qué ya hizo el usuario en el proyecto), nunca inferido en el navegador. Cada
paso apunta a la pantalla donde se completa y explica qué se aprende ahí.

El contenido autorado (what/tip/eli5/hands_on) vive en
app/content/tutorial_es.py; aquí solo se calcula el estado y los enlaces.
"""
from decimal import Decimal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select, func, or_, and_
from sqlalchemy.orm import Session

from app.content import llm_provider as tutorial_llm
from app.content import render
from app.content.tutorial_es import STEPS as CONTENT
from app.database import get_db
from app.engine.money import D
from app.models import (Project, Scenario, Client, AssumptionSet, SimulationRun,
                        Campaign, SubscriptionPlan, HiringRole, SensitivityAnalysis,
                        ExecutiveConclusion, ExportJob, ImportJob)

router = APIRouter()

# Claves cuya presencia como override indica que el usuario modeló el crecimiento
GROWTH_PREFIXES = ("b2b.curve.", "b2b.churn_rate", "b2b.cac", "b2b.acquisition",
                   "b2b.onboarding", "b2c.cohort.", "b2c.consumer_churn")

# Nombre corto de cada palanca para el tornado de la escena de análisis
LEVER_LABELS = {
    "b2b.churn_rate": "churn", "b2b.cac": "CAC", "b2b.curve.rate": "curva",
    "b2b.curve.max_clients": "techo", "b2c.avg_ticket": "ticket",
    "b2c.purchase_conversion": "conversión", "b2c.purchase_frequency": "frecuencia",
    "b2c.consumer_churn_rate": "churn B2C", "revenue.commission.pigui_pct": "comisión",
    "payments.stripe_share": "ruta Stripe",
}


def _trunc(text: str, limit: int) -> str:
    """Recorta para no romper los anchos fijos de las escenas (w-56/w-64)."""
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _fmt_money(value) -> str:
    """Monto compacto para utilería visual: $45, $92,000, $1.2M."""
    d = D(value)
    if abs(d) >= Decimal("1000000"):
        compact = (d / Decimal("1000000")).quantize(Decimal("0.1"))
        text = f"${compact}M"
        return text.replace(".0M", "M")
    return f"${d.quantize(Decimal('1')):,}"


def _fmt_int(value) -> str:
    return f"{int(D(value)):,}"


def _num(value) -> Decimal | None:
    """Decimal finito o None: la BD puede traer 'NaN'/'Infinity' vía la API."""
    try:
        d = D(value)
    except Exception:
        return None
    return d if d.is_finite() else None


def _first_client(db: Session, pid: str) -> Client | None:
    return db.execute(
        select(Client).where(Client.project_id == pid, Client.status != "archived")
        .order_by(Client.created_at)
    ).scalars().first()


def _rewrite_context(db: Session, project: Project) -> dict:
    """Datos mínimos para que el LLM adapte registro y ejemplos: nombres y
    giro del negocio. Sin métricas — el LLM redacta, no calcula."""
    ctx = {
        "proyecto": project.name,
        "moneda": project.base_currency,
        "horizonte_meses": project.horizon_months,
    }
    client = _first_client(db, project.id)
    if client:
        ctx["cliente"] = client.trade_name
        ctx["giro"] = client.industry
    return ctx


def _latest_override(db: Session, pid: str, key: str,
                     scenario_id: str | None) -> list[AssumptionSet]:
    """Historial (viejo → vigente) de un supuesto: nivel proyecto y el
    escenario dado (el mismo al que apuntan los enlaces del tutorial).

    Los overrides de OTROS escenarios (p. ej. Conservador/Optimista creados
    por el wizard) se excluyen. El orden respeta la jerarquía de resolución
    (proyecto → escenario) con la versión dentro de cada alcance: el último
    elemento es el valor vigente aunque el override global sea más reciente.
    """
    scopes = (AssumptionSet.scope_type == "global") & AssumptionSet.scenario_id.is_(None)
    if scenario_id:
        scopes = or_(scopes, and_(AssumptionSet.scope_type == "scenario",
                                  AssumptionSet.scenario_id == scenario_id))
    return db.execute(
        select(AssumptionSet)
        .where(AssumptionSet.project_id == pid, AssumptionSet.key == key, scopes)
        .order_by(AssumptionSet.scope_type == "scenario",
                  AssumptionSet.version, AssumptionSet.created_at)
    ).scalars().all()


def _scene_data(db: Session, project: Project | None, scenario_ids: list[str],
                scenario_id: str | None) -> dict:
    """Datos reales del proyecto para las escenas, ya formateados y truncados.

    Cada escena tiene su variante de utilería en el frontend; aquí solo se
    devuelven las claves que existen de verdad (fallback por dato, no por
    paso). Nunca se calcula nada nuevo: se reusa lo que la BD ya conoce.
    scenario_id es el primer escenario del proyecto — el mismo al que apuntan
    los enlaces del tutorial.
    """
    if not project:
        return {}
    pid = project.id
    scenes: dict[str, dict] = {}

    scenes["proyecto"] = {
        "is_real": True,
        "project_name": _trunc(project.name, 18),
        "currency": project.base_currency,
        "horizon_label": f"{project.horizon_months} meses",
    }

    client = _first_client(db, pid)
    if client:
        branches = [b for brand in client.brands for b in brand.branches][:2]
        products = [item for b in branches for item in b.catalog_items
                    if _num(item.sale_price) is not None][:3]
        data = {
            "is_real": True,
            "client_name": _trunc(client.trade_name, 18),
        }
        if branches:
            data["branches"] = [_trunc(b.name, 10) for b in branches]
        if products:
            data["products"] = [{"name": _trunc(p.name, 14), "price": _fmt_money(p.sale_price)}
                                for p in products]
        base = client.baseline
        if base:
            sales = _num(base.avg_monthly_sales)
            tx = _num(base.avg_monthly_transactions)
            consumers = _num(base.active_consumers)
            if sales is not None and sales > 0 and tx is not None and consumers is not None:
                data["baseline_line"] = (
                    f"Línea base: ventas {_fmt_money(sales)} · "
                    f"{_fmt_int(tx)} tickets · "
                    f"{_fmt_int(consumers)} consumidores")
        scenes["clientes"] = data

    churn_rows = _latest_override(db, pid, "b2b.churn_rate", scenario_id)
    if churn_rows:
        current = churn_rows[-1]
        previous = churn_rows[-2] if len(churn_rows) > 1 else None
        old_value = previous.value if previous else "0.03"
        old_label = (f"v{previous.version} · {_trunc(previous.value, 8)} · guardada"
                     if previous else "default · 0.03 · motor")
        scenes["supuestos"] = {
            "is_real": True,
            "old_value": _trunc(old_value, 8),
            "new_value": _trunc(current.value, 8),
            "v_old_label": old_label,
            "v_new_label": f"v{current.version} · {_trunc(current.value, 8)} · vigente ✓",
        }

    capacity_rows = _latest_override(db, pid, "b2b.onboarding_capacity_monthly", scenario_id)
    if capacity_rows:
        scenes["crecimiento"] = {
            "is_real": True,
            "capacity_label": f"capacidad del equipo ({_trunc(capacity_rows[-1].value, 6)}/mes)",
        }

    campaign = db.execute(
        select(Campaign).where(Campaign.project_id == pid, Campaign.status != "archived")
        .order_by(Campaign.created_at)
    ).scalars().first()
    if campaign:
        scenes["operaciones"] = {
            "is_real": True,
            "campaign_name": f"«{_trunc(campaign.name, 12)}»",
            "campaign_window": f"meses {campaign.start_month}–{campaign.end_month}",
            "campaign_start": campaign.start_month,
            "campaign_end": campaign.end_month,
        }

    run = None
    if scenario_ids:
        run = db.execute(
            select(SimulationRun).where(SimulationRun.scenario_id.in_(scenario_ids),
                                        SimulationRun.status == "succeeded")
            .order_by(SimulationRun.created_at.desc())
        ).scalars().first()
    if run:
        hash_short = f"{run.input_hash[:6]}…"
        scenes["simulacion"] = {"is_real": True, "hash_short": hash_short}
        scenes["entregable"] = {
            "is_real": True,
            "horizon_label": f"{run.horizon_months} meses",
            "run_ref": f"run {run.input_hash[:6]} citado",
        }

    analysis = db.execute(
        select(SensitivityAnalysis).where(SensitivityAnalysis.project_id == pid)
        .order_by(SensitivityAnalysis.created_at.desc())
    ).scalars().first()
    if analysis and isinstance(analysis.results, list) and analysis.results:
        def impact_of(row):
            try:
                return abs(D(row.get("impact") or 0))
            except Exception:
                return Decimal("0")
        top = max(analysis.results, key=impact_of)
        key = top.get("key", "")
        scenes["analisis"] = {
            "is_real": True,
            "top_lever": LEVER_LABELS.get(key, _trunc(key.split(".")[-1], 10)),
        }

    return scenes


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
    scenario_ids: list[str] = []
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

    # Señal de cumplimiento, detalle y destino de cada paso (el texto vive en CONTENT)
    dynamic = {
        "proyecto": {
            "done": project is not None,
            "detail": project.name if project else None,
            "href": "/projects/new/",
        },
        "clientes": {
            "done": clients > 0,
            "detail": f"{clients} cliente(s) en el portafolio" if clients else None,
            "href": f"/clients/{q}" if pid else "/",
        },
        "supuestos": {
            "done": overrides > 0,
            "detail": f"{overrides} supuesto(s) declarados" if overrides else None,
            "href": f"/assumptions/{qs}" if scenario_id else "/",
        },
        "crecimiento": {
            "done": growth_overrides > 0,
            "detail": f"{growth_overrides} palanca(s) de crecimiento ajustadas" if growth_overrides else None,
            "href": f"/growth-b2b/{qs}" if scenario_id else "/",
        },
        "operaciones": {
            "done": operations > 0,
            "detail": f"{operations} elemento(s) configurados" if operations else None,
            "href": f"/campaigns/{qs}" if scenario_id else "/",
        },
        "simulacion": {
            "done": runs_ok > 0,
            "detail": f"{runs_ok} corrida(s) exitosa(s)" if runs_ok else None,
            "href": f"/simulate/{qs}" if scenario_id else "/",
        },
        "analisis": {
            "done": analyses > 0 or runs_ok >= 2 or conclusions > 0,
            "detail": (f"{analyses} análisis de sensibilidad" if analyses
                       else f"{runs_ok} corridas comparables" if runs_ok >= 2
                       else f"{conclusions} conclusión(es) guardadas" if conclusions else None),
            "href": f"/sensitivity/{qs}" if scenario_id else "/",
        },
        "entregable": {
            "done": exports > 0,
            "detail": f"{exports} exportación(es) generadas" if exports else None,
            "href": f"/run/{q}" if pid else "/",
        },
    }

    extra = {"imports": imports, "scenario_ids": scenario_ids, "first_scenario_id": scenario_id}
    return [{**content, **dynamic[content["key"]]} for content in CONTENT], extra


@router.get("/onboarding")
def get_onboarding(background_tasks: BackgroundTasks, project_id: str | None = None,
                   db: Session = Depends(get_db)):
    """Estado del roadmap. Sin project_id usa el proyecto más reciente."""
    if project_id:
        project = db.get(Project, project_id)
        if not project:
            raise HTTPException(404, "Proyecto no encontrado")
    else:
        project = db.execute(select(Project).where(Project.status != "archived")
                             .order_by(Project.created_at.desc())).scalars().first()

    steps, extra = _steps(db, project)
    scenes = _scene_data(db, project, extra["scenario_ids"], extra["first_scenario_id"])

    # Re-redacción opcional con LLM (F6): si hay provider configurado, la
    # versión adaptada al negocio se genera en background y se sirve desde
    # caché cuando está lista. El endpoint nunca espera al modelo.
    rewrite_status = "off"
    rewritten: dict = {}
    provider = tutorial_llm.default_provider()
    if provider is not None and project is not None:
        ctx = _rewrite_context(db, project)
        fp = render.fingerprint(project.id, ctx, steps, provider.model)
        cached = render.get_cached(fp)
        if cached is not None:
            rewritten = cached
            rewrite_status = "listo"
        else:
            if render.should_generate(fp):
                background_tasks.add_task(render.generate, provider, fp, ctx,
                                          [dict(s) for s in steps])
            rewrite_status = render.status(fp)

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
        step["scene_data"] = scenes.get(step["key"])
        # el quiz enseña a usar la herramienta; hoy todo es contenido autorado
        step["quiz"] = [{**q, "uses_real_data": False} for q in step.get("quiz", [])]
        # el quiz nunca se re-redacta: sus afirmaciones están verificadas a mano
        step["rewritten"] = rewritten.get(step["key"])

    completed = sum(1 for s in steps if s["status"] == "completado")
    return {
        "project": {"id": project.id, "name": project.name} if project else None,
        "steps": [{**s, "order": i + 1} for i, s in enumerate(steps)],
        "completed": completed,
        "total": len(steps),
        "current_key": current["key"] if current else None,
        "imports_committed": extra["imports"],
        "rewrite_status": rewrite_status,
    }
