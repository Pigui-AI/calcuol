"""Transacciones operativas, settlements y AR por factura — pantallas 38–44.

Registro append-only de transacciones reales (pantallas 38–39): jamás
UPDATE/DELETE; una corrección es una fila espejo con montos negados y
`reverses_transaction_id` (contra-asiento). Los agregados de cabecera
(pantalla 38) los calcula el servidor con Decimal. Settlements (pantalla 41)
y AR por factura con aging (pantallas 42–43) son lecturas de las filas
derivadas de un run `succeeded`; el frontend no calcula nada (pantalla 44).
"""
from datetime import datetime
from decimal import InvalidOperation

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (Project, Client, Brand, Branch, Campaign, TransactionRecord,
                        SettlementBatch, ArInvoice, SimulationRun, FieldProvenance)
from app.schemas import TransactionIn
from app.engine.money import D, ZERO, q_money, q_count
from app import audit

router = APIRouter()

VALID_ROUTES = ("stripe", "caja")


def project_or_404(db: Session, project_id: str) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Proyecto no encontrado")
    return project


def succeeded_run_or_error(db: Session, run_id: str) -> SimulationRun:
    """Guardas de pantallas 41–43: el run debe existir y haber terminado bien."""
    run = db.get(SimulationRun, run_id)
    if not run:
        raise HTTPException(404, "Run no encontrado")
    if run.status != "succeeded":
        raise HTTPException(409, f"El run está en estado '{run.status}'")
    return run


def _parse_money(value, field: str):
    try:
        parsed = D(value)
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(422, f"'{field}' no es un monto numérico válido: {value!r}")
    if not parsed.is_finite():
        raise HTTPException(422, f"'{field}' debe ser un monto finito: {value!r}")
    return parsed


def serialize_transaction(t: TransactionRecord) -> dict:
    return {"id": t.id, "project_id": t.project_id, "client_id": t.client_id,
            "branch_id": t.branch_id, "campaign_id": t.campaign_id,
            "occurred_on": t.occurred_on, "month_label": t.month_label,
            "amount": str(t.amount), "payment_route": t.payment_route,
            "reward_eligible": t.reward_eligible,
            "points_issued": str(t.points_issued),
            "points_redeemed": str(t.points_redeemed),
            "reference": t.reference,
            "reverses_transaction_id": t.reverses_transaction_id,
            "source_type": t.source_type, "created_by": t.created_by,
            "created_at": t.created_at.isoformat() if t.created_at else None}


def serialize_settlement(s: SettlementBatch) -> dict:
    return {"id": s.id, "run_id": s.run_id, "month_index": s.month_index,
            "month_label": s.month_label,
            "gross_collected": str(s.gross_collected),
            "processing_fee": str(s.processing_fee),
            "pigui_take": str(s.pigui_take),
            "merchant_due": str(s.merchant_due),
            "payout_month_index": s.payout_month_index, "status": s.status}


def serialize_invoice(i: ArInvoice) -> dict:
    return {"id": i.id, "run_id": i.run_id, "invoice_number": i.invoice_number,
            "month_index": i.month_index, "month_label": i.month_label,
            "amount": str(i.amount),
            "due_month_index": i.due_month_index,
            "due_month_label": i.due_month_label,
            "expected_collection": str(i.expected_collection),
            "expected_writeoff": str(i.expected_writeoff),
            "status": i.status}


# ---------------------------------------------------------------------------
# Registro de transacciones (pantallas 38–39)
# ---------------------------------------------------------------------------

