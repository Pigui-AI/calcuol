"""Golden scenarios de la Fase 5 — campañas, rewards, embudo de redención,
settlements y AR por factura (pantallas 31–44), sección 14.1.

Todos los motores nuevos nacen apagados: TestGolden26 verifica la identidad
total con el modelo previo. Economía base cerrada: 10 clientes estables,
1,000 consumidores, GMV 100,000, utilidad elegible 40,000, comisión 10,000,
puntos 2,000, negocio 28,000; con stripe 0.6: collected 7,200 y AR 4,800.
"""
from decimal import Decimal

from app.engine.simulator import simulate
from tests.conftest import make_snapshot

D = Decimal
TOL_MONEY = D("0.05")
TOL_COUNT = D("0.001")


def stable_base():
    return {
        "b2b.initial_clients": 10, "b2b.curve.type": "linear", "b2b.curve.rate": 0,
        "b2b.curve.max_clients": 10, "b2b.churn_rate": 0, "b2b.reactivation_rate": 0,
        "b2c.initial_consumers": 1000, "b2c.new_consumers_per_client_monthly": 0,
        "b2c.consumer_churn_rate": 0, "b2c.purchase_conversion": "0.5",
        "b2c.purchase_frequency": 2, "b2c.avg_ticket": 100, "b2c.margin_pct": "0.4",
    }


def campaign(effects: dict, start=1, end=1, cid="camp-1", name="Campaña test"):
    base = {
        "campaign.uplift.conversion_pct": "0", "campaign.uplift.frequency_pct": "0",
        "campaign.uplift.ticket_pct": "0", "campaign.points.extra_pct": "0",
        "campaign.redemption.uplift_pct": "0", "campaign.cost_monthly": "0",
    }
    base.update(effects)
    return {"id": cid, "name": name, "campaign_type": "mixta", "status": "active",
            "start_month": start, "end_month": end, "effects": base}


class TestGolden17_CampanaConversion:
    """Campaña de conversión en meses 2–3: uplift 20% y costo mensual 5,000."""

    def run(self):
        return simulate(make_snapshot(
            {**stable_base(), "campaigns.enabled": "true"}, horizon=4,
            campaigns=[campaign({"campaign.uplift.conversion_pct": "0.20",
                                 "campaign.cost_monthly": "5000"}, start=2, end=3)],
        ))

    def test_mes_activo_exacto(self):
        m = self.run()["metrics"]
        assert m["b2c.buyers"][1] == D("600.0000")
        assert m["b2c.transactions"][1] == D("1200.0000")
        assert m["tx.gmv"][1] == D("120000.00")
        assert m["rev.commission"][1] == D("12000.00")
        assert m["points.emitted"][1] == D("2400.0000")
        assert m["camp.gmv_incremental"][1] == D("20000.00")
        assert m["camp.revenue_incremental"][1] == D("2000.00")
        assert m["cost.campaigns"][1] == D("5000.00")
        assert m["camp.roi"][1] == D("0.400000")
        assert m["camp.active_count"][1] == D("1.0000")

    def test_meses_inactivos_en_base(self):
        m = self.run()["metrics"]
        for i in (0, 3):
            assert m["tx.gmv"][i] == D("100000.00")
            assert m["camp.active_count"][i] == D("0.0000")
            assert m["camp.gmv_incremental"][i] == D("0.00")
            assert m["cost.campaigns"][i] == D("0.00")

    def test_opex_carga_el_gasto(self):
        m = self.run()["metrics"]
        assert m["pnl.opex"][1] - m["pnl.opex"][0] == D("5000.00")

    def test_summary_campanas(self):
        s = self.run()["summary"]["campaigns"]
        assert s["total_spend"] == "10000.00"
        assert s["total_gmv_incremental"] == "40000.00"
        assert s["total_revenue_incremental"] == "4000.00"
        assert s["roi_total"] == "0.400000"


