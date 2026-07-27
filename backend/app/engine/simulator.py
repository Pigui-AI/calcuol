"""Motor de simulación financiera — secciones 4 y 5 del documento.

Función pura y determinística: snapshot → resultados mensuales.
Orden de cálculo por mes (4.2):
  1. Abrir saldos  2. Adquisición B2B  3. Adopción B2C  4. Campañas (fase 5)
  5. Transacciones y GMV  6. Ingresos Pigui, puntos, AR  7. Costos
  8. Cierre: P&L, cash flow, unit economics, KPIs y saldos siguientes.

Toda la aritmética es Decimal; el redondeo ocurre al emitir cada métrica,
no en pasos intermedios (16.1).
"""
from decimal import Decimal

from app.engine.money import D, q_money, q_count, q_rate, ZERO, ONE
from app.engine.curves import curve_target
from app.engine.assumptions import as_bool
from app.engine.snapshot import effective_from_snapshot, hash_of, ENGINE_VERSION

MONEY_METRICS_PREFIXES = ("tx.", "rev.", "cash.", "ar.", "cost.", "pnl.", "ue.arpa",
                          "ue.cm_per_client", "ue.cac", "ue.ltv", "points.value", "kpi.burn")


def month_label(start_month: str, index: int) -> str:
    """start_month 'YYYY-MM' + (index-1) meses."""
    year, month = int(start_month[:4]), int(start_month[5:7])
    total = year * 12 + (month - 1) + (index - 1)
    return f"{total // 12:04d}-{(total % 12) + 1:02d}"


def _quantize_for(key: str, value: Decimal) -> Decimal:
    if key.startswith(("b2b.", "b2c.", "points.balance", "points.emitted", "points.redeemed",
                       "points.expired", "rev.subscribers")):
        return q_count(value)
    if key.startswith(("ue.ltv_cac", "ue.payback", "ue.take_rate", "pnl.ebitda_margin", "kpi.runway")):
        return q_rate(value)
    return q_money(value)


