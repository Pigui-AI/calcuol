"""Golden scenarios de la Fase 6 — suscripciones detalladas, tokens/IA, costos
escalonados y hiring plan (pantallas 45–49, 62–63), secciones 3.4/5.5/14.1.

Cada motor detallado es un refinamiento activable del agregado: con los flags
apagados el simulador es idéntico al 1.2.0 (los 63 tests previos no se tocan).
"""
from decimal import Decimal

from app.engine.simulator import simulate
from tests.conftest import make_snapshot

D = Decimal
TOL_MONEY = D("0.05")
TOL_COUNT = D("0.001")


def stable_base():
    """Economía E: buyers 500, tx 1000, GMV 100,000, comisión 10,000/mes."""
    return {
        "b2b.initial_clients": 10, "b2b.curve.type": "linear", "b2b.curve.rate": 0,
        "b2b.curve.max_clients": 10, "b2b.churn_rate": 0, "b2b.reactivation_rate": 0,
        "b2c.initial_consumers": 1000, "b2c.new_consumers_per_client_monthly": 0,
        "b2c.consumer_churn_rate": 0, "b2c.purchase_conversion": "0.5",
        "b2c.purchase_frequency": 2, "b2c.avg_ticket": 100, "b2c.margin_pct": "0.4",
        "payments.stripe_share": 1,
    }


def plan(pid="plan-1", **kw):
    base = {
        "id": pid, "name": f"Plan {pid}", "price_monthly": "500", "currency": "MXN",
        "trial_kind": "none", "trial_conversion": "0.25", "adoption_rate": "0.30",
        "start_month": 13, "ramp_months": 1, "churn_rate": "0",
        "upgrade_to_plan_id": None, "upgrade_rate": "0", "included_token_credits": "0",
    }
    base.update(kw)
    return base


def role(rid="rol-1", **kw):
    base = {
        "id": rid, "name": "Onboarding specialist", "department": "nomina",
        "headcount": 2, "monthly_salary": "30000", "start_month": 3,
        "end_month": None, "ramp_months": 2, "onboarding_capacity_per_fte": "4",
    }
    base.update(kw)
    return base


class TestGoldenF6_1_SuscripcionMes13Detallada:
    """14.1 'Suscripción activada en mes 13': MRR solo desde la fecha efectiva."""

    def run(self):
        return simulate(make_snapshot(
            {**stable_base(), "subs.enabled": "true", "subs.detail.enabled": "true"},
            horizon=15, subscription_plans=[plan()]))

    def test_mrr_desde_fecha_efectiva(self):
        m = self.run()["metrics"]
        for i in range(12):
            assert m["rev.subscriptions"][i] == D("0.00")
            assert m["rev.mrr.end"][i] == D("0.00")
        for i in (12, 13, 14):
            assert m["rev.subscriptions"][i] == D("1500.00")   # 3 activos × 500
        assert m["pnl.revenue"][12] == D("11500.00")
        assert m["rev.mrr.new"][12] == D("1500.00")
        assert m["rev.mrr.new"][13] == D("0.00")
        assert m["rev.mrr.end"][14] == D("1500.00")


class TestGoldenF6_2_EquivalenciaSubsAgregado:
    """Detallado con 1 plan sin trial/churn/upgrade ≡ motor agregado, exacto."""

    def test_series_identicas(self):
        agg = simulate(make_snapshot({
            **stable_base(), "subs.enabled": "true", "subs.start_month": 13,
            "subs.price_monthly": 500, "subs.adoption_rate": "0.3", "subs.ramp_months": 1,
        }, horizon=18))["metrics"]
        det = simulate(make_snapshot(
            {**stable_base(), "subs.enabled": "true", "subs.detail.enabled": "true"},
            horizon=18, subscription_plans=[plan()]))["metrics"]
        assert det["rev.subscriptions"] == agg["rev.subscriptions"]
        assert det["rev.subscribers"] == agg["rev.subscribers"]