class TestGolden18_ContrafactualMultiplicativo:
    """Uplifts simultáneos de conversión, frecuencia y ticket: GMV = base × 1.1³."""

    def overrides(self):
        return {**stable_base(), "campaigns.enabled": "true"}

    def camp(self):
        return campaign({"campaign.uplift.conversion_pct": "0.1",
                         "campaign.uplift.frequency_pct": "0.1",
                         "campaign.uplift.ticket_pct": "0.1"}, start=2, end=2)

    def test_gmv_y_contrafactual(self):
        m = simulate(make_snapshot(self.overrides(), horizon=3,
                                   campaigns=[self.camp()]))["metrics"]
        assert m["tx.gmv"][1] == D("133100.00")   # 100000 × 1.1³
        assert m["camp.gmv_incremental"][1] == D("33100.00")

    def test_uplifts_en_rama_de_cohortes(self):
        m = simulate(make_snapshot({
            **self.overrides(),
            "b2c.cohort.enabled": "true",
            # retención constante = 1 (sin churn) y actividad plena → equivalencia
            "b2c.cohort.retention_m1": "1", "b2c.cohort.retention_stable": "1",
            "b2c.cohort.maturation_months": "1", "b2c.cohort.initial_activity_factor": "1",
        }, horizon=3, campaigns=[self.camp()]))["metrics"]
        assert abs(m["tx.gmv"][1] - D("133100.00")) <= TOL_MONEY
        assert abs(m["b2c.transactions"][1] - D("1210.0000")) <= TOL_COUNT  # 500×1.1×2×1.1


class TestGolden19_RewardsGating:
    """Gating por catálogo: solo el share elegible emite puntos; el resto vuelve al negocio."""

    def test_split_conservado(self):
        m = simulate(make_snapshot({
            **stable_base(), "rewards.catalog_gating.enabled": "true",
            "rewards.eligible_share": "0.6",
        }, horizon=3))["metrics"]
        for i in range(3):
            assert m["points.emitted"][i] == D("1200.0000")
            assert m["points.business_returned"][i] == D("800.0000")
            assert m["tx.business_net"][i] == D("28800.00")
            total = m["rev.commission"][i] + m["points.emitted"][i] + m["tx.business_net"][i]
            assert abs(total - D("40000.00")) <= TOL_MONEY

    def test_puntos_extra_de_campana(self):
        r = simulate(make_snapshot({
            **stable_base(), "campaigns.enabled": "true",
            "rewards.catalog_gating.enabled": "true", "rewards.eligible_share": "0.6",
        }, horizon=2, campaigns=[campaign({"campaign.points.extra_pct": "0.10"}, 1, 2)]))
        m = r["metrics"]
        assert m["camp.extra_points"][0] == D("2400.0000")   # 40000 × 0.10 × 0.6
        assert m["cost.campaigns"][0] == D("2400.00")        # devengados como gasto
        # los extras no los paga el negocio: el cobro inmediato no cambia
        assert m["cash.collected_immediate"][0] == D("6720.00")  # (10000+1200) × 0.6


class TestGolden20_EmbudoFIFO:
    """Embudo FIFO: intención 0.5 × conversión 0.7, expiración a los 2 meses."""

    def run(self):
        return simulate(make_snapshot({
            **stable_base(), "points.funnel.enabled": "true",
            "points.funnel.intent_rate": "0.5",
            "points.funnel.redemption_conversion": "0.7",
            "points.funnel.expiry_months": "2",
        }, horizon=4))

    def test_valores_cerrados(self):
        m = self.run()["metrics"]
        assert [m["points.redeemed"][i] for i in range(4)] == \
            [D("0.0000"), D("700.0000"), D("1155.0000"), D("1400.0000")]
        assert [m["points.expired"][i] for i in range(4)] == \
            [D("0.0000"), D("0.0000"), D("145.0000"), D("600.0000")]
        assert [m["points.balance_end"][i] for i in range(4)] == \
            [D("2000.0000"), D("3300.0000"), D("4000.0000"), D("4000.0000")]

    def test_reconciliacion_ledger(self):
        m = self.run()["metrics"]
        prev = D("0")
        for i in range(4):
            expected = prev + m["points.emitted"][i] + m["camp.extra_points"][i] \
                - m["points.redeemed"][i] - m["points.expired"][i]
            assert abs(m["points.balance_end"][i] - expected) <= D("0.01"), f"mes {i+1}"
            prev = m["points.balance_end"][i]


