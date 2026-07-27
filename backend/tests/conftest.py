import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from decimal import Decimal  # noqa: E402
import pytest  # noqa: E402

from app.engine.assumptions import DEFAULTS  # noqa: E402
from app.engine.snapshot import ENGINE_VERSION, hash_of  # noqa: E402


def make_snapshot(overrides: dict | None = None, cost_items: list | None = None,
                  horizon: int = 12, clients: list | None = None) -> dict:
    """Snapshot mínimo y puro para golden tests (sin base de datos)."""
    assumptions = {k: v[0] for k, v in DEFAULTS.items()}
    if overrides:
        assumptions.update({k: str(v) for k, v in overrides.items()})
    snapshot = {
        "engine_version": ENGINE_VERSION,
        "project": {
            "id": "p-test", "name": "Test", "base_currency": "MXN",
            "start_month": "2026-08", "horizon_months": horizon,
        },
        "scenario": {"id": "s-test", "name": "Base", "type": "base"},
        "assumptions": assumptions,
        "assumption_origins": {k: "test" for k in assumptions},
        "cost_items": cost_items or [],
        "portfolio": {"active_clients": 0, "profile": None, "clients": clients or []},
    }
    snapshot["input_hash"] = hash_of({k: v for k, v in snapshot.items() if k != "input_hash"})
    return snapshot


@pytest.fixture
def D():
    return Decimal
