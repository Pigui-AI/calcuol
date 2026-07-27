"""Golden scenarios — sección 14.1 del documento (subconjunto Fases 0–3).

El motor debe ser determinístico, reconciliable mes a mes y explicable.
"""
from decimal import Decimal

from app.engine.simulator import simulate
from tests.conftest import make_snapshot

D = Decimal
TOL_MONEY = D("0.05")
TOL_COUNT = D("0.001")


def stable_overrides():
    """Economía estable: 10 clientes, 1,000 consumidores, sin churn ni crecimiento."""
    return {
        "b2b.initial_clients": 10, "b2b.curve.type": "linear", "b2b.curve.rate": 0,
        "b2b.curve.max_clients": 10, "b2b.churn_rate": 0, "b2b.reactivation_rate": 0,
        "b2c.initial_consumers": 1000, "b2c.new_consumers_per_client_monthly": 0,
        "b2c.consumer_churn_rate": 0, "b2c.purchase_conversion": "0.5",
        "b2c.purchase_frequency": 2, "b2c.avg_ticket": 100, "b2c.margin_pct": "0.4",
        "payments.stripe_share": 1,
    }


class TestGolden1_SinChurnLineal:
    """10 clientes, 1,000 consumidores, sin churn → stocks y flujos lineales."""

    def test_stocks_estables_e_ingresos_reconciliados(self):
        r = simulate(make_snapshot(stable_overrides(), horizon=12))
        m = r["metrics"]
        for i in range(12):
            assert m["b2b.clients_end"][i] == D("10")
            assert m["b2c.consumers_end"][i] == D("1000")
            assert m["b2c.transactions"][i] == D("1000")          # 1000 × 0.5 × 2
            assert m["tx.gmv"][i] == D("100000.00")
            assert m["tx.eligible_utility"][i] == D("40000.00")
            assert m["rev.commission"][i] == D("10000.00")        # 25%
            assert m["points.emitted"][i] == D("2000")            # 5%
            assert m["tx.business_net"][i] == D("28000.00")       # 70%
            # distribución 25/5/70 suma 100% de la utilidad elegible
            total = m["rev.commission"][i] + m["points.emitted"][i] + m["tx.business_net"][i]
            assert abs(total - m["tx.eligible_utility"][i]) <= TOL_MONEY


class TestGolden2_ChurnYReactivacion:
    """100 clientes con churn/reactivación → altas, bajas y base final exactas."""

    def test_movimiento_exacto(self):
        r = simulate(make_snapshot({
            "b2b.initial_clients": 100, "b2b.curve.type": "linear", "b2b.curve.rate": 0,
            "b2b.curve.max_clients": 100, "b2b.churn_rate": "0.05",
            "b2b.reactivation_rate": "0.10", "b2b.acquisition_budget_monthly": 0,
        }, horizon=3))
        m = r["metrics"]
        # Mes 1: churned = 100×5% = 5; sin pool para reactivar
        assert m["b2b.churned"][0] == D("5")
        assert m["b2b.reactivated"][0] == D("0")
        assert m["b2b.clients_end"][0] == D("95")
        # Mes 2: churned = 95×5% = 4.75; reactivados = 5×10% = 0.5
        assert m["b2b.churned"][1] == D("4.75")
        assert m["b2b.reactivated"][1] == D("0.5")
        assert m["b2b.clients_end"][1] == D("90.75")

    def test_reconciliacion_stock(self):
        r = simulate(make_snapshot({"b2b.initial_clients": 100}, horizon=24))
        m = r["metrics"]
        for i in range(24):
            end = (m["b2b.clients_start"][i] + m["b2b.adds_activated"][i]
                   + m["b2b.reactivated"][i] - m["b2b.churned"][i])
            assert abs(end - m["b2b.clients_end"][i]) <= TOL_COUNT


