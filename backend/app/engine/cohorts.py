"""Cohortes B2C — fase 4 (pantallas 24–30), sección 5 del documento.

Cada cohorte agrupa a los consumidores dados de alta en un mes calendario.
La retención mensual depende de la antigüedad de la cohorte y converge de la
retención del primer mes hacia la retención madura:

    ret(edad) = estable + (m1 - estable) * ramp^(edad - 1)      (edad >= 1)

La actividad de compra (sobre la conversión) también madura: arranca en
`initial_activity_factor` y crece linealmente hasta 1.0 en `maturation_months`.
Todo en Decimal; el redondeo ocurre al emitir métricas, nunca aquí (16.1).
"""
from decimal import Decimal

from app.engine.money import D, ZERO, ONE


def monthly_retention(age: int, r1: Decimal, stable: Decimal, ramp: Decimal) -> Decimal:
    """Retención mensual a la edad dada (1 = primer mes tras el alta)."""
    if age < 1:
        return ONE
    if age == 1:
        ret = r1   # equivale a ramp^0 = 1; evita Decimal 0**0 (inválido) con ramp = 0
    else:
        ret = stable + (r1 - stable) * (ramp ** (age - 1))
    if ret < ZERO:
        return ZERO
    if ret > ONE:
        return ONE
    return ret


def activity_factor(age: int, initial_factor: Decimal, maturation_months: int) -> Decimal:
    """Factor de actividad de compra según antigüedad (1 = mes del alta)."""
    if maturation_months <= 1 or age >= maturation_months:
        return ONE
    if age < 1:
        return initial_factor
    step = (ONE - initial_factor) / D(maturation_months - 1)
    factor = initial_factor + step * D(age - 1)
    return factor if factor < ONE else ONE


def survival_to(age: int, r1: Decimal, stable: Decimal, ramp: Decimal) -> Decimal:
    """Fracción de la cohorte presente al INICIO de la edad dada.

    survival_to(1) = 1 (recién dados de alta); survival_to(a) aplica las
    retenciones de las edades 1..a-1.
    """
    surv = ONE
    for k in range(1, age):
        surv *= monthly_retention(k, r1, stable, ramp)
    return surv


def ltv_b2c(conversion: Decimal, frequency: Decimal, ticket: Decimal, margin_pct: Decimal,
            pigui_pct: Decimal, r1: Decimal, stable: Decimal, ramp: Decimal,
            initial_factor: Decimal, maturation_months: int, horizon_months: int) -> Decimal:
    """LTV por cohortes (5.6): comisión esperada de Pigui por consumidor dado de alta.

    Alineado con la convención de devengo del simulador: la cohorte aporta medio
    mes en su mes de alta (presencia promedio 1/2) y después presencia promedio
    (supervivencia inicial + final) / 2 de cada mes. Así Σ rev.commission de una
    cohorte aislada reconcilia con ltv_b2c · tamaño inicial.
    Sin redondeo intermedio; el llamador cuantiza al emitir.
    """
    def monthly_value(age: int) -> Decimal:
        return conversion * activity_factor(age, initial_factor, maturation_months) \
            * frequency * ticket * margin_pct * pigui_pct

    if horizon_months < 1:
        return ZERO
    total = monthly_value(1) / 2   # mes del alta: presencia promedio 1/2
    surv_start = ONE               # supervivencia al inicio del mes siguiente
    for age in range(2, horizon_months + 1):
        surv_end = surv_start * monthly_retention(age - 1, r1, stable, ramp)
        total += (surv_start + surv_end) / 2 * monthly_value(age)
        surv_start = surv_end
    return total