@router.get("/projects/{project_id}/transactions/summary")
def transactions_summary(project_id: str, month: str | None = None,
                         db: Session = Depends(get_db)):
    """Cabecera de pantalla 38: agregados server-side con Decimal, por mes y por
    ruta. Los reversos restan solos porque sus montos son negativos."""
    project_or_404(db, project_id)
    rows = db.execute(select(TransactionRecord).where(
        TransactionRecord.project_id == project_id)).scalars().all()
    if month:
        rows = [t for t in rows if t.month_label == month]

    def aggregate(txs: list[TransactionRecord]) -> dict:
        gmv = issued = redeemed = ZERO
        for t in txs:
            gmv += D(t.amount)
            issued += D(t.points_issued)
            redeemed += D(t.points_redeemed)
        return {"count": len(txs), "gmv": str(q_money(gmv)),
                "points_issued": str(q_count(issued)),
                "points_redeemed": str(q_count(redeemed))}

    summary = aggregate(rows)
    summary["by_route"] = {route: aggregate([t for t in rows if t.payment_route == route])
                           for route in VALID_ROUTES}
    return summary


@router.get("/projects/{project_id}/transactions")
def list_transactions(project_id: str, client_id: str | None = None,
                      month: str | None = None, route: str | None = None,
                      campaign_id: str | None = None,
                      db: Session = Depends(get_db)):
    """Pantalla 38: lista filtrada en memoria (filtros opcionales), montos string."""
    project_or_404(db, project_id)
    rows = db.execute(select(TransactionRecord)
                      .where(TransactionRecord.project_id == project_id)
                      .order_by(TransactionRecord.occurred_on.desc(),
                                TransactionRecord.created_at.desc())).scalars().all()
    if client_id:
        rows = [t for t in rows if t.client_id == client_id]
    if month:
        rows = [t for t in rows if t.month_label == month]
    if route:
        rows = [t for t in rows if t.payment_route == route]
    if campaign_id:
        rows = [t for t in rows if t.campaign_id == campaign_id]
    return {"transactions": [serialize_transaction(t) for t in rows]}


