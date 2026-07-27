"""Golden tests de cohortes B2C — fase 4 (pantallas 24–30), sección 14.1.

Con cohortes activas el churn plano se sustituye por retención dependiente
de la antigüedad y la actividad de compra madura con la edad de la cohorte.
Con cohortes inactivas el motor debe ser idéntico al modelo agregado.
"""
from decimal import Decimal

from app.engine.simulator import simulate
from app.engine.cohorts import monthly_retention, activity_factor, survival_to, ltv_b2c
from tests.conftest import make_snapshot

D = Decimal
TOL_MONEY = D("0.05")
TOL_COUNT = D("0.001")
# la suma de tamaños de cohortes cuantizados acumula medio diezmilésimo por cohorte
TOL_COHORT_SUM = D("0.01")


class TestCohortes_FuncionesPuras:
    """Curva de retención, factor de actividad y supervivencia (valores cerrados)."""

    def test_retencion_converge_de_m1_a_estable(self):
        r1, stable, ramp = D("0.70"), D("0.94"), D("0.85")
        assert monthly_retention(1, r1, stable, ramp) == D("0.70")
        assert monthly_retention(2, r1, stable, ramp) == D("0.736")
        assert monthly_retention(3, r1, stable, ramp) == D("0.7666")
        assert abs(monthly_retention(120, r1, stable, ramp) - stable) < D("0.0001")

    def test_retencion_acotada_a_0_1(self):
        assert monthly_retention(1, D("1.5"), D("0.9"), D("0.5")) == D("1")
        assert monthly_retention(1, D("-0.5"), D("0.1"), D("0.5")) == D("0")

    def test_ramp_cero_no_truena(self):
        """ramp = 0 es válido (convergencia inmediata); Decimal 0**0 sería inválido."""
        assert monthly_retention(1, D("0.7"), D("0.94"), D("0")) == D("0.7")
        assert monthly_retention(2, D("0.7"), D("0.94"), D("0")) == D("0.94")
        assert survival_to(3, D("0.7"), D("0.94"), D("0")) == D("0.7") * D("0.94")
        r = simulate(make_snapshot({
            "b2b.initial_clients": 10, "b2c.initial_consumers": 1000,
            "b2c.cohort.enabled": "true", "b2c.cohort.retention_ramp": "0",
        }, horizon=6))
        assert r["output_hash"]

    def test_factor_de_actividad_rampa_lineal(self):
        f = lambda age: activity_factor(age, D("0.60"), 3)
        assert f(1) == D("0.60")
        assert f(2) == D("0.80")
        assert f(3) == D("1")
        assert f(4) == D("1")
        # sin maduración: actividad plena desde el primer mes
        assert activity_factor(1, D("0.60"), 1) == D("1")
        assert activity_factor(1, D("0.60"), 0) == D("1")

    def test_supervivencia_es_producto_de_retenciones(self):
        r1, stable, ramp = D("0.70"), D("0.94"), D("0.85")
        assert survival_to(1, r1, stable, ramp) == D("1")
        assert survival_to(2, r1, stable, ramp) == D("0.70")
        assert survival_to(3, r1, stable, ramp) == D("0.70") * D("0.736")


class TestGoldenC1_EquivalenciaConModeloAgregado:
    """Retención constante = 1 − churn y actividad plena → cohortes reproducen
    exactamente el modelo agregado (misma serie en cada métrica)."""

    def test_metricas_identicas(self):
        base = {
            "b2b.initial_clients": 10, "b2c.initial_consumers": 1000,
            "b2c.consumer_churn_rate": "0.06",
        }
        agg = simulate(make_snapshot(base, horizon=24))
        coh = simulate(make_snapshot({
            **base,
            "b2c.cohort.enabled": "true",
            "b2c.cohort.retention_m1": "0.94",
            "b2c.cohort.retention_stable": "0.94",
            "b2c.cohort.retention_ramp": "0.85",
            "b2c.cohort.maturation_months": "1",
            "b2c.cohort.initial_activity_factor": "1",
        }, horizon=24))
        for key, series in agg["metrics"].items():
            assert coh["metrics"][key] == series, f"la métrica {key} difiere"
        assert "ltv_b2c" in coh["summary"]
        assert "ltv_b2c" not in agg["summary"]


