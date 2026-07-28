"""Golden tests de la Fase 8 — importación asistida (sección 8, IA-01…IA-07).

Cubren parseo, clasificación, mapeo con confianza, normalización de valores y
las validaciones del paso 6 (duplicados, monedas mezcladas, valores imposibles,
márgenes inconsistentes). El commit exige revisión humana: el pipeline solo
propone.
"""
import io
from decimal import Decimal

from openpyxl import Workbook

from app.imports.pipeline import (
    parse_file, classify_table, match_header, normalize, normalize_value,
    parse_number, propose_from_parsed, validate_entity_rows, confidence_band,
    summarize, kind_of,
)

D = Decimal


def catalog_xlsx(rows=None) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Catálogo"
    ws.append(["Producto", "SKU", "Categoría", "Precio de venta", "Costo directo",
               "Inventario", "Elegible rewards"])
    for row in rows or [["Café americano", "CAF-001", "Bebidas", "$45.00", "18", 120, "Sí"],
                        ["Croissant", "PAN-002", "Panadería", "38,50", "15.00", 80, "No"]]:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


class TestGoldenF8_1_Parseo:
    """IA-02: cada formato se normaliza a tablas + bloques de texto."""

    def test_xlsx(self):
        p = parse_file("catalogo.xlsx", catalog_xlsx())
        assert p["kind"] == "xlsx" and p["error"] is None
        assert len(p["tables"]) == 1
        assert p["tables"][0]["name"] == "Catálogo"
        assert len(p["tables"][0]["rows"]) == 2
        assert len(p["sha256"]) == 64

    def test_csv_con_punto_y_coma(self):
        data = "Producto;Precio de venta;Costo directo\nCafé;45;18\nPan;38;15\n".encode()
        p = parse_file("catalogo.csv", data)
        assert p["error"] is None and len(p["tables"][0]["rows"]) == 2

    def test_extension_no_soportada(self):
        p = parse_file("notas.txt", b"hola")
        assert p["error"] and "no soportada" in p["error"].lower()
        assert kind_of("notas.txt") == ""

    def test_archivo_danado_no_revienta(self):
        p = parse_file("roto.xlsx", b"esto no es un xlsx")
        assert p["error"] and p["tables"] == []


class TestGoldenF8_2_ClasificacionYMapeo:
    """IA-03: la entidad se infiere de los encabezados y cada mapeo lleva confianza."""

    def test_catalogo_se_clasifica_como_producto(self):
        p = parse_file("catalogo.xlsx", catalog_xlsx())
        c = classify_table(p["tables"][0])
        assert c["entity_type"] == "ProductService"
        assert D(c["score"]) > D("0.5")
        assert {"name", "sku", "sale_price", "direct_cost"} <= set(c["mapping"])

    def test_baseline_se_clasifica_por_sus_encabezados(self):
        table = {"name": "Base", "headers": ["Ventas mensuales", "Transacciones",
                                             "Ticket promedio", "Margen %",
                                             "Consumidores activos"],
                 "rows": [[100000, 1000, 100, "35%", 800]]}
        assert classify_table(table)["entity_type"] == "ClientBaseline"

    def test_confianza_por_tipo_de_coincidencia(self):
        field, conf = match_header("Precio de venta", "ProductService")
        assert field == "sale_price" and conf == D("0.95")     # exacta
        field2, conf2 = match_header("Precio de venta unitario", "ProductService")
        assert field2 == "sale_price" and conf2 == D("0.80")   # parcial
        assert match_header("Columna sin sentido", "ProductService")[0] is None

    def test_normalizacion_de_encabezados(self):
        assert normalize("Categoría ") == "categoria"
        assert normalize("MARGEN %") == "margen %"


class TestGoldenF8_3_NormalizacionDeValores:
    """16.1: montos como Decimal y porcentajes como decimal 0–1."""

    def test_montos_con_formato_local(self):
        assert parse_number("$1,234.50")[0] == D("1234.50")
        assert parse_number("1234,56")[0] == D("1234.56")
        assert parse_number("  ")[0] is None

    def test_porcentaje_a_decimal(self):
        value, _cur, err = normalize_value("margin_pct", "35%")
        assert value == "0.35" and err is None
        value2, _c2, _e2 = normalize_value("margin_pct", "35")
        assert value2 == "0.35"      # 35 se interpreta como 35%

    def test_moneda_detectada(self):
        _v, currency, _e = normalize_value("sale_price", "1200 MXN")
        assert currency == "MXN"

    def test_booleano_de_elegibilidad(self):
        assert normalize_value("reward_eligible", "Sí")[0] == "true"
        assert normalize_value("reward_eligible", "No")[0] == "false"

    def test_valor_no_numerico_reporta_error(self):
        value, _c, err = normalize_value("sale_price", "carísimo")
        assert value is None and err


