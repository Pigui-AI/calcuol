"""Hook provider LLM del tutorial (F6): contrato estricto y fallback total.

Usa un provider falso (sin red): valida la puerta de activación, el ciclo
generando→listo vía background task, el guard de números, el conteo de fallos
y la invalidación por cambio de contexto. GET /onboarding nunca debe fallar ni
esperar al LLM.
"""
import pytest

from app.content import llm_provider, render
from app.content.tutorial_es import STEPS

from tests.test_onboarding import client, session_factory, _seed_project  # noqa: F401


@pytest.fixture(autouse=True)
def clean_render_state():
    render.reset()
    yield
    render.reset()


class FakeProvider:
    model = "fake-model"

    def __init__(self, transform):
        self._transform = transform
        self.calls = 0

    def rewrite(self, system, prompt, schema):
        self.calls += 1
        return self._transform()


def _rewrite_from_content(mutate=None):
    """RewrittenTutorial válido construido desde el contenido real."""
    steps = []
    for s in STEPS:
        step = render.RewrittenStep(
            key=s["key"],
            what="[taquería] " + s["what"],
            eli5="[taquería] " + s["eli5"],
            tip=s["tip"],
            dialogue=[render.RewrittenTurn(**t) for t in s["dialogue"]],
        )
        if mutate:
            step = mutate(step)
        steps.append(step)
    return render.RewrittenTutorial(steps=steps)


def test_gate_off_without_credentials(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("TUTORIAL_LLM", raising=False)
    assert llm_provider.default_provider() is None

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("TUTORIAL_LLM", "off")
    assert llm_provider.default_provider() is None


def test_endpoint_off_without_provider(client, monkeypatch):
    monkeypatch.setattr(llm_provider, "default_provider", lambda: None)
    data = client.get("/onboarding").json()
    assert data["rewrite_status"] == "off"
    assert all(s["rewritten"] is None for s in data["steps"])


def test_rewrite_generates_in_background_then_serves(client, session_factory, monkeypatch):
    db = session_factory()
    _seed_project(db)
    db.close()
    fake = FakeProvider(_rewrite_from_content)
    monkeypatch.setattr(llm_provider, "default_provider", lambda: fake)

    first = client.get("/onboarding").json()
    assert first["rewrite_status"] == "generando"      # nunca bloquea
    assert all(s["rewritten"] is None for s in first["steps"])

    second = client.get("/onboarding").json()
    assert second["rewrite_status"] == "listo"
    steps = {s["key"]: s for s in second["steps"]}
    rewritten = steps["clientes"]["rewritten"]
    assert rewritten["what"].startswith("[taquería]")
    # el diálogo conserva estructura: mismos turnos, mismos hablantes
    assert [t["speaker"] for t in rewritten["dialogue"]] == \
        [t["speaker"] for t in steps["clientes"]["dialogue"]]
    # el quiz jamás se re-redacta
    assert "quiz" not in (rewritten or {})
    assert steps["clientes"]["quiz"][0]["options"]
    assert fake.calls == 1                              # la caché evita regenerar


def test_rewrite_rejects_invented_numbers(client, session_factory, monkeypatch):
    db = session_factory()
    _seed_project(db)
    db.close()

    def mutate(step):
        if step.key == "proyecto":
            step.what = "Gana $999,999 garantizados. " + step.what
        return step

    fake = FakeProvider(lambda: _rewrite_from_content(mutate))
    monkeypatch.setattr(llm_provider, "default_provider", lambda: fake)

    client.get("/onboarding")
    data = client.get("/onboarding").json()
    steps = {s["key"]: s for s in data["steps"]}
    assert steps["proyecto"]["rewritten"] is None      # fallback por slot
    assert steps["clientes"]["rewritten"] is not None  # el resto sí se sirve


def test_provider_errors_never_break_the_endpoint(client, session_factory, monkeypatch):
    db = session_factory()
    _seed_project(db)
    db.close()

    def explode():
        raise RuntimeError("api caída")

    fake = FakeProvider(explode)
    monkeypatch.setattr(llm_provider, "default_provider", lambda: fake)

    for _ in range(render.MAX_ATTEMPTS):
        resp = client.get("/onboarding")
        assert resp.status_code == 200

    data = client.get("/onboarding").json()
    assert data["rewrite_status"] == "agotado"
    assert fake.calls == render.MAX_ATTEMPTS           # y deja de intentar


def test_context_change_invalidates_cache(client, session_factory, monkeypatch):
    db = session_factory()
    _seed_project(db)
    db.close()
    fake = FakeProvider(_rewrite_from_content)
    monkeypatch.setattr(llm_provider, "default_provider", lambda: fake)

    client.get("/onboarding")
    assert client.get("/onboarding").json()["rewrite_status"] == "listo"

    from sqlalchemy import select
    from app.models import Client as ClientModel
    db = session_factory()
    first = db.execute(select(ClientModel)).scalars().first()
    first.industry = "florería"
    db.commit()
    db.close()

    assert client.get("/onboarding").json()["rewrite_status"] == "generando"