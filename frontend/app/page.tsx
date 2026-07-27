"use client";
/** Pantalla 01 — Proyectos y escenarios. */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, Project } from "@/lib/api";
import { money, STATUS_LABELS } from "@/lib/format";
import { Badge, Button, Card, CardBody, EmptyState, ErrorState, KpiCard, SectionTitle, Skeleton, inputClass } from "@/components/ui";

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"todos" | "activos" | "archivados">("todos");

  const load = () => {
    setError(null);
    api.get<Project[]>("/projects")
      .then(setProjects)
      .catch((e) => setError(String(e.message)));
  };
  useEffect(load, []);

  const filtered = useMemo(() => {
    if (!projects) return [];
    let list = projects;
    if (tab === "activos") list = list.filter((p) => p.status === "active");
    if (tab === "archivados") list = list.filter((p) => p.status === "archived");
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
    return list;
  }, [projects, q, tab]);

  const withRun = projects?.filter((p) => p.kpis) ?? [];

  return (
    <div>
      <SectionTitle
        title="Proyectos y escenarios"
        subtitle="Administra tus proyectos financieros, escenarios y simulaciones."
        right={<Button href="/projects/new">+ Nuevo proyecto</Button>}
      />

      {error && <ErrorState message={error} onRetry={load} />}
      {!projects && !error && <Skeleton rows={4} />}

      {projects && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label="Proyectos" value={projects.length} />
            <KpiCard label="Con simulación" value={withRun.length}
              hint={withRun.length === 0 ? "Sin calcular" : undefined}
              tone={withRun.length === 0 ? "muted" : "default"} />
            <KpiCard label="Ingresos año 1 (último run)"
              value={withRun[0]?.kpis?.revenue_y1 ? money(withRun[0].kpis.revenue_y1, withRun[0].base_currency, true) : "Sin calcular"}
              tone={withRun[0]?.kpis?.revenue_y1 ? "default" : "muted"} />
            <KpiCard label="EBITDA año 1 (último run)"
              value={withRun[0]?.kpis?.ebitda_y1 ? money(withRun[0].kpis.ebitda_y1, withRun[0].base_currency, true) : "Sin calcular"}
              tone={withRun[0]?.kpis?.ebitda_y1 ? (parseFloat(withRun[0].kpis.ebitda_y1) >= 0 ? "good" : "bad") : "muted"} />
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
              {(["todos", "activos", "archivados"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  className={`rounded-md px-3 py-1.5 text-sm capitalize ${tab === t ? "bg-pigui-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  {t}
                </button>
              ))}
            </div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar proyecto…"
              className={`${inputClass} max-w-xs`} />
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title="Aún no hay proyectos"
              description="Crea tu primer proyecto para configurar escenarios, clientes B2B y correr simulaciones de 12 a 60 meses. También puedes correr los seeds del backend para cargar el proyecto demo."
              action={<Button href="/projects/new">Crear proyecto</Button>}
            />
          ) : (
            <Card>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-5 py-3">Proyecto</th>
                    <th className="px-3 py-3">Estado</th>
                    <th className="px-3 py-3">Escenarios</th>
                    <th className="px-3 py-3">Clientes</th>
                    <th className="px-3 py-3">Horizonte</th>
                    <th className="px-3 py-3">Break-even</th>
                    <th className="px-3 py-3 text-right">Capital requerido</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr key={p.id} onClick={() => router.push(`/project/?id=${p.id}`)}
                      className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-pigui-50/40">
                      <td className="px-5 py-3">
                        <p className="font-medium text-slate-900">{p.name}</p>
                        <p className="text-xs text-slate-400">{p.start_month} · {p.base_currency}</p>
                      </td>
                      <td className="px-3 py-3"><Badge tone={p.status}>{STATUS_LABELS[p.status] || p.status}</Badge></td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          {p.scenarios.map((s) => (
                            <span key={s.id} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{s.name}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-3">{p.clients_count}</td>
                      <td className="px-3 py-3">{p.horizon_months} m</td>
                      <td className="px-3 py-3">
                        {p.kpis?.breakeven_month
                          ? <span className="text-emerald-700">Mes {p.kpis.breakeven_month}</span>
                          : <span className="text-slate-400">{p.kpis ? "No alcanzado" : "Sin calcular"}</span>}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {p.kpis?.funding_need ? money(p.kpis.funding_need, p.base_currency, true) : <span className="text-slate-400">Sin calcular</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <p className="mt-4 text-xs text-slate-400">
            Leyenda de escenarios: <Badge tone="hipotesis">Base</Badge>{" "}
            <Badge tone="declarado">Conservador</Badge> <Badge tone="estimado">Optimista</Badge>{" "}
            — los KPIs provienen del último run exitoso de cada proyecto; si no existe se muestra “Sin calcular”.
          </p>
        </>
      )}
    </div>
  );
}
