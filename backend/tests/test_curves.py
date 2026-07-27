"""Pruebas de curvas de crecimiento (pantalla 27)."""
from decimal import Decimal

from app.engine.curves import curve_target

D = Decimal


def test_linear_respeta_techo():
    assert curve_target("linear", 1, D("0"), D("100"), D("10"), D("0")) == D("10")
    assert curve_target("linear", 50, D("0"), D("100"), D("10"), D("0")) == D("100")


def test_exponential_crece_y_respeta_techo():
    m3 = curve_target("exponential", 3, D("10"), D("1000"), D("0.5"), D("0"))
    assert m3 == D("33.75")  # 10 × 1.5³
    assert curve_target("exponential", 60, D("10"), D("1000"), D("0.5"), D("0")) == D("1000")


def test_logistic_pasa_por_inflexion_y_satura():
    base, mx = D("10"), D("210")
    mid = curve_target("logistic", 18, base, mx, D("0.4"), D("18"))
    assert abs(mid - D("110")) < D("1")          # punto medio en la inflexión
    end = curve_target("logistic", 60, base, mx, D("0.4"), D("18"))
    assert end > D("209")


def test_decelerated_monotona_y_acotada():
    prev = D("0")
    for m in range(1, 61):
        v = curve_target("decelerated", m, D("0"), D("100"), D("0.1"), D("0"))
        assert v >= prev
        assert v <= D("100")
        prev = v


def test_max_menor_o_igual_a_base_devuelve_base():
    assert curve_target("logistic", 5, D("50"), D("50"), D("0.3"), D("10")) == D("50")
