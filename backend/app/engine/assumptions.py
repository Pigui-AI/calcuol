"""Catálogo de supuestos del motor con defaults, unidades y validaciones.

Jerarquía de resolución (pantalla 50): defaults del motor → proyecto (global)
→ escenario. La arquitectura admite alcances cliente/sucursal/campaña.
Porcentajes se almacenan como decimal (0.25 = 25%) — sección 16.1.
"""
from decimal import Decimal
from app.engine.money import D

# key: (default, unidad, descripción)
DEFAULTS = {
    # --- B2B ---
    "b2b.initial_clients":            ("0", "clientes", "Clientes B2B activos al inicio"),
    "b2b.curve.type":                 ("logistic", "", "Curva: linear|exponential|logistic|decelerated"),
    "b2b.curve.max_clients":          ("200", "clientes", "Techo objetivo de clientes"),
    "b2b.curve.rate":                 ("0.25", "", "Parámetro de velocidad de la curva"),
    "b2b.curve.inflection_month":     ("18", "meses", "Mes de inflexión (logística)"),
    "b2b.churn_rate":                 ("0.03", "%", "Churn mensual B2B"),
    "b2b.reactivation_rate":          ("0.05", "%", "Reactivación mensual de churned"),
    "b2b.cac":                        ("3500", "MXN", "CAC completo por cliente activado"),
    "b2b.acquisition_budget_monthly": ("50000", "MXN", "Presupuesto mensual de adquisición"),
    "b2b.onboarding_capacity_monthly":("15", "clientes", "Capacidad de onboarding mensual"),

    # --- B2C (promedios por cliente activo) ---
    "b2c.initial_consumers":              ("0", "consumidores", "Consumidores activos iniciales (total)"),
    "b2c.consumers_initial_per_client":   ("120", "consumidores", "Consumidores activos por cliente al integrarse"),
    "b2c.new_consumers_per_client_monthly":("18", "consumidores", "Nuevos consumidores por cliente activo/mes"),
    "b2c.consumer_churn_rate":            ("0.06", "%", "Churn mensual de consumidores"),
    "b2c.purchase_conversion":            ("0.45", "%", "Consumidores activos que compran en el mes"),
    "b2c.purchase_frequency":             ("1.8", "tx/comprador", "Transacciones por comprador/mes"),
    "b2c.avg_ticket":                     ("180", "MXN", "Ticket promedio"),
    "b2c.margin_pct":                     ("0.35", "%", "Margen elegible sobre venta neta"),

    # --- Cohortes B2C (fase 4, pantallas 24–30) ---
    "b2c.cohort.enabled":                 ("false", "bool", "Modelo de cohortes B2C activo (fase 4)"),
    "b2c.cohort.retention_m1":            ("0.70", "%", "Retención del primer mes tras el alta"),
    "b2c.cohort.retention_stable":        ("0.94", "%", "Retención mensual madura (largo plazo)"),
    "b2c.cohort.retention_ramp":          ("0.85", "%", "Convergencia hacia la retención madura (decimal 0–1)"),
    "b2c.cohort.maturation_months":       ("3", "meses", "Meses para alcanzar actividad de compra plena"),
    "b2c.cohort.initial_activity_factor": ("0.60", "%", "Actividad de compra del primer mes (sobre conversión)"),
    "b2c.cohort.ltv_horizon_months":      ("36", "meses", "Horizonte del LTV por cohorte"),

    # --- Modelo de ingresos: comisiones (3.1) ---
    "revenue.commission.enabled":     ("true", "bool", "Motor de comisiones activo"),
    "revenue.commission.pigui_pct":   ("0.25", "%", "Participación Pigui sobre utilidad elegible"),
    "revenue.commission.points_pct":  ("0.05", "%", "Puntos al consumidor sobre utilidad elegible"),
    "revenue.commission.business_pct":("0.70", "%", "Utilidad neta del negocio"),

    # --- Rutas de pago (3.2) ---
    "payments.stripe_share":          ("0.60", "%", "Parte del GMV cobrada vía Pigui Scan/Stripe"),
    "payments.processing_fee_pct":    ("0.029", "%", "Fee de procesamiento sobre lo cobrado vía Stripe"),
    "payments.ar.collection_lag_months": ("1", "meses", "Rezago de cobro para ruta en caja"),
    "payments.ar.collection_rate":    ("0.98", "%", "Tasa de cobro de AR (resto incobrable)"),

    # --- Settlements y fees (3.2 refinado, fase 5, pantallas 40–44) ---
    "payments.processing_fee.enabled": ("false", "bool", "Aplicar payments.processing_fee_pct a lo cobrado vía Stripe"),
    "payments.settlement.enabled":    ("false", "bool", "Flujo bruto por Stripe con liquidación diferida a negocios"),
    "payments.settlement.lag_months": ("1", "meses", "Rezago de liquidación a negocios (float)"),

    # --- Puntos (5.4) ---
    "points.monthly_redemption_rate": ("0.35", "%", "Redención mensual sobre saldo de puntos"),
    "points.monthly_expiry_rate":     ("0.05", "%", "Expiración mensual sobre saldo (breakage)"),

    # --- Embudo de redención (5.4 refinado, fase 5, pantallas 35–36) ---
    "points.funnel.enabled":          ("false", "bool", "Embudo de redención por edad FIFO (sustituye tasas planas)"),
    "points.funnel.intent_rate":      ("0.50", "%", "Intención mensual de redención sobre saldo inicial"),
    "points.funnel.redemption_conversion": ("0.70", "%", "Conversión de intentos a redenciones efectivas"),
    "points.funnel.expiry_months":    ("12", "meses", "Edad de expiración de puntos no redimidos (FIFO)"),

    # --- Campañas (fase 5, pantallas 31–33, 37) ---
    "campaigns.enabled":              ("false", "bool", "Motor de campañas activo (fase 5)"),
    "campaign.uplift.conversion_pct": ("0", "%", "Uplift relativo de conversión de compra durante la campaña"),
    "campaign.uplift.frequency_pct":  ("0", "%", "Uplift relativo de frecuencia de compra durante la campaña"),
    "campaign.uplift.ticket_pct":     ("0", "%", "Uplift relativo de ticket promedio durante la campaña"),
    "campaign.points.extra_pct":      ("0", "%", "Puntos extra sobre utilidad elegible, fondeados por Pigui"),
    "campaign.redemption.uplift_pct": ("0", "%", "Uplift aditivo de la tasa de redención/intención"),
    "campaign.cost_monthly":          ("0", "MXN", "Costo directo mensual de la campaña"),

    # --- Recompensas (fase 5, pantalla 34) ---
    "rewards.catalog_gating.enabled": ("false", "bool", "Limitar emisión de puntos al catálogo reward_eligible"),
    "rewards.eligible_share":         ("1", "%", "Share de utilidad elegible que emite puntos (derivable del catálogo)"),

    # --- Suscripciones (3.4) ---
    "subs.enabled":                   ("false", "bool", "Motor de suscripciones activo"),
    "subs.start_month":               ("13", "meses", "Mes de activación"),
    "subs.price_monthly":             ("499", "MXN", "Precio mensual del plan"),
    "subs.adoption_rate":             ("0.30", "%", "Adopción sobre clientes activos"),
    "subs.ramp_months":               ("6", "meses", "Meses para alcanzar adopción plena"),

    # --- IA / tokens (3.4) ---
    "tokens.enabled":                 ("false", "bool", "Motor de IA/tokens activo"),
    "tokens.start_month":             ("13", "meses", "Mes de activación"),
    "tokens.revenue_per_client_monthly": ("150", "MXN", "Ingreso promedio de IA por cliente adoptante"),
    "tokens.adoption_rate":           ("0.40", "%", "Adopción sobre clientes activos"),
    "tokens.cost_pct":                ("0.40", "%", "Costo del proveedor sobre ingreso de IA"),

    # --- Finanzas (5.6) ---
    "finance.opening_cash":           ("0", "MXN", "Caja inicial"),
    "finance.operating_buffer":       ("0", "MXN", "Buffer operativo para funding need"),
    "finance.one_time_costs":         ("0", "MXN", "Costos one-time para funding need"),
}