@router.post("/projects/{project_id}/transactions", status_code=201)
def create_transactions(project_id: str, payload: TransactionIn | list[TransactionIn],
                        db: Session = Depends(get_db)):
    """Alta individual o en lote (pantalla 39). El servidor deriva `month_label`
    de `occurred_on`; toda fila escribe FieldProvenance y AuditEvent."""
    project_or_404(db, project_id)
    single = isinstance(payload, TransactionIn)
    items = [payload] if single else payload
    if not items:
        raise HTTPException(422, "Se requiere al menos una transacción")

    created: list[TransactionRecord] = []
    for item in items:
        client = db.get(Client, item.client_id)
        if not client or client.project_id != project_id:
            raise HTTPException(422, f"El cliente '{item.client_id}' no pertenece al proyecto")
        if item.payment_route not in VALID_ROUTES:
            raise HTTPException(
                422, f"Ruta de pago inválida: '{item.payment_route}' (usar 'stripe' o 'caja')")
        try:
            datetime.strptime(item.occurred_on, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(422, f"Fecha inexistente: '{item.occurred_on}'")
        if item.branch_id:
            branch = db.get(Branch, item.branch_id)
            brand = db.get(Brand, branch.brand_id) if branch else None
            if not branch or not brand or brand.client_id != item.client_id:
                raise HTTPException(422, f"La sucursal '{item.branch_id}' no pertenece al cliente")
        if item.campaign_id:
            camp = db.get(Campaign, item.campaign_id)
            if not camp or camp.project_id != project_id:
                raise HTTPException(422, f"La campaña '{item.campaign_id}' no pertenece al proyecto")
        amount = _parse_money(item.amount, "amount")
        points_issued = _parse_money(item.points_issued, "points_issued")
        points_redeemed = _parse_money(item.points_redeemed, "points_redeemed")

        tx = TransactionRecord(
            project_id=project_id, client_id=item.client_id,
            branch_id=item.branch_id, campaign_id=item.campaign_id,
            occurred_on=item.occurred_on, month_label=item.occurred_on[:7],
            amount=str(amount), payment_route=item.payment_route,
            reward_eligible=item.reward_eligible,
            points_issued=str(points_issued), points_redeemed=str(points_redeemed),
            reference=item.reference, source_type=item.source_type,
        )
        db.add(tx)
        db.flush()
        db.add(FieldProvenance(
            entity_type="TransactionRecord", entity_id=tx.id, field_name="amount",
            source_type=item.source_type, declared_by=tx.created_by or "usuario",
            locator="captura manual (pantalla 39)",
        ))
        audit.record(db, "transaction.create", "TransactionRecord", tx.id,
                     after={"client_id": tx.client_id, "occurred_on": tx.occurred_on,
                            "amount": str(amount), "payment_route": tx.payment_route})
        created.append(tx)

    db.commit()
    rows = [serialize_transaction(t) for t in created]
    return rows[0] if single else rows


@router.post("/transactions/{transaction_id}/reversal", status_code=201)
def reverse_transaction(transaction_id: str, db: Session = Depends(get_db)):
    """Contra-asiento (pantalla 38, acción "Anular"): fila espejo con montos
    negados. Jamás UPDATE/DELETE sobre la fila original (append-only)."""
    tx = db.get(TransactionRecord, transaction_id)
    if not tx:
        raise HTTPException(404, "Transacción no encontrada")
    existing = db.execute(select(TransactionRecord).where(
        TransactionRecord.reverses_transaction_id == transaction_id)).scalars().first()
    if existing:
        raise HTTPException(409, "Transacción ya revertida")
    if tx.reverses_transaction_id:
        raise HTTPException(409, "No se puede revertir un reverso")

    # ZERO - x evita el "-0" de Decimal al negar montos nulos
    reversal = TransactionRecord(
        project_id=tx.project_id, client_id=tx.client_id, branch_id=tx.branch_id,
        campaign_id=tx.campaign_id, occurred_on=tx.occurred_on,
        month_label=tx.month_label,
        amount=str(ZERO - D(tx.amount)), payment_route=tx.payment_route,
        reward_eligible=tx.reward_eligible,
        points_issued=str(ZERO - D(tx.points_issued)),
        points_redeemed=str(ZERO - D(tx.points_redeemed)),
        reference=tx.reference, reverses_transaction_id=tx.id,
        source_type=tx.source_type,
    )
    db.add(reversal)
    db.flush()
    audit.record(db, "transaction.reversal", "TransactionRecord", reversal.id,
                 after={"reverses_transaction_id": tx.id,
                        "amount": str(reversal.amount)})
    db.commit()
    return serialize_transaction(reversal)


# ---------------------------------------------------------------------------
# Settlements y AR por factura derivados de un run (pantallas 41–43)
# ---------------------------------------------------------------------------

@router.get("/simulation-runs/{run_id}/settlements")
def run_settlements(run_id: str, db: Session = Depends(get_db)):
    """Pantalla 41: filas `SettlementBatch` del run, ordenadas por mes."""
    succeeded_run_or_error(db, run_id)
    rows = db.execute(select(SettlementBatch)
                      .where(SettlementBatch.run_id == run_id)
                      .order_by(SettlementBatch.month_index)).scalars().all()
    return [serialize_settlement(s) for s in rows]


@router.get("/simulation-runs/{run_id}/ar-invoices")
def run_ar_invoices(run_id: str, db: Session = Depends(get_db)):
    """Pantallas 42–43: facturas del run + aging calculado por el servidor con
    Decimal al último mes del horizonte. Invariante: por_cobrar_corriente +
    cobrado_esperado + castigo_esperado = Σ amount."""
    run = succeeded_run_or_error(db, run_id)
    rows = db.execute(select(ArInvoice)
                      .where(ArInvoice.run_id == run_id)
                      .order_by(ArInvoice.month_index)).scalars().all()

    horizon = run.horizon_months
    corriente = cobrado = castigo = ZERO
    for inv in rows:
        if inv.due_month_index > horizon:
            corriente += D(inv.amount)          # aún no vence al cierre del horizonte
        else:
            cobrado += D(inv.expected_collection)
            castigo += D(inv.expected_writeoff)

    return {
        "invoices": [serialize_invoice(i) for i in rows],
        "aging": {
            "por_cobrar_corriente": str(q_money(corriente)),
            "cobrado_esperado": str(q_money(cobrado)),
            "castigo_esperado": str(q_money(castigo)),
        },
    }