class TestGoldenF6_3_TrialsPorCohorte:
    """Pantalla 47: con tarjeta decide el mes siguiente; sin tarjeta el mismo mes
    con media mensualidad."""

    def test_con_tarjeta_30(self):
        r = simulate(make_snapshot(
            {**stable_base(), "subs.enabled": "true", "subs.detail.enabled": "true"},
            horizon=15,
            subscription_plans=[plan(price_monthly="1000", adoption_rate="0.6",
                                     ramp_months=2, trial_kind="con_tarjeta_30",
                                     trial_conversion="0.6")]))
        m = r["metrics"]
        assert m["subs.trial_starts"][12] == D("3.0000")   # objetivo 10×0.6×½
        assert m["rev.subscriptions"][12] == D("0.00")
        assert m["subs.conversions"][13] == D("1.8000")
        assert m["rev.subscriptions"][13] == D("1800.00")
        assert m["rev.mrr.new"][13] == D("1800.00")
        assert m["rev.subscriptions"][14] == D("3600.00")
        assert m["rev.mrr.end"][14] == D("3600.00")
        cohorts = r["logs"]["subs_cohorts"]
        assert len(cohorts) == 2 and all(c["conversion_rate"] == "0.600000" for c in cohorts)

    def test_sin_tarjeta_15(self):
        m = simulate(make_snapshot(
            {**stable_base(), "subs.enabled": "true", "subs.detail.enabled": "true"},
            horizon=15,
            subscription_plans=[plan(price_monthly="1000", adoption_rate="0.6",
                                     ramp_months=2, trial_kind="sin_tarjeta_15",
                                     trial_conversion="0.25")]))["metrics"]
        # m13: 3 trials, 0.75 conversos el mismo mes → media mensualidad
        assert m["rev.subscriptions"][12] == D("375.00")
        assert m["rev.mrr.end"][12] == D("750.00")
        # m14: 1.5 activos; los nuevos 0.75 pagan media mensualidad
        assert m["rev.subscriptions"][13] == D("1125.00")
        assert m["rev.mrr.end"][13] == D("1500.00")


class TestGoldenF6_4_MRRBridge:
    """Pantalla 62: end = start + new + expansion − contraction − churned, exacto."""

    def run(self):
        return simulate(make_snapshot(
            {**stable_base(), "subs.enabled": "true", "subs.detail.enabled": "true"},
            horizon=16,
            subscription_plans=[
                plan("p1", price_monthly="500", adoption_rate="0.4", churn_rate="0.10",
                     upgrade_to_plan_id="p2", upgrade_rate="0.25"),
                plan("p2", price_monthly="1000", adoption_rate="0", churn_rate="0.10"),
            ]))

    def test_valores_cerrados(self):
        m = self.run()["metrics"]
        assert m["rev.mrr.new"][12] == D("2000.00")
        assert m["rev.mrr.end"][12] == D("2000.00")
        assert m["rev.mrr.churned"][13] == D("200.00")
        assert m["rev.mrr.expansion"][13] == D("450.00")
        assert m["rev.mrr.end"][13] == D("2250.00")
        assert m["rev.mrr.churned"][14] == D("225.00")
        assert m["rev.mrr.expansion"][14] == D("303.75")
        assert m["rev.mrr.end"][14] == D("2328.75")

    def test_identidad_del_bridge(self):
        m = self.run()["metrics"]
        for i in range(16):
            end = m["rev.mrr.start"][i] + m["rev.mrr.new"][i] + m["rev.mrr.expansion"][i] \
                - m["rev.mrr.contraction"][i] - m["rev.mrr.churned"][i]
            assert abs(m["rev.mrr.end"][i] - end) <= TOL_MONEY, f"mes {i+1}"


class TestGoldenF6_4b_BridgeBajoCombinaciones:
    """El bridge cierra con churn, upgrades encadenados, downgrades y ambos
    tipos de trial simultáneos; el MRR final de un mes abre el siguiente."""

    def test_identidad_y_continuidad(self):
        plans = [
            plan("p1", price_monthly="500", adoption_rate="0.4", churn_rate="0.08",
                 upgrade_to_plan_id="p2", upgrade_rate="0.2", start_month=2,
                 ramp_months=3, trial_kind="con_tarjeta_30", trial_conversion="0.5"),
            plan("p2", price_monthly="1000", adoption_rate="0.1", churn_rate="0.05",
                 upgrade_to_plan_id="p3", upgrade_rate="0.15", start_month=2,
                 ramp_months=2, trial_kind="sin_tarjeta_15", trial_conversion="0.4"),
            plan("p3", price_monthly="300", adoption_rate="0", churn_rate="0.03"),
        ]
        m = simulate(make_snapshot(
            {**stable_base(), "subs.enabled": "true", "subs.detail.enabled": "true"},
            horizon=12, subscription_plans=plans))["metrics"]
        for i in range(12):
            end = m["rev.mrr.start"][i] + m["rev.mrr.new"][i] + m["rev.mrr.expansion"][i] \
                - m["rev.mrr.contraction"][i] - m["rev.mrr.churned"][i]
            assert abs(m["rev.mrr.end"][i] - end) <= TOL_MONEY, f"mes {i+1}"
            if i < 11:
                assert abs(m["rev.mrr.start"][i + 1] - m["rev.mrr.end"][i]) <= TOL_MONEY
        # el downgrade p2→p3 (1000 → 300) alimenta contracción, no expansión
        assert sum(m["rev.mrr.contraction"], D("0")) > D("0")

    def test_objetivo_decreciente_no_genera_altas(self):
        """El objetivo por plan es un stock: si baja no hay entrantes ni doble
        conteo cuando vuelve a subir (ratchet sobre el máximo histórico)."""
        m = simulate(make_snapshot({
            **stable_base(), "subs.enabled": "true", "subs.detail.enabled": "true",
        }, horizon=6, subscription_plans=[
            plan(start_month=1, ramp_months=1, churn_rate="0")]))["metrics"]
        assert m["rev.mrr.new"][0] == D("1500.00")
        for i in range(1, 6):
            assert m["rev.mrr.new"][i] == D("0.00"), f"mes {i+1} no debe re-dar de alta"


