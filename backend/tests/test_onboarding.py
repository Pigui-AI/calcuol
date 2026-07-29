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
def client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool, future=True)
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, future=True)

    def override_get_db():
        db = TestSession()
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
