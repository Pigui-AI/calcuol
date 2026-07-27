# Pigui Financial Engine

Implementación de las Fases 0–4 del roadmap de la **Especificación funcional, financiera, UX y técnica v1.0** del motor de simulaciones hiperrealistas de Pigui.

## Qué incluye este MVP

El motor cubre el flujo completo de valor definido en la sección 15 del documento: crear un proyecto con escenarios versionados (Base, Conservador, Optimista), cargar el portafolio de clientes B2B con marcas, sucursales, catálogo y línea base financiera, ejecutar simulaciones mensuales determinísticas de 12 a 60 meses con estado de resultados, flujo de efectivo y unit economics, y exportar el business plan completo a Excel. Cada corrida congela un snapshot inmutable de inputs cuyo hash garantiza reproducibilidad: mismos inputs + misma versión del motor = mismos outputs.

## Arquitectura (sección 6.1 del documento)

```
pigui-financial-engine/
├── backend/                  # FastAPI + motor financiero en Python
│   ├── app/
│   │   ├── engine/           #   Motor puro: money types, curvas, cohortes, snapshots, simulador
│   │   │   ├── money.py      #   Aritmética Decimal, nunca float (6.2/16.1)
│   │   │   ├── curves.py     #   Curvas lineal/exponencial/logística/desacelerada (p.27)
│   │   │   ├── cohorts.py    #   Cohortes B2C: retención por antigüedad y LTV (fase 4, 24–30)
│   │   │   ├── assumptions.py#   Catálogo de supuestos con defaults y validaciones
│   │   │   ├── snapshot.py   #   Snapshots inmutables + hash canónico (4.3)
│   │   │   └── simulator.py  #   Orden de cálculo mensual (4.2) y fórmulas (5)
│   │   ├── models.py         #   Modelo de datos (7): Project, Scenario, AssumptionSet,
│   │   │                     #   Client, Brand, Branch, ProductService, ClientBaseline,
│   │   │                     #   CostItem, SimulationRun, MonthlyProjection,
│   │   │                     #   FieldProvenance, AuditEvent, ExportJob
│   │   ├── routers/          #   API REST (11.1): projects, clients, simulations, exports
│   │   ├── services.py       #   Resolución de supuestos, snapshots, ejecución de runs
│   │   ├── exports/excel.py  #   Workbook Excel (13.1) con openpyxl
│   │   └── seeds.py          #   Proyecto demo con 10 clientes (checklist 16.4)
│   └── tests/                #   Golden tests (14.1) + reconciliaciones + curvas
└── frontend/                 # Next.js 14 + TypeScript + Tailwind + Recharts
    └── app/                  #   Pantallas implementadas (ver mapa abajo)
```

La base de datos es SQLite por defecto (cero configuración) y queda lista para PostgreSQL: exporta `DATABASE_URL=postgresql://...` y SQLAlchemy hace el resto. Los montos se guardan como texto decimal exacto, portátil entre ambos motores.

## Cómo correr

Requisitos: Python 3.10+ y Node 18+.

**Backend** (puerto 8000):

```bash
cd backend
pip install -r requirements.txt
python -m app.seeds            # opcional: carga el proyecto demo con 10 clientes
uvicorn app.main:app --reload --port 8000
```

**Frontend** (puerto 3000):

```bash
cd frontend
npm install
npm run dev
```

Abre http://localhost:3000. La documentación interactiva de la API queda en http://localhost:8000/docs.