class TestGoldenF6_5_TokensDetallado:
    """Pantallas 46/63: consumo, incluidos, overage, recargas y margen unitario."""

    def overrides(self):
        return {
            **stable_base(), "tokens.enabled": "true", "tokens.detail.enabled": "true",
            "tokens.start_month": 13, "tokens.adoption_rate": "0.4",
            "tokens.consumption_per_adopter_monthly": "100",
            "tokens.included_per_adopter_monthly": "50",
            "tokens.overage_price_per_unit": "1.50",
            "tokens.provider_cost_per_unit": "0.60",
            "tokens.recharge_share": "0.25",
            "tokens.recharge_price_per_unit": "1.20",
        }

    def test_mes_13_cerrado(self):
        r = simulate(make_snapshot(self.overrides(), horizon=14))
        m = r["metrics"]
        assert m["tokens.units.consumed"][12] == D("400.0000")
        assert m["tokens.units.included"][12] == D("200.0000")
        assert m["tokens.units.overage"][12] == D("200.0000")
        assert m["tokens.units.recharge"][12] == D("50.0000")
        assert m["rev.tokens.recharges"][12] == D("60.00")
        assert m["rev.tokens.overage"][12] == D("225.00")
        assert m["rev.tokens"][12] == D("285.00")
        assert m["cost.tokens"][12] == D("240.00")
        assert m["tokens.unit_margin"][12] == D("0.90")
        assert m["tokens.margin_pct"][12] == D("0.157895")
        assert any(mv["movement_type"] == "consumo" for mv in r["logs"]["token_ledger"])

    def test_credito_inicial_y_expiracion(self):
        m = simulate(make_snapshot({
            **self.overrides(), "tokens.included_per_adopter_monthly": "0",
            "tokens.initial_credit_units": "75", "tokens.credit_expiry_months": "2",
        }, horizon=16))["metrics"]
        # crédito inicial 4×75 = 300: cubre 300 del overage de m13 (consumo 400)
        assert m["tokens.units.credit_used"][12] == D("300.0000")
        assert m["tokens.units.overage"][12] == D("100.0000")
        # m14+: sin crédito restante, overage completo
        assert m["tokens.units.overage"][13] == D("400.0000")


class TestGoldenF6_6_EquivalenciaTokensAgregado:
    """Detallado con defaults (100 × 1.50, costo 0.60) ≡ agregado (150, cost 40%)."""

    def test_series_identicas(self):
        base = {**stable_base(), "tokens.enabled": "true", "tokens.start_month": 13}
        agg = simulate(make_snapshot(base, horizon=16))["metrics"]
        det = simulate(make_snapshot({**base, "tokens.detail.enabled": "true"},
                                     horizon=16))["metrics"]
        assert det["rev.tokens"] == agg["rev.tokens"]
        assert det["cost.tokens"] == agg["cost.tokens"]
        assert det["rev.tokens"][12] == D("600.00")
        assert det["cost.tokens"][12] == D("240.00")


