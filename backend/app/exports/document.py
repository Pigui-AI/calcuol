"""Documento ejecutivo — sección 13.2 del documento maestro (pantalla 72).

Genera un HTML autocontenido (sin dependencias externas, imprimible a PDF desde
el navegador) con las secciones exactas que pide 13.2: portada, resumen y
supuestos, evolución B2B/B2C, campañas/rewards/transacciones/puntos, ingresos
por motor con costos/P&L/cash/unit economics, break-even/burn/runway/capital,
riesgos/sensibilidad/acciones/readiness VC y apéndice con fórmulas, fuentes y
disclaimer.

Regla del documento: cada cifra sale del run que originó el export (métricas
persistidas + resumen del snapshot); aquí no se calcula nada nuevo salvo el
análisis de sensibilidad, que es una corrida derivada del mismo snapshot.
"""
import html
import os
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import SimulationRun, MonthlyProjection
from app.engine.money import D, q_money, q_count, q_rate, ZERO
from app.engine.assumptions import DEFAULTS
from app.engine.analysis import derive_conclusions, vc_readiness, sensitivity_batch
from app.engine.snapshot import ENGINE_VERSION
from app.engine.simulator import month_label
from app.exports.excel import EXPORT_DIR

DASH = "—"

# --- Bloques anuales (etiqueta, métrica, agregación, formato) -----------------
# sum → flujo del periodo · last → saldo al cierre · avg → promedio · min → mínimo

GROWTH_FLOW_ROWS = [
    ("Altas B2B activadas", "b2b.adds_activated", "sum", "count"),
    ("Altas B2B deseadas (antes de restricciones)", "b2b.adds_desired", "sum", "count"),
    ("Churn B2B", "b2b.churned", "sum", "count"),
    ("Reactivaciones B2B", "b2b.reactivated", "sum", "count"),
    ("Clientes B2B promedio del periodo", "b2b.clients_avg", "avg", "count"),
    ("Nuevos consumidores", "b2c.consumers_new", "sum", "count"),
    ("Consumidores dados de baja", "b2c.consumers_churned", "sum", "count"),
    ("Compradores", "b2c.buyers", "sum", "count"),
    ("Transacciones", "b2c.transactions", "sum", "count"),
]

CAMPAIGN_ROWS = [
    ("Campañas activas (promedio de meses)", "camp.active_count", "avg", "count"),
    ("GMV incremental de campañas", "camp.gmv_incremental", "sum", "money"),
    ("Ingreso incremental de campañas", "camp.revenue_incremental", "sum", "money"),
    ("Costo de campañas", "cost.campaigns", "sum", "money"),
    ("Puntos extra de campañas", "camp.extra_points", "sum", "count"),
]

POINTS_ROWS = [
    ("GMV", "tx.gmv", "sum", "money"),
    ("GMV vía Pigui Scan/Stripe", "tx.gmv_stripe", "sum", "money"),
    ("GMV en caja", "tx.gmv_cash", "sum", "money"),
    ("Utilidad elegible", "tx.eligible_utility", "sum", "money"),
    ("Puntos emitidos (valor)", "points.emitted", "sum", "money"),
    ("Puntos redimidos (valor)", "points.redeemed", "sum", "money"),
    ("Puntos expirados (valor)", "points.expired", "sum", "money"),
    ("Saldo de puntos al cierre (pasivo)", "points.balance_end", "last", "money"),
    ("Utilidad neta del negocio (70%)", "tx.business_net", "sum", "money"),
]

REVENUE_ROWS = [
    ("Ingresos por comisiones", "rev.commission", "sum", "money"),
    ("Ingresos por suscripciones", "rev.subscriptions", "sum", "money"),
    ("Ingresos por IA/tokens", "rev.tokens", "sum", "money"),
    ("Ingresos totales Pigui", "rev.total", "sum", "money"),
    ("MRR al cierre", "rev.mrr.end", "last", "money"),
    ("Suscriptores activos al cierre", "subs.active_total", "last", "count"),
]

COST_ROWS = [
    ("Costos variables", "pnl.variable_costs", "sum", "money"),
    ("Fees de procesamiento", "cost.processing_fees", "sum", "money"),
    ("Costo de tokens (proveedor)", "cost.tokens", "sum", "money"),
    ("Costos de campañas", "cost.campaigns", "sum", "money"),
    ("Costos fijos", "cost.fixed", "sum", "money"),
    ("Nómina (hiring plan)", "cost.hiring", "sum", "money"),
    ("Costo de adquisición B2B", "cost.acquisition", "sum", "money"),
    ("OPEX total", "pnl.opex", "sum", "money"),
]

PNL_ROWS = [
    ("Ingresos", "pnl.revenue", "sum", "money"),
    ("Costos variables", "pnl.variable_costs", "sum", "money"),
    ("Margen bruto", "pnl.gross_margin", "sum", "money"),
    ("Contribution Margin", "pnl.contribution_margin", "sum", "money"),
    ("OPEX", "pnl.opex", "sum", "money"),
    ("EBITDA", "pnl.ebitda", "sum", "money"),
]

