"use client";
/** Pantalla 07 — Portafolio de clientes B2B. Ruta estática: /clients?project= */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, Client } from "@/lib/api";
import { money, num, pct, INDUSTRIES, STATUS_LABELS } from "@/lib/format";
import { Badge, Button, Card, EmptyState, ErrorState, KpiCard, SectionTitle, Skeleton, inputClass } from "@/components/ui";

interface ListResponse {
  clients: Client[];
  kpis: { count: number; active: number; gmv_base_monthly: string; active_consumers: number };
}

function ClientPortfolio() {
  const projectId = useSearchParams().get("project") ?? "";
  const router = useRouter();
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [industry, setIndustry] = useState("");
  const [status, setStatus] = useState("");

  const load = useCallback(() => {
    if (!projectId) return;
    setError(null);
    api.get<ListResponse>(`/projects/${projectId}/clients`)
      .then(setData)
      .catch((e) => setError(String(e.message)));
  }, [projectId]);
  useEffect(load, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.clients.filter((c) =>
      (!q || c.trade_name.toLowerCase().includes(q.toLowerCase()) || c.legal_name.toLowerCase().includes(q.toLowerCase())) &&
      (!industry || c.industry === industry) &&
      (!status || c.status === status)
    );
  }, [data, q, industry, status]);

  if (!projectId) return <ErrorState message="Falta el parámetro ?project=" />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <Skeleton rows={5} />;

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href="/" className="hover:text-pigui-700">Proyectos</Link> /{" "}
        <Link href={`/project/?id=${projectId}`} className="hover:text-pigui-700">Proyecto</Link> / Clientes B2B
      </nav>
      <SectionTitle
        title="Portafolio de clientes B2B"
        subtitle="Negocios, marcas, sucursales y calidad de datos que alimentan la línea base del motor."
        right={<Button href={`/clients/new/?project=${projectId}`}>+ Cliente</Button>}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Clientes" value={data.kpis.count} />
        <KpiCard label="Activos" value={data.kpis.active} tone="good" />
        <KpiCard label="GMV base mensual" value={money(data.kpis.gmv_base_monthly, "MXN", true)}
          hint="Suma de líneas base vigentes" />
        <KpiCard label="Consumidores activos" value={num(data.kpis.active_consumers)} />
      </div>

      <div className="mb-4 flex flex-wrap gap-3">
        <input className={`${inputClass} max-w-xs`} placeholder="Buscar cliente…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={`${inputClass} max-w-[180px]`} value={industry} onChange={(e) => setIndustry(e.target.value)}>
          <option value="">Todas las industrias</option>
          {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        <select className={`${inputClass} max-w-[160px]`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos los estados</option>
          {["active", "draft", "onboarding", "churned"].map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="Sin clientes en el portafolio"
          description="Agrega tu primer cliente B2B con su marca, sucursales, catálogo y línea base financiera. La importación con IA llega en la Fase 8."
          action={<Button href={`/clients/new/?project=${projectId}`}>Agregar cliente</Button>}
        />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3">Cliente</th>
                <th className="px-3 py-3">Industria</th>
                <th className="px-3 py-3">Estado</th>
                <th className="px-3 py-3">Sucursales</th>
                <th className="px-3 py-3 text-right">Ventas base/mes</th>
                <th className="px-3 py-3 text-right">Margen</th>
                <th className="px-3 py-3 text-right">Consumidores</th>
                <th className="px-3 py-3">Calidad</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} onClick={() => router.push(`/client/?project=${projectId}&id=${c.id}`)}
                  className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-pigui-50/40">
                  <td className="px-5 py-3">
                    <p className="font-medium text-slate-900">{c.trade_name}</p>
                    <p className="text-xs text-slate-400">{c.legal_name}</p>
                  </td>
                  <td className="px-3 py-3 text-slate-600">{c.industry}</td>
                  <td className="px-3 py-3"><Badge tone={c.status}>{STATUS_LABELS[c.status] || c.status}</Badge></td>
                  <td className="px-3 py-3">{c.branches_count}</td>
                  <td className="px-3 py-3 text-right">{c.baseline ? money(c.baseline.avg_monthly_sales, c.currency, true) : "—"}</td>
                  <td className="px-3 py-3 text-right">{c.baseline ? pct(c.baseline.margin_pct) : "—"}</td>
                  <td className="px-3 py-3 text-right">{c.baseline ? num(c.baseline.active_consumers) : "—"}</td>
                  <td className="px-3 py-3">
                    {c.baseline
                      ? <Badge tone={c.baseline.source_type}>{c.baseline.source_type} · {c.baseline.confidence}%</Badge>
                      : <Badge tone="default">sin línea base</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><ClientPortfolio /></Suspense>;
}