class TestGolden20b_RegresionesDeRevision:
    """Regresiones de la revisión adversarial: el embudo no debe pisar la curva B2B
    y redención+expiración jamás debitan más del 100% del saldo."""

    def test_funnel_no_corrompe_target_curve(self):
        base = simulate(make_snapshot(stable_base(), horizon=4))["metrics"]
        funnel = simulate(make_snapshot({
            **stable_base(), "points.funnel.enabled": "true",
        }, horizon=4))["metrics"]
        assert funnel["b2b.target_curve"] == base["b2b.target_curve"]
        assert funnel["b2b.target_curve"][0] == D("10.0000")

    def test_redencion_mas_expiracion_acotadas_al_saldo(self):
        m = simulate(make_snapshot({
            **stable_base(), "campaigns.enabled": "true",
        }, horizon=6, campaigns=[campaign({"campaign.redemption.uplift_pct": "0.80"}, 1, 6)]))["metrics"]
        for i in range(6):
            debit = m["points.redeemed"][i] + m["points.expired"][i]
            start = m["points.balance_end"][i - 1] if i > 0 else D("0")
            assert debit <= start + D("0.01"), f"mes {i+1} debita más del saldo"
            assert m["points.balance_end"][i] >= D("0")


class TestGolden21_FunnelEquivalencia:
    """Funnel con defaults (0.50 × 0.70 = 0.35): redención idéntica al modelo plano
    antes de la primera expiración."""

    def test_redencion_equivalente(self):
        plano = simulate(make_snapshot(stable_base(), horizon=6))["metrics"]
        funnel = simulate(make_snapshot({
            **stable_base(), "points.funnel.enabled": "true",
        }, horizon=6))["metrics"]
        # expiry default 12 meses: en horizonte 6 nunca expira por edad
        for i in range(6):
            # el saldo diverge porque la expiración plana (5% del saldo) no existe en FIFO
            # hasta los 12 meses; comparar solo la PRIMERA redención (mismo saldo inicial)
            if i == 0:
                assert funnel["points.redeemed"][i] == plano["points.redeemed"][i]
        assert funnel["points.redeemed"][1] == D("0.35") * funnel["points.balance_end"][0]


class TestGolden22_Settlements:
    """Settlements con lag 1 y processing fee 2.9% sobre el bruto."""

    def run(self):
        return simulate(make_snapshot({
            **stable_base(), "payments.settlement.enabled": "true",
            "payments.settlement.lag_months": "1",
            "payments.processing_fee.enabled": "true",
        }, horizon=3))

    def test_mes_1(self):
        m = self.run()["metrics"]
        assert m["stl.gross_collected"][0] == D("60000.00")
        assert m["cost.processing_fees"][0] == D("1740.00")     # 60000 × 0.029
        assert m["stl.merchant_due"][0] == D("52800.00")        # 60000 − 7200
        assert m["stl.paid_out"][0] == D("0.00")
        assert m["stl.payable_end"][0] == D("52800.00")

    def test_mes_2_liquidacion_y_ar(self):
        m = self.run()["metrics"]
        assert m["stl.paid_out"][1] == D("52800.00")
        assert m["ar.collections"][1] == D("4704.00")           # 4800 × 0.98

    def test_reconciliacion_payable(self):
        m = self.run()["metrics"]
        total_due = sum(m["stl.merchant_due"], D("0"))
        total_paid = sum(m["stl.paid_out"], D("0"))
        assert abs(m["stl.payable_end"][-1] - (total_due - total_paid)) <= TOL_MONEY

    def test_logs_de_settlements(self):
        logs = self.run()["logs"]["settlements"]
        assert len(logs) == 3
        assert logs[0] == {"month": 1, "gross_collected": "60000.00", "processing_fee": "1740.00",
                           "pigui_take": "7200.00", "merchant_due": "52800.00", "payout_month": 2}


class TestGolden23_SettlementsNeutralidad:
    """Settlements con lag 0 y sin fee: la caja neta y el EBITDA no cambian."""

    def test_series_identicas(self):
        base = simulate(make_snapshot(stable_base(), horizon=6))["metrics"]
        stl = simulate(make_snapshot({
            **stable_base(), "payments.settlement.enabled": "true",
            "payments.settlement.lag_months": "0",
        }, horizon=6))["metrics"]
        assert stl["cash.net"] == base["cash.net"]
        assert stl["pnl.ebitda"] == base["pnl.ebitda"]
        assert stl["cash.balance_end"] == base["cash.balance_end"]


class TestGolden24_FeeSinSettlements:
    """Solo el fee activo: 2.9% sobre lo cobrado vía Stripe (7,200)."""

    def test_fee_mensual(self):
        m = simulate(make_snapshot({
            **stable_base(), "payments.processing_fee.enabled": "true",
        }, horizon=3))["metrics"]
        for i in range(3):
            assert m["cost.processing_fees"][i] == D("208.80")   # 7200 × 0.029
            assert m["pnl.variable_costs"][i] == m["cost.variable_items"][i] \
                + m["cost.tokens"][i] + D("208.80")


