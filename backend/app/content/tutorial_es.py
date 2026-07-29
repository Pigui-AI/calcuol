"""Contenido autorado del tutorial (roadmap de activación) — español.

Única fuente del texto pedagógico de los ocho pasos: qué se aprende (what),
la versión sencilla (eli5), la guía clic por clic (hands_on) y el tip. La
lógica de estado (qué paso está cumplido y a dónde apunta cada href) vive en
app/routers/onboarding.py; aquí solo hay contenido, para que al cambiar el
motor el texto, el quiz y el diálogo de un paso se revisen en el mismo diff.
"""

STEPS = [
    {
        "key": "proyecto", "title": "Crear tu proyecto",
        "short": "Proyecto", "icon": "folder",
        "what": "Defines el horizonte (12, 36 o 60 meses), la moneda y la base de partida. "
                "El asistente te lleva por la base inicial, el crecimiento y el modelo de ingresos.",
        "tip": "Empieza con 60 meses: siempre puedes mirar solo el primer año, pero no puedes "
               "extender un horizonte ya simulado sin volver a correr.",
        "eli5": "Un proyecto es como una maqueta de tu negocio. Le dices cuántos "
                "meses quieres imaginar (12, 36 o 60), en qué moneda juegas y con qué "
                "empiezas. Nada es definitivo: es tu tablero para probar ideas.",
        "hands_on": ["Pulsa «+ Nuevo proyecto» arriba a la derecha",
                     "Escribe un nombre y elige la moneda",
                     "Elige el horizonte: 60 meses te deja ver más lejos",
                     "Avanza con «Guardar y continuar» y al final pulsa «Crear proyecto»"],
    },
    {
        "key": "clientes", "title": "Cargar clientes B2B",
        "short": "Clientes", "icon": "store",
        "what": "Cada negocio se captura con sus sucursales, su catálogo y su línea base "
                "financiera (ventas, transacciones, ticket, margen y consumidores).",
        "tip": "Con línea base real el motor deriva ticket, margen, frecuencia y conversión de "
               "tus propios datos en vez de usar supuestos genéricos. Es lo que más mejora la "
               "calidad de la simulación.",
        "eli5": "Cada cliente es una tiendita con sus sucursales y su menú de "
                "productos. La línea base son sus números de un mes normal: cuánto vende, "
                "cuántos tickets hace y cuánta gente le compra. Con eso el motor aprende "
                "cómo se comporta una tienda de verdad.",
        "hands_on": ["Entra a «Clientes B2B» y pulsa «+ Cliente»",
                     "Llena el nombre del negocio y su giro",
                     "Agrega al menos una sucursal con su dirección",
                     "Captura 3 o 4 productos con su precio y su costo",
                     "En la línea base escribe ventas, tickets y consumidores de un mes típico",
                     "Revisa y pulsa «Crear cliente B2B»"],
    },
    {
        "key": "supuestos", "title": "Ajustar los supuestos",
        "short": "Supuestos", "icon": "sliders",
        "what": "El centro de supuestos reúne todas las variables del escenario con su valor "
                "efectivo y su origen: default del motor, valor del proyecto o del escenario.",
        "tip": "Nada se sobrescribe: cada edición crea una versión nueva con autor y fecha, así "
               "que puedes experimentar sin miedo a perder el valor anterior.",
        "eli5": "Un supuesto es un número que tú decides mientras no tengas el dato "
                "real: «cada mes se me va el 3% de los clientes». Cambiarlo es como guardar "
                "una partida nueva en un videojuego: la anterior no se borra, por si "
                "quieres regresar.",
        "hands_on": ["Abre tu proyecto y entra a «Supuestos» del escenario Base",
                     "Busca b2b.churn_rate y cámbialo (por ejemplo de 0.03 a 0.05)",
                     "El borde morado significa «cambio sin guardar»",
                     "Pulsa «Guardar cambios»: el origen ahora dirá «escenario» y quedará una versión nueva"],
    },
    {
        "key": "crecimiento", "title": "Modelar el crecimiento",
        "short": "Crecimiento", "icon": "trending",
        "what": "Curva de adquisición (lineal, exponencial, logística o desacelerada), churn, "
                "CAC, presupuesto y capacidad de onboarding. En Cohortes modelas la retención "
                "de consumidores por antigüedad en vez de un churn plano.",
        "tip": "Mira la columna «restricción activa»: te dice mes a mes si el freno fue la "
               "curva, el presupuesto o la capacidad de onboarding.",
        "eli5": "La curva dice cuántos clientes te gustaría tener cada mes. Pero "
                "querer no es poder: si tu presupuesto o tu equipo solo alcanzan para 8 "
                "altas, el motor te da 8 y te dice quién puso el freno. Es como invitar a "
                "20 amigos cuando en el coche solo caben 8.",
        "hands_on": ["Entra a «Adquisición B2B»",
                     "Prueba otra curva (la logística es la más realista)",
                     "Baja la capacidad de onboarding a 5 y guarda",
                     "Mira la tabla: la columna «restricción activa» dirá «capacidad_onboarding»",
                     "Visita «Cohortes» para ver cuánta gente sigue activa mes a mes"],
    },
    {
        "key": "operaciones", "title": "Configurar operaciones",
        "short": "Operaciones", "icon": "gear",
        "what": "Campañas y recompensas, transacciones y rutas de pago, planes de suscripción, "
                "consumo de IA, costos escalonados y el plan de contratación.",
        "tip": "Casi todos estos motores nacen apagados: mientras no los enciendas no afectan "
               "tus resultados, así que puedes incorporarlos de uno en uno.",
        "eli5": "Aquí viven los motores extra: campañas, suscripciones, tokens de IA, "
                "costos y contrataciones. Todos vienen apagados, como los focos de una "
                "casa: enciendes uno, miras qué cambia y, si no te gusta, lo apagas. Nada "
                "se rompe por probar.",
        "hands_on": ["Entra a «Campañas y recompensas» y pulsa «+ Nueva campaña»",
                     "Dale una ventana de meses y un empujón de conversión (0.15 = 15%)",
                     "Enciende el interruptor maestro del motor de campañas",
                     "Opcional: crea un plan en «Suscripciones» y un rol en «Equipo e hiring»"],
    },
    {
        "key": "simulacion", "title": "Ejecutar la simulación",
        "short": "Simular", "icon": "play",
        "what": "El motor congela un snapshot con todo lo que capturaste y calcula el horizonte "
                "completo: plan mensual, estado de resultados, flujo de efectivo y unit economics.",
        "tip": "Mismo snapshot y misma versión del motor producen exactamente los mismos "
               "números. Por eso un plan exportado siempre se puede reproducir y defender.",
        "eli5": "Simular es apretar el botón de «ya, calcula». El motor primero le "
                "toma una foto a todo lo que capturaste (esa foto se llama snapshot) y "
                "luego cuenta la historia mes a mes. Como la foto no cambia, si vuelves a "
                "simular la misma foto salen exactamente los mismos números.",
        "hands_on": ["En tu proyecto pulsa «Simular» en el escenario Base",
                     "Espera unos segundos a que el run diga «Exitoso»",
                     "Abre los resultados: dashboard, plan mensual, P&L, flujo y unit economics",
                     "Fíjate en el hash del run: es la huella de esa foto"],
    },
    {
        "key": "analisis", "title": "Analizar y comparar",
        "short": "Análisis", "icon": "chart",
        "what": "Sensibilidad te dice qué palanca mueve más la aguja; el comparador enfrenta "
                "escenarios con sus diferencias; y Conclusiones propone hallazgos, riesgos y "
                "acciones citando la métrica que los sustenta.",
        "tip": "En sensibilidad cada corrida cambia una sola variable, así los impactos son "
               "comparables entre sí contra el mismo punto de partida.",
        "eli5": "La sensibilidad es el juego de «¿y si…?»: mueves una sola perilla a "
                "la vez y ves cuál mueve más la aguja. El tornado ordena las barras: la "
                "más larga es la perilla que más importa. El comparador pone dos "
                "escenarios lado a lado, y las conclusiones te dicen qué encontró el "
                "motor, con pruebas.",
        "hands_on": ["Entra a «Sensibilidad» y elige el EBITDA acumulado como objetivo",
                     "Marca 3 o 4 palancas (churn, CAC, conversión…) y ejecuta el análisis",
                     "Lee el tornado: la barra más larga es tu prioridad",
                     "En «Comparador» selecciona dos runs y mira los deltas",
                     "En «Conclusiones» acepta o descarta lo que el motor propone"],
    },
    {
        "key": "entregable", "title": "Exportar el plan",
        "short": "Exportar", "icon": "download",
        "what": "Desde los resultados generas el business plan en Excel (once hojas, sesenta "
                "meses) o el documento ejecutivo listo para presentar.",
        "tip": "Ambos entregables citan la corrida que los originó, para que ningún número "
               "circule sin saber de dónde salió.",
        "eli5": "Al final conviertes todo en algo que puedes compartir: un Excel con "
                "los 60 meses o un documento listo para presentar. Los dos llevan el "
                "sello del run que los creó, para que cualquiera pueda preguntar «¿de "
                "dónde salió este número?» y siempre haya respuesta.",
        "hands_on": ["Abre los resultados de tu mejor run",
                     "Pulsa «Exportar a Excel» y descarga el archivo",
                     "Pulsa «Documento ejecutivo» y ábrelo en el navegador",
                     "Imprímelo a PDF si lo vas a enviar: el run va citado en la portada"],
    },
]

STEP_KEYS = [s["key"] for s in STEPS]