PCT_KEYS = {k for k, (_, u, _d) in DEFAULTS.items() if u == "%"}
BOOL_KEYS = {k for k, (_, u, _d) in DEFAULTS.items() if u == "bool"}


def default_value(key: str) -> str:
    return DEFAULTS[key][0]


def as_bool(value: str) -> bool:
    return str(value).strip().lower() in ("true", "1", "si", "sí", "yes")


def validate(key: str, value: str) -> str | None:
    """Devuelve mensaje de error o None. Reglas del documento (validaciones por pantalla)."""
    if key in BOOL_KEYS:
        return None
    if key == "b2b.curve.type":
        if value not in ("linear", "exponential", "logistic", "decelerated"):
            return "Curva inválida"
        return None
    try:
        v = D(value)
    except Exception:
        return "Valor numérico inválido"
    if key in PCT_KEYS and not (Decimal("0") <= v <= Decimal("1")):
        return "Porcentaje fuera de rango 0–100% (usar decimal 0–1)"
    if key in PCT_KEYS:
        return None
    if v < 0 and key != "finance.opening_cash":
        return "El valor no puede ser negativo"
    return None


def validate_commission_split(pigui: Decimal, points: Decimal, business: Decimal) -> str | None:
    total = pigui + points + business
    if total != Decimal("1"):
        return f"Pigui + puntos + negocio deben sumar 100% (actual: {total * 100}%)"
    return None


def resolve_effective(project_rows, scenario_rows) -> dict:
    """Combina defaults → proyecto → escenario. Cada fila es (key, value, source_type, version).
    Devuelve {key: {"value": str, "origin": str, "source_type": str}}."""
    effective = {
        k: {"value": v[0], "origin": "default", "source_type": "hipotesis", "unit": v[1], "description": v[2]}
        for k, v in DEFAULTS.items()
    }
    for row in project_rows:
        if row.key in effective:
            effective[row.key].update(value=row.value, origin="proyecto", source_type=row.source_type)
    for row in scenario_rows:
        if row.key in effective:
            effective[row.key].update(value=row.value, origin="escenario", source_type=row.source_type)
    return effective