class TestGolden3_PagoEnCaja:
    """Pago en caja → ingreso devengado y AR, sin entrada de cash inmediata."""

    def test_ar_generada_y_cobrada_con_rezago(self):
        ov = stable_overrides()
        ov.update({"payments.stripe_share": 0, "payments.ar.collection_lag_months": 1,
                   "payments.ar.collection_rate": "0.98"})
        r = simulate(make_snapshot(ov, horizon=6))
        m = r["metrics"]
        # Mes 1: ingreso devengado 10,000 pero caja cero (todo a AR)
        assert m["rev.commission"][0] == D("10000.00")
        assert m["cash.collected_immediate"][0] == D("0.00")
        assert m["ar.new"][0] == D("12000.00")            # comisión + fondeo de puntos
        assert m["ar.balance_end"][0] == D("12000.00")
        # Mes 2: cobra 98% del mes 1 y castiga 2%
        assert m["ar.collections"][1] == D("11760.00")
        assert m["ar.writeoffs"][1] == D("240.00")
        assert m["ar.balance_end"][1] == D("12000.00")    # entra AR nueva del mes 2

    def test_reconciliacion_ar(self):
        ov = stable_overrides()
        ov["payments.stripe_share"] = "0.4"
        r = simulate(make_snapshot(ov, horizon=12))
        m = r["metrics"]
        prev = D("0")
        for i in range(12):
            expected = prev + m["ar.new"][i] - m["ar.collections"][i] - m["ar.writeoffs"][i]
            assert abs(expected - m["ar.balance_end"][i]) <= TOL_MONEY
            prev = m["ar.balance_end"][i]


class TestGolden4_SuscripcionMes13:
    """Suscripción activada en mes 13 → MRR solo desde fecha efectiva."""

    def test_mrr_desde_mes_13(self):
        ov = stable_overrides()
        ov.update({"subs.enabled": "true", "subs.start_month": 13,
                   "subs.price_monthly": 500, "subs.adoption_rate": "0.3", "subs.ramp_months": 1})
        r = simulate(make_snapshot(ov, horizon=24))
        m = r["metrics"]
        for i in range(12):
            assert m["rev.subscriptions"][i] == D("0.00")
        for i in range(12, 24):
            assert m["rev.subscriptions"][i] == D("1500.00")   # 10 × 30% × 500
        assert m["pnl.revenue"][12] == D("11500.00")           # comisión + MRR


class TestGolden5_CapacidadLimitada:
    """Capacidad limitada → altas menores al objetivo y explicación del cuello de botella."""

    def test_cuello_de_botella_visible(self):
        r = simulate(make_snapshot({
            "b2b.initial_clients": 0, "b2b.curve.type": "linear", "b2b.curve.rate": 10,
            "b2b.curve.max_clients": 100, "b2b.onboarding_capacity_monthly": 3,
            "b2b.acquisition_budget_monthly": 1000000, "b2b.cac": 100,
            "b2b.churn_rate": 0,
        }, horizon=3))
        m = r["metrics"]
        assert m["b2b.adds_desired"][0] == D("10")
        assert m["b2b.adds_activated"][0] == D("3")
        assert m["b2b.clients_end"][0] == D("3")
        assert r["logs"]["bottlenecks"][0]["restriccion_activa"] == "capacidad_onboarding"

    def test_restriccion_presupuesto(self):
        r = simulate(make_snapshot({
            "b2b.initial_clients": 0, "b2b.curve.type": "linear", "b2b.curve.rate": 10,
            "b2b.curve.max_clients": 100, "b2b.onboarding_capacity_monthly": 50,
            "b2b.acquisition_budget_monthly": 700, "b2b.cac": 100, "b2b.churn_rate": 0,
        }, horizon=1))
        assert r["metrics"]["b2b.adds_activated"][0] == D("7")
        assert r["logs"]["bottlenecks"][0]["restriccion_activa"] == "presupuesto"