def simulate(snapshot: dict) -> dict:
    eff = effective_from_snapshot(snapshot)
    a = eff["assumptions"]
    horizon = int(snapshot["project"]["horizon_months"])
    start = snapshot["project"]["start_month"]

    # ---------- parseo de supuestos ----------
    g = lambda k: D(a[k])
    b2b_initial = g("b2b.initial_clients")
    curve_type = a["b2b.curve.type"]
    curve_max = g("b2b.curve.max_clients")
    curve_rate = g("b2b.curve.rate")
    curve_inflection = g("b2b.curve.inflection_month")
    churn_b2b = g("b2b.churn_rate")
    reactivation = g("b2b.reactivation_rate")
    cac = g("b2b.cac")
    budget = g("b2b.acquisition_budget_monthly")
    onboarding_cap = g("b2b.onboarding_capacity_monthly")

    consumers_initial_total = g("b2c.initial_consumers")
    consumers_per_client = g("b2c.consumers_initial_per_client")
    new_consumers_per_client = g("b2c.new_consumers_per_client_monthly")
    churn_b2c = g("b2c.consumer_churn_rate")
    conversion = g("b2c.purchase_conversion")
    frequency = g("b2c.purchase_frequency")
    ticket = g("b2c.avg_ticket")
    margin_pct = g("b2c.margin_pct")

    commission_enabled = as_bool(a["revenue.commission.enabled"])
    pigui_pct = g("revenue.commission.pigui_pct")
    points_pct = g("revenue.commission.points_pct")
    business_pct = g("revenue.commission.business_pct")

    stripe_share = g("payments.stripe_share")
    ar_lag = int(g("payments.ar.collection_lag_months"))
    ar_rate = g("payments.ar.collection_rate")

    redemption_rate = g("points.monthly_redemption_rate")
    expiry_rate = g("points.monthly_expiry_rate")

    subs_enabled = as_bool(a["subs.enabled"])
    subs_start = int(g("subs.start_month"))
    subs_price = g("subs.price_monthly")
    subs_adoption = g("subs.adoption_rate")
    subs_ramp = int(g("subs.ramp_months")) or 1

    tokens_enabled = as_bool(a["tokens.enabled"])
    tokens_start = int(g("tokens.start_month"))
    tokens_rev_per_client = g("tokens.revenue_per_client_monthly")
    tokens_adoption = g("tokens.adoption_rate")
    tokens_cost_pct = g("tokens.cost_pct")

    opening_cash = g("finance.opening_cash")
    buffer = g("finance.operating_buffer")
    one_time = g("finance.one_time_costs")

    cost_items = snapshot.get("cost_items", [])
    all_cost_categories = sorted({ci["category"] for ci in cost_items})

    # ---------- estado ----------
    clients = b2b_initial
    churned_pool = ZERO
    consumers = consumers_initial_total if consumers_initial_total > ZERO else b2b_initial * consumers_per_client
    cash = opening_cash
    min_cash = cash
    points_balance = ZERO
    ar_balance = ZERO
    ar_schedule: dict[int, list] = {}   # mes -> [(monto_cobrable, monto_castigo)]
    metrics: dict[str, list] = {}
    bottlenecks = []
    cash_net_history = []

    def emit(key: str, value):
        metrics.setdefault(key, [])
        if value is None:
            metrics[key].append(None)
        else:
            metrics[key].append(_quantize_for(key, D(value)))

    # ---------- bucle mensual ----------
    for m in range(1, horizon + 1):
        # 1) abrir saldos
        clients_start = clients
        consumers_start = consumers
        cash_start = cash
        points_start = points_balance

        # 2) adquisición B2B
        target = curve_target(curve_type, m, b2b_initial, curve_max, curve_rate, curve_inflection)
        churned = clients_start * churn_b2b
        reactivated = churned_pool * reactivation
        desired = target - (clients_start - churned + reactivated)
        if desired < ZERO:
            desired = ZERO
        budget_cap = (budget / cac) if cac > ZERO else desired
        constraint = "curva"
        adds = desired
        if budget_cap < adds:
            adds, constraint = budget_cap, "presupuesto"
        if onboarding_cap < adds:
            adds, constraint = onboarding_cap, "capacidad_onboarding"
        clients_end = clients_start + adds + reactivated - churned
        churned_pool = churned_pool + churned - reactivated
        clients_avg = (clients_start + clients_end) / 2
        clients = clients_end
        bottlenecks.append({
            "month": m, "objetivo_curva": str(q_count(target)),
            "altas_deseadas": str(q_count(desired)), "altas_activadas": str(q_count(adds)),
            "restriccion_activa": constraint if adds < desired or constraint != "curva" else "curva",
        })

        # 3) adopción B2C
        new_from_new_clients = adds * consumers_per_client
        organic_new = clients_avg * new_consumers_per_client
        consumer_churned = consumers_start * churn_b2c
        consumers_end = consumers_start + new_from_new_clients + organic_new - consumer_churned
        if consumers_end < ZERO:
            consumers_end = ZERO
        consumers_avg = (consumers_start + consumers_end) / 2
        consumers = consumers_end

        # 4) campañas — fase 5 del roadmap (no modeladas en MVP)

        # 5) transacciones y GMV
        buyers = consumers_avg * conversion
        transactions = buyers * frequency
        gmv = transactions * ticket
        eligible_utility = gmv * margin_pct
        direct_costs = gmv - eligible_utility

        # 6) ingresos Pigui, puntos, rutas de pago y AR
        if commission_enabled:
            commission = eligible_utility * pigui_pct
            points_emitted = eligible_utility * points_pct
            business_net = eligible_utility * business_pct
        else:
            commission = points_emitted = ZERO
            business_net = eligible_utility

        pigui_take_total = commission + points_emitted  # dinero que fluye hacia Pigui (puntos = fondo restringido)
        collected_now = pigui_take_total * stripe_share
        to_ar = pigui_take_total - collected_now
        if to_ar > ZERO:
            due = m + ar_lag
            ar_schedule.setdefault(due, []).append((to_ar * ar_rate, to_ar * (ONE - ar_rate)))
        ar_balance += to_ar

        ar_collections = ZERO
        ar_writeoffs = ZERO
        for coll, wo in ar_schedule.pop(m, []):
            ar_collections += coll
            ar_writeoffs += wo
        ar_balance -= (ar_collections + ar_writeoffs)

        # puntos: pasivo append-only (5.4)
        points_redeemed = points_start * redemption_rate
        points_expired = points_start * expiry_rate
        points_balance = points_start + points_emitted - points_redeemed - points_expired

        # suscripciones
        subscribers = ZERO
        subs_revenue = ZERO
        if subs_enabled and m >= subs_start:
            ramp = D(min(subs_ramp, m - subs_start + 1)) / D(subs_ramp)
            subscribers = clients_end * subs_adoption * ramp
            subs_revenue = subscribers * subs_price

        # IA / tokens
        tokens_revenue = ZERO
        tokens_cost = ZERO
        if tokens_enabled and m >= tokens_start:
            tokens_revenue = clients_end * tokens_adoption * tokens_rev_per_client
            tokens_cost = tokens_revenue * tokens_cost_pct

        # ingreso reconocido (devengo). Los puntos emitidos NO son ingreso (5.4).
        revenue_total = commission + subs_revenue + tokens_revenue

        # 7) costos
        acquisition_spend = adds * cac
        fixed_total = ZERO
        variable_items_total = ZERO
        cat_totals: dict[str, Decimal] = {}
        for ci in cost_items:
            frm = int(ci.get("effective_from") or 1)
            to = ci.get("effective_to")
            if m < frm or (to is not None and m > int(to)):
                continue
            amount = D(ci["amount"])
            behavior = ci["behavior"]
            if behavior == "fixed":
                value = amount
                fixed_total += value
            elif behavior == "per_active_client":
                value = amount * clients_avg
                variable_items_total += value
            elif behavior == "per_transaction":
                value = amount * transactions
                variable_items_total += value
            elif behavior == "pct_gmv":
                value = amount * gmv
                variable_items_total += value
            else:
                continue
            cat_totals[ci["category"]] = cat_totals.get(ci["category"], ZERO) + value

        variable_costs = variable_items_total + tokens_cost
        opex = fixed_total + acquisition_spend

        # 8) cierre
        gross_margin = revenue_total - variable_costs
        contribution_margin = gross_margin  # MVP: sin split comercial adicional
        ebitda = contribution_margin - opex
        ebitda_margin = (ebitda / revenue_total) if revenue_total > ZERO else None

        # flujo de efectivo (5.4 / pantalla 60): separar devengo de caja
        points_paid_out = points_redeemed  # pago a negocios por redenciones
        cash_in = collected_now + ar_collections + subs_revenue + tokens_revenue
        cash_out = variable_items_total + tokens_cost + fixed_total + acquisition_spend + points_paid_out
        cash_net = cash_in - cash_out
        cash = cash_start + cash_net
        if cash < min_cash:
            min_cash = cash
        cash_net_history.append(cash_net)

        # unit economics (5.6)
        arpa = (revenue_total / clients_avg) if clients_avg > ZERO else ZERO
        cm_per_client = (contribution_margin / clients_avg) if clients_avg > ZERO else ZERO
        ltv = (cm_per_client / churn_b2b) if (churn_b2b > ZERO and cm_per_client > ZERO) else None
        ltv_cac = (ltv / cac) if (ltv is not None and cac > ZERO) else None
        payback = (cac / cm_per_client) if cm_per_client > ZERO else None
        take_rate = (revenue_total / gmv) if gmv > ZERO else None

        # burn y runway (pantalla 69): burn = consumo neto de caja; runway con burn promedio 3m
        burn = -cash_net if cash_net < ZERO else ZERO
        recent = cash_net_history[-3:]
        avg_net = sum(recent) / D(len(recent))
        runway = (cash / -avg_net) if avg_net < ZERO and cash > ZERO else None

        # ---------- emisión de métricas ----------
        emit("b2b.clients_start", clients_start)
        emit("b2b.target_curve", target)
        emit("b2b.adds_desired", desired)
        emit("b2b.adds_activated", adds)
        emit("b2b.churned", churned)
        emit("b2b.reactivated", reactivated)
        emit("b2b.clients_end", clients_end)
        emit("b2b.clients_avg", clients_avg)
        emit("b2c.consumers_start", consumers_start)
        emit("b2c.consumers_new", new_from_new_clients + organic_new)
        emit("b2c.consumers_churned", consumer_churned)
        emit("b2c.consumers_end", consumers_end)
        emit("b2c.consumers_avg", consumers_avg)
        emit("b2c.buyers", buyers)
        emit("b2c.transactions", transactions)
        emit("tx.gmv", gmv)
        emit("tx.direct_costs", direct_costs)
        emit("tx.eligible_utility", eligible_utility)
        emit("tx.business_net", business_net)
        emit("rev.commission", commission)
        emit("rev.subscriptions", subs_revenue)
        emit("rev.subscribers", subscribers)
        emit("rev.tokens", tokens_revenue)
        emit("rev.total", revenue_total)
        emit("points.emitted", points_emitted)
        emit("points.redeemed", points_redeemed)
        emit("points.expired", points_expired)
        emit("points.balance_end", points_balance)
        emit("cash.collected_immediate", collected_now)
        emit("ar.new", to_ar)
        emit("ar.collections", ar_collections)
        emit("ar.writeoffs", ar_writeoffs)
        emit("ar.balance_end", ar_balance)
        emit("cost.variable_items", variable_items_total)
        emit("cost.tokens", tokens_cost)
        emit("cost.fixed", fixed_total)
        emit("cost.acquisition", acquisition_spend)
        for cat in all_cost_categories:
            emit(f"cost.cat.{cat}", cat_totals.get(cat, ZERO))
        emit("pnl.revenue", revenue_total)
        emit("pnl.variable_costs", variable_costs)
        emit("pnl.gross_margin", gross_margin)
        emit("pnl.contribution_margin", contribution_margin)
        emit("pnl.opex", opex)
        emit("pnl.ebitda", ebitda)
        emit("pnl.ebitda_margin", ebitda_margin)
        emit("cash.in_total", cash_in)
        emit("cash.out_total", cash_out)
        emit("cash.net", cash_net)
        emit("cash.points_paid_out", points_paid_out)
        emit("cash.balance_end", cash)
        emit("ue.arpa", arpa)
        emit("ue.cm_per_client", cm_per_client)
        emit("ue.cac", cac)
        emit("ue.ltv", ltv)
        emit("ue.ltv_cac", ltv_cac)
        emit("ue.payback_months", payback)
        emit("ue.take_rate", take_rate)
        emit("kpi.burn_net", burn)
        emit("kpi.runway_months", runway)

    # ---------- resumen ----------
    ebitda_series = metrics["pnl.ebitda"]
    breakeven_month = next((i + 1 for i, v in enumerate(ebitda_series) if v is not None and v >= ZERO), None)
    funding_need = q_money(abs(min(min_cash, ZERO)) + buffer + one_time)
    labels = [month_label(start, i) for i in range(1, horizon + 1)]

    def year_sum(key, year):
        seg = metrics[key][(year - 1) * 12: year * 12]
        return q_money(sum(v for v in seg if v is not None))

    def year_last(key, year):
        seg = [v for v in metrics[key][(year - 1) * 12: year * 12] if v is not None]
        return seg[-1] if seg else None

    years = list(range(1, (horizon // 12) + 1))
    annual = [{
        "year": y,
        "revenue": str(year_sum("pnl.revenue", y)),
        "gmv": str(year_sum("tx.gmv", y)),
        "ebitda": str(year_sum("pnl.ebitda", y)),
        "opex": str(year_sum("pnl.opex", y)),
        "clients_end": str(year_last("b2b.clients_end", y)),
        "consumers_end": str(year_last("b2c.consumers_end", y)),
        "cash_end": str(year_last("cash.balance_end", y)),
    } for y in years]

    summary = {
        "engine_version": ENGINE_VERSION,
        "horizon_months": horizon,
        "breakeven_month": breakeven_month,
        "breakeven_label": labels[breakeven_month - 1] if breakeven_month else None,
        "min_cash": str(q_money(min_cash)),
        "funding_need": str(funding_need),
        "final_cash": str(q_money(cash)),
        "final_clients": str(q_count(clients)),
        "final_consumers": str(q_count(consumers)),
        "annual": annual,
        "derived_inputs": eff["derived"],
    }

    serializable = {
        key: [None if v is None else str(v) for v in series]
        for key, series in metrics.items()
    }
    output_hash = hash_of({"metrics": serializable, "summary": summary})

    return {
        "months": labels,
        "metrics": metrics,
        "summary": summary,
        "logs": {"bottlenecks": bottlenecks},
        "output_hash": output_hash,
    }
