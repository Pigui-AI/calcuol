"""Análisis sobre resultados: sensibilidad (54), comparación (55) y conclusiones (71).

Todo es función pura sobre snapshots y resultados ya calculados: mismas entradas
+ misma versión del motor ⇒ mismas salidas. Las conclusiones se derivan de reglas
explicables que SIEMPRE citan la métrica, el mes y el valor que las respalda
(el documento prohíbe inventar causalidad: se distingue hallazgo de inferencia).
"""
import copy
from decimal import Decimal

from app.engine.money import D, q_money, q_rate, ZERO
from app.engine.simulator import simulate
from app.engine.snapshot import effective_from_snapshot

# Métricas objetivo del tornado: (etiqueta, agregación)
#   sum  → suma del horizonte (flujos)   last → último valor (saldos)
#   summary → escalar del resumen
SENSITIVITY_TARGETS = {
    "pnl.ebitda": ("EBITDA acumulado", "sum"),
    "rev.total": ("Ingresos acumulados", "sum"),
    "tx.gmv": ("GMV acumulado", "sum"),
    "cash.balance_end": ("Caja final", "last"),
    "b2b.clients_end": ("Clientes al cierre", "last"),
    "summary.funding_need": ("Necesidad de capital", "summary"),
    "summary.min_cash": ("Caja mínima", "summary"),
    "summary.final_cash": ("Caja final (resumen)", "summary"),
}

# KPIs comparables entre runs (pantalla 55)
COMPARE_KPIS = [
    ("rev.total", "Ingresos acumulados", "sum"),
    ("tx.gmv", "GMV acumulado", "sum"),
    ("pnl.ebitda", "EBITDA acumulado", "sum"),
    ("pnl.opex", "OPEX acumulado", "sum"),
    ("cash.balance_end", "Caja final", "last"),
    ("b2b.clients_end", "Clientes al cierre", "last"),
    ("b2c.consumers_end", "Consumidores al cierre", "last"),
    ("summary.funding_need", "Necesidad de capital", "summary"),
    ("summary.min_cash", "Caja mínima", "summary"),
    ("summary.breakeven_month", "Mes de break-even", "summary"),
]


def extract_target(result: dict, key: str, agg: str) -> Decimal | None:
    """Valor objetivo de un resultado del motor. None si no es calculable."""
    if agg == "summary":
        raw = result["summary"].get(key.split(".", 1)[1])
        if raw is None:
            return None
        return D(str(raw))
    series = result["metrics"].get(key)
    if not series:
        return None
    values = [v for v in series if v is not None]
    if not values:
        return None
    return sum(values, ZERO) if agg == "sum" else values[-1]


def _with_assumption(snapshot: dict, key: str, value: str) -> dict:
    variant = copy.deepcopy(snapshot)
    variant["assumptions"][key] = str(value)
    return variant


def sensitivity_batch(snapshot: dict, variables: list, target_metric: str) -> dict:
    """Corridas derivadas con UN cambio controlado por variable (pantalla 54).

    `variables`: [{"key": ..., "low": ..., "high": ...}]. Devuelve el baseline y,
    por variable, el valor objetivo en cada extremo, su delta y la elasticidad
    (Δ% del objetivo ÷ Δ% de la variable), comparables contra el mismo baseline.
    """
    label, agg = SENSITIVITY_TARGETS.get(target_metric, (target_metric, "sum"))
    base_result = simulate(snapshot)
    baseline = extract_target(base_result, target_metric, agg)
    # supuestos que el portafolio sobrescribe: variarlos no mueve el resultado,
    # así que la respuesta lo dice en lugar de devolver un impacto cero sin causa
    overridden = effective_from_snapshot(snapshot)["derived"]
    rows = []
    for var in variables:
        key = var["key"]
        base_input = D(snapshot["assumptions"].get(key, "0"))
        out = {"key": key, "baseline_input": str(base_input)}
        if key in overridden:
            out["overridden_by"] = overridden[key].get("source")
            out["effective_value"] = overridden[key].get("to")
        for side in ("low", "high"):
            raw = var.get(side)
            if raw is None:
                out[f"{side}_value"] = None
                out[f"delta_{side}"] = None
                out[f"elasticity_{side}"] = None
                continue
            value = extract_target(simulate(_with_assumption(snapshot, key, raw)),
                                   target_metric, agg)
            out[f"{side}_input"] = str(raw)
            out[f"{side}_value"] = None if value is None else str(q_money(value))
            if value is None or baseline is None:
                out[f"delta_{side}"] = None
                out[f"elasticity_{side}"] = None
                continue
            delta = value - baseline
            out[f"delta_{side}"] = str(q_money(delta))
            # elasticidad: solo definible con baseline y entrada base distintos de cero
            input_delta = D(raw) - base_input
            if baseline != ZERO and base_input != ZERO and input_delta != ZERO:
                elasticity = (delta / baseline) / (input_delta / base_input)
                out[f"elasticity_{side}"] = str(q_rate(elasticity))
            else:
                out[f"elasticity_{side}"] = None
        spans = [abs(D(out[f"delta_{s}"])) for s in ("low", "high")
                 if out.get(f"delta_{s}") is not None]
        out["impact"] = str(q_money(max(spans))) if spans else "0"
        rows.append(out)
    # el tornado se ordena por impacto absoluto descendente
    rows.sort(key=lambda r: D(r["impact"]), reverse=True)
    return {
        "target_metric": target_metric,
        "target_label": label,
        "aggregation": agg,
        "baseline_value": "0" if baseline is None else str(q_money(baseline)),
        "engine_version": base_result["summary"]["engine_version"],
        "input_hash": snapshot.get("input_hash", ""),
        "results": rows,
    }