class TestGoldenF6_7_CostosEscalonados:
    """Pantalla 48: costo = fijo (OPEX) + Σ tramos marginales (variable)."""

    def test_tramos_marginales(self):
        m = simulate(make_snapshot(stable_base(), horizon=3, cost_items=[{
            "name": "Infraestructura escalonada", "category": "infraestructura",
            "behavior": "tiered_per_transaction", "amount": "1000",
            "effective_from": 1, "effective_to": None,
            "tiers": [{"from": "0", "to": "500", "rate": "0.50"},
                      {"from": "500", "to": "2000", "rate": "0.30"},
                      {"from": "2000", "to": None, "rate": "0.10"}],
        }]))["metrics"]
        for i in range(3):   # tx = 1000: 500×0.50 + 500×0.30 = 400
            assert m["cost.fixed"][i] == D("1000.00")
            assert m["cost.variable_items"][i] == D("400.00")
            assert m["cost.cat.infraestructura"][i] == D("1400.00")
            assert m["pnl.opex"][i] >= D("1000.00")
            assert m["pnl.variable_costs"][i] >= D("400.00")


class TestGoldenF6_8_HiringCapacidadYNomina:
    """Pantalla 49→30 y 14.1 'capacidad limitada': nómina completa desde la fecha
    efectiva; la capacidad rampa y explica el cuello de botella."""

    def run(self):
        return simulate(make_snapshot({
            "b2b.initial_clients": 0, "b2b.curve.type": "linear", "b2b.curve.rate": 50,
            "b2b.curve.max_clients": 500, "b2b.churn_rate": 0, "b2b.reactivation_rate": 0,
            "b2b.acquisition_budget_monthly": "10000000", "b2b.cac": "1000",
            "hiring.capacity.enabled": "true",
        }, horizon=6, hiring_roles=[role()]))

    def test_capacidad_y_nomina(self):
        r = self.run()
        m = r["metrics"]
        for i in (0, 1):   # rol aún no efectivo: capacidad 0, nómina 0
            assert m["b2b.adds_activated"][i] == D("0.0000")
            assert m["cost.hiring"][i] == D("0.00")
            assert r["logs"]["bottlenecks"][i]["restriccion_activa"] == "capacidad_onboarding"
        # m3: rampa ½ → capacidad 2×4×0.5 = 4; nómina completa 60,000
        assert m["b2b.adds_activated"][2] == D("4.0000")
        assert m["cost.hiring"][2] == D("60000.00")
        assert m["cost.cat.nomina"][2] == D("60000.00")
        # m4+: rampa completa → 8
        assert m["b2b.adds_activated"][3] == D("8.0000")
        assert r["logs"]["bottlenecks"][2]["fuente_capacidad"] == "hiring"

    def test_nomina_en_opex_y_caja(self):
        m = self.run()["metrics"]
        assert m["pnl.opex"][2] >= D("60000.00")
        assert m["cash.out_total"][2] >= D("60000.00")


class TestGoldenF6_9_DeterminismoYDefaults:
    """Defaults apagados ⇒ métricas nuevas en cero; mismo snapshot ⇒ mismo hash;
    cada configuración nueva cambia los hashes."""

    def test_apagado_todo_en_cero(self):
        m = simulate(make_snapshot(stable_base(), horizon=6))["metrics"]
        for key in ("rev.mrr.end", "subs.trial_starts", "subs.active_total",
                    "tokens.units.consumed", "rev.tokens.overage", "cost.hiring",
                    "hiring.headcount", "hiring.onboarding_capacity"):
            assert all(v in (D("0"), D("0.00"), D("0.0000"), D("0.000000")) for v in m[key]), key

    def test_determinismo_y_sensibilidad(self):
        snap = make_snapshot(
            {**stable_base(), "subs.enabled": "true", "subs.detail.enabled": "true",
             "tokens.enabled": "true", "tokens.detail.enabled": "true",
             "hiring.capacity.enabled": "true"},
            horizon=15, subscription_plans=[plan()], hiring_roles=[role(start_month=1)])
        assert simulate(snap)["output_hash"] == simulate(snap)["output_hash"]
        base_snap = make_snapshot(stable_base(), horizon=15)
        for variant in (
            make_snapshot({**stable_base(), "subs.detail.enabled": "true"}, horizon=15),
            make_snapshot(stable_base(), horizon=15, subscription_plans=[plan()]),
            make_snapshot(stable_base(), horizon=15, hiring_roles=[role()]),
            make_snapshot(stable_base(), horizon=15, cost_items=[{
                "name": "x", "category": "otros", "behavior": "tiered_pct_gmv",
                "amount": "0", "effective_from": 1, "effective_to": None,
                "tiers": [{"from": "0", "to": None, "rate": "0.001"}]}]),
        ):
            assert variant["input_hash"] != base_snap["input_hash"]