class TestGoldenC2_CohortesGolden:
    """Escenario cerrado calculado a mano: 10 clientes estables, cohorte inicial
    madura y cohortes nuevas con retención 0.5 el primer mes y maduración de 2."""

    def overrides(self):
        return {
            "b2b.initial_clients": 10, "b2b.curve.type": "linear", "b2b.curve.rate": 0,
            "b2b.curve.max_clients": 10, "b2b.churn_rate": 0, "b2b.reactivation_rate": 0,
            "b2c.consumers_initial_per_client": 100,
            "b2c.new_consumers_per_client_monthly": 10,
            "b2c.purchase_conversion": "0.5", "b2c.purchase_frequency": 2,
            "b2c.avg_ticket": 100, "b2c.margin_pct": "0.4",
            "b2c.cohort.enabled": "true",
            "b2c.cohort.retention_m1": "0.5",
            "b2c.cohort.retention_stable": "0.9",
            "b2c.cohort.retention_ramp": "0.5",
            "b2c.cohort.maturation_months": "2",
            "b2c.cohort.initial_activity_factor": "0.5",
        }

    def test_mes_1_y_2_exactos(self):
        r = simulate(make_snapshot(self.overrides(), horizon=6))
        m = r["metrics"]
        # mes 1: inicial 1000 → 900 (madura, ret 0.9); cohorte nueva 100 (10 clientes × 10)
        assert m["b2c.consumers_churned"][0] == D("100.0000")
        assert m["b2c.consumers_end"][0] == D("1000.0000")
        # compradores: inicial avg 950 × 0.5 × 1 + nueva avg 50 × 0.5 × 0.5 = 487.5
        assert m["b2c.buyers"][0] == D("487.5000")
        assert m["b2c.transactions"][0] == D("975.0000")
        assert m["tx.gmv"][0] == D("97500.00")
        # mes 2: inicial 900→810; cohorte m1 (edad 1, ret(1)=0.5) 100→50; nueva 100
        assert m["b2c.consumers_churned"][1] == D("140.0000")
        assert m["b2c.consumers_end"][1] == D("960.0000")
        # compradores: 855×0.5 + 75×0.5×1 (edad 2 = madurada) + 50×0.5×0.5 = 477.5
        assert m["b2c.buyers"][1] == D("477.5000")

    def test_matriz_de_cohortes_reconcilia_con_stock(self):
        r = simulate(make_snapshot(self.overrides(), horizon=12))
        m = r["metrics"]
        cohorts = r["logs"]["cohorts"]
        assert cohorts, "con cohortes activas la matriz no puede estar vacía"
        for i in range(12):
            total = sum((D(c["sizes"][i]) for c in cohorts if c["sizes"][i] is not None), D("0"))
            assert abs(total - m["b2c.consumers_end"][i]) <= TOL_COHORT_SUM, f"mes {i+1}"

    def test_cada_cohorte_decrece_tras_su_alta(self):
        r = simulate(make_snapshot(self.overrides(), horizon=12))
        for c in r["logs"]["cohorts"]:
            sizes = [D(v) for v in c["sizes"] if v is not None]
            for a, b in zip(sizes, sizes[1:]):
                assert b < a, f"cohorte {c['cohort_label']} no decrece"

    def test_actividad_intermedia_en_la_rampa(self):
        """Con maduración de 3 meses la edad 2 usa el factor intermedio 0.75."""
        r = simulate(make_snapshot({**self.overrides(), "b2c.cohort.maturation_months": "3"},
                                   horizon=6))
        m = r["metrics"]
        # mes 1 igual que el golden base (la edad 1 usa el factor inicial 0.5)
        assert m["b2c.buyers"][0] == D("487.5000")
        # mes 2: inicial 855×0.5×1 + cohorte m1 avg 75×0.5×0.75 + nueva 50×0.5×0.5
        assert m["b2c.buyers"][1] == D("468.1250")