def compare_runs(runs: list) -> dict:
    """Deltas de KPIs y diferencias de supuestos entre runs (pantalla 55).

    `runs`: [{"id","label","snapshot","summary","metrics"}]; el primero es el
    baseline. Advierte cuando la comparación no es directa (versión del motor,
    horizonte o moneda distintos).
    """
    if not runs:
        return {"kpis": [], "assumption_diffs": [], "warnings": [], "runs": []}
    base = runs[0]
    warnings = []
    for r in runs[1:]:
        if r["summary"].get("engine_version") != base["summary"].get("engine_version"):
            warnings.append(
                f"«{r['label']}» usa el motor v{r['summary'].get('engine_version')} y "
                f"«{base['label']}» v{base['summary'].get('engine_version')}: los deltas "
                "pueden no ser comparables directamente.")
        if r["snapshot"]["project"]["horizon_months"] != base["snapshot"]["project"]["horizon_months"]:
            warnings.append(f"«{r['label']}» tiene un horizonte distinto al baseline.")
        if r["snapshot"]["project"]["base_currency"] != base["snapshot"]["project"]["base_currency"]:
            warnings.append(f"«{r['label']}» está en otra moneda que el baseline.")

    kpis = []
    for key, label, agg in COMPARE_KPIS:
        row = {"key": key, "label": label, "aggregation": agg, "values": []}
        base_value = extract_target(base, key, agg)
        for r in runs:
            value = extract_target(r, key, agg)
            entry = {"run_id": r["id"], "label": r["label"],
                     "value": None if value is None else str(q_money(value))}
            if value is not None and base_value is not None and r["id"] != base["id"]:
                delta = value - base_value
                entry["delta"] = str(q_money(delta))
                entry["delta_pct"] = str(q_rate(delta / base_value)) if base_value != ZERO else None
            row["values"].append(entry)
        kpis.append(row)

    # supuestos con al menos un valor distinto entre los runs comparados
    diffs = []
    all_keys = sorted({k for r in runs for k in r["snapshot"]["assumptions"]})
    for key in all_keys:
        values = [r["snapshot"]["assumptions"].get(key) for r in runs]
        if len(set(values)) > 1:
            diffs.append({"key": key,
                          "values": [{"run_id": r["id"], "label": r["label"], "value": v}
                                     for r, v in zip(runs, values)]})
    return {
        "kpis": kpis,
        "assumption_diffs": diffs,
        "warnings": warnings,
        "runs": [{"id": r["id"], "label": r["label"],
                  "engine_version": r["summary"].get("engine_version"),
                  "horizon_months": r["snapshot"]["project"]["horizon_months"]} for r in runs],
    }


def _ev(metrics_key, month_label, value, label):
    return {"metric_key": metrics_key, "month_label": month_label,
            "value": str(value), "label": label}