CASH_ROWS = [
    ("Entradas de caja", "cash.in_total", "sum", "money"),
    ("Cobro inmediato (Pigui Scan/Stripe)", "cash.collected_immediate", "sum", "money"),
    ("Cobranza de AR", "ar.collections", "sum", "money"),
    ("Salidas de caja", "cash.out_total", "sum", "money"),
    ("Pago de redenciones de puntos", "cash.points_paid_out", "sum", "money"),
    ("Liquidaciones a negocios", "stl.paid_out", "sum", "money"),
    ("Flujo neto", "cash.net", "sum", "money"),
    ("Caja al cierre", "cash.balance_end", "last", "money"),
    ("AR al cierre", "ar.balance_end", "last", "money"),
    ("Incobrables", "ar.writeoffs", "sum", "money"),
]

UE_ROWS = [
    ("ARPA (ingreso por cliente activo)", "ue.arpa", "last", "money"),
    ("Contribution margin por cliente", "ue.cm_per_client", "last", "money"),
    ("CAC", "ue.cac", "last", "money"),
    ("LTV", "ue.ltv", "last", "money"),
    ("LTV/CAC", "ue.ltv_cac", "last", "ratio"),
    ("Payback (meses)", "ue.payback_months", "last", "ratio"),
    ("Take rate sobre GMV", "ue.take_rate", "last", "pct"),
]

# Variables del tornado de sensibilidad (pantalla 54): palancas de mayor uso.
SENSITIVITY_VARS = [
    ("b2c.avg_ticket", "Ticket promedio"),
    ("b2c.margin_pct", "Margen elegible sobre venta neta"),
    ("b2b.churn_rate", "Churn mensual B2B"),
    ("b2b.cac", "CAC por cliente activado"),
]

# Fórmulas citadas del documento maestro (secciones 3.1, 5.1–5.6).
FORMULAS = [
    ("3.1 Comisiones", "utilidad_elegible = max(0, venta_neta − costo_directo − "
     "costo_incentivo − costos_configurados)"),
    ("3.1 Distribución 25/5/70", "comision_pigui = utilidad_elegible × 25% · "
     "puntos = utilidad_elegible × 5% · negocio = utilidad_elegible × 70% (suma = 100%)"),
    ("5.1 B2B", "clientes_fin = inicio + altas_activadas + reactivados − churned − bajas_manual · "
     "altas = min(leads×conversion, presupuesto/CAC, capacidad_onboarding, objetivo_curva − base)"),
    ("5.2 B2C", "consumidores_fin = inicio + nuevos + reactivados − abandonos · "
     "compradores = activos × conversion_compra · transacciones = compradores × frecuencia"),
    ("5.4 Puntos y cash", "puntos_fin = inicio + emitidos − redimidos − expirados − ajustes. "
     "Los puntos emitidos NO son ingreso: son pasivo/fondo restringido"),
    ("5.4 AR", "AR_fin = AR_inicio + comisiones_no_cobradas + puntos_financiados − cobros "
     "− notas − incobrables"),
    ("5.5 P&L", "EBITDA = Contribution Margin − OPEX"),
    ("5.6 CAC", "CAC = (marketing + ventas + herramientas + personal + incentivos) / "
     "clientes_nuevos_activados (variante por default: activado)"),
    ("5.6 LTV", "LTV = CM_mensual_por_cliente / churn (aproximación; en producción, cohortes "
     "y flujo descontado)"),
    ("5.6 Payback", "payback = CAC / CM_mensual (no alcanzable si CM ≤ 0)"),
    ("5.6 Necesidad de capital", "funding_need = |min(caja_acumulada)| + buffer + one_time"),
    ("16.1 Dinero", "Aritmética decimal, porcentajes como decimal (0.25 = 25%) y redondeo al "
     "final del cálculo, nunca en pasos intermedios"),
]

STYLE = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
       color: #1f2a44; margin: 0; padding: 32px 40px 64px; line-height: 1.45;
       font-size: 13px; background: #fff; }