**Despliegue.** El frontend se publica automáticamente en GitHub Pages con cada push a `main` (https://pigui-ai.github.io/calcuol/) y el backend está listo para Google Cloud Run con su Dockerfile. Instrucciones completas en [DEPLOY.md](DEPLOY.md).

**Pruebas** (golden scenarios de la sección 14.1):

```bash
cd backend
python -m pytest tests/ -q     # 34 pruebas: determinismo, churn exacto, AR, MRR mes 13,
                               # cuellos de botella, reconciliación de caja/P&L/puntos,
                               # cohortes B2C (equivalencia, matriz, LTV, sensibilidad de hash)
```

## Mapa de pantallas implementadas

| Pantallas del documento | Ruta en la app |
|---|---|
| 01 Proyectos y escenarios | `/` |
| 02–06 Wizard de proyecto (general, base, crecimiento, ingresos, revisión) | `/projects/new` |
| 07 Portafolio de clientes B2B | `/projects/{id}/clients` |
| 08–12 Wizard de cliente (negocio, marca/sucursales, catálogo, línea base, revisión) | `/projects/{id}/clients/new` |
| 13–16 Perfil del cliente (resumen, sucursales, catálogo, línea base) | `/projects/{id}/clients/{clientId}` |
| 24–27 Adquisición B2B (curvas y restricciones) | `/growth-b2b` |
| 28–29 Adopción B2C (embudo) | `/growth-b2c` |
| 30 Cohortes y restricciones de crecimiento | `/cohorts` + sección en `/run` |
| 50 Centro de supuestos | `/projects/{id}/scenarios/{sid}/assumptions` |
| 51 Escenarios | `/projects/{id}` (tarjetas de escenario) |
| 52 Ejecutar simulación | `/projects/{id}/scenarios/{sid}/simulate` |
| 53, 56–60, 64–70 Resultados (plan mensual, P&L, cash flow, unit economics, dashboard) | `/projects/{id}/runs/{runId}` |
| 72 Exportación a Excel | Botón "Exportar a Excel" en resultados |

## Decisiones de implementación fieles al documento

Aritmética `Decimal` en todo el motor con redondeo solo al emitir métricas (16.1). Supuestos versionados que nunca se sobrescriben: cada cambio crea una nueva versión con actor y timestamp, y la jerarquía de resolución es default → proyecto → escenario (pantalla 50). Los escenarios Conservador y Optimista se materializan como overrides explícitos y editables. La distribución 25/5/70 es paramétrica y el servidor valida que sume 100%. Los puntos emitidos no son ingreso: son pasivo con ledger de emisión/redención/expiración. La ruta de pago en caja devenga la comisión y genera cuentas por cobrar con rezago y tasa de cobro; la ruta Stripe cobra de inmediato. El motor explica el cuello de botella de crecimiento de cada mes (curva, presupuesto o capacidad de onboarding). Si el portafolio tiene líneas base, el motor deriva el perfil por cliente del portafolio y lo etiqueta como dato "estimado" en el snapshot y el Excel. Toda mutación relevante escribe `AuditEvent`; la línea base registra `FieldProvenance` por campo. La simulación corre como job con `Idempotency-Key`, y el frontend nunca calcula resultados definitivos: solo el servidor.

**Cohortes B2C (fase 4).** El modelo de cohortes es activable por supuesto (`b2c.cohort.enabled`), igual que suscripciones y tokens: desactivado, el motor es idéntico al modelo agregado (hay un golden test de equivalencia exacta). Activado, cada mes de altas forma una cohorte con retención dependiente de la antigüedad — converge de `retention_m1` a `retention_stable` a velocidad `retention_ramp` — y la actividad de compra madura linealmente hasta `maturation_months`. El stock inicial se trata como cohorte madura. El motor emite la matriz de cohortes (informativa, fuera del `output_hash`, como los bottlenecks) y el LTV B2C por cohorte (5.6) en el summary. La vista previa de crecimiento (`/growth-preview`) ejecuta el motor en memoria sin persistir nada: el frontend sigue sin calcular resultados.

## Qué sigue (fases 5–8 del roadmap)

Fase 5: campañas, rewards, embudo de redención, transacciones individuales, settlements y AR por factura (31–44). Fase 6: planes de suscripción detallados, ledger de tokens y hiring plan (45–49); los motores agregados ya son activables. Fase 7: sensibilidad, comparador de escenarios y documento ejecutivo (54–55, 71). Fase 8: importación con IA (IA-01 a IA-07) y conectores; el flujo de la sección 8 exige revisión humana antes de persistir, y `ImportJob`/`FieldProvenance` ya existen en el esquema.

## Verificación realizada

21 pruebas pasan, incluidos los golden scenarios aplicables al MVP. Flujo end-to-end verificado: seeds → simulación de 60 meses → 3,788 proyecciones persistidas → export Excel reconciliado contra la base de datos (ingresos, EBITDA y caja idénticos en meses 1, 30 y 60). Determinismo verificado: re-simular el snapshot de un run produce exactamente el mismo hash de salida.
