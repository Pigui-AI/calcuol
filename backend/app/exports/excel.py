"""Exportación a Excel — sección 13.1. Cada workbook referencia el run que lo originó."""
import os
from datetime import datetime, timezone
from decimal import Decimal

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import SimulationRun, MonthlyProjection, Client, Project
from app.engine.money import D

HEADER_FILL = PatternFill("solid", fgColor="1F2A44")
HEADER_FONT = Font(color="FFFFFF", bold=True)
TITLE_FONT = Font(bold=True, size=14)
MONEY_FMT = "#,##0.00"
COUNT_FMT = "#,##0.0"

EXPORT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "exports_files")

PNL_ROWS = [
    ("Ingresos por comisiones", "rev.commission"),
    ("Ingresos por suscripciones", "rev.subscriptions"),
    ("Ingresos por IA/tokens", "rev.tokens"),
    ("Ingresos totales", "pnl.revenue"),
    ("Costos variables", "pnl.variable_costs"),
    ("Margen bruto", "pnl.gross_margin"),
    ("Contribution Margin", "pnl.contribution_margin"),
    ("OPEX (fijos + adquisición)", "pnl.opex"),
    ("EBITDA", "pnl.ebitda"),
]

CASH_ROWS = [
    ("Cobro inmediato (Stripe/Pigui Scan)", "cash.collected_immediate"),
    ("Cobranza de AR", "ar.collections"),
    ("Entradas totales", "cash.in_total"),
    ("Salidas totales", "cash.out_total"),
    ("Pago de redenciones de puntos", "cash.points_paid_out"),
    ("Flujo neto", "cash.net"),
    ("Caja al cierre", "cash.balance_end"),
    ("AR nueva", "ar.new"),
    ("AR saldo", "ar.balance_end"),
    ("Incobrables", "ar.writeoffs"),
]

PLAN_ROWS = [
    ("Clientes B2B al cierre", "b2b.clients_end", COUNT_FMT),
    ("Altas activadas", "b2b.adds_activated", COUNT_FMT),
    ("Churn B2B", "b2b.churned", COUNT_FMT),
    ("Consumidores activos", "b2c.consumers_end", COUNT_FMT),
    ("Compradores", "b2c.buyers", COUNT_FMT),
    ("Transacciones", "b2c.transactions", COUNT_FMT),
    ("GMV", "tx.gmv", MONEY_FMT),
    ("Utilidad elegible", "tx.eligible_utility", MONEY_FMT),
    ("Comisión Pigui", "rev.commission", MONEY_FMT),
    ("Puntos emitidos (valor)", "points.emitted", MONEY_FMT),
    ("Utilidad neta del negocio", "tx.business_net", MONEY_FMT),
    ("Saldo de puntos (pasivo)", "points.balance_end", MONEY_FMT),
    ("Ingresos Pigui", "pnl.revenue", MONEY_FMT),
    ("EBITDA", "pnl.ebitda", MONEY_FMT),
    ("Caja", "cash.balance_end", MONEY_FMT),
]

UE_ROWS = [
    ("ARPA (ingreso por cliente)", "ue.arpa", MONEY_FMT),
    ("Contribution margin por cliente", "ue.cm_per_client", MONEY_FMT),
    ("CAC", "ue.cac", MONEY_FMT),
    ("LTV", "ue.ltv", MONEY_FMT),
    ("LTV/CAC", "ue.ltv_cac", "0.00"),
    ("Payback (meses)", "ue.payback_months", "0.0"),
    ("Take rate sobre GMV", "ue.take_rate", "0.00%"),
    ("Burn neto", "kpi.burn_net", MONEY_FMT),
    ("Runway (meses)", "kpi.runway_months", "0.0"),
]


def _style_header(ws, row, cols):
    for col in range(1, cols + 1):
        cell = ws.cell(row=row, column=col)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(horizontal="center")


def _metric_matrix(db: Session, run_id: str) -> dict:
    rows = db.execute(select(MonthlyProjection).where(MonthlyProjection.run_id == run_id))
    metrics: dict[str, dict[int, Decimal]] = {}
    for r in rows.scalars():
        metrics.setdefault(r.metric_key, {})[r.month_index] = D(r.value)
    return metrics


def _write_metric_sheet(ws, title, months, metrics, rows_def, currency):
    ws.append([title] )
    ws["A1"].font = TITLE_FONT
    ws.append([f"Moneda: {currency}. Valores mensuales."])
    ws.append([])
    header = ["Concepto"] + months
    ws.append(header)
    _style_header(ws, 4, len(header))
    for defn in rows_def:
        label, key = defn[0], defn[1]
        fmt = defn[2] if len(defn) > 2 else MONEY_FMT
        series = metrics.get(key, {})
        row = [label] + [series.get(i + 1) for i in range(len(months))]
        ws.append(row)
        for col in range(2, len(months) + 2):
            ws.cell(row=ws.max_row, column=col).number_format = fmt
    ws.freeze_panes = "B5"
    ws.column_dimensions["A"].width = 34
    for i in range(len(months)):
        ws.column_dimensions[get_column_letter(i + 2)].width = 12


