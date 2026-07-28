"""Golden tests de la Fase 7 — sensibilidad (54), comparación (55) y
conclusiones con readiness VC (71), secciones 5.6 y 16.2.

El análisis es puro: mismas entradas ⇒ mismas salidas, y cada conclusión debe
citar la métrica, el mes y el valor que la sustentan.
"""
from decimal import Decimal

from app.engine.simulator import simulate
from app.engine.analysis import (
    sensitivity_batch, compare_runs, derive_conclusions, vc_readiness,
    extract_target, SENSITIVITY_TARGETS,
)
from tests.conftest import make_snapshot

D = Decimal
TOL_MONEY = D("0.05")


def stable_base():
    return {
        "b2b.initial_clients": 10, "b2b.curve.type": "linear", "b2b.curve.rate": 0,
        "b2b.curve.max_clients": 10, "b2b.churn_rate": 0, "b2b.reactivation_rate": 0,
        "b2c.initial_consumers": 1000, "b2c.new_consumers_per_client_monthly": 0,
        "b2c.consumer_churn_rate": 0, "b2c.purchase_conversion": "0.5",
        "b2c.purchase_frequency": 2, "b2c.avg_ticket": 100, "b2c.margin_pct": "0.4",
        "payments.stripe_share": 1,
    }


class TestGoldenF7_1_Sensibilidad:
    """Pantalla 54: cada variación cambia UNA variable y se compara contra el
    mismo baseline; el tornado se ordena por impacto absoluto."""

    def test_impacto_y_orden_del_tornado(self):
        snap = make_snapshot(stable_base(), horizon=12)
        out = sensitivity_batch(snap, [
            {"key": "b2c.avg_ticket", "low": "90", "high": "110"},
            {"key": "b2c.margin_pct", "low": "0.35", "high": "0.45"},
        ], "rev.total")
        # baseline: comisión 10,000/mes × 12
        assert out["baseline_value"] == "120000.00"
        by_key = {r["key"]: r for r in out["results"]}
        # ticket ±10% mueve el GMV proporcionalmente: 12 × 10,000 × ±0.1
        assert by_key["b2c.avg_ticket"]["delta_high"] == "12000.00"
        assert by_key["b2c.avg_ticket"]["delta_low"] == "-12000.00"
        # margen 0.4 → 0.45 sube la utilidad elegible 12.5%
        assert by_key["b2c.margin_pct"]["delta_high"] == "15000.00"
        # el orden es por impacto absoluto descendente
        impacts = [D(r["impact"]) for r in out["results"]]
        assert impacts == sorted(impacts, reverse=True)

    def test_elasticidad_unitaria_del_ticket(self):
        snap = make_snapshot(stable_base(), horizon=12)
        out = sensitivity_batch(snap, [{"key": "b2c.avg_ticket", "low": "90", "high": "110"}],
                                "rev.total")
        row = out["results"][0]
        # ingreso proporcional al ticket ⇒ elasticidad 1 en ambos extremos
        assert row["elasticity_high"] == "1.000000"
        assert row["elasticity_low"] == "1.000000"

    def test_determinismo_del_batch(self):
        snap = make_snapshot(stable_base(), horizon=6)
        vars_ = [{"key": "b2b.churn_rate", "low": "0", "high": "0.05"}]
        assert sensitivity_batch(snap, vars_, "pnl.ebitda") == \
            sensitivity_batch(snap, vars_, "pnl.ebitda")

    def test_supuesto_sobrescrito_por_el_portafolio_se_declara(self):
        """Si el portafolio deriva el valor, variar el supuesto no mueve nada:
        la respuesta lo dice en vez de devolver un impacto cero sin explicación."""
        # make_snapshot no calcula el perfil del portafolio (eso lo hace
        # build_snapshot en producción): se inyecta explícitamente
        snap = make_snapshot(stable_base(), horizon=6)
        snap["portfolio"]["active_clients"] = 1
        snap["portfolio"]["profile"] = {
            "clients_with_baseline": 1, "avg_ticket": "100", "margin_pct": "0.4",
            "consumers_per_client": "1000", "purchase_conversion": "0.5",
            "purchase_frequency": "2", "source_type": "estimado",
        }
        out = sensitivity_batch(snap, [{"key": "b2c.avg_ticket", "low": "80", "high": "120"}],
                                "rev.total")
        row = out["results"][0]
        assert row["impact"] == "0.00"
        assert row["overridden_by"] == "portafolio (estimado)"
        assert row["effective_value"] is not None

    def test_targets_de_resumen(self):
        snap = make_snapshot({**stable_base(), "finance.opening_cash": "0"}, horizon=6)
        out = sensitivity_batch(snap, [{"key": "b2b.cac", "low": "1000", "high": "9000"}],
                                "summary.funding_need")
        assert out["aggregation"] == "summary"
        assert out["target_label"] == SENSITIVITY_TARGETS["summary.funding_need"][0]
        assert out["results"][0]["high_value"] is not None


