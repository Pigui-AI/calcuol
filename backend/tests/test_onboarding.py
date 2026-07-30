"""Snapshot del roadmap de activación.

Garantiza que extraer el contenido a app/content/tutorial_es.py no cambió la
respuesta de GET /onboarding: se compara contra tests/golden_onboarding.json,
capturado con la versión previa al refactor (BD vacía). Solo se comparan las
claves presentes en el golden: los campos que fases posteriores añadan
(scene_data, quiz…) son aditivos y no rompen este contrato.
"""
import json
import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models  # noqa: F401  (registra modelos)
from app.database import Base, get_db
from app.main import app

GOLDEN_PATH = os.path.join(os.path.dirname(__file__), "golden_onboarding.json")


@pytest.fixture()
def session_factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool, future=True)
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, future=True)
    engine.dispose()


@pytest.fixture()
def client(session_factory):
    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    startup_handlers = list(app.router.on_startup)
    app.router.on_startup.clear()  # el startup real crearía tablas en la BD del repo
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.router.on_startup.extend(startup_handlers)
        app.dependency_overrides.pop(get_db, None)


def assert_subset(expected, actual, path="$"):
    """expected ⊆ actual: mismas claves y valores del golden; extras permitidos."""
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{path}: se esperaba objeto"
        for key, value in expected.items():
            assert key in actual, f"{path}.{key}: clave ausente"
            assert_subset(value, actual[key], f"{path}.{key}")
    elif isinstance(expected, list):
        assert isinstance(actual, list), f"{path}: se esperaba lista"
        assert len(expected) == len(actual), f"{path}: longitud {len(actual)} != {len(expected)}"
        for i, (e, a) in enumerate(zip(expected, actual)):
            assert_subset(e, a, f"{path}[{i}]")
    else:
        assert expected == actual, f"{path}: {actual!r} != {expected!r}"


def test_onboarding_empty_db_matches_golden(client):
    resp = client.get("/onboarding")
    assert resp.status_code == 200
    golden = json.load(open(GOLDEN_PATH, encoding="utf-8"))
    assert_subset(golden, resp.json())


def test_content_module_shape():
    from app.content.tutorial_es import STEPS, STEP_KEYS

    assert len(STEPS) == 8
    assert len(set(STEP_KEYS)) == 8
    for step in STEPS:
        for field in ("key", "title", "short", "icon", "what", "tip", "eli5", "hands_on"):
            assert step.get(field), f"paso {step.get('key')}: falta {field}"
        assert isinstance(step["hands_on"], list) and step["hands_on"]


def test_scene_data_empty_db_is_null(client):
    steps = client.get("/onboarding").json()["steps"]
    assert all(s["scene_data"] is None for s in steps)


def test_quiz_authored_shape():
    from app.content.tutorial_es import STEPS, STEP_KEYS

    seen_ids = set()
    for step in STEPS:
        assert step.get("quiz"), f"paso {step['key']}: sin quiz"
        for q in step["quiz"]:
            assert q["id"] not in seen_ids, f"id de pregunta duplicado: {q['id']}"
            seen_ids.add(q["id"])
            assert q["text"].strip()
            corrects = [o for o in q["options"] if o.get("correct")]
            assert len(corrects) == 1, f"{q['id']}: debe haber exactamente una correcta"
            for o in q["options"]:
                assert o.get("feedback", "").strip(), f"{q['id']}: opción sin feedback"
                if "review_step" in o:
                    assert o["review_step"] in STEP_KEYS, f"{q['id']}: review_step inválido"


def test_quiz_empty_db_is_authored(client):
    steps = client.get("/onboarding").json()["steps"]
    for s in steps:
        assert s["quiz"], f"paso {s['key']}: sin quiz en la respuesta"
        assert all(q["uses_real_data"] is False for q in s["quiz"])


def test_dialogue_authored_shape(client):
    from app.content.tutorial_es import STEPS

    for step in STEPS:
        dialogue = step.get("dialogue")
        assert dialogue and len(dialogue) >= 4, f"paso {step['key']}: diálogo corto o ausente"
        assert dialogue[0]["speaker"] == "alumno"       # el alumno abre con la duda
        for turn in dialogue:
            assert turn["speaker"] in ("alumno", "mentor")
            assert turn["text"].strip()

    # y viaja en la respuesta del API
    steps = client.get("/onboarding").json()["steps"]
    assert all(len(s.get("dialogue") or []) >= 4 for s in steps)


