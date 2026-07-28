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
from app.engine.cohorts import monthly_retention, activity_factor, ltv_b2c as cohort_ltv_b2c
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
                       "points.expired", "points.funnel.", "points.business_returned",
                       "rev.subscribers", "tx.count_", "camp.active_count", "camp.extra_points",
                       "subs.", "tokens.units.", "hiring.")):
        return q_count(value)
    if key.startswith(("ue.ltv_cac", "ue.payback", "ue.take_rate", "pnl.ebitda_margin",
                       "kpi.runway", "camp.roi", "tokens.margin_pct")):
        return q_rate(value)
    return q_money(value)


def simulate(snapshot: dict) -> dict:
    eff = effective_from_snapshot(snapshot)
    a = eff["assumptions"]
    # la sustitución de capacidad por hiring (fase 6, 49→30) se reporta como derivado
    if as_bool(a.get("hiring.capacity.enabled", "false")):
        eff["derived"]["b2b.onboarding_capacity_monthly"] = {
            "from": a.get("b2b.onboarding_capacity_monthly"),
            "to": "capacidad del hiring plan (rampa mensual)",
            "source": "hiring plan",
        }
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

    # cohortes B2C (fase 4, pantallas 24–30); cuando están activas sustituyen
    # el churn plano por retención dependiente de la antigüedad
    cohorts_enabled = as_bool(a["b2c.cohort.enabled"])
    ret_m1 = g("b2c.cohort.retention_m1")
    ret_stable = g("b2c.cohort.retention_stable")
    ret_ramp = g("b2c.cohort.retention_ramp")
    maturation_months = int(g("b2c.cohort.maturation_months"))
    initial_activity = g("b2c.cohort.initial_activity_factor")
    ltv_horizon = int(g("b2c.cohort.ltv_horizon_months"))

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

    # fase 6: modos detallados (suscripciones por plan/trial, tokens por unidad, hiring)
    plans_all = snapshot.get("subscription_plans", [])
    subs_detailed = as_bool(a["subs.detail.enabled"]) and subs_enabled and bool(plans_all)
    tokens_detailed = as_bool(a["tokens.detail.enabled"]) and tokens_enabled
    tok_consumption = g("tokens.consumption_per_adopter_monthly")
    tok_included = g("tokens.included_per_adopter_monthly")
    tok_overage_price = g("tokens.overage_price_per_unit")
    tok_provider_cost = g("tokens.provider_cost_per_unit")
    tok_recharge_share = g("tokens.recharge_share")
    tok_recharge_price = g("tokens.recharge_price_per_unit")
    tok_initial_credit = g("tokens.initial_credit_units")
    tok_credit_expiry = int(g("tokens.credit_expiry_months"))
    hiring_roles = snapshot.get("hiring_roles", [])
    hiring_cap_on = as_bool(a["hiring.capacity.enabled"])

    # fase 5: campañas, gating de rewards, embudo de redención, settlements y fees
    campaigns_on = as_bool(a["campaigns.enabled"])
    campaigns_all = snapshot.get("campaigns", [])
    rewards_gating_on = as_bool(a["rewards.catalog_gating.enabled"])
    eligible_share = g("rewards.eligible_share") if rewards_gating_on else ONE
    funnel_on = as_bool(a["points.funnel.enabled"])
    funnel_intent = g("points.funnel.intent_rate")
    funnel_conv = g("points.funnel.redemption_conversion")
    funnel_expiry_months = int(g("points.funnel.expiry_months"))
    fee_on = as_bool(a["payments.processing_fee.enabled"])
    fee_pct = g("payments.processing_fee_pct")
    settlement_on = as_bool(a["payments.settlement.enabled"])
    settlement_lag = int(g("payments.settlement.lag_months"))

    opening_cash = g("finance.opening_cash")
    buffer = g("finance.operating_buffer")
    one_time = g("finance.one_time_costs")

    cost_items = snapshot.get("cost_items", [])
    all_cost_categories = sorted({ci["category"] for ci in cost_items}
                                 | {r.get("department") or "nomina" for r in hiring_roles})

    # ---------- estado ----------
    clients = b2b_initial
    churned_pool = ZERO
    consumers = consumers_initial_total if consumers_initial_total > ZERO else b2b_initial * consumers_per_client
    # estado de cohortes: el stock inicial se trata como cohorte madura
    cohort_state: list[dict] = []
    if cohorts_enabled and consumers > ZERO:
        cohort_state.append({"month": 0, "size": consumers, "initial": consumers,
                             "mature": True, "series": []})
    cash = opening_cash
    min_cash = cash
    points_balance = ZERO
    ar_balance = ZERO
    ar_schedule: dict[int, list] = {}   # mes -> [(monto_cobrable, monto_castigo)]
    metrics: dict[str, list] = {}
    bottlenecks = []
    cash_net_history = []
    # fase 5: buckets FIFO de puntos [mes_emision, remanente], payable de settlements y logs
    point_buckets: list[list] = []
    payable_schedule: dict[int, Decimal] = {}
    payable_balance = ZERO
    settlements_log = []
    ar_invoices_log = []
    # fase 6: estado de suscripciones detalladas, tokens detallados y sus logs
    plan_by_id = {p["id"]: p for p in plans_all}
    subs_active: dict[str, Decimal] = {p["id"]: ZERO for p in plans_all}
    subs_prev_target: dict[str, Decimal] = {p["id"]: ZERO for p in plans_all}
    trial_pipeline: list[dict] = []
    subs_cohorts_log = []
    token_ledger_log = []
    credit_pool = ZERO
    credit_granted_month = 0

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

        # hiring plan (fase 6, pantalla 49): nómina COMPLETA desde la fecha efectiva;
        # la capacidad de onboarding rampa y puede sustituir el supuesto (49→30)
        payroll = ZERO
        headcount_total = ZERO
        capacity_hiring = ZERO
        cat_hiring: dict[str, Decimal] = {}
        for role in hiring_roles:
            r_start = int(role["start_month"])
            r_end = role.get("end_month")
            if m < r_start or (r_end is not None and m > int(r_end)):
                continue
            hc = D(role["headcount"])
            salary = hc * D(role["monthly_salary"])
            payroll += salary
            dep = role.get("department") or "nomina"
            cat_hiring[dep] = cat_hiring.get(dep, ZERO) + salary
            headcount_total += hc
            r_ramp = int(role["ramp_months"])
            ramp_f = ONE if r_ramp <= 1 else min(ONE, D(m - r_start + 1) / D(r_ramp))
            capacity_hiring += hc * D(role["onboarding_capacity_per_fte"]) * ramp_f
        onboarding_cap_eff = capacity_hiring if hiring_cap_on else onboarding_cap

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
        if onboarding_cap_eff < adds:
            adds, constraint = onboarding_cap_eff, "capacidad_onboarding"
        clients_end = clients_start + adds + reactivated - churned
        churned_pool = churned_pool + churned - reactivated
        clients_avg = (clients_start + clients_end) / 2
        clients = clients_end
        bottleneck_row = {
            "month": m, "objetivo_curva": str(q_count(target)),
            "altas_deseadas": str(q_count(desired)), "altas_activadas": str(q_count(adds)),
            "restriccion_activa": constraint if adds < desired or constraint != "curva" else "curva",
            "capacidad_onboarding": str(q_count(onboarding_cap_eff)),
        }
        if hiring_cap_on:
            bottleneck_row["fuente_capacidad"] = "hiring"
        bottlenecks.append(bottleneck_row)

        # 3) adopción B2C
        new_from_new_clients = adds * consumers_per_client
        organic_new = clients_avg * new_consumers_per_client
        new_consumers = new_from_new_clients + organic_new
        if cohorts_enabled:
            # cohortes (fase 4): retención por antigüedad en lugar de churn plano
            consumer_churned = ZERO
            month_cohorts = []   # (cohorte, tamaño promedio del mes, edad en el mes)
            for c in cohort_state:
                age = m - c["month"]   # meses completos desde el alta
                ret = ret_stable if c["mature"] else monthly_retention(age, ret_m1, ret_stable, ret_ramp)
                before = c["size"]
                after = before * ret
                consumer_churned += before - after
                c["size"] = after
                month_cohorts.append((c, (before + after) / 2, age + 1))
            if new_consumers > ZERO:
                born = {"month": m, "size": new_consumers, "initial": new_consumers,
                        "mature": False, "series": [None] * (m - 1)}
                cohort_state.append(born)
                month_cohorts.append((born, new_consumers / 2, 1))
            consumers_end = sum((c["size"] for c in cohort_state), ZERO)
            for c in cohort_state:
                c["series"].append(c["size"])
        else:
            consumer_churned = consumers_start * churn_b2c
            consumers_end = consumers_start + new_consumers - consumer_churned
            if consumers_end < ZERO:
                consumers_end = ZERO
        consumers_avg = (consumers_start + consumers_end) / 2
        consumers = consumers_end

        # 4) campañas (fase 5): modulan compra/puntos/redención — nunca adquisición
        #    ni adopción (posición en el orden 4.2). Uplifts aditivos entre campañas.
        uc = uf = ut = camp_extra_pct = camp_red_uplift = camp_spend = ZERO
        camp_active = 0
        if campaigns_on:
            for camp in campaigns_all:   # congeladas en el snapshot, ordenadas por id
                if int(camp["start_month"]) <= m <= int(camp["end_month"]):
                    e = camp["effects"]
                    camp_active += 1
                    uc += D(e["campaign.uplift.conversion_pct"])
                    uf += D(e["campaign.uplift.frequency_pct"])
                    ut += D(e["campaign.uplift.ticket_pct"])
                    camp_extra_pct += D(e["campaign.points.extra_pct"])
                    camp_red_uplift += D(e["campaign.redemption.uplift_pct"])
                    camp_spend += D(e["campaign.cost_monthly"])

        # 5) transacciones y GMV (uplifts de campaña; identidad exacta si están en cero)
        conversion_eff = conversion * (ONE + uc)
        frequency_eff = frequency * (ONE + uf)
        ticket_eff = ticket * (ONE + ut)
        if cohorts_enabled:
            # la actividad de compra madura con la edad de la cohorte
            buyers = ZERO
            for c, avg_size, age_in_month in month_cohorts:
                factor = ONE if c["mature"] else activity_factor(age_in_month, initial_activity, maturation_months)
                buyers += avg_size * conversion_eff * factor
        else:
            buyers = consumers_avg * conversion_eff
        transactions = buyers * frequency_eff
        gmv = transactions * ticket_eff
        # contrafactual exacto sin segunda simulación: las campañas no tocan stocks
        camp_factor = (ONE + uc) * (ONE + uf) * (ONE + ut)
        gmv_base = gmv if camp_factor == ONE else gmv / camp_factor
        gmv_incremental = gmv - gmv_base
        tx_count_stripe = transactions * stripe_share
        tx_count_cash = transactions - tx_count_stripe
        tx_gmv_stripe = gmv * stripe_share
        tx_gmv_cash = gmv - tx_gmv_stripe
        eligible_utility = gmv * margin_pct
        direct_costs = gmv - eligible_utility

        # 6) ingresos Pigui, puntos, rutas de pago y AR
        if commission_enabled:
            commission = eligible_utility * pigui_pct
            # gating de rewards (pantalla 34): solo el share elegible emite puntos;
            # el residuo regresa al negocio — conservación del split garantizada
            points_base = eligible_utility * points_pct * eligible_share
            points_returned = eligible_utility * points_pct * (ONE - eligible_share)
            business_net = eligible_utility * business_pct + points_returned
            revenue_incremental = (eligible_utility - gmv_base * margin_pct) * pigui_pct
        else:
            commission = points_base = points_returned = ZERO
            business_net = eligible_utility
            revenue_incremental = ZERO
        camp_extra_points = eligible_utility * camp_extra_pct * eligible_share
        points_emitted_total = points_base + camp_extra_points

        pigui_take_total = commission + points_base  # los puntos extra no los paga el negocio
        collected_now = pigui_take_total * stripe_share
        to_ar = pigui_take_total - collected_now
        if to_ar > ZERO:
            due = m + ar_lag
            ar_schedule.setdefault(due, []).append((to_ar * ar_rate, to_ar * (ONE - ar_rate)))
            ar_invoices_log.append({
                "number": f"INV-{m:04d}", "month": m, "amount": str(q_money(to_ar)),
                "due_month": due,
                "expected_collection": str(q_money(to_ar * ar_rate)),
                "expected_writeoff": str(q_money(to_ar * (ONE - ar_rate))),
            })
        ar_balance += to_ar

        ar_collections = ZERO
        ar_writeoffs = ZERO
        for coll, wo in ar_schedule.pop(m, []):
            ar_collections += coll
            ar_writeoffs += wo
        ar_balance -= (ar_collections + ar_writeoffs)

        # settlements (fase 5, pantalla 41): flujo bruto por Stripe y liquidación diferida
        if settlement_on:
            gross_collected = tx_gmv_stripe
            merchant_due = gross_collected - collected_now
            due_key = m + settlement_lag
            payable_schedule[due_key] = payable_schedule.get(due_key, ZERO) + merchant_due
            paid_out = payable_schedule.pop(m, ZERO)
            payable_balance = payable_balance + merchant_due - paid_out
            fee_base = gross_collected
        else:
            gross_collected = merchant_due = paid_out = ZERO
            fee_base = collected_now
        processing_fee = fee_base * fee_pct if fee_on else ZERO
        if settlement_on:
            settlements_log.append({
                "month": m, "gross_collected": str(q_money(gross_collected)),
                "processing_fee": str(q_money(processing_fee)),
                "pigui_take": str(q_money(collected_now)),
                "merchant_due": str(q_money(merchant_due)),
                "payout_month": m + settlement_lag,
            })

        # puntos: pasivo append-only (5.4); embudo FIFO por edad opcional (fase 5)
        if funnel_on:
            intent_eff = funnel_intent + camp_red_uplift
            if intent_eff > ONE:
                intent_eff = ONE
            funnel_intents = points_start * intent_eff
            redeem_target = funnel_intents * funnel_conv
            points_redeemed = ZERO
            for bucket in point_buckets:   # FIFO: el más viejo primero
                if redeem_target <= ZERO:
                    break
                take = bucket[1] if bucket[1] <= redeem_target else redeem_target
                bucket[1] -= take
                points_redeemed += take
                redeem_target -= take
            points_expired = ZERO
            remaining = []
            for emit_month, rem in point_buckets:
                if rem <= ZERO:
                    continue
                if (m - emit_month) >= funnel_expiry_months:
                    points_expired += rem
                else:
                    remaining.append([emit_month, rem])
            point_buckets = remaining
            if points_emitted_total > ZERO:
                point_buckets.append([m, points_emitted_total])
            points_balance = sum((b[1] for b in point_buckets), ZERO)
        else:
            # redención + expiración operan sobre el mismo saldo inicial: el clamp
            # garantiza que juntas nunca debiten más del 100% (con uplift de campaña)
            red_eff = redemption_rate + camp_red_uplift
            if red_eff > ONE - expiry_rate:
                red_eff = ONE - expiry_rate
            funnel_intents = ZERO
            points_redeemed = points_start * red_eff
            points_expired = points_start * expiry_rate
            points_balance = points_start + points_emitted_total - points_redeemed - points_expired

        # suscripciones — agregado (fase 3) o detallado por plan/trial (fase 6, 45/47/62)
        subscribers = ZERO
        subs_revenue = ZERO
        mrr_start = mrr_new = mrr_exp = mrr_con = mrr_churn = mrr_end = ZERO
        trial_starts_m = conversions_m = ZERO
        if subs_detailed:
            mrr_start = sum((subs_active[p["id"]] * D(p["price_monthly"]) for p in plans_all), ZERO)
            # (a) churn por plan sobre activos al inicio (los nuevos del mes no churnean)
            for p in plans_all:
                churned_p = subs_active[p["id"]] * D(p["churn_rate"])
                subs_active[p["id"]] -= churned_p
                mrr_churn += churned_p * D(p["price_monthly"])
            # (b) upgrades/downgrades: el signo del delta decide el lado del bridge (62)
            for p in plans_all:
                dest = p.get("upgrade_to_plan_id")
                if not dest or dest not in subs_active:
                    continue
                moved = subs_active[p["id"]] * D(p["upgrade_rate"])
                if moved <= ZERO:
                    continue
                subs_active[p["id"]] -= moved
                subs_active[dest] += moved
                delta = D(plan_by_id[dest]["price_monthly"]) - D(p["price_monthly"])
                if delta > ZERO:
                    mrr_exp += moved * delta
                else:
                    mrr_con += moved * (-delta)
            # (c) conversiones de trials con tarjeta cuya decisión es este mes (47)
            half_month_value = ZERO
            remaining_pipeline = []
            for c in trial_pipeline:
                if c["decision_month"] != m:
                    remaining_pipeline.append(c)
                    continue
                p = plan_by_id[c["plan_id"]]
                conv = c["size"] * D(p["trial_conversion"])
                subs_active[p["id"]] += conv
                mrr_new += conv * D(p["price_monthly"])
                conversions_m += conv
                subs_cohorts_log.append({
                    "plan_id": p["id"], "plan_name": p["name"], "trial_kind": p["trial_kind"],
                    "cohort_month": c["cohort_month"], "starts": str(q_count(c["size"])),
                    "decision_month": m, "conversions": str(q_count(conv)),
                    "conversion_rate": str(q_rate(D(p["trial_conversion"]))),
                })
            trial_pipeline = remaining_pipeline
            # (d) nuevos trials: solo el INCREMENTO del objetivo entra — nunca doble trial (47)
            for p in plans_all:
                p_start = int(p["start_month"])
                if m < p_start:
                    continue
                p_ramp = int(p["ramp_months"])
                ramp_f = ONE if p_ramp <= 1 else min(ONE, D(m - p_start + 1) / D(p_ramp))
                gross_target = clients_end * D(p["adoption_rate"]) * ramp_f
                entrants = gross_target - subs_prev_target[p["id"]]
                subs_prev_target[p["id"]] = max(subs_prev_target[p["id"]], gross_target)
                if entrants <= ZERO:
                    continue
                kind = p["trial_kind"]
                if kind == "none":
                    subs_active[p["id"]] += entrants
                    mrr_new += entrants * D(p["price_monthly"])
                elif kind == "sin_tarjeta_15":
                    # decide dentro del mismo mes: el converso paga media mensualidad
                    trial_starts_m += entrants
                    conv = entrants * D(p["trial_conversion"])
                    subs_active[p["id"]] += conv
                    mrr_new += conv * D(p["price_monthly"])
                    conversions_m += conv
                    half_month_value += conv * D(p["price_monthly"]) / 2
                    subs_cohorts_log.append({
                        "plan_id": p["id"], "plan_name": p["name"], "trial_kind": kind,
                        "cohort_month": m, "starts": str(q_count(entrants)),
                        "decision_month": m, "conversions": str(q_count(conv)),
                        "conversion_rate": str(q_rate(D(p["trial_conversion"]))),
                    })
                elif kind == "con_tarjeta_30":
                    # decide al abrir el mes siguiente y paga mensualidad completa
                    trial_starts_m += entrants
                    trial_pipeline.append({"plan_id": p["id"], "cohort_month": m,
                                           "size": entrants, "decision_month": m + 1})
            mrr_end = sum((subs_active[p["id"]] * D(p["price_monthly"]) for p in plans_all), ZERO)
            subs_revenue = mrr_end - half_month_value
            subscribers = sum(subs_active.values(), ZERO)
        elif subs_enabled and m >= subs_start:
            ramp = D(min(subs_ramp, m - subs_start + 1)) / D(subs_ramp)
            subscribers = clients_end * subs_adoption * ramp
            subs_revenue = subscribers * subs_price

        # IA / tokens — agregado (fase 3) o detallado por unidad (fase 6, 46/63)
        tokens_revenue = ZERO
        tokens_cost = ZERO
        tokens_rev_overage = tokens_rev_recharges = ZERO
        tok_units = {"consumed": ZERO, "included": ZERO, "included_expired": ZERO,
                     "credit_used": ZERO, "credit_expired": ZERO, "overage": ZERO,
                     "recharge": ZERO}
        if tokens_detailed and m >= tokens_start:
            adopters = clients_end * tokens_adoption
            consumed = adopters * tok_consumption
            plan_credits = sum((subs_active[p["id"]] * D(p["included_token_credits"])
                                for p in plans_all), ZERO) if subs_detailed else ZERO
            if subs_detailed and plan_credits > ZERO:
                included_allowance = plan_credits   # mandan los créditos de los planes (46)
            else:
                included_allowance = adopters * tok_included
            covered = min(consumed, included_allowance)
            included_expired = included_allowance - covered   # incluidos sin rollover
            rem = consumed - covered
            if m == tokens_start and tok_initial_credit > ZERO:
                credit_pool = adopters * tok_initial_credit
                credit_granted_month = m
                token_ledger_log.append({"month": m, "movement_type": "credito_inicial",
                                         "units": str(q_count(credit_pool))})
            from_credit = min(rem, credit_pool)
            credit_pool -= from_credit
            rem -= from_credit
            credit_expired = ZERO
            if credit_pool > ZERO and credit_granted_month \
                    and (m - credit_granted_month) >= tok_credit_expiry:
                credit_expired, credit_pool = credit_pool, ZERO
            overage_units = rem
            recharge_units = overage_units * tok_recharge_share
            payg_units = overage_units - recharge_units
            tokens_rev_overage = payg_units * tok_overage_price
            tokens_rev_recharges = recharge_units * tok_recharge_price
            tokens_revenue = tokens_rev_overage + tokens_rev_recharges
            tokens_cost = consumed * tok_provider_cost   # costo unidad × consumo (46)
            tok_units.update(consumed=consumed, included=covered,
                             included_expired=included_expired, credit_used=from_credit,
                             credit_expired=credit_expired, overage=overage_units,
                             recharge=recharge_units)
            for mtype, units, ucost, uprice, amount in (
                ("consumo", consumed, tok_provider_cost, ZERO, tokens_cost),
                ("incluido", covered, ZERO, ZERO, ZERO),
                ("overage", payg_units, ZERO, tok_overage_price, tokens_rev_overage),
                ("recarga", recharge_units, ZERO, tok_recharge_price, tokens_rev_recharges),
                ("expiracion", included_expired + credit_expired, ZERO, ZERO, ZERO),
            ):
                if units > ZERO:
                    token_ledger_log.append({
                        "month": m, "movement_type": mtype, "units": str(q_count(units)),
                        "unit_cost": str(q_money(ucost)), "unit_price": str(q_money(uprice)),
                        "amount": str(q_money(amount)),
                    })
        elif tokens_enabled and m >= tokens_start:
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
            elif behavior in ("tiered_per_active_client", "tiered_per_transaction", "tiered_pct_gmv"):
                # escalonados (fase 6, pantalla 48): costo = fijo + Σ tramos MARGINALES
                driver = clients_avg if behavior == "tiered_per_active_client" \
                    else transactions if behavior == "tiered_per_transaction" else gmv
                tier_part = ZERO
                for t in ci.get("tiers", []):   # ordenados por "from"
                    lo = D(t["from"])
                    hi = driver if t["to"] is None else min(driver, D(t["to"]))
                    span = hi - lo
                    if span > ZERO:
                        tier_part += span * D(t["rate"])
                fixed_total += amount             # componente fijo → OPEX (5.5)
                variable_items_total += tier_part  # tramos por driver → costos variables (5.5)
                value = amount + tier_part
            else:
                continue
            cat_totals[ci["category"]] = cat_totals.get(ci["category"], ZERO) + value

        # gasto de campañas: costo directo + puntos extra devengados al emitirse (fase 5)
        campaigns_expense = camp_spend + camp_extra_points
        # nómina del hiring plan → OPEX y categorías (fase 6, pantalla 49 / 5.5)
        for dep, val in cat_hiring.items():
            cat_totals[dep] = cat_totals.get(dep, ZERO) + val
        variable_costs = variable_items_total + tokens_cost + processing_fee
        opex = fixed_total + acquisition_spend + campaigns_expense + payroll

        # 8) cierre
        gross_margin = revenue_total - variable_costs
        contribution_margin = gross_margin  # MVP: sin split comercial adicional
        ebitda = contribution_margin - opex
        ebitda_margin = (ebitda / revenue_total) if revenue_total > ZERO else None

        # flujo de efectivo (5.4 / pantalla 60): separar devengo de caja
        points_paid_out = points_redeemed  # pago a negocios por redenciones (incluye puntos extra)
        # con settlements entra el flujo bruto y sale la liquidación diferida a negocios;
        # con lag 0 y fee 0 la caja neta es idéntica al modelo sin settlements
        cash_in = (gross_collected if settlement_on else collected_now) \
            + ar_collections + subs_revenue + tokens_revenue
        cash_out = variable_items_total + tokens_cost + fixed_total + acquisition_spend \
            + points_paid_out + camp_spend + processing_fee + paid_out + payroll
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
        emit("tx.count_stripe", tx_count_stripe)
        emit("tx.count_cash", tx_count_cash)
        emit("tx.gmv_stripe", tx_gmv_stripe)
        emit("tx.gmv_cash", tx_gmv_cash)
        emit("camp.active_count", camp_active)
        emit("camp.gmv_incremental", gmv_incremental)
        emit("camp.revenue_incremental", revenue_incremental)
        emit("camp.extra_points", camp_extra_points)
        emit("camp.roi", (revenue_incremental / campaigns_expense) if campaigns_expense > ZERO else ZERO)
        emit("stl.gross_collected", gross_collected)
        emit("stl.merchant_due", merchant_due)
        emit("stl.paid_out", paid_out)
        emit("stl.payable_end", payable_balance)
        emit("rev.commission", commission)
        emit("rev.subscriptions", subs_revenue)
        emit("rev.subscribers", subscribers)
        emit("rev.tokens", tokens_revenue)
        emit("rev.total", revenue_total)
        emit("rev.mrr.start", mrr_start)
        emit("rev.mrr.new", mrr_new)
        emit("rev.mrr.expansion", mrr_exp)
        emit("rev.mrr.contraction", mrr_con)
        emit("rev.mrr.churned", mrr_churn)
        emit("rev.mrr.end", mrr_end)
        emit("subs.trial_starts", trial_starts_m)
        emit("subs.trial_active", sum((c["size"] for c in trial_pipeline), ZERO))
        emit("subs.conversions", conversions_m)
        emit("subs.active_total", subscribers if subs_detailed else ZERO)
        for p in plans_all:
            emit(f"subs.plan.{p['id']}.active", subs_active[p["id"]])
        emit("rev.tokens.overage", tokens_rev_overage)
        emit("rev.tokens.recharges", tokens_rev_recharges)
        for uk, uv in tok_units.items():
            emit(f"tokens.units.{uk}", uv)
        emit("tokens.unit_margin", (tok_overage_price - tok_provider_cost) if tokens_detailed else ZERO)
        emit("tokens.margin_pct",
             ((tokens_revenue - tokens_cost) / tokens_revenue) if tokens_revenue > ZERO else ZERO)
        emit("cost.hiring", payroll)
        emit("hiring.headcount", headcount_total)
        emit("hiring.onboarding_capacity", capacity_hiring)
        emit("b2b.onboarding_capacity", onboarding_cap_eff)
        emit("points.emitted", points_base)
        emit("points.redeemed", points_redeemed)
        emit("points.expired", points_expired)
        emit("points.balance_end", points_balance)
        emit("points.funnel.intents", funnel_intents)
        emit("points.business_returned", points_returned)
        emit("cash.collected_immediate", collected_now)
        emit("ar.new", to_ar)
        emit("ar.collections", ar_collections)
        emit("ar.writeoffs", ar_writeoffs)
        emit("ar.balance_end", ar_balance)
        emit("cost.variable_items", variable_items_total)
        emit("cost.tokens", tokens_cost)
        emit("cost.fixed", fixed_total)
        emit("cost.acquisition", acquisition_spend)
        emit("cost.campaigns", campaigns_expense)
        emit("cost.processing_fees", processing_fee)
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
    if cohorts_enabled:
        # LTV por cohortes (5.6): comisión esperada de Pigui por consumidor nuevo
        summary["ltv_b2c"] = str(q_money(cohort_ltv_b2c(
            conversion, frequency, ticket, margin_pct,
            pigui_pct if commission_enabled else ZERO,
            ret_m1, ret_stable, ret_ramp, initial_activity, maturation_months, ltv_horizon,
        )))
    # resumen de campañas (fase 5) — siempre presente, en cero cuando el motor está apagado
    camp_spend_total = sum(metrics["cost.campaigns"], ZERO)
    camp_rev_total = sum(metrics["camp.revenue_incremental"], ZERO)
    summary["campaigns"] = {
        "total_spend": str(q_money(camp_spend_total)),
        "total_extra_points": str(q_count(sum(metrics["camp.extra_points"], ZERO))),
        "total_gmv_incremental": str(q_money(sum(metrics["camp.gmv_incremental"], ZERO))),
        "total_revenue_incremental": str(q_money(camp_rev_total)),
        "roi_total": str(q_rate(camp_rev_total / camp_spend_total)) if camp_spend_total > ZERO else "0",
    }

    # matriz de cohortes para la pantalla de cohortes (solo informativa; no
    # participa del output_hash, igual que los bottlenecks)
    cohorts_log = [{
        "cohort_month": c["month"],
        "cohort_label": "inicial" if c["month"] == 0 else labels[c["month"] - 1],
        "initial_size": str(q_count(c["initial"])),
        "sizes": [None if v is None else str(q_count(v)) for v in c["series"]],
    } for c in cohort_state]

    serializable = {
        key: [None if v is None else str(v) for v in series]
        for key, series in metrics.items()
    }
    output_hash = hash_of({"metrics": serializable, "summary": summary})

    return {
        "months": labels,
        "metrics": metrics,
        "summary": summary,
        "logs": {"bottlenecks": bottlenecks, "cohorts": cohorts_log,
                 "settlements": settlements_log, "ar_invoices": ar_invoices_log,
                 "subs_cohorts": subs_cohorts_log, "token_ledger": token_ledger_log},
        "output_hash": output_hash,
    }
