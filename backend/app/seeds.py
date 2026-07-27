"""Seeds — checklist 16.4: proyecto demo con 10 clientes de distintas industrias.

Uso:  python -m app.seeds
"""
from app.database import SessionLocal, init_db
from app.models import (Project, Scenario, Client, Brand, Branch, ProductService,
                        ClientBaseline, CostItem, Campaign)
from app.engine.snapshot import ENGINE_VERSION
from app import services, audit

# (nombre comercial, legal, industria, sucursales, catálogo, línea base)
CLIENTS = [
    ("Taquería La Norteña", "Alimentos La Norteña SA de CV", "restaurante",
     [("Centro", "Av. Juárez 120, Monterrey"), ("San Pedro", "Río Nazas 45, San Pedro")],
     [("producto", "Orden de tacos (5)", 95, 38), ("producto", "Refresco", 30, 12),
      ("producto", "Quesadilla especial", 75, 30), ("servicio", "Paquete evento", 2500, 1400)],
     dict(sales=185000, tx=2300, ticket=80, margin="0.42", reg=2600, act=1400, buyers=760, freq="1.9")),
    ("Café Alborada", "Alborada Coffee SAPI", "cafeteria",
     [("Roma Norte", "Álvaro Obregón 88, CDMX")],
     [("producto", "Latte", 65, 22), ("producto", "Espresso doble", 48, 14),
      ("producto", "Croissant", 55, 24), ("producto", "Bolsa de grano 250g", 180, 95)],
     dict(sales=98000, tx=1850, ticket=53, margin="0.55", reg=1900, act=980, buyers=540, freq="2.4")),
    ("GymForce", "Fuerza Deportiva del Norte SA", "fitness",
     [("Valle Oriente", "Lázaro Cárdenas 2400, MTY")],
     [("servicio", "Membresía mensual", 749, 190), ("servicio", "Clase personal", 350, 160),
      ("producto", "Proteína (bote)", 890, 560), ("producto", "Shaker", 150, 60)],
     dict(sales=224000, tx=520, ticket=430, margin="0.58", reg=1100, act=640, buyers=410, freq="1.2")),
    ("Estética Kloé", "Kloé Beauty SA de CV", "belleza",
     [("Polanco", "Masaryk 310, CDMX"), ("Condesa", "Tamaulipas 66, CDMX")],
     [("servicio", "Corte y peinado", 380, 120), ("servicio", "Color completo", 1250, 480),
      ("servicio", "Manicure", 260, 90), ("producto", "Shampoo profesional", 320, 170)],
     dict(sales=142000, tx=430, ticket=330, margin="0.60", reg=980, act=520, buyers=310, freq="1.1")),
    ("Farmacia Vida", "Distribuidora Vida Sana SA", "farmacia",
     [("Centro", "Hidalgo 55, Guadalajara"), ("Chapalita", "Guadalupe 1120, GDL"),
      ("Zapopan", "Av. Ávila Camacho 900, Zapopan")],
     [("producto", "Analgésico caja", 85, 52), ("producto", "Vitamínico", 210, 120),
      ("producto", "Dermocosmético", 340, 200), ("servicio", "Consulta médica", 75, 25)],
     dict(sales=460000, tx=6200, ticket=74, margin="0.28", reg=5200, act=3100, buyers=1900, freq="2.1")),
    ("Boutique Marea", "Marea Moda SAPI", "retail_moda",
     [("Antara", "Ejército Nacional 843, CDMX")],
     [("producto", "Vestido casual", 890, 380), ("producto", "Blusa", 450, 190),
      ("producto", "Accesorio", 250, 90), ("producto", "Bolsa artesanal", 1200, 520)],
     dict(sales=132000, tx=210, ticket=630, margin="0.52", reg=760, act=380, buyers=150, freq="0.8")),
    ("Ferretería El Tornillo", "Ferretera Industrial del Bajío SA", "ferreteria",
     [("Centro", "Madero 210, León"), ("Bodega Norte", "Blvd. Hidalgo 2201, León")],
     [("producto", "Taladro inalámbrico", 1450, 980), ("producto", "Caja de tornillos", 120, 55),
      ("producto", "Pintura 4L", 480, 300), ("servicio", "Corte a medida", 90, 30)],
     dict(sales=380000, tx=1450, ticket=262, margin="0.31", reg=2100, act=1200, buyers=690, freq="1.4")),
    ("Panadería San Blas", "Pan Artesanal San Blas SC", "panaderia",
     [("Mercado", "Portal Juárez 8, Puebla")],
     [("producto", "Concha", 12, 4), ("producto", "Baguette", 32, 12),
      ("producto", "Pastel 20 pers.", 620, 280), ("producto", "Café de olla", 28, 8)],
     dict(sales=76000, tx=3800, ticket=20, margin="0.62", reg=2400, act=1600, buyers=1100, freq="3.5")),
    ("Veterinaria Patitas", "Clínica Veterinaria Patitas SC", "salud_mascotas",
     [("Del Valle", "Gabriel Mancera 720, CDMX")],
     [("servicio", "Consulta general", 350, 120), ("servicio", "Vacunación", 420, 210),
      ("producto", "Alimento premium 8kg", 980, 640), ("servicio", "Estética canina", 380, 150)],
     dict(sales=118000, tx=390, ticket=303, margin="0.47", reg=850, act=460, buyers=280, freq="1.0")),
    ("Lavandería Burbujas", "Servicios Burbujas SA de CV", "servicios",
     [("Narvarte", "Dr. Vértiz 1080, CDMX"), ("Portales", "Santa Cruz 340, CDMX")],
     [("servicio", "Carga autoservicio", 95, 30), ("servicio", "Lavado por encargo kg", 28, 9),
      ("servicio", "Tintorería prenda", 85, 32), ("producto", "Bolsa de detergente", 45, 22)],
     dict(sales=64000, tx=1650, ticket=39, margin="0.63", reg=1300, act=740, buyers=520, freq="2.6")),
]

