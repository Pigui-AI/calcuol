# Dockerfile raíz para Cloud Run (flujo "deploy from repository" de la consola,
# que usa la raíz del repo como contexto). Construye el BACKEND (motor financiero).
# El frontend se sirve en GitHub Pages, o con frontend/Dockerfile si se quiere en Cloud Run.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app

# RUN_SEEDS=true carga el proyecto demo al arrancar (idempotente).
# Para persistencia real usar Cloud SQL vía DATABASE_URL (ver DEPLOY.md).
CMD ["sh", "-c", "if [ \"$RUN_SEEDS\" = \"true\" ]; then python -m app.seeds; fi && uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