def derive_conclusions(result: dict, snapshot: dict) -> list:
    """Hallazgos, riesgos y acciones derivados con reglas explicables (pantalla 71).

    Cada conclusión cita la métrica, el mes y el valor que la sustentan. Las
    reglas describen lo que el run muestra; no afirman causalidad.
    """
    s = result["summary"]
    m = result["metrics"]
    months = result["months"]
    horizon = len(months)
    out = []

    def last(key):
        series = m.get(key) or []
        vals = [(i, v) for i, v in enumerate(series) if v is not None]
        return vals[-1] if vals else (None, None)

    # --- punto de equilibrio (pantalla 68) ---
    if s.get("breakeven_month"):
        idx = int(s["breakeven_month"]) - 1
        out.append({
            "kind": "hallazgo", "code": "breakeven_alcanzado", "severity": "baja",
            "title": f"Punto de equilibrio en el mes {s['breakeven_month']} ({s.get('breakeven_label')})",
            "body": "El EBITDA mensual deja de ser negativo a partir de ese mes en este run.",
            "evidence": [_ev("pnl.ebitda", months[idx], m["pnl.ebitda"][idx],
                             "Primer EBITDA mensual no negativo")],
        })
    else:
        i, v = last("pnl.ebitda")
        out.append({
            "kind": "riesgo", "code": "sin_breakeven", "severity": "alta",
            "title": f"No se alcanza el punto de equilibrio en {horizon} meses",
            "body": "El EBITDA mensual permanece negativo durante todo el horizonte simulado.",
            "evidence": [_ev("pnl.ebitda", months[i], v, "EBITDA del último mes")] if i is not None else [],
        })

    # --- capital y caja (pantalla 69, 5.6) ---
    funding = D(s.get("funding_need", "0"))
    min_cash = D(s.get("min_cash", "0"))
    if funding > ZERO:
        out.append({
            "kind": "hallazgo", "code": "funding_need", "severity": "media",
            "title": f"Necesidad de capital de {q_money(funding):,.2f}",
            "body": "Incluye la caja mínima negativa del horizonte más el buffer operativo "
                    "y los costos one-time configurados.",
            "evidence": [_ev("summary.funding_need", months[-1], q_money(funding), "Necesidad de capital"),
                         _ev("summary.min_cash", months[-1], q_money(min_cash), "Caja mínima del horizonte")],
        })
    if min_cash < ZERO:
        out.append({
            "kind": "riesgo", "code": "caja_negativa", "severity": "alta",
            "title": "La caja llega a saldo negativo dentro del horizonte",
            "body": "Sin financiamiento adicional la operación no puede sostener el plan simulado.",
            "evidence": [_ev("summary.min_cash", months[-1], q_money(min_cash), "Caja mínima")],
        })

    # --- runway (pantalla 69) ---
    runway = m.get("kpi.runway_months") or []
    tight = [(i, v) for i, v in enumerate(runway) if v is not None and v < D("6")]
    if tight:
        i, v = tight[0]
        out.append({
            "kind": "riesgo", "code": "runway_corto", "severity": "alta",
            "title": f"El runway baja de 6 meses en {months[i]}",
            "body": f"Se detectan {len(tight)} meses con runway menor a 6 meses en este run.",
            "evidence": [_ev("kpi.runway_months", months[i], v, "Runway en meses")],
        })

    # --- unit economics (5.6, pantallas 64–65) ---
    i, ltv_cac = last("ue.ltv_cac")
    if ltv_cac is not None:
        if ltv_cac < D("3"):
            out.append({
                "kind": "riesgo", "code": "ltv_cac_bajo", "severity": "media",
                "title": f"LTV/CAC de {ltv_cac} al cierre, por debajo de 3x",
                "body": "La relación entre valor de vida y costo de adquisición queda debajo "
                        "del umbral habitual de referencia para escalar adquisición.",
                "evidence": [_ev("ue.ltv_cac", months[i], ltv_cac, "LTV/CAC del último mes")],
            })
        else:
            out.append({
                "kind": "hallazgo", "code": "ltv_cac_sano", "severity": "baja",
                "title": f"LTV/CAC de {ltv_cac} al cierre",
                "body": "La economía unitaria del run soporta la inversión en adquisición.",
                "evidence": [_ev("ue.ltv_cac", months[i], ltv_cac, "LTV/CAC del último mes")],
            })
    i, payback = last("ue.payback_months")
    if payback is not None and payback > D("18"):
        out.append({
            "kind": "riesgo", "code": "payback_largo", "severity": "media",
            "title": f"Payback de {payback} meses",
            "body": "El CAC tarda más de 18 meses en recuperarse con el margen de contribución "
                    "por cliente de este run.",
            "evidence": [_ev("ue.payback_months", months[i], payback, "Payback en meses")],
        })
    i, cm = last("ue.cm_per_client")
    if cm is not None and cm <= ZERO:
        out.append({
            "kind": "riesgo", "code": "cm_no_positivo", "severity": "alta",
            "title": "El margen de contribución por cliente no es positivo",
            "body": "Con margen de contribución ≤ 0 el payback no es alcanzable y crecer "
                    "aumenta la pérdida.",
            "evidence": [_ev("ue.cm_per_client", months[i], cm, "CM por cliente")],
        })

    # --- restricciones de crecimiento (pantalla 30) ---
    bottlenecks = result.get("logs", {}).get("bottlenecks", [])
    by_cap = [b for b in bottlenecks if b["restriccion_activa"] == "capacidad_onboarding"]
    by_budget = [b for b in bottlenecks if b["restriccion_activa"] == "presupuesto"]
    if by_cap:
        first = by_cap[0]
        out.append({
            "kind": "accion", "code": "ampliar_capacidad", "severity": "media",
            "title": f"Ampliar la capacidad de onboarding: limita el crecimiento en {len(by_cap)} meses",
            "body": "En esos meses las altas activadas quedaron por debajo de las deseadas por "
                    "la capacidad de onboarding configurada.",
            "evidence": [_ev("b2b.adds_activated", months[first["month"] - 1],
                             first["altas_activadas"],
                             f"Altas activadas vs deseadas {first['altas_deseadas']}")],
        })
    if by_budget:
        first = by_budget[0]
        out.append({
            "kind": "accion", "code": "ampliar_presupuesto", "severity": "media",
            "title": f"Revisar el presupuesto de adquisición: limita el crecimiento en {len(by_budget)} meses",
            "body": "El presupuesto mensual dividido entre el CAC quedó por debajo de las altas deseadas.",
            "evidence": [_ev("b2b.adds_activated", months[first["month"] - 1],
                             first["altas_activadas"],
                             f"Altas activadas vs deseadas {first['altas_deseadas']}")],
        })

    # --- calidad de la evidencia (7.1 y 16.2) ---
    derived = s.get("derived_inputs") or {}
    if derived:
        out.append({
            "kind": "hallazgo", "code": "inputs_derivados", "severity": "baja",
            "title": f"{len(derived)} supuestos se derivaron de datos del portafolio",
            "body": "Estos valores no son hipótesis: provienen de las líneas base y el catálogo "
                    "cargados, y están etiquetados como tales en el snapshot: "
                    + ", ".join(sorted(derived)) + ".",
            "evidence": [_ev(k, months[0], v.get("to"), f"Origen: {v.get('source')}")
                         for k, v in sorted(derived.items())],
        })
    return out


