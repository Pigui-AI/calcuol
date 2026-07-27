# Pigui Financial Engine — backend para Cloud Run
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Seeds opcionales al arrancar: define RUN_SEEDS=true en el servicio
# (útil para demo; con SQLite el almacenamiento de Cloud Run es efímero,
#  usa Cloud SQL vía DATABASE_URL para persistencia real)
CMD ["sh", "-c", "if [ \"$RUN_SEEDS\" = \"true\" ]; then python -m app.seeds; fi && uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