def _seed_project(db):
    from app.models import (Project, Scenario, Client, Brand, Branch, ProductService,
                            ClientBaseline, AssumptionSet, SimulationRun,
                            SensitivityAnalysis)

    project = Project(name="Plan Cafeterías Norte 2027", start_month="2026-08",
                      horizon_months=60, base_currency="MXN")
    db.add(project)
    db.flush()
    scenario = Scenario(project_id=project.id, name="Base", engine_version="test")
    db.add(scenario)
    db.flush()
    cl = Client(project_id=project.id, legal_name="Alborada SA",
                trade_name="Café La Esperanza del Barrio", industry="cafetería")
    db.add(cl)
    db.flush()
    brand = Brand(client_id=cl.id, name="La Esperanza")
    db.add(brand)
    db.flush()
    branch = Branch(brand_id=brand.id, name="Sucursal Centro Histórico")
    db.add(branch)
    db.flush()
    db.add(ProductService(branch_id=branch.id, name="Café de olla grande",
                          sale_price="48", direct_cost="17"))
    db.add(ClientBaseline(client_id=cl.id, avg_monthly_sales="148500",
                          avg_monthly_transactions="3120", avg_ticket="47.60",
                          active_consumers=812))
    db.add(AssumptionSet(project_id=project.id, scenario_id=scenario.id,
                         scope_type="scenario", key="b2b.churn_rate",
                         value="0.05", version=1))
    db.add(SimulationRun(scenario_id=scenario.id, engine_version="test",
                         status="succeeded", snapshot={}, input_hash="abc123def456",
                         horizon_months=60))
    db.add(SensitivityAnalysis(project_id=project.id, scenario_id=scenario.id,
                               engine_version="test", input_hash="abc123def456",
                               target_metric="ebitda", variables=[],
                               results=[{"key": "b2b.cac", "impact": "1200"},
                                        {"key": "b2b.churn_rate", "impact": "-8400"}]))
    db.commit()


def test_scene_data_with_seeded_project(client, session_factory):
    db = session_factory()
    _seed_project(db)
    db.close()

    steps = {s["key"]: s for s in client.get("/onboarding").json()["steps"]}

    proyecto = steps["proyecto"]["scene_data"]
    assert proyecto["is_real"] and proyecto["currency"] == "MXN"
    assert proyecto["horizon_label"] == "60 meses"
    assert len(proyecto["project_name"]) <= 18  # truncado para la escena

    clientes = steps["clientes"]["scene_data"]
    assert len(clientes["client_name"]) <= 18
    assert clientes["products"][0]["price"] == "$48"
    assert "ventas $148,500" in clientes["baseline_line"]
    assert "3,120 tickets" in clientes["baseline_line"]

    supuestos = steps["supuestos"]["scene_data"]
    assert supuestos["new_value"] == "0.05"
    assert supuestos["old_value"] == "0.03"        # sin versión previa cae al default
    assert supuestos["v_old_label"] == "default · 0.03 · motor"
    assert "v1 · 0.05 · vigente" in supuestos["v_new_label"]

    assert steps["simulacion"]["scene_data"]["hash_short"] == "abc123…"
    assert steps["entregable"]["scene_data"]["run_ref"] == "run abc123 citado"
    # la palanca con mayor |impacto| gana el tornado
    assert steps["analisis"]["scene_data"]["top_lever"] == "churn"
    # sin campaña ni override de capacidad: esas escenas quedan en utilería
    assert steps["operaciones"]["scene_data"] is None
    assert steps["crecimiento"]["scene_data"] is None


def test_scene_supuestos_ignores_other_scenarios(client, session_factory):
    """Los overrides de Conservador/Optimista (wizard) no deben aparecer como
    «vigente»: el tutorial apunta al primer escenario del proyecto."""
    from sqlalchemy import select
    from app.models import Scenario, AssumptionSet, Project

    db = session_factory()
    _seed_project(db)
    project = db.execute(select(Project)).scalars().first()
    otro = Scenario(project_id=project.id, name="Optimista", type="optimista",
                    engine_version="test")
    db.add(otro)
    db.flush()
    # override de churn en OTRO escenario, creado después del de Base
    db.add(AssumptionSet(project_id=project.id, scenario_id=otro.id,
                         scope_type="scenario", key="b2b.churn_rate",
                         value="0.024", version=1))
    # override global (nivel proyecto): pierde contra el del escenario Base
    db.add(AssumptionSet(project_id=project.id, scenario_id=None,
                         scope_type="global", key="b2b.churn_rate",
                         value="0.08", version=1))
    db.commit()
    db.close()

    steps = {s["key"]: s for s in client.get("/onboarding").json()["steps"]}
    supuestos = steps["supuestos"]["scene_data"]
    assert "0.05" in supuestos["v_new_label"]      # vigente = escenario Base
    assert "0.024" not in str(supuestos)           # Optimista queda fuera
    assert supuestos["old_value"] == "0.08"        # el global es el anterior


def test_scene_data_tolerates_non_finite_baseline(client, session_factory):
    """'NaN'/'Infinity' guardados vía la API no deben tumbar el roadmap."""
    from sqlalchemy import select
    from app.models import ClientBaseline

    db = session_factory()
    _seed_project(db)
    baseline = db.execute(select(ClientBaseline)).scalars().first()
    baseline.avg_monthly_sales = "NaN"
    db.commit()
    db.close()

    resp = client.get("/onboarding")
    assert resp.status_code == 200
    steps = {s["key"]: s for s in resp.json()["steps"]}
    clientes = steps["clientes"]["scene_data"]
    assert clientes is not None                    # la escena degrada por dato
    assert "baseline_line" not in clientes