class TestGolden6_Determinismo:
    """Mismos inputs + misma versión del motor = mismos outputs (1.2 / pantalla 52)."""

    def test_mismo_snapshot_mismo_hash(self):
        snap = make_snapshot(stable_overrides(), horizon=36)
        assert simulate(snap)["output_hash"] == simulate(snap)["output_hash"]

    def test_input_distinto_hash_distinto(self):
        a = simulate(make_snapshot(stable_overrides(), horizon=12))
        ov = stable_overrides()
        ov["b2c.avg_ticket"] = 101
        b = simulate(make_snapshot(ov, horizon=12))
        assert a["output_hash"] != b["output_hash"]


class TestReconciliacionesGlobales:
    """Reconciliación mensual completa (sección 14, capa Simulación)."""

    def _run(self):
        cost_items = [
            {"name": "Nómina", "category": "nomina", "behavior": "fixed",
             "amount": "20000", "effective_from": 1, "effective_to": None},
            {"name": "Infra por transacción", "category": "infraestructura",
             "behavior": "per_transaction", "amount": "0.5", "effective_from": 1, "effective_to": None},
            {"name": "Procesamiento", "category": "infraestructura", "behavior": "pct_gmv",
             "amount": "0.01", "effective_from": 1, "effective_to": None},
            {"name": "Soporte por cliente", "category": "otros", "behavior": "per_active_client",
             "amount": "50", "effective_from": 6, "effective_to": 12},
        ]
        return simulate(make_snapshot({"b2b.initial_clients": 20, "finance.opening_cash": 500000},
                                      cost_items=cost_items, horizon=24))

    def test_continuidad_de_caja(self):
        m = self._run()["metrics"]
        prev = D("500000")
        for i in range(24):
            assert abs((prev + m["cash.net"][i]) - m["cash.balance_end"][i]) <= TOL_MONEY
            assert abs((m["cash.in_total"][i] - m["cash.out_total"][i]) - m["cash.net"][i]) <= TOL_MONEY
            prev = m["cash.balance_end"][i]

    def test_pnl_reconcilia(self):
        m = self._run()["metrics"]
        for i in range(24):
            ebitda = m["pnl.revenue"][i] - m["pnl.variable_costs"][i] - m["pnl.opex"][i]
            assert abs(ebitda - m["pnl.ebitda"][i]) <= TOL_MONEY
            opex = m["cost.fixed"][i] + m["cost.acquisition"][i]
            assert abs(opex - m["pnl.opex"][i]) <= TOL_MONEY

    def test_ledger_puntos_reconcilia(self):
        m = self._run()["metrics"]
        prev = D("0")
        for i in range(24):
            expected = prev + m["points.emitted"][i] - m["points.redeemed"][i] - m["points.expired"][i]
            assert abs(expected - m["points.balance_end"][i]) <= D("0.01")
            prev = m["points.balance_end"][i]

    def test_costo_por_categoria_suma_total(self):
        m = self._run()["metrics"]
        for i in range(24):
            cats = m["cost.cat.nomina"][i] + m["cost.cat.infraestructura"][i] + m["cost.cat.otros"][i]
            total = m["cost.fixed"][i] + m["cost.variable_items"][i]
            assert abs(cats - total) <= TOL_MONEY

    def test_costo_con_ventana_efectiva(self):
        m = self._run()["metrics"]
        assert m["cost.cat.otros"][0] == D("0.00")     # inicia mes 6
        assert m["cost.cat.otros"][5] > D("0")
        assert m["cost.cat.otros"][12] == D("0.00")    # termina mes 12


class TestFundraising:
    """Necesidad de capital (5.6): funding_need = |min caja| + buffer + one-time."""

    def test_funding_need(self):
        cost_items = [{"name": "Nómina", "category": "nomina", "behavior": "fixed",
                       "amount": "100000", "effective_from": 1, "effective_to": None}]
        ov = stable_overrides()
        ov.update({"finance.opening_cash": 0, "finance.operating_buffer": 50000,
                   "finance.one_time_costs": 10000})
        r = simulate(make_snapshot(ov, cost_items=cost_items, horizon=12))
        s = r["summary"]
        min_cash = D(s["min_cash"])
        assert min_cash < 0
        assert D(s["funding_need"]) == abs(min_cash) + D("60000")
