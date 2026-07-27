"use client";
/** Hub del proyecto: escenarios (51), accesos, runs recientes. Ruta estática: /project?id= */
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, Project, Run } from "@/lib/api";
import { money, STATUS_LABELS } from "@/lib/format";
import { Badge, Button, Card, CardBody, ErrorState, KpiCard, SectionTitle, Skeleton } from "@/components/ui";

function ProjectHub() {
  const id = useSearchParams().get("id") ?? "";
  const [project, setProject] = useState<Project | null>(null);
  const [runsByScenario, setRunsByScenario] = useState<Record<string, Run[]>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    setError(null);
    api.get<Project>(`/projects/${id}`)
      .then(async (p) => {
        setProject(p);
        const entries = await Promise.all(
          p.scenarios.map(async (s) => [s.id, await api.get<Run[]>(`/scenarios/${s.id}/runs`)] as const)
        );
        setRunsByScenario(Object.fromEntries(entries));
      })
      .catch((e) => setError(String(e.message)));
  }, [id]);
  useEffect(load, [load]);

  if (!id) return <ErrorState message="Falta el parámetro ?id= del proyecto" />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!project) return <Skeleton rows={5} />;

  const k = project.kpis;
  const currency = project.base_currency;

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link> / {project.name}
      </nav>
      <SectionTitle
        title={project.name}
        subtitle={`${project.description || "Proyecto financiero"} · Inicio ${project.start_month} · ${project.horizon_months} meses · ${currency}`}
        right={
          <div className="flex gap-2">
            <Button variant="secondary" href={`/clients/?project=${project.id}`}>Clientes B2B</Button>
            <Button href={`/simulate/?project=${project.id}&scenario=${project.scenarios[0]?.id}`}>
              Ejecutar simulación
            </Button>
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Clientes en portafolio" value={project.clients_count}
          hint={project.clients_count === 0 ? "Agrega clientes para enriquecer la línea base" : undefined} />
        <KpiCard label="Ingresos año 1" value={k?.revenue_y1 ? money(k.revenue_y1, currency, true) : "Sin calcular"}
          tone={k ? "default" : "muted"} hint={k ? "Último run exitoso" : "Ejecuta una simulación"} />
        <KpiCard label="EBITDA año 1" value={k?.ebitda_y1 ? money(k.ebitda_y1, currency, true) : "Sin calcular"}
          tone={k?.ebitda_y1 ? (parseFloat(k.ebitda_y1) >= 0 ? "good" : "bad") : "muted"} />
        <KpiCard label="Necesidad de capital" value={k?.funding_need ? money(k.funding_need, currency, true) : "Sin calcular"}
          tone={k ? "default" : "muted"} hint={k?.breakeven_month ? `Break-even en mes ${k.breakeven_month}` : undefined} />
      </div>

      <SectionTitle title="Escenarios" subtitle="Cada escenario hereda del proyecto y sobrescribe supuestos con overrides explícitos." />
      <div className="grid gap-3 md:grid-cols-3">
        {project.scenarios.map((s) => {
          const runs = runsByScenario[s.id] || [];
          const lastOk = runs.find((r) => r.status === "succeeded");
          return (
            <Card key={s.id}>
              <CardBody>
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-slate-900">{s.name}</p>
                  <Badge tone={s.type === "base" ? "hipotesis" : s.type === "conservador" ? "declarado" : "estimado"}>
                    {s.type}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {runs.length} run{runs.length !== 1 && "s"} · {lastOk ? `último exitoso ${new Date(lastOk.created_at).toLocaleDateString("es-MX")}` : "sin run exitoso"}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="secondary" href={`/assumptions/?project=${project.id}&scenario=${s.id}`} className="!px-3 !py-1.5">
                    Supuestos
                  </Button>
                  <Button variant="secondary" href={`/simulate/?project=${project.id}&scenario=${s.id}`} className="!px-3 !py-1.5">
                    Simular
                  </Button>
                  {lastOk && (
                    <Button variant="ghost" href={`/run/?project=${project.id}&id=${lastOk.id}`} className="!px-3 !py-1.5">
                      Ver resultados
                    </Button>
                  )}
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>

      <div className="mt-8">
        <SectionTitle title="Runs recientes" subtitle="Ejecuciones inmutables: snapshot + versión del motor = resultados reproducibles." />
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3">Run</th>
                <th className="px-3 py-3">Escenario</th>
                <th className="px-3 py-3">Estado</th>
                <th className="px-3 py-3">Fecha</th>
                <th className="px-3 py-3">Hash de salida</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(runsByScenario).flatMap(([sid, runs]) =>
                runs.slice(0, 3).map((r) => {
                  const scenario = project.scenarios.find((s) => s.id === sid);
                  return (
                    <tr key={r.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-5 py-2.5 font-mono text-xs text-slate-500">{r.id.slice(0, 12)}…</td>
                      <td className="px-3 py-2.5">{scenario?.name}</td>
                      <td className="px-3 py-2.5"><Badge tone={r.status}>{STATUS_LABELS[r.status] || r.status}</Badge></td>
                      <td className="px-3 py-2.5 text-slate-500">{new Date(r.created_at).toLocaleString("es-MX")}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-slate-400">{r.output_hash?.slice(0, 12) || "—"}</td>
                      <td className="px-3 py-2.5 text-right">
                        {r.status === "succeeded" && (
                          <Link className="text-xs font-medium text-pigui-700 hover:underline"
                            href={`/run/?project=${project.id}&id=${r.id}`}>Abrir</Link>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
              {Object.values(runsByScenario).every((rs) => rs.length === 0) && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-slate-400">
                  Sin runs todavía. Ejecuta una simulación para generar el business plan.
                </td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><ProjectHub /></Suspense>;
}
