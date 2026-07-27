"""Curvas de crecimiento (pantalla 27): lineal, exponencial, logística y desacelerada.

La curva produce el OBJETIVO de stock por mes; el motor aplica después las
restricciones (presupuesto, CAC, capacidad de onboarding) — sección 5.1.
Todo en Decimal para determinismo.
"""
from decimal import Decimal
from app.engine.money import D, q_count, ZERO, ONE

CURVE_TYPES = ("linear", "exponential", "logistic", "decelerated")


def curve_target(curve_type: str, month: int, base: Decimal, max_value: Decimal,
                 rate: Decimal, inflection_month: Decimal) -> Decimal:
    """Objetivo de stock al cierre del mes `month` (1..horizonte)."""
    m = D(month)
    base = D(base)
    max_value = D(max_value)
    rate = D(rate)

    if max_value <= base:
        return q_count(max(base, max_value))

    if curve_type == "linear":
        # rate = altas objetivo por mes
        target = base + rate * m
    elif curve_type == "exponential":
        eff_base = base if base > ZERO else ONE
        target = eff_base * ((ONE + rate) ** int(month))
    elif curve_type == "decelerated":
        # base + (max-base) * (1 - e^(-rate*m))
        target = base + (max_value - base) * (ONE - (-rate * m).exp())
    else:  # logistic (default)
        # base + (max-base) / (1 + e^(-rate*(m - inflexión)))
        k = rate if rate > ZERO else Decimal("0.25")
        exponent = -k * (m - D(inflection_month))
        target = base + (max_value - base) / (ONE + exponent.exp())

    if target > max_value:
        target = max_value
    if target < base:
        target = base
    return q_count(target)