class TestGoldenC3_LTVPorCohortes:
    """LTV por cohortes (5.6): valor cerrado y reconciliación con el devengo."""

    def test_funcion_pura_valor_cerrado(self):
        # base mensual 1×1×100×0.35×0.25 = 8.75; presencias promedio:
        # mes de alta 1/2 → 4.375; edad 2 (1+0.9)/2 → 8.3125; edad 3 (0.9+0.81)/2 → 7.48125
        value = ltv_b2c(D("1"), D("1"), D("100"), D("0.35"), D("0.25"),
                        D("0.9"), D("0.9"), D("0.5"), D("1"), 1, 3)
        assert value == D("20.16875")

    def test_summary_emite_ltv_cuantizado(self):
        r = simulate(make_snapshot({
            "b2b.initial_clients": 10, "b2c.initial_consumers": 1000,
            "b2c.purchase_conversion": 1, "b2c.purchase_frequency": 1,
            "b2c.avg_ticket": 100, "b2c.margin_pct": "0.35",
            "b2c.cohort.enabled": "true",
            "b2c.cohort.retention_m1": "0.9",
            "b2c.cohort.retention_stable": "0.9",
            "b2c.cohort.retention_ramp": "0.5",
            "b2c.cohort.maturation_months": "1",
            "b2c.cohort.initial_activity_factor": "1",
            "b2c.cohort.ltv_horizon_months": "3",
        }, horizon=6))
        assert r["summary"]["ltv_b2c"] == "20.17"

    def test_ltv_reconcilia_con_el_devengo_del_motor(self):
        """Una cohorte aislada: Σ rev.commission del run ≈ ltv_b2c × tamaño inicial."""
        horizon = 36
        r = simulate(make_snapshot({
            # una sola alta B2B en el mes 1 (curva lineal 0→1) y cero stock inicial
            "b2b.initial_clients": 0, "b2b.curve.type": "linear", "b2b.curve.rate": 1,
            "b2b.curve.max_clients": 1, "b2b.churn_rate": 0, "b2b.reactivation_rate": 0,
            "b2c.initial_consumers": 0, "b2c.consumers_initial_per_client": 100,
            "b2c.new_consumers_per_client_monthly": 0,
            "b2c.cohort.enabled": "true",
            "b2c.cohort.ltv_horizon_months": str(horizon),
        }, horizon=horizon))
        assert len(r["logs"]["cohorts"]) == 1, "el escenario debe producir una única cohorte"
        commission_total = sum(v for v in r["metrics"]["rev.commission"] if v is not None)
        expected = D(r["summary"]["ltv_b2c"]) * D("100")
        assert abs(commission_total - expected) <= D("1.00")

    def test_ltv_cero_con_comisiones_desactivadas(self):
        r = simulate(make_snapshot({
            "b2b.initial_clients": 10, "b2c.initial_consumers": 1000,
            "b2c.cohort.enabled": "true", "revenue.commission.enabled": "false",
        }, horizon=6))
        assert r["summary"]["ltv_b2c"] == "0.00"


class TestGoldenC4_DeterminismoYSensibilidad:
    """Mismo snapshot → mismo hash; cambiar la retención cambia el hash."""

    def base(self):
        return {
            "b2b.initial_clients": 10, "b2c.initial_consumers": 1000,
            "b2c.cohort.enabled": "true",
        }

    def test_determinismo_con_cohortes(self):
        snap = make_snapshot(self.base(), horizon=18)
        assert simulate(snap)["output_hash"] == simulate(snap)["output_hash"]

    def test_retencion_cambia_el_hash(self):
        a = simulate(make_snapshot(self.base(), horizon=18))
        b = simulate(make_snapshot({**self.base(), "b2c.cohort.retention_m1": "0.71"}, horizon=18))
        assert a["output_hash"] != b["output_hash"]

    def test_desactivadas_no_emiten_rastro(self):
        r = simulate(make_snapshot({"b2b.initial_clients": 10}, horizon=6))
        assert r["logs"]["cohorts"] == []
        assert "ltv_b2c" not in r["summary"]
