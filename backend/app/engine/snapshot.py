"""Snapshots inmutables (4.3): congelan todos los inputs de una corrida.

Mismos inputs + misma versión del motor = mismos outputs (1.2).
El hash canónico permite verificar determinismo e idempotencia.
"""
import hashlib
import json
from decimal import Decimal

from app.engine.money import D
from app.engine import assumptions as A

ENGINE_VERSION = "1.1.0"


def canonical_json(data) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def hash_of(data) -> str:
    return hashlib.sha256(canonical_json(data).encode("utf-8")).hexdigest()


def _weighted_portfolio_profile(clients: list) -> dict | None:
    """Promedio ponderado de líneas base del portafolio (etiquetado como estimado).

    clients: [{"id","trade_name","industry","status","baseline":{...}|None}]
    """
    with_baseline = [c for c in clients if c.get("baseline") and c.get("status") in ("active", "onboarding")]
    if not with_baseline:
        return None
    n = Decimal(len(with_baseline))
    tot_sales = sum(D(c["baseline"]["avg_monthly_sales"]) for c in with_baseline)
    tot_tx = sum(D(c["baseline"]["avg_monthly_transactions"]) for c in with_baseline)
    tot_consumers = sum(D(c["baseline"]["active_consumers"]) for c in with_baseline)
    tot_buyers = sum(D(c["baseline"]["monthly_buyers"]) for c in with_baseline)
    # margen ponderado por ventas
    margin_num = sum(D(c["baseline"]["avg_monthly_sales"]) * D(c["baseline"]["margin_pct"]) for c in with_baseline)
    avg_ticket = (tot_sales / tot_tx) if tot_tx > 0 else Decimal("0")
    freq_num = sum(D(c["baseline"]["purchase_frequency"]) for c in with_baseline)
    return {
        "clients_with_baseline": int(n),
        "avg_monthly_sales_per_client": str(tot_sales / n),
        "avg_transactions_per_client": str(tot_tx / n),
        "avg_ticket": str(avg_ticket),
        "margin_pct": str(margin_num / tot_sales) if tot_sales > 0 else None,
        "consumers_per_client": str(tot_consumers / n),
        "purchase_conversion": str(tot_buyers / tot_consumers) if tot_consumers > 0 else None,
        "purchase_frequency": str(freq_num / n),
        "source_type": "estimado",
    }


def build_snapshot(project: dict, scenario: dict, effective_assumptions: dict,
                   cost_items: list, clients: list) -> dict:
    """Construye el snapshot puro (serializable) que consume el simulador."""
    portfolio_profile = _weighted_portfolio_profile(clients)
    snapshot = {
        "engine_version": ENGINE_VERSION,
        "project": {
            "id": project["id"], "name": project["name"],
            "base_currency": project["base_currency"],
            "start_month": project["start_month"],
            "horizon_months": project["horizon_months"],
        },
        "scenario": {"id": scenario["id"], "name": scenario["name"], "type": scenario["type"]},
        "assumptions": {k: v["value"] for k, v in effective_assumptions.items()},
        "assumption_origins": {k: v["origin"] for k, v in effective_assumptions.items()},
        "cost_items": [
            {
                "name": ci["name"], "category": ci["category"], "behavior": ci["behavior"],
                "amount": str(ci["amount"]), "effective_from": ci["effective_from"],
                "effective_to": ci["effective_to"],
            } for ci in sorted(cost_items, key=lambda x: (x["category"], x["name"]))
        ],
        "portfolio": {
            "active_clients": len([c for c in clients if c.get("status") in ("active", "onboarding")]),
            "profile": portfolio_profile,
            "clients": [
                {"id": c["id"], "trade_name": c["trade_name"], "industry": c["industry"], "status": c["status"]}
                for c in sorted(clients, key=lambda x: x["id"])
            ],
        },
    }
    snapshot["input_hash"] = hash_of({k: v for k, v in snapshot.items() if k != "input_hash"})
    return snapshot


def effective_from_snapshot(snapshot: dict) -> dict:
    """Valores efectivos que usará el motor, combinando supuestos y perfil del portafolio.

    Regla documentada: si el portafolio tiene líneas base, el perfil por cliente
    (ticket, margen, frecuencia, consumidores/cliente, conversión) se estima del
    portafolio (tipo 'estimado'); de lo contrario se usan los supuestos.
    El stock inicial B2B es max(supuesto, clientes activos reales).
    """
    a = dict(snapshot["assumptions"])
    derived = {}
    profile = snapshot["portfolio"].get("profile")
    if profile:
        mapping = {
            "b2c.avg_ticket": profile.get("avg_ticket"),
            "b2c.margin_pct": profile.get("margin_pct"),
            "b2c.purchase_frequency": profile.get("purchase_frequency"),
            "b2c.consumers_initial_per_client": profile.get("consumers_per_client"),
            "b2c.purchase_conversion": profile.get("purchase_conversion"),
        }
        for key, val in mapping.items():
            if val not in (None, "", "0"):
                derived[key] = {"from": a.get(key), "to": val, "source": "portafolio (estimado)"}
                a[key] = val
    real_clients = D(snapshot["portfolio"]["active_clients"])
    assumed = D(a.get("b2b.initial_clients", "0"))
    if real_clients > assumed:
        derived["b2b.initial_clients"] = {"from": str(assumed), "to": str(real_clients), "source": "portafolio (real)"}
        a["b2b.initial_clients"] = str(real_clients)
    return {"assumptions": a, "derived": derived}