class TestGolden25_ArPorFactura:
    """Una factura sintética por mes con AR nueva; montos reconciliados."""

    def test_facturas(self):
        r = simulate(make_snapshot(stable_base(), horizon=3))
        invoices = r["logs"]["ar_invoices"]
        assert len(invoices) == 3
        assert invoices[0] == {"number": "INV-0001", "month": 1, "amount": "4800.00",
                               "due_month": 2, "expected_collection": "4704.00",
                               "expected_writeoff": "96.00"}
        total = sum(D(i["amount"]) for i in invoices)
        ar_new = sum(r["metrics"]["ar.new"], D("0"))
        assert abs(total - ar_new) <= TOL_MONEY


class TestGolden26_ApagadoTotal:
    """Defaults nuevos + campaña presente pero motor apagado: idéntico al modelo previo."""

    def test_identidad_con_campana_ignorada(self):
        base = simulate(make_snapshot(stable_base(), horizon=6))
        con_campana = simulate(make_snapshot(stable_base(), horizon=6,
                                             campaigns=[campaign(
                                                 {"campaign.uplift.conversion_pct": "0.5",
                                                  "campaign.cost_monthly": "99999"}, 1, 6)]))
        for key in base["metrics"]:
            assert con_campana["metrics"][key] == base["metrics"][key], key

    def test_metricas_nuevas_en_cero(self):
        m = simulate(make_snapshot(stable_base(), horizon=6))["metrics"]
        for key in ("camp.gmv_incremental", "camp.revenue_incremental", "cost.campaigns",
                    "cost.processing_fees", "stl.gross_collected", "stl.paid_out",
                    "stl.payable_end", "points.funnel.intents", "points.business_returned"):
            assert all(v == D("0") or v == D("0.00") or v == D("0.0000") or v == D("0.000000")
                       for v in m[key]), key


class TestGolden27_DeterminismoFase5:
    """Mismo snapshot → mismo hash; cada supuesto nuevo y cada campaña cambian el hash."""

    NUEVAS = ("campaigns.enabled", "rewards.catalog_gating.enabled", "rewards.eligible_share",
              "points.funnel.enabled", "points.funnel.intent_rate",
              "points.funnel.redemption_conversion", "points.funnel.expiry_months",
              "payments.processing_fee.enabled", "payments.settlement.enabled",
              "payments.settlement.lag_months")

    def activado(self, extra=None, campaigns=None):
        overrides = {
            **stable_base(), "campaigns.enabled": "true", "points.funnel.enabled": "true",
            "payments.settlement.enabled": "true", "payments.processing_fee.enabled": "true",
            "rewards.catalog_gating.enabled": "true", "rewards.eligible_share": "0.8",
        }
        overrides.update(extra or {})
        return make_snapshot(overrides, horizon=8,
                             campaigns=campaigns if campaigns is not None
                             else [campaign({"campaign.uplift.conversion_pct": "0.1",
                                             "campaign.cost_monthly": "1000"}, 2, 5)])

    def test_determinismo(self):
        snap = self.activado()
        assert simulate(snap)["output_hash"] == simulate(snap)["output_hash"]

    def test_cada_supuesto_cambia_hashes(self):
        base_snap = self.activado()
        base = simulate(base_snap)
        alternos = {
            "campaigns.enabled": "false", "rewards.catalog_gating.enabled": "false",
            "rewards.eligible_share": "0.5", "points.funnel.enabled": "false",
            "points.funnel.intent_rate": "0.4", "points.funnel.redemption_conversion": "0.6",
            # expiración a 1 mes: visible dentro del horizonte (con 6+ la redención FIFO
            # consume los buckets antes de que expiren y la salida sería idéntica)
            "points.funnel.expiry_months": "1", "payments.processing_fee.enabled": "false",
            "payments.settlement.enabled": "false", "payments.settlement.lag_months": "2",
        }
        for key in self.NUEVAS:
            snap = self.activado(extra={key: alternos[key]})
            assert snap["input_hash"] != base_snap["input_hash"], key
            assert simulate(snap)["output_hash"] != base["output_hash"], key

    def test_campana_cambia_input_hash(self):
        sin = self.activado(campaigns=[])
        con = self.activado()
        otra = self.activado(campaigns=[campaign({"campaign.uplift.conversion_pct": "0.2",
                                                  "campaign.cost_monthly": "1000"}, 2, 5)])
        assert sin["input_hash"] != con["input_hash"]
        assert otra["input_hash"] != con["input_hash"]
