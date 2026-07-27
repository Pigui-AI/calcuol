"""Tipos y utilidades de dinero.

Regla del documento (6.2 y 16.1): aritmética decimal, nunca float binario en
cálculos contables. Redondeo al final de cada cálculo, no en pasos intermedios.
"""
from decimal import Decimal, ROUND_HALF_UP, getcontext
from sqlalchemy.types import TypeDecorator, String

getcontext().prec = 34  # precisión amplia para cálculos intermedios

ZERO = Decimal("0")
ONE = Decimal("1")
HUNDRED = Decimal("100")

# cuantizaciones finales
Q_MONEY = Decimal("0.01")     # montos monetarios
Q_RATE = Decimal("0.000001")  # tasas y porcentajes (como decimal: 0.25 = 25%)
Q_COUNT = Decimal("0.0001")   # stocks (clientes, consumidores, transacciones)


def D(value) -> Decimal:
    """Convierte con seguridad a Decimal (evita pasar por float binario cuando es str)."""
    if value is None:
        return ZERO
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        return Decimal(str(value))
    return Decimal(str(value))


def q_money(value: Decimal) -> Decimal:
    return D(value).quantize(Q_MONEY, rounding=ROUND_HALF_UP)


def q_rate(value: Decimal) -> Decimal:
    return D(value).quantize(Q_RATE, rounding=ROUND_HALF_UP)


def q_count(value: Decimal) -> Decimal:
    return D(value).quantize(Q_COUNT, rounding=ROUND_HALF_UP)


class MoneyType(TypeDecorator):
    """Guarda Decimal como texto exacto. Portátil entre SQLite y PostgreSQL."""
    impl = String(40)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return str(D(value))

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return Decimal(value)