class TestGoldenF8_4_Validaciones:
    """IA-04: duplicados, monedas mezcladas y reglas de consistencia."""

    def test_duplicado_y_margen_negativo(self):
        data = catalog_xlsx([
            ["Café", "CAF-001", "Bebidas", "45", "18", 10, "Sí"],
            ["Café", "CAF-001", "Bebidas", "45", "60", 10, "Sí"],
        ])
        out = propose_from_parsed(parse_file("c.xlsx", data))
        codes = {i["code"] for i in out["issues"]}
        assert "duplicado" in codes and "margen_negativo" in codes

    def test_precio_cero_es_alta(self):
        data = catalog_xlsx([["Regalo", "REG-1", "Otros", "0", "0", 1, "No"]])
        out = propose_from_parsed(parse_file("c.xlsx", data))
        issue = next(i for i in out["issues"] if i["code"] == "precio_invalido")
        assert issue["severity"] == "alta"

    def test_monedas_mezcladas(self):
        data = catalog_xlsx([
            ["Café", "C1", "Bebidas", "45 MXN", "18", 10, "Sí"],
            ["Latte", "C2", "Bebidas", "3 USD", "1", 10, "Sí"],
        ])
        out = propose_from_parsed(parse_file("c.xlsx", data))
        assert any(i["code"] == "monedas_mezcladas" for i in out["issues"])

    def test_baseline_incoherente(self):
        rows = [{"entity_ref": "b1", "values": {
            "avg_monthly_sales": {"value": "100000"},
            "avg_monthly_transactions": {"value": "1000"},
            "avg_ticket": {"value": "250"},          # implícito 100 → difiere >10%
            "active_consumers": {"value": "500"},
            "registered_consumers": {"value": "300"},  # activos > registrados
            "monthly_buyers": {"value": "900"},        # compradores > activos
        }}]
        codes = {i["code"] for i in validate_entity_rows("ClientBaseline", rows)}
        assert {"ticket_inconsistente", "activos_mayores", "compradores_mayores"} <= codes


class TestGoldenF8_5_PropuestasYConfianza:
    """IA-05/8.2: cada propuesta trae origen, locator y banda de confianza."""

    def test_propuestas_con_locator_y_origen(self):
        out = propose_from_parsed(parse_file("catalogo.xlsx", catalog_xlsx()))
        assert len(out["proposals"]) == 14      # 7 campos × 2 filas
        price = next(p for p in out["proposals"]
                     if p["field_name"] == "sale_price" and p["entity_ref"] == "Café americano")
        assert price["raw_value"] == "$45.00"
        assert price["proposed_value"] == "45.00"
        assert price["locator"] == "Catálogo!D2"
        assert price["source_type"] == "declarado"
        assert confidence_band(price["confidence"]) == "alta"

    def test_valor_ilegible_baja_la_confianza(self):
        data = catalog_xlsx([["Café", "C1", "Bebidas", "carísimo", "18", 10, "Sí"]])
        out = propose_from_parsed(parse_file("c.xlsx", data))
        bad = next(p for p in out["proposals"] if p["field_name"] == "sale_price")
        assert confidence_band(bad["confidence"]) in ("media", "baja")
        assert bad["source_type"] == "estimado" and bad["notes"]

    def test_bandas_de_la_seccion_8_2(self):
        assert confidence_band("0.95") == "alta"
        assert confidence_band("0.75") == "media"
        assert confidence_band("0.50") == "baja"

    def test_resumen_del_job(self):
        out = propose_from_parsed(parse_file("catalogo.xlsx", catalog_xlsx()))
        s = summarize(out["proposals"], out["issues"])
        assert s["proposals"] == 14 and s["by_entity"]["ProductService"] == 14
        assert s["by_band"]["alta"] == 14
        assert D(s["confidence"]) > D("0.9")

    def test_target_forzado_remapea_a_la_entidad_pedida(self):
        parsed = parse_file("catalogo.xlsx", catalog_xlsx())
        out = propose_from_parsed(parsed, target="catalog")
        assert {p["entity_type"] for p in out["proposals"]} == {"ProductService"}

    def test_determinismo(self):
        parsed = parse_file("catalogo.xlsx", catalog_xlsx())
        assert propose_from_parsed(parsed) == propose_from_parsed(parsed)


class TestGoldenF8_6_Docx:
    """DOCX se lee con la biblioteca estándar: párrafos y tablas."""

    def test_tabla_y_parrafos(self):
        import zipfile
        doc = io.BytesIO()
        xml = ("<?xml version='1.0'?><w:document xmlns:w='x'><w:body>"
               "<w:p><w:r><w:t>Catálogo de la sucursal centro</w:t></w:r></w:p>"
               "<w:tbl>"
               "<w:tr><w:tc><w:p><w:r><w:t>Producto</w:t></w:r></w:p></w:tc>"
               "<w:tc><w:p><w:r><w:t>Precio de venta</w:t></w:r></w:p></w:tc></w:tr>"
               "<w:tr><w:tc><w:p><w:r><w:t>Café</w:t></w:r></w:p></w:tc>"
               "<w:tc><w:p><w:r><w:t>45</w:t></w:r></w:p></w:tc></w:tr>"
               "</w:tbl></w:body></w:document>")
        with zipfile.ZipFile(doc, "w") as z:
            z.writestr("word/document.xml", xml)
        p = parse_file("catalogo.docx", doc.getvalue())
        assert p["error"] is None
        assert p["text_blocks"] and "sucursal centro" in p["text_blocks"][0]
        assert p["tables"][0]["headers"] == ["Producto", "Precio de venta"]