def generate_workbook(db: Session, run: SimulationRun) -> str:
    os.makedirs(EXPORT_DIR, exist_ok=True)
    snapshot = run.snapshot
    project_info = snapshot["project"]
    scenario_info = snapshot["scenario"]
    currency = project_info["base_currency"]
    summary = (run.logs or {}).get("summary", {})
    metrics = _metric_matrix(db, run.id)
    from app.engine.simulator import month_label
    months = [month_label(project_info["start_month"], i)
              for i in range(1, run.horizon_months + 1)]

    wb = Workbook()

    # --- README ---
    ws = wb.active
    ws.title = "README"
    meta = [
        ("Pigui Financial Engine — Export", ""),
        ("Proyecto", project_info["name"]),
        ("Escenario", f"{scenario_info['name']} ({scenario_info['type']})"),
        ("Run de simulación", run.id),
        ("Hash de inputs", run.input_hash),
        ("Hash de outputs", run.output_hash or ""),
        ("Versión del motor", run.engine_version),
        ("Horizonte (meses)", run.horizon_months),
        ("Mes de inicio", project_info["start_month"]),
        ("Moneda", currency),
        ("Generado (UTC)", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")),
        ("", ""),
        ("Advertencia", "Proyección basada en supuestos e hipótesis; no es contabilidad oficial."),
        ("Punto de equilibrio", summary.get("breakeven_label") or "No alcanzado en el horizonte"),
        ("Necesidad de capital", summary.get("funding_need", "")),
        ("Caja mínima", summary.get("min_cash", "")),
    ]
    for label, value in meta:
        ws.append([label, value])
    ws["A1"].font = TITLE_FONT
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 60

    # --- Assumptions ---
    ws = wb.create_sheet("Assumptions")
    ws.append(["Supuesto", "Valor", "Origen", "Tipo de dato"])
    _style_header(ws, 1, 4)
    origins = snapshot.get("assumption_origins", {})
    for key, value in sorted(snapshot["assumptions"].items()):
        ws.append([key, value, origins.get(key, ""), "hipótesis/declarado"])
    derived = summary.get("derived_inputs", {})
    if derived:
        ws.append([])
        ws.append(["Valores derivados del portafolio (estimado)", "", "", ""])
        ws[f"A{ws.max_row}"].font = Font(bold=True)
        for key, info in derived.items():
            ws.append([key, info.get("to"), info.get("source"), "estimado"])
    ws.column_dimensions["A"].width = 40
    ws.column_dimensions["B"].width = 16
    ws.column_dimensions["C"].width = 24

    # --- Clients ---
    ws = wb.create_sheet("Clients")
    ws.append(["Cliente", "Industria", "Estado", "Sucursales", "Ventas base/mes",
               "Transacciones/mes", "Ticket", "Margen %", "Consumidores activos"])
    _style_header(ws, 1, 9)
    clients = db.execute(select(Client).where(Client.project_id == project_info["id"],
                                              Client.status != "archived")).scalars().all()
    for c in clients:
        b = c.baseline
        branches = sum(len(brand.branches) for brand in c.brands)
        ws.append([
            c.trade_name, c.industry, c.status, branches,
            float(b.avg_monthly_sales) if b else None,
            float(b.avg_monthly_transactions) if b else None,
            float(b.avg_ticket) if b else None,
            float(b.margin_pct) if b else None,
            b.active_consumers if b else None,
        ])
    for col, width in (("A", 28), ("B", 16), ("E", 16), ("F", 16)):
        ws.column_dimensions[col].width = width

    # --- Catalog ---
    ws = wb.create_sheet("Catalog")
    ws.append(["Cliente", "Sucursal", "Tipo", "Artículo", "SKU", "Precio", "Costo directo",
               "Margen", "Margen %", "Elegible rewards"])
    _style_header(ws, 1, 10)
    for c in clients:
        for brand in c.brands:
            for branch in brand.branches:
                for item in branch.catalog_items:
                    price, cost = D(item.sale_price), D(item.direct_cost)
                    margin = price - cost
                    ws.append([c.trade_name, branch.name, item.type, item.name, item.sku,
                               float(price), float(cost), float(margin),
                               float(margin / price) if price > 0 else None,
                               "Sí" if item.reward_eligible else "No"])
    ws.column_dimensions["A"].width = 24
    ws.column_dimensions["D"].width = 30

    # --- Monthly Plan / P&L / Cash Flow / Unit Economics ---
    _write_metric_sheet(wb.create_sheet("Monthly Plan"), "Business plan mensual",
                        months, metrics, PLAN_ROWS, currency)
    _write_metric_sheet(wb.create_sheet("P&L"), "Estado de resultados",
                        months, metrics, PNL_ROWS, currency)
    _write_metric_sheet(wb.create_sheet("Cash Flow"), "Flujo de efectivo",
                        months, metrics, CASH_ROWS, currency)
    _write_metric_sheet(wb.create_sheet("Unit Economics"), "Unit economics",
                        months, metrics, UE_ROWS, currency)

    # --- Scenarios (resumen anual del run) ---
    ws = wb.create_sheet("Scenarios")
    ws.append(["Resumen anual", scenario_info["name"]])
    ws["A1"].font = TITLE_FONT
    ws.append([])
    ws.append(["Año", "Ingresos", "GMV", "EBITDA", "OPEX", "Clientes cierre",
               "Consumidores cierre", "Caja cierre"])
    _style_header(ws, 3, 8)
    for row in summary.get("annual", []):
        ws.append([row["year"], float(row["revenue"]), float(row["gmv"]),
                   float(row["ebitda"]), float(row["opex"]),
                   float(row["clients_end"]) if row["clients_end"] else None,
                   float(row["consumers_end"]) if row["consumers_end"] else None,
                   float(row["cash_end"]) if row["cash_end"] else None])
        for col in range(2, 9):
            ws.cell(row=ws.max_row, column=col).number_format = MONEY_FMT
    for col in ("B", "C", "D", "E", "H"):
        ws.column_dimensions[col].width = 15

    file_name = f"pigui_business_plan_{scenario_info['type']}_{run.id[:8]}.xlsx"
    path = os.path.join(EXPORT_DIR, file_name)
    wb.save(path)
    return path