def vc_readiness(result: dict, snapshot: dict) -> list:
    """Señales de readiness para VC (apéndice 16.2), cada una citando su métrica."""
    s = result["summary"]
    m = result["metrics"]
    months = result["months"]

    def last(key):
        series = m.get(key) or []
        vals = [(i, v) for i, v in enumerate(series) if v is not None]
        return vals[-1] if vals else (None, None)

    rows = []
    i, clients = last("b2b.clients_end")
    rows.append({"dimension": "Mercado y crecimiento", "metric_key": "b2b.clients_end",
                 "value": None if clients is None else str(clients),
                 "month_label": months[i] if i is not None else None,
                 "signal": "Clientes B2B activos al cierre del horizonte"})
    i, ltv_cac = last("ue.ltv_cac")
    rows.append({"dimension": "Economía", "metric_key": "ue.ltv_cac",
                 "value": None if ltv_cac is None else str(ltv_cac),
                 "month_label": months[i] if i is not None else None,
                 "signal": "LTV/CAC (referencia habitual: ≥ 3x)"})
    i, payback = last("ue.payback_months")
    rows.append({"dimension": "Economía", "metric_key": "ue.payback_months",
                 "value": None if payback is None else str(payback),
                 "month_label": months[i] if i is not None else None,
                 "signal": "Meses de recuperación del CAC"})
    i, consumers = last("b2c.consumers_end")
    rows.append({"dimension": "Retención", "metric_key": "b2c.consumers_end",
                 "value": None if consumers is None else str(consumers),
                 "month_label": months[i] if i is not None else None,
                 "signal": "Consumidores activos al cierre"})
    i, take = last("ue.take_rate")
    rows.append({"dimension": "Producto", "metric_key": "ue.take_rate",
                 "value": None if take is None else str(take),
                 "month_label": months[i] if i is not None else None,
                 "signal": "Take rate sobre GMV"})
    rows.append({"dimension": "Finanzas", "metric_key": "summary.funding_need",
                 "value": s.get("funding_need"), "month_label": months[-1] if months else None,
                 "signal": "Capital requerido según el plan"})
    rows.append({"dimension": "Finanzas", "metric_key": "summary.breakeven_month",
                 "value": None if not s.get("breakeven_month") else str(s["breakeven_month"]),
                 "month_label": s.get("breakeven_label"),
                 "signal": "Mes de punto de equilibrio (vacío si no se alcanza)"})

    # calidad de evidencia: proporción de supuestos que siguen siendo hipótesis
    origins = snapshot.get("assumption_origins") or {}
    total = len(origins)
    declared = sum(1 for v in origins.values() if v in ("proyecto", "escenario"))
    derived = len(s.get("derived_inputs") or {})
    share = (D(declared + derived) / D(total)) if total else ZERO
    rows.append({"dimension": "Calidad de evidencia", "metric_key": "assumptions.declared_share",
                 "value": str(q_rate(share)), "month_label": None,
                 "signal": f"{declared + derived} de {total} supuestos declarados o derivados "
                           "(el resto son defaults del motor)"})
    return rows