COST_ITEMS = [
    ("Nómina núcleo (producto+ops)", "nomina", "fixed", "180000", 1, None),
    ("Nómina expansión", "nomina", "fixed", "120000", 13, None),
    ("Infraestructura cloud base", "tecnologia", "fixed", "18000", 1, None),
    ("Herramientas SaaS", "tecnologia", "fixed", "9500", 1, None),
    ("Oficina y administración", "administracion", "fixed", "32000", 1, None),
    ("Marketing de marca", "marketing", "fixed", "25000", 1, None),
    ("Mensajería/WhatsApp por transacción", "infraestructura", "per_transaction", "0.35", 1, None),
    ("Cómputo IA por cliente activo", "infraestructura", "per_active_client", "120", 1, None),
    ("Procesamiento y fraude (% GMV)", "infraestructura", "pct_gmv", "0.003", 1, None),
    ("Soporte por cliente activo", "otros", "per_active_client", "85", 1, None),
]

PROJECT_ASSUMPTIONS = {
    "b2b.initial_clients": "10",
    "b2b.curve.type": "logistic",
    "b2b.curve.max_clients": "420",
    "b2b.curve.rate": "0.22",
    "b2b.curve.inflection_month": "22",
    "b2b.churn_rate": "0.028",
    "b2b.reactivation_rate": "0.06",
    "b2b.cac": "4200",
    "b2b.acquisition_budget_monthly": "90000",
    "b2b.onboarding_capacity_monthly": "18",
    "b2c.new_consumers_per_client_monthly": "22",
    "b2c.consumer_churn_rate": "0.055",
    "b2c.cohort.enabled": "true",
    "b2c.cohort.retention_m1": "0.72",
    "b2c.cohort.retention_stable": "0.945",
    "b2c.cohort.retention_ramp": "0.85",
    "b2c.cohort.maturation_months": "3",
    "b2c.cohort.initial_activity_factor": "0.60",
    "payments.stripe_share": "0.55",
    "campaigns.enabled": "true",
    "points.funnel.enabled": "true",
    "payments.processing_fee.enabled": "true",
    "payments.settlement.enabled": "true",
    "rewards.catalog_gating.enabled": "true",
    "subs.enabled": "true",
    "subs.start_month": "13",
    "subs.price_monthly": "599",
    "subs.adoption_rate": "0.35",
    "subs.ramp_months": "6",
    "tokens.enabled": "true",
    "tokens.start_month": "16",
    "tokens.revenue_per_client_monthly": "180",
    "tokens.adoption_rate": "0.45",
    "tokens.cost_pct": "0.42",
    "finance.opening_cash": "2500000",
    "finance.operating_buffer": "500000",
}