class TestGoldenF7_2_Comparador:
    """Pantalla 55: deltas correctos contra el baseline y advertencias cuando la
    comparación no es directa."""

    def _run(self, overrides, label, rid, horizon=12):
        snap = make_snapshot({**stable_base(), **overrides}, horizon=horizon)
        r = simulate(snap)
        return {"id": rid, "label": label, "snapshot": snap,
                "summary": r["summary"], "metrics": r["metrics"]}

    def test_deltas_contra_baseline(self):
        base = self._run({}, "Base", "r1")
        alt = self._run({"b2c.avg_ticket": 110}, "Ticket +10%", "r2")
        out = compare_runs([base, alt])
        rev = next(k for k in out["kpis"] if k["key"] == "rev.total")
        assert rev["values"][0]["value"] == "120000.00"
        assert rev["values"][1]["value"] == "132000.00"
        assert rev["values"][1]["delta"] == "12000.00"
        assert rev["values"][1]["delta_pct"] == "0.100000"
        assert "delta" not in rev["values"][0]   # el baseline no tiene delta

    def test_diferencias_de_supuestos(self):
        base = self._run({}, "Base", "r1")
        alt = self._run({"b2c.avg_ticket": 110, "b2b.cac": 5000}, "Alt", "r2")
        out = compare_runs([base, alt])
        keys = {d["key"] for d in out["assumption_diffs"]}
        assert keys == {"b2c.avg_ticket", "b2b.cac"}

    def test_advertencia_por_horizonte(self):
        base = self._run({}, "Base", "r1", horizon=12)
        other = self._run({}, "Corto", "r2", horizon=6)
        out = compare_runs([base, other])
        assert any("horizonte" in w for w in out["warnings"])


class TestGoldenF7_3_Conclusiones:
    """Pantalla 71: reglas explicables; toda conclusión enlaza a evidencia."""

    def test_sin_breakeven_es_riesgo_alto(self):
        r = simulate(make_snapshot({**stable_base(), "b2c.margin_pct": "0.01"},
                                   horizon=12, cost_items=[{
                                       "name": "Nómina", "category": "nomina", "behavior": "fixed",
                                       "amount": "500000", "effective_from": 1, "effective_to": None}]))
        out = derive_conclusions(r, {})
        risk = next(c for c in out if c["code"] == "sin_breakeven")
        assert risk["kind"] == "riesgo" and risk["severity"] == "alta"
        assert risk["evidence"][0]["metric_key"] == "pnl.ebitda"

    def test_breakeven_alcanzado_cita_el_mes(self):
        r = simulate(make_snapshot(stable_base(), horizon=12))
        out = derive_conclusions(r, {})
        found = next(c for c in out if c["code"] == "breakeven_alcanzado")
        assert found["kind"] == "hallazgo"
        assert found["evidence"][0]["month_label"] == r["summary"]["breakeven_label"]

    def test_toda_conclusion_tiene_evidencia_o_es_explicita(self):
        r = simulate(make_snapshot(stable_base(), horizon=12))
        for c in derive_conclusions(r, {}):
            assert c["kind"] in ("hallazgo", "riesgo", "accion", "readiness")
            assert c["title"] and c["code"]
            for ev in c["evidence"]:
                assert ev["metric_key"] and ev["value"] is not None

    def test_cuello_de_botella_genera_accion(self):
        r = simulate(make_snapshot({
            "b2b.initial_clients": 0, "b2b.curve.type": "linear", "b2b.curve.rate": 50,
            "b2b.curve.max_clients": 500, "b2b.onboarding_capacity_monthly": 2,
            "b2b.acquisition_budget_monthly": "9999999",
        }, horizon=6))
        out = derive_conclusions(r, {})
        action = next(c for c in out if c["code"] == "ampliar_capacidad")
        assert action["kind"] == "accion"
        assert "6 meses" in action["title"]

    def test_determinismo(self):
        r = simulate(make_snapshot(stable_base(), horizon=12))
        assert derive_conclusions(r, {}) == derive_conclusions(r, {})


class TestGoldenF7_4_ReadinessVC:
    """Apéndice 16.2: seis dimensiones, cada una con su métrica y valor."""

    def test_dimensiones_y_evidencia(self):
        snap = make_snapshot(stable_base(), horizon=12)
        r = simulate(snap)
        rows = vc_readiness(r, snap)
        dims = {row["dimension"] for row in rows}
        assert {"Mercado y crecimiento", "Economía", "Retención", "Producto",
                "Finanzas", "Calidad de evidencia"} <= dims
        for row in rows:
            assert row["metric_key"] and row["signal"]

    def test_calidad_de_evidencia_refleja_supuestos_declarados(self):
        snap = make_snapshot(stable_base(), horizon=6)
        # make_snapshot marca todos los orígenes como "test": ninguno cuenta como
        # declarado en proyecto/escenario, así que la proporción es 0
        rows = vc_readiness(simulate(snap), snap)
        quality = next(r for r in rows if r["metric_key"] == "assumptions.declared_share")
        assert quality["value"] == "0.000000"

        snap2 = make_snapshot(stable_base(), horizon=6)
        snap2["assumption_origins"] = {k: "escenario" for k in snap2["assumptions"]}
        rows2 = vc_readiness(simulate(snap2), snap2)
        quality2 = next(r for r in rows2 if r["metric_key"] == "assumptions.declared_share")
        assert quality2["value"] == "1.000000"


class TestGoldenF7_5_ExtractTarget:
    """La agregación declarada decide cómo se lee la métrica objetivo."""

    def test_sum_last_y_summary(self):
        r = simulate(make_snapshot(stable_base(), horizon=12))
        assert extract_target(r, "rev.total", "sum") == D("120000.00")
        assert extract_target(r, "cash.balance_end", "last") == r["metrics"]["cash.balance_end"][-1]
        assert extract_target(r, "summary.min_cash", "summary") == D(r["summary"]["min_cash"])
        assert extract_target(r, "metrica.inexistente", "sum") is None
