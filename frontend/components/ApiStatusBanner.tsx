"use client";
/** Aviso cuando el backend no es accesible (p. ej. Pages sin Cloud Run configurado). */
import { useEffect, useState } from "react";
import { api, API_URL } from "@/lib/api";

export default function ApiStatusBanner() {
  const [down, setDown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get("/health").then(() => !cancelled && setDown(false)).catch(() => !cancelled && setDown(true));
    return () => { cancelled = true; };
  }, []);

  if (!down) return null;
  const isLocalDefault = API_URL.includes("localhost");
  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <p className="font-semibold">Sin conexión con el motor financiero ({API_URL})</p>
      <p className="mt-0.5 text-xs">
        {isLocalDefault
          ? "Este sitio estático necesita el backend. Despliega el backend en Cloud Run (ver DEPLOY.md) y define la variable de repositorio NEXT_PUBLIC_API_URL con su URL; luego vuelve a ejecutar el workflow de Pages. En desarrollo local: uvicorn app.main:app --port 8000."
          : "Verifica que el servicio de Cloud Run esté activo y que CORS_ORIGINS incluya este dominio."}
      </p>
    </div>
  );
}