def run_seeds():
    init_db()
    db = SessionLocal()
    try:
        existing = db.query(Project).filter(Project.name == "Pigui — Plan maestro demo").first()
        if existing:
            print(f"El proyecto demo ya existe (id={existing.id}); no se duplica.")
            return existing.id

        project = Project(
            name="Pigui — Plan maestro demo",
            description="Proyecto de demostración con 10 clientes B2B de distintas industrias (seeds 16.4).",
            base_currency="MXN", start_month="2026-08", horizon_months=60, status="active",
        )
        db.add(project)
        db.flush()

        services.upsert_assumptions(db, project.id, None, PROJECT_ASSUMPTIONS,
                                    source_type="declarado", actor="seeds")

        for name, category, behavior, amount, frm, to in COST_ITEMS:
            db.add(CostItem(project_id=project.id, name=name, category=category,
                            behavior=behavior, amount=amount,
                            effective_from=frm, effective_to=to))

        base = Scenario(project_id=project.id, name="Base", type="base", engine_version=ENGINE_VERSION)
        db.add(base)
        db.flush()
        for stype, sname in (("conservador", "Conservador"), ("optimista", "Optimista")):
            sc = Scenario(project_id=project.id, name=sname, type=stype,
                          parent_scenario_id=base.id, engine_version=ENGINE_VERSION)
            db.add(sc)
            db.flush()
            services.apply_scenario_multipliers(db, project.id, sc.id, stype)

        for trade, legal, industry, branches, items, bl in CLIENTS:
            client = Client(project_id=project.id, legal_name=legal, trade_name=trade,
                            industry=industry, status="active", currency="MXN",
                            onboarding_date="2026-07-01")
            db.add(client)
            db.flush()
            brand = Brand(client_id=client.id, name=trade)
            db.add(brand)
            db.flush()
            branch_ids = []
            for bname, location in branches:
                br = Branch(brand_id=brand.id, name=bname, location=location)
                db.add(br)
                db.flush()
                branch_ids.append(br.id)
            for i, (itype, iname, price, cost) in enumerate(items):
                db.add(ProductService(branch_id=branch_ids[i % len(branch_ids)], type=itype,
                                      name=iname, sale_price=str(price), direct_cost=str(cost),
                                      sku=f"{trade[:3].upper()}-{i+1:03d}"))
            db.add(ClientBaseline(
                client_id=client.id, avg_monthly_sales=str(bl["sales"]),
                avg_monthly_transactions=str(bl["tx"]), avg_ticket=str(bl["ticket"]),
                margin_pct=bl["margin"], registered_consumers=bl["reg"],
                active_consumers=bl["act"], monthly_buyers=bl["buyers"],
                purchase_frequency=bl["freq"], source_type="declarado", confidence=85,
            ))
            audit.record(db, "client_created", "Client", client.id, actor_id="seeds",
                         after={"trade_name": trade})

        # campaña demo (fase 5): promo de conversión con puntos extra en meses 3–8
        promo = Campaign(project_id=project.id, name="Promo de lanzamiento",
                         description="Impulso de conversión con puntos extra durante el arranque.",
                         campaign_type="mixta", status="active",
                         start_month=3, end_month=8, created_by="seeds")
        db.add(promo)
        db.flush()
        services.upsert_campaign_effects(db, project.id, promo.id, {
            "campaign.uplift.conversion_pct": "0.15",
            "campaign.points.extra_pct": "0.05",
            "campaign.cost_monthly": "12000",
        }, source_type="declarado", actor="seeds")
        audit.record(db, "campaign.create", "Campaign", promo.id, actor_id="seeds",
                     after={"name": promo.name})

        audit.record(db, "project_created", "Project", project.id, actor_id="seeds",
                     after={"name": project.name})
        db.commit()
        print(f"Proyecto demo creado: {project.id}")
        print(f"Escenarios: {[s.name for s in project.scenarios]}")
        print(f"Clientes: {len(CLIENTS)}")
        return project.id
    finally:
        db.close()


if __name__ == "__main__":
    run_seeds()
