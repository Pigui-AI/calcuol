import type { Metadata } from "next";
import Link from "next/link";
import ApiStatusBanner from "@/components/ApiStatusBanner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pigui Financial Engine",
  description: "Motor de simulaciones financieras hiperrealistas de Pigui",
};

/* Menú principal (9.1). Los módulos de fases futuras se muestran deshabilitados. */
const MENU: { group: string; items: { label: string; href?: string; phase?: string }[] }[] = [
  { group: "Inicio", items: [{ label: "Proyectos", href: "/" }] },
  {
    group: "Configuración",
    items: [
      { label: "Proyectos y escenarios", href: "/" },
      { label: "Clientes B2B (por proyecto)" },
    ],
  },
  {
    group: "Crecimiento",
    items: [
      { label: "Adquisición B2B", href: "/growth-b2b/" },
      { label: "Adopción B2C", href: "/growth-b2c/" },
      { label: "Cohortes", href: "/cohorts/" },
    ],
  },
  {
    group: "Operaciones",
    items: [
      { label: "Campañas y recompensas", href: "/campaigns/" },
      { label: "Transacciones y pagos", href: "/transactions/" },
      { label: "Costos e infraestructura", href: undefined },
    ],
  },
  {
    group: "Resultados",
    items: [
      { label: "Business plan (por run)" },
      { label: "Dashboard ejecutivo (por run)" },
      { label: "Importación con IA", phase: "Fase 8" },
    ],
  },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <div className="flex min-h-screen">
          <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white lg:block">
            <div className="sticky top-0 p-5">
              <Link href="/" className="flex items-baseline gap-1">
                <span className="text-xl font-black tracking-tight text-pigui-700">pigui</span>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                  Financial Engine
                </span>
              </Link>
              <nav className="mt-6 space-y-5">
                {MENU.map((section) => (
                  <div key={section.group}>
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      {section.group}
                    </p>
                    <ul className="space-y-0.5">
                      {section.items.map((item) => (
                        <li key={item.label}>
                          {item.href ? (
                            <Link href={item.href}
                              className="block rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-pigui-50 hover:text-pigui-700">
                              {item.label}
                            </Link>
                          ) : (
                            <span className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-slate-400"
                              title={item.phase ? `Planeado en ${item.phase} del roadmap` : "Se accede desde un proyecto"}>
                              {item.label}
                              {item.phase && (
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium">{item.phase}</span>
                              )}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </nav>
              <p className="mt-8 text-[11px] leading-relaxed text-slate-400">
                Fases 0–5 · motor v1.2.0<br />Especificación v1.0 (jul 2026)
              </p>
            </div>
          </aside>
          <main className="min-w-0 flex-1">
            <div className="mx-auto max-w-7xl px-4 py-6 lg:px-8">
              <ApiStatusBanner />
              {children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