.wrap { max-width: 1040px; margin: 0 auto; }
h1 { font-size: 27px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 34px 0 10px; padding-bottom: 6px;
     border-bottom: 2px solid #1f2a44; }
h3 { font-size: 15px; margin: 20px 0 8px; color: #29365a; }
p { margin: 8px 0; }
.cover { border: 1px solid #d6dbe6; border-left: 6px solid #1f2a44; padding: 22px 24px;
         background: #f7f9fc; }
.cover .subtitle { font-size: 15px; color: #48547a; margin: 0 0 14px; }
.meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 26px; margin-top: 8px; }
.meta div { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0;
            border-bottom: 1px dotted #cdd4e2; }
.meta span.k { color: #5a6485; }
.meta span.v { font-weight: 600; text-align: right; }
.hash { font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size: 11px; word-break: break-all; }
table { border-collapse: collapse; width: 100%; margin: 10px 0 18px; font-size: 12px; }
th, td { border: 1px solid #dde2ec; padding: 5px 8px; text-align: left; vertical-align: top; }
thead th { background: #1f2a44; color: #fff; font-weight: 600; }
tbody tr:nth-child(even) { background: #f6f8fc; }
td.num, th.num { text-align: right; white-space: nowrap; }
tbody tr.total td { font-weight: 700; background: #eef2f9; }
.cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 14px 0 6px; }
.card { border: 1px solid #dde2ec; border-radius: 6px; padding: 10px 12px; background: #fbfcfe; }
.card .label { font-size: 11px; color: #5a6485; text-transform: uppercase; letter-spacing: .03em; }
.card .value { font-size: 17px; font-weight: 700; margin-top: 4px; }
.card .foot { font-size: 11px; color: #6b7597; margin-top: 2px; }
.finding { border: 1px solid #dde2ec; border-left: 5px solid #8b93ab; border-radius: 4px;
           padding: 10px 14px; margin: 10px 0; background: #fbfcfe; }
.finding.riesgo { border-left-color: #b3261e; }
.finding.accion { border-left-color: #b26a00; }
.finding.hallazgo { border-left-color: #1f7a4d; }
.finding h4 { margin: 0 0 4px; font-size: 14px; }
.badge { display: inline-block; font-size: 10px; letter-spacing: .04em; text-transform: uppercase;
         border-radius: 3px; padding: 2px 6px; margin-right: 6px; background: #e6eaf3; color: #29365a; }
.badge.alta { background: #f7dedc; color: #8c1d18; }
.badge.media { background: #fbecd4; color: #8a5300; }
.badge.baja { background: #dff0e6; color: #14603b; }
.finding table { margin: 8px 0 0; font-size: 11px; }
.note, .empty { color: #5a6485; font-style: italic; }
.disclaimer { border: 1px solid #e2c9a0; background: #fdf6e9; padding: 12px 16px; border-radius: 4px; }
.toc ol { margin: 6px 0 0 18px; padding: 0; }
.toc li { margin: 2px 0; }
footer { margin-top: 32px; padding-top: 10px; border-top: 1px solid #dde2ec;
         font-size: 11px; color: #6b7597; }
@page { margin: 15mm; }
@media print {
  body { padding: 0; font-size: 11px; }
  h2 { page-break-after: avoid; }
  table, .finding, .card { page-break-inside: avoid; }
  .toc { page-break-after: always; }
}
"""


# --------------------------------------------------------------------------- #
# Utilidades de formato
# --------------------------------------------------------------------------- #

def _dec(value):
    """Decimal o None. Nunca lanza: los logs de runs viejos pueden traer texto."""
    if value is None or value == "":
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return D(value)
    except (InvalidOperation, ValueError, TypeError):
        return None


def _money(value):
    d = _dec(value)
    return DASH if d is None else f"{q_money(d):,.2f}"


def _count(value):
    """Stocks (clientes, consumidores, transacciones) redondeados a un decimal.

    El motor los guarda con cuatro decimales; el redondeo es solo de presentación
    y se advierte en el apéndice. El valor exacto vive en el run y en el xlsx.
    """
    d = _dec(value)
    if d is None:
        return DASH
    d = q_count(d).quantize(Decimal("0.1"))
    return f"{int(d):,}" if d == d.to_integral_value() else f"{d:,.1f}"


def _ratio(value):
    d = _dec(value)
    return DASH if d is None else f"{d:,.2f}"


def _pct(value):
    d = _dec(value)
    return DASH if d is None else f"{q_rate(d) * 100:,.2f}%"


def _num_str(value):
    """Valor tal cual lo emitió el run, con separador de miles y sin ceros de relleno."""
    d = _dec(value)
    if d is None:
        return DASH if value in (None, "") else str(value)
    text = format(d, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    negative = text.startswith("-")
    integer, _, fraction = text.lstrip("-").partition(".")
    out = f"{int(integer):,}" + (f".{fraction}" if fraction else "")
    return f"-{out}" if negative else out


FORMATTERS = {"money": _money, "count": _count, "ratio": _ratio, "pct": _pct}


def _esc(value):
    if value is None or value == "":
        return DASH
    return html.escape(str(value))


def _table(headers, rows, num=None, empty="Sin datos para este run.", total_rows=()):
    """Tabla HTML; `num` son los índices de columna alineados a la derecha."""
    if not rows:
        return f'<p class="empty">{_esc(empty)}</p>'
    numeric = set(range(1, len(headers))) if num is None else set(num)
    out = ["<table><thead><tr>"]
    for i, head in enumerate(headers):
        out.append(f'<th class="{"num" if i in numeric else ""}">{_esc(head)}</th>')
    out.append("</tr></thead><tbody>")
    for r, row in enumerate(rows):
        out.append(f'<tr class="{"total" if r in total_rows else ""}">')
        for i, cell in enumerate(row):
            out.append(f'<td class="{"num" if i in numeric else ""}">{_esc(cell)}</td>')
        out.append("</tr>")
    out.append("</tbody></table>")
    return "".join(out)


def _cards(items):
    """Tarjetas de KPI: (etiqueta, valor, pie)."""
    out = ['<div class="cards">']
    for label, value, foot in items:
        out.append(f'<div class="card"><div class="label">{_esc(label)}</div>'
                   f'<div class="value">{_esc(value)}</div>'
                   f'<div class="foot">{_esc(foot) if foot else ""}</div></div>')
    out.append("</div>")
    return "".join(out)


# --------------------------------------------------------------------------- #
# Reconstrucción del resultado del run (mismo patrón que run_results)
# --------------------------------------------------------------------------- #

def _run_result(db: Session, run: SimulationRun) -> dict:
    """Resultado del run reconstruido desde MonthlyProjection + run.logs.

    Los valores son Decimal porque `analysis` compara y agrega con Decimal.
    """
    horizon = run.horizon_months
    start = run.snapshot["project"]["start_month"]
    months = [month_label(start, i) for i in range(1, horizon + 1)]
    rows = db.execute(select(MonthlyProjection)
                      .where(MonthlyProjection.run_id == run.id)).scalars().all()
    metrics: dict[str, list] = {}
    for row in rows:
        series = metrics.setdefault(row.metric_key, [None] * horizon)
        if 1 <= row.month_index <= horizon:
            series[row.month_index - 1] = D(row.value)
    logs = run.logs or {}
    return {
        "months": months,
        "metrics": metrics,
        "summary": logs.get("summary") or {},
        "logs": {"bottlenecks": logs.get("bottlenecks") or []},
    }


def _year_bounds(horizon: int):
    """[(año, índice_inicio, índice_fin)] cubriendo también un último año parcial."""
    years = max(1, (horizon + 11) // 12)
    return [(y, (y - 1) * 12, min(y * 12, horizon)) for y in range(1, years + 1)]


def _aggregate(series, lo, hi, agg):
    seg = [v for v in series[lo:hi] if v is not None]
    if not seg:
        return None
    if agg == "sum":
        return sum(seg, ZERO)
    if agg == "avg":
        return sum(seg, ZERO) / D(len(seg))
    if agg == "min":
        return min(seg)
    return seg[-1]  # last


def _annual_table(metrics: dict, horizon: int, rows_def) -> str:
    """Matriz anual: filas = concepto, columnas = años + total del horizonte."""
    bounds = _year_bounds(horizon)
    headers = ["Concepto"] + [f"Año {y}" + (" (parcial)" if hi - lo < 12 else "")
                              for y, lo, hi in bounds] + ["Horizonte"]
    body = []
    for label, key, agg, fmt in rows_def:
        series = metrics.get(key)
        if not series:
            continue
        fmt_fn = FORMATTERS[fmt]
        row = [label] + [fmt_fn(_aggregate(series, lo, hi, agg)) for _, lo, hi in bounds]
        row.append(fmt_fn(_aggregate(series, 0, horizon, agg)))
        body.append(row)
    return _table(headers, body,
                  empty="El run no registró estas métricas (motor apagado en el escenario).")


# --------------------------------------------------------------------------- #
# Supuestos efectivos
# --------------------------------------------------------------------------- #

def _same_value(a, b) -> bool:
    da, db = _dec(a), _dec(b)
    if da is not None and db is not None:
        return da == db
    return str(a).strip().lower() == str(b).strip().lower()


def _effective_assumptions(snapshot: dict, summary: dict) -> list:
    """Supuestos efectivos del snapshot que NO son el default del motor.

    El valor efectivo incorpora los `derived_inputs` (estimados del portafolio),
    que sobreescriben al supuesto declarado — sección 7.1 y pantalla 50.
    """
    assumptions = snapshot.get("assumptions", {}) or {}
    origins = snapshot.get("assumption_origins", {}) or {}
    derived = summary.get("derived_inputs") or {}
    out = []
    for key in sorted(set(assumptions) | set(derived)):
        default = DEFAULTS.get(key, ("", "", ""))
        if key in derived:
            value = derived[key].get("to")
            origin = derived[key].get("source", "derivado del portafolio")
            declared = derived[key].get("from")
            detail = (f"Sobrescribe el supuesto declarado {declared}"
                      if declared not in (None, "") else "")
        else:
            value = assumptions.get(key)
            origin = origins.get(key) or "default del motor"
            detail = ""
        if key in DEFAULTS and _same_value(value, default[0]) and key not in derived:
            continue  # es el default del motor: no se lista como supuesto principal
        out.append({
            "key": key, "value": value, "unit": default[1],
            "origin": origin, "default": default[0] if key in DEFAULTS else "",
            "description": (default[2] + (f". {detail}" if detail else "")) if default[2] else detail,
        })
    return out


# --------------------------------------------------------------------------- #
# Secciones
# --------------------------------------------------------------------------- #

def _section_cover(run: SimulationRun, snapshot: dict, months: list, generated: str) -> str:
    project = snapshot["project"]
    scenario = snapshot["scenario"]
    horizon = run.horizon_months
    ventana = f"{months[0]} → {months[-1]}" if months else DASH
    meta = [
        ("Proyecto", project.get("name")),
        ("Escenario", f"{scenario.get('name')} ({scenario.get('type')})"),
        ("Run de simulación", run.id),
        ("Horizonte", f"{horizon} meses ({ventana})"),
        ("Moneda base", project.get("base_currency")),
        ("Fecha de generación (UTC)", generated),
        ("Versión del motor (run)", run.engine_version),
        ("Versión del motor (actual)", ENGINE_VERSION),
    ]
    grid = "".join(f'<div><span class="k">{_esc(k)}</span>'
                   f'<span class="v">{_esc(v)}</span></div>' for k, v in meta)
    hashes = "".join(
        f'<div><span class="k">{_esc(k)}</span>'
        f'<span class="v hash">{_esc(v)}</span></div>'
        for k, v in (("Hash de inputs", run.input_hash),
                     ("Hash de outputs", run.output_hash)))
    return (
        '<header class="cover">'
        "<h1>Documento ejecutivo — Pigui Financial Engine</h1>"
        f'<p class="subtitle">Plan financiero proyectado de {_esc(project.get("name"))} · '
        f'escenario «{_esc(scenario.get("name"))}»</p>'
        f'<div class="meta">{grid}{hashes}</div>'
        "</header>"
        '<nav class="toc"><h2>Contenido</h2><ol>'
        "<li>Portada e identificación del run</li>"
        "<li>Resumen ejecutivo y principales supuestos</li>"
        "<li>Evolución B2B/B2C</li>"
        "<li>Campañas, rewards, transacciones, puntos y valor generado</li>"
        "<li>Ingresos por motor, costos, P&amp;L, cash flow y unit economics</li>"
        "<li>Punto de equilibrio, burn, runway y necesidad de capital</li>"
        "<li>Riesgos, sensibilidad, acciones recomendadas y readiness para VC</li>"
        "<li>Apéndice: fórmulas, fuentes y disclaimer</li>"
        "</ol></nav>"
    )


def _section_summary(run: SimulationRun, snapshot: dict, result: dict) -> str:
    summary = result["summary"]
    metrics = result["metrics"]
    horizon = run.horizon_months
    currency = snapshot["project"].get("base_currency", "")
    months = result["months"]

    def total(key, agg="sum"):
        series = metrics.get(key)
        return None if not series else _aggregate(series, 0, horizon, agg)

    cards = [
        (f"Ingresos acumulados ({currency})", _money(total("rev.total")), f"{horizon} meses"),
        (f"GMV acumulado ({currency})", _money(total("tx.gmv")), "Ventas de los negocios"),
        (f"EBITDA acumulado ({currency})", _money(total("pnl.ebitda")), "CM − OPEX (5.5)"),
        (f"Caja al cierre ({currency})", _money(summary.get("final_cash")), months[-1] if months else ""),
        ("Clientes B2B al cierre", _count(summary.get("final_clients")), months[-1] if months else ""),
        ("Consumidores al cierre", _count(summary.get("final_consumers")), months[-1] if months else ""),
        ("Punto de equilibrio", summary.get("breakeven_label") or "No alcanzado",
         f"Mes {summary['breakeven_month']}" if summary.get("breakeven_month") else "En el horizonte simulado"),
        (f"Necesidad de capital ({currency})", _money(summary.get("funding_need")),
         f"Caja mínima {_money(summary.get('min_cash'))}"),
    ]

    rows = _effective_assumptions(snapshot, summary)
    table = _table(
        ["Supuesto", "Valor efectivo", "Unidad", "Origen", "Default del motor", "Descripción"],
        [[r["key"], r["value"], r["unit"] or DASH, r["origin"], r["default"] or DASH,
          r["description"] or DASH] for r in rows],
        num=(),
        empty="Todos los supuestos del escenario coinciden con los defaults del motor.")
    return (
        "<h2>2. Resumen ejecutivo y principales supuestos</h2>"
        + _cards(cards)
        + f"<p>El plan simula {horizon} meses con el motor v{_esc(run.engine_version)} sobre un "
          "snapshot inmutable de supuestos. Las cifras de este documento provienen exclusivamente "
          f"de las métricas persistidas del run <span class=\"hash\">{_esc(run.id)}</span>.</p>"
        "<h3>2.1 Supuestos efectivos distintos del default</h3>"
        f'<p class="note">{len(rows)} supuesto(s) del escenario difieren del default del motor '
        "o fueron derivados del portafolio. El resto conserva el valor por default (apéndice 8.3).</p>"
        + table
    )


def _section_growth(run: SimulationRun, result: dict) -> str:
    summary = result["summary"]
    metrics = result["metrics"]
    horizon = run.horizon_months
    annual = summary.get("annual") or []
    if annual:
        rows = [[f"Año {a['year']}", _count(a.get("clients_end")), _count(a.get("consumers_end"))]
                for a in annual]
        note = ""
    else:
        # horizonte menor a 12 meses: el resumen anual del motor queda vacío
        rows = []
        for y, lo, hi in _year_bounds(horizon):
            rows.append([f"Año {y} (parcial)",
                         _count(_aggregate(metrics.get("b2b.clients_end", []), lo, hi, "last")),
                         _count(_aggregate(metrics.get("b2c.consumers_end", []), lo, hi, "last"))])
        note = ('<p class="note">El horizonte no cubre un año completo: los cierres se toman '
                "del último mes simulado.</p>")
    cierre = _table(["Periodo", "Clientes B2B al cierre", "Consumidores activos al cierre"], rows)
    return (
        "<h2>3. Evolución B2B/B2C</h2>"
        "<h3>3.1 Saldos al cierre de cada año</h3>"
        + note + cierre
        + "<h3>3.2 Flujos del periodo (altas, churn y actividad)</h3>"
        + _annual_table(metrics, horizon, GROWTH_FLOW_ROWS)
    )


def _section_campaigns(run: SimulationRun, snapshot: dict, result: dict) -> str:
    summary = result["summary"]
    metrics = result["metrics"]
    horizon = run.horizon_months
    campaigns = snapshot.get("campaigns") or []
    rows = []
    for camp in campaigns:
        effects = camp.get("effects") or {}
        rows.append([
            camp.get("name", ""),
            camp.get("campaign_type", ""),
            f"Meses {camp.get('start_month', '')}–{camp.get('end_month', '')}",
            "; ".join(f"{k} = {v}" for k, v in sorted(effects.items())) or DASH,
        ])
    catalogo = _table(["Campaña", "Tipo", "Ventana", "Efectos congelados"], rows, num=(),
                      empty="Este run no congeló campañas en el snapshot.")

    camp_summary = summary.get("campaigns") or {}
    totals = _table(
        ["Indicador del horizonte", "Valor"],
        [["Gasto total en campañas", _money(camp_summary.get("total_spend"))],
         ["Puntos extra totales", _count(camp_summary.get("total_extra_points"))],
         ["GMV incremental total", _money(camp_summary.get("total_gmv_incremental"))],
         ["Ingreso incremental total", _money(camp_summary.get("total_revenue_incremental"))],
         ["ROI total de campañas", _ratio(camp_summary.get("roi_total"))]],
        empty="El run no incluye resumen de campañas.")
    return (
        "<h2>4. Campañas, rewards, transacciones, puntos y valor generado</h2>"
        "<h3>4.1 Campañas congeladas en el snapshot</h3>" + catalogo
        + "<h3>4.2 Resultado de campañas en el horizonte</h3>" + totals
        + _annual_table(metrics, horizon, CAMPAIGN_ROWS)
        + "<h3>4.3 Transacciones, GMV y puntos por año</h3>"
        + _annual_table(metrics, horizon, POINTS_ROWS)
        + '<p class="note">Los puntos emitidos no son ingreso de Pigui: son pasivo hacia el '
          "consumidor hasta su redención o expiración (sección 5.4).</p>"
    )


def _section_pnl(run: SimulationRun, result: dict) -> str:
    metrics = result["metrics"]
    horizon = run.horizon_months
    return (
        "<h2>5. Ingresos por motor, costos, P&amp;L, cash flow y unit economics</h2>"
        "<h3>5.1 Ingresos Pigui por motor</h3>" + _annual_table(metrics, horizon, REVENUE_ROWS)
        + "<h3>5.2 Costos</h3>" + _annual_table(metrics, horizon, COST_ROWS)
        + "<h3>5.3 Estado de resultados</h3>" + _annual_table(metrics, horizon, PNL_ROWS)
        + "<h3>5.4 Flujo de efectivo</h3>" + _annual_table(metrics, horizon, CASH_ROWS)
        + "<h3>5.5 Unit economics (valor del último mes de cada año)</h3>"
        + _annual_table(metrics, horizon, UE_ROWS)
    )


def _section_capital(run: SimulationRun, snapshot: dict, result: dict) -> str:
    summary = result["summary"]
    metrics = result["metrics"]
    months = result["months"]
    horizon = run.horizon_months
    currency = snapshot["project"].get("base_currency", "")

    def month_of(series, predicate):
        for i, v in enumerate(series or []):
            if v is not None and predicate(v):
                return months[i], v
        return None, None

    burn = metrics.get("kpi.burn_net") or []
    burn_months = [(i, v) for i, v in enumerate(burn) if v is not None and v > ZERO]
    burn_avg = (sum((v for _, v in burn_months), ZERO) / D(len(burn_months))) if burn_months else None
    peak_i, peak_v = (max(burn_months, key=lambda t: t[1]) if burn_months else (None, None))

    runway = metrics.get("kpi.runway_months") or []
    runway_vals = [(i, v) for i, v in enumerate(runway) if v is not None]
    last_runway = runway_vals[-1] if runway_vals else (None, None)
    min_runway = min(runway_vals, key=lambda t: t[1]) if runway_vals else (None, None)
    neg_month, neg_value = month_of(metrics.get("cash.balance_end"), lambda v: v < ZERO)

    be = summary.get("breakeven_month")
    rows = [
        ["Punto de equilibrio (primer EBITDA mensual ≥ 0)",
         summary.get("breakeven_label") or "No alcanzado",
         f"Mes {be} del horizonte" if be else f"EBITDA negativo en los {horizon} meses simulados"],
        ["Caja mínima del horizonte", _money(summary.get("min_cash")),
         f"Primer mes con caja negativa: {neg_month}" if neg_month else "La caja nunca es negativa"],
        ["Caja al cierre", _money(summary.get("final_cash")), months[-1] if months else DASH],
        ["Necesidad de capital", _money(summary.get("funding_need")),
         "|min(caja acumulada)| + buffer + costos one-time (5.6)"],
        ["Burn neto promedio (meses con consumo)", _money(burn_avg),
         f"{len(burn_months)} de {horizon} meses con flujo neto negativo"],
        ["Burn neto máximo", _money(peak_v),
         months[peak_i] if peak_i is not None else DASH],
        ["Último runway calculado", _ratio(last_runway[1]) + (" meses" if last_runway[1] is not None else ""),
         f"Último mes con burn promedio negativo: {months[last_runway[0]]}"
         if last_runway[0] is not None else "Sin burn promedio negativo: el runway no aplica"],
        ["Runway mínimo del horizonte",
         _ratio(min_runway[1]) + (" meses" if min_runway[1] is not None else ""),
         months[min_runway[0]] if min_runway[0] is not None else DASH],
    ]
    return (
        "<h2>6. Punto de equilibrio, burn, runway y necesidad de capital</h2>"
        + _table([f"Indicador ({currency})", "Valor", "Evidencia"], rows, num=(1,))
        + f'<p class="note">El runway se calcula con el burn promedio de los últimos tres meses '
          "y solo existe cuando ese promedio es negativo y hay caja disponible (pantalla 69). "
          f'La caja negativa mínima registrada es {_esc(_money(neg_value)) if neg_value is not None else "inexistente"}.</p>'
    )


def _finding_html(item: dict) -> str:
    kind = item.get("kind", "hallazgo")
    severity = item.get("severity", "baja")
    evidence = item.get("evidence") or []
    ev_table = _table(["Métrica", "Mes", "Valor", "Qué sustenta"],
                      [[e.get("metric_key"), e.get("month_label"), _num_str(e.get("value")),
                        e.get("label")] for e in evidence],
                      num=(2,), empty="Conclusión sin evidencia asociada en el run.")
    return (
        f'<div class="finding {html.escape(kind)}">'
        f'<h4><span class="badge {html.escape(severity)}">{_esc(kind)} · {_esc(severity)}</span>'
        f"{_esc(item.get('title'))}</h4>"
        f"<p>{_esc(item.get('body'))}</p>{ev_table}</div>"
    )


def _sensitivity_html(run: SimulationRun, snapshot: dict, summary: dict) -> str:
    """Tornado ±10% sobre las palancas principales (pantalla 54).

    Es una corrida derivada del mismo snapshot: determinista y sin datos nuevos.
    Se omite si el run se produjo con otra versión del motor (no sería comparable)
    o si la palanca fue derivada del portafolio (variarla no cambiaría nada).
    """
    if run.engine_version != ENGINE_VERSION:
        return ('<p class="note">Sensibilidad omitida: el run se ejecutó con el motor '
                f"v{_esc(run.engine_version)} y el motor actual es v{_esc(ENGINE_VERSION)}; "
                "una corrida derivada no sería comparable con este run.</p>")
    assumptions = snapshot.get("assumptions") or {}
    derived = summary.get("derived_inputs") or {}
    variables, labels, skipped = [], {}, []
    for key, label in SENSITIVITY_VARS:
        if key in derived:
            skipped.append(f"{label} ({key}): valor derivado del portafolio")
            continue
        base = _dec(assumptions.get(key))
        if base is None or base == ZERO:
            skipped.append(f"{label} ({key}): sin valor base distinto de cero")
            continue
        variables.append({"key": key, "low": str(base * D("0.9")), "high": str(base * D("1.1"))})
        labels[key] = label
    if not variables:
        return ('<p class="note">No hay palancas variables en este escenario: todas las '
                "candidatas son derivadas del portafolio o valen cero.</p>")
    try:
        out = sensitivity_batch(snapshot, variables, "pnl.ebitda")
    except Exception as exc:  # noqa: BLE001 — el documento no debe fallar por el anexo
        return f'<p class="note">No fue posible calcular la sensibilidad: {_esc(exc)}</p>'
    rows = [[labels.get(r["key"], r["key"]), r["key"], _num_str(r.get("baseline_input")),
             _num_str(r.get("low_input")), _money(r.get("delta_low")),
             _num_str(r.get("high_input")), _money(r.get("delta_high")),
             _money(r.get("impact"))] for r in out["results"]]
    note = ('<p class="note">Palancas excluidas: ' + _esc("; ".join(skipped)) + ".</p>") if skipped else ""
    return (
        f'<p>Variación aislada de ±10% por palanca sobre el objetivo '
        f'«{_esc(out["target_label"])}» (baseline {_money(out["baseline_value"])}). '
        "Cada corrida cambia una sola variable contra el mismo baseline.</p>"
        + _table(["Palanca", "Supuesto", "Base", "−10%", "Δ EBITDA (−10%)",
                  "+10%", "Δ EBITDA (+10%)", "Impacto absoluto"],
                 rows, num=(2, 3, 4, 5, 6, 7))
        + note
    )


def _readiness_value(metric_key: str, raw) -> str:
    if raw in (None, ""):
        return DASH
    if metric_key in ("summary.funding_need",):
        return _money(raw)
    if metric_key in ("ue.take_rate", "assumptions.declared_share"):
        return _pct(raw)
    if metric_key in ("ue.ltv_cac", "ue.payback_months"):
        return _ratio(raw)
    if metric_key in ("b2b.clients_end", "b2c.consumers_end"):
        return _count(raw)
    return _num_str(raw)


def _section_conclusions(run: SimulationRun, snapshot: dict, result: dict) -> str:
    conclusions = derive_conclusions(result, snapshot)
    readiness = vc_readiness(result, snapshot)
    groups = [("riesgo", "7.1 Riesgos detectados"),
              ("accion", "7.3 Acciones recomendadas"),
              ("hallazgo", "7.4 Hallazgos de respaldo")]
    blocks = []
    for kind, title in groups:
        items = [c for c in conclusions if c.get("kind") == kind]
        body = ("".join(_finding_html(c) for c in items) if items
                else f'<p class="empty">Sin elementos de tipo «{kind}» en este run.</p>')
        blocks.append(f"<h3>{title}</h3>{body}")
    readiness_table = _table(
        ["Dimensión", "Señal", "Métrica", "Mes", "Valor"],
        [[r.get("dimension"), r.get("signal"), r.get("metric_key"), r.get("month_label"),
          _readiness_value(r.get("metric_key", ""), r.get("value"))] for r in readiness],
        num=(4,))
    return (
        "<h2>7. Riesgos, sensibilidad, acciones recomendadas y readiness para VC</h2>"
        f'<p class="note">Las conclusiones se derivan de reglas explicables sobre este run y '
        "siempre citan la métrica, el mes y el valor que las sustentan; describen lo que el run "
        "muestra y no afirman causalidad (pantalla 71).</p>"
        + blocks[0]
        + "<h3>7.2 Sensibilidad a las palancas principales</h3>"
        + _sensitivity_html(run, snapshot, result["summary"])
        + blocks[1] + blocks[2]
        + "<h3>7.5 Readiness para VC (apéndice 16.2)</h3>" + readiness_table
    )


def _section_appendix(run: SimulationRun, snapshot: dict, result: dict) -> str:
    summary = result["summary"]
    formulas = _table(["Sección del documento", "Fórmula"],
                      [[s, f] for s, f in FORMULAS], num=())
    derived = summary.get("derived_inputs") or {}
    derived_table = _table(
        ["Supuesto", "Valor declarado", "Valor derivado", "Fuente"],
        [[k, v.get("from"), v.get("to"), v.get("source")] for k, v in sorted(derived.items())],
        num=(),
        empty="Ningún supuesto se derivó del portafolio: todos provienen del escenario o del motor.")
    portfolio = snapshot.get("portfolio") or {}
    origins = snapshot.get("assumption_origins") or {}
    declared = sum(1 for v in origins.values() if v in ("proyecto", "escenario"))
    fuentes = _table(
        ["Fuente", "Detalle"],
        [["Snapshot de inputs", f"Hash {run.input_hash}"],
         ["Outputs del run", f"Hash {run.output_hash or DASH}"],
         ["Versión del motor", run.engine_version],
         ["Clientes activos en el portafolio", str(portfolio.get("active_clients", 0))],
         ["Perfil estimado del portafolio",
          "Sí (ticket, margen, frecuencia y consumidores por cliente)" if portfolio.get("profile")
          else "No: se usaron los supuestos declarados"],
         ["Supuestos declarados en proyecto/escenario", f"{declared} de {len(origins)}"],
         ["Supuestos derivados del portafolio", str(len(derived))]],
        num=())
    return (
        "<h2>8. Apéndice</h2>"
        "<h3>8.1 Fórmulas clave usadas</h3>" + formulas
        + "<h3>8.2 Fuentes y calidad de la evidencia</h3>" + fuentes
        + "<h3>8.3 Valores derivados del portafolio</h3>" + derived_table
        + "<h3>8.4 Disclaimer</h3>"
        '<div class="disclaimer"><p><strong>Las hipótesis no son datos reales.</strong> '
        "Este documento es una proyección construida sobre supuestos e hipótesis congelados en "
        "el snapshot del run; no es contabilidad oficial, no constituye una promesa de resultados "
        "ni asesoría de inversión. Los valores marcados como derivados provienen de las líneas base "
        "y catálogos cargados en el portafolio (tipo «estimado»/«real»); el resto son supuestos "
        "declarados o defaults del motor.</p>"
        "<p>Toda cifra puede reproducirse volviendo a ejecutar el run con el mismo hash de inputs "
        "y la misma versión del motor: mismos inputs + misma versión ⇒ mismos resultados.</p>"
        "<p>Presentación: los montos se muestran con dos decimales en la moneda base del proyecto, "
        "los porcentajes se convierten a % desde su decimal (0.25 = 25%) y los conteos de clientes, "
        "consumidores y transacciones se redondean a un decimal. El valor exacto de cada métrica "
        "está en el export xlsx y en los resultados del run.</p></div>"
    )


# --------------------------------------------------------------------------- #
# Entrada pública
# --------------------------------------------------------------------------- #

def build_document(db: Session, run: SimulationRun) -> str:
    """Documento ejecutivo (13.2) en HTML autocontenido. Devuelve la ruta del archivo."""
    os.makedirs(EXPORT_DIR, exist_ok=True)
    snapshot = run.snapshot
    result = _run_result(db, run)
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    project = snapshot["project"]
    scenario = snapshot["scenario"]

    body = [
        _section_cover(run, snapshot, result["months"], generated),
        _section_summary(run, snapshot, result),
        _section_growth(run, result),
        _section_campaigns(run, snapshot, result),
        _section_pnl(run, result),
        _section_capital(run, snapshot, result),
        _section_conclusions(run, snapshot, result),
        _section_appendix(run, snapshot, result),
        f'<footer>Pigui Financial Engine · motor v{_esc(run.engine_version)} · '
        f'run {_esc(run.id)} · generado el {_esc(generated)} UTC. '
        "Proyección basada en supuestos: no es contabilidad oficial.</footer>",
    ]
    title = f"Documento ejecutivo — {project.get('name')} · {scenario.get('name')}"
    document = (
        "<!DOCTYPE html>\n"
        '<html lang="es"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{_esc(title)}</title><style>{STYLE}</style></head>"
        f'<body><div class="wrap">{"".join(body)}</div></body></html>\n'
    )

    file_name = f"pigui_documento_ejecutivo_{scenario['type']}_{run.id[:8]}.html"
    path = os.path.join(EXPORT_DIR, file_name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(document)
    return path
