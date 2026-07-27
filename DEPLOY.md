# Despliegue: GitHub Pages + Google Cloud Run

La arquitectura de despliegue separa las dos piezas tal como recomienda la especificación (6.1): el frontend es un sitio estático (GitHub Pages o Cloud Run con nginx) y el backend con el motor financiero corre en Cloud Run.

## 1. Frontend en GitHub Pages (automático)

El workflow `.github/workflows/deploy-pages.yml` se ejecuta en cada push a `main`: compila el export estático de Next.js, activa GitHub Pages si no lo está y publica. El sitio queda en:

**https://pigui-ai.github.io/calcuol/**

El sitio necesita saber dónde vive el backend. Una vez desplegado Cloud Run (paso 2), define la variable del repositorio y relanza el workflow:

1. GitHub → repo `calcuol` → **Settings → Secrets and variables → Actions → Variables → New repository variable**
2. Nombre: `NEXT_PUBLIC_API_URL` · Valor: `https://TU-SERVICIO.run.app` (sin diagonal final)
3. **Actions → Deploy frontend a GitHub Pages → Run workflow**

Mientras no exista esa variable, el sitio carga pero muestra un banner ámbar de "Sin conexión con el motor financiero".

## 2. Backend en Cloud Run

**Opción rápida — consola con despliegue continuo desde GitHub:** en Cloud Run → Create service → "Continuously deploy from a repository", selecciona `Pigui-AI/calcuol`, rama `main`, Build type **Dockerfile** y deja la ruta `/Dockerfile` (el Dockerfile de la raíz construye el backend). En "Variables y secretos" agrega `CORS_ORIGINS=https://pigui-ai.github.io` y `RUN_SEEDS=true`, y permite invocaciones sin autenticar.

**Opción CLI:** requiere [gcloud CLI](https://cloud.google.com/sdk/docs/install) autenticado (`gcloud auth login`) y un proyecto activo (`gcloud config set project TU_PROYECTO`).

```bash
cd backend

gcloud run deploy pigui-engine \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "CORS_ORIGINS=https://pigui-ai.github.io,RUN_SEEDS=true"
```

`RUN_SEEDS=true` carga el proyecto demo con 10 clientes al arrancar (idempotente: no duplica). La URL que imprime el deploy (`https://pigui-engine-....run.app`) es la que va en `NEXT_PUBLIC_API_URL` del paso 1.

**Persistencia.** Sin configuración extra el backend usa SQLite en el sistema de archivos del contenedor, que en Cloud Run es efímero: los datos se pierden al escalar a cero o redesplegar. Suficiente para demo; para uso real crea una instancia de Cloud SQL (PostgreSQL) y conéctala:

```bash
gcloud sql instances create pigui-db --database-version=POSTGRES_16 \
  --tier=db-f1-micro --region=us-central1
gcloud sql databases create pigui --instance=pigui-db
gcloud sql users set-password postgres --instance=pigui-db --password=TU_PASSWORD

gcloud run deploy pigui-engine \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --add-cloudsql-instances TU_PROYECTO:us-central1:pigui-db \
  --set-env-vars "CORS_ORIGINS=https://pigui-ai.github.io,DATABASE_URL=postgresql+psycopg2://postgres:TU_PASSWORD@/pigui?host=/cloudsql/TU_PROYECTO:us-central1:pigui-db"
```

El driver `psycopg2` ya está en `requirements.txt`; los modelos son portátiles (los montos se guardan como texto decimal exacto).

## 3. Frontend en Cloud Run (opcional)

Si prefieres servir el frontend también desde Cloud Run en lugar de Pages:

```bash
cd frontend

gcloud run deploy pigui-frontend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-build-env-vars "NEXT_PUBLIC_API_URL=https://pigui-engine-....run.app"
```

Recuerda añadir el dominio resultante a `CORS_ORIGINS` del backend.

## Notas

La comunicación es únicamente frontend → API REST; no hay secretos en el frontend. La API hoy no tiene autenticación de usuarios (el modelo de roles de la sección 12 es de fases posteriores): si el backend queda público con `--allow-unauthenticated`, cualquiera con la URL puede leer y escribir datos de demo. Para restringirlo, opciones rápidas: mantenerlo solo con datos demo, o poner el servicio detrás de Identity-Aware Proxy / API Gateway.
