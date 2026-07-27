/** Formateo: montos con moneda, conteos y porcentajes (16.1). */
export function money(value: string | number | null | undefined, currency = "MXN", compact = false): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : parseFloat(value);
  if (Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("es-MX", {
    style: "currency", currency, maximumFractionDigits: compact ? 0 : 2,
    notation: compact && Math.abs(n) >= 1_000_000 ? "compact" : "standard",
  }).format(n);
}

export function num(value: string | number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : parseFloat(value);
  if (Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("es-MX", { maximumFractionDigits: decimals }).format(n);
}

export function pct(value: string | number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : parseFloat(value);
  if (Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("es-MX", { style: "percent", maximumFractionDigits: decimals }).format(n);
}

export function monthName(label: string): string {
  const [y, m] = label.split("-").map(Number);
  const names = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${names[m - 1]} ${String(y).slice(2)}`;
}

export const INDUSTRIES = [
  "restaurante", "cafeteria", "fitness", "belleza", "farmacia", "retail_moda",
  "ferreteria", "panaderia", "salud_mascotas", "servicios", "abarrotes", "otro",
];

export const STATUS_LABELS: Record<string, string> = {
  draft: "Borrador", active: "Activo", onboarding: "Onboarding", archived: "Archivado",
  churned: "Baja", queued: "En cola", running: "Ejecutando", succeeded: "Exitoso", failed: "Fallido",
};
