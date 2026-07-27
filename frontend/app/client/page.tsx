"use client";
/** Pantalla 13 (simplificada) — Cliente. Ruta estática: /client?project=&id= */
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, Client } from "@/lib/api";
import { money, num, pct, STATUS_LABELS } from "@/lib/format";
import { Badge, Button, Card, CardBody, ErrorState, KpiCard, SectionTitle, Skeleton } from "@/components/ui";

const TABS = ["Resumen", "Marcas y sucursales", "Productos y servicios", "Línea base"] as const;

function ClientProfile() {
  const params = useSearchParams();
  const projectId = params.get("project") ?? "";
  const clientId = params.get("id") ?? "";
  const [client, setClient] = useState<Client | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Resumen");

  const load = useCallback(() => {
    if (!clientId) return;
    api.get<Client>(`/clients/${clientId}`).then(setClient).catch((e) => setError(String(e.message)));
  }, [clientId]);
  useEffect(load, [load]);

  const activate = async () => {
    try {
      const updated = await api.patch<Client>(`/clients/${clientId}`, { status: "active" });
      setClient(updated);
    } catch (e) { setError(String((e as Error).message)); }
  };

  if (!clientId) return <ErrorState message="Falta el parámetro ?id= del cliente" />;
  if (error) return <ErrorState message={error} onRetry={() => { setError(null); load(); }} />;
  if (!client) return <Skeleton rows={5} />;

  const b = client.baseline;

  return (
    <div>
      <nav className="mb-2 text-xs text-slate-400">
        <Link href={`/clients/?project=${projectId}`} className="hover:text-pigui-700">Portafolio</Link> / {client.trade_name}
      </nav>
      <SectionTitle
        title={client.trade_name}
        subtitle={`${client.legal_name} · ${client.industry} · ${client.currency}`}
        right={
          <div className="flex items-center gap-2">
            <Badge tone={client.status}>{STATUS_LABELS[client.status] || client.status}</Badge>
            {client.status === "draft" && <Button onClick={activate}>Activar cliente</Button>}
          </div>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Ventas base / mes" value={b ? money(b.avg_monthly_sales, client.currency, true) : "Sin datos"}
          tone={b ? "default" : "muted"} hint={b ? `Dato ${b.source_type} · confianza ${b.confidence}%` : undefined} />
        <KpiCard label="Transacciones / mes" value={b ? num(b.avg_monthly_transactions) : "—"} />
        <KpiCard label="Margen elegible" value={b ? pct(b.margin_pct) : "—"} />
        <KpiCard label="Consumidores activos" value={b ? num(b.active_consumers) : "—"}
          hint={b ? `${num(b.monthly_buyers)} compradores/mes` : undefined} />
      </div>

      <div className="mb-4 flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === t ? "bg-pigui-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === "Resumen" && (
        <Card><CardBody>
          <dl className="grid gap-3 text-sm md:grid-cols-2">
            <div><dt className="text-slate-500">Contacto</dt>
              <dd className="font-medium">{client.contact_name || "—"} {client.contact_email && `· ${client.contact_email}`}</dd></div>
            <div><dt className="text-slate-500">Estructura</dt>
              <dd className="font-medium">{client.brands_count} marca(s), {client.branches_count} sucursal(es), {client.catalog?.length ?? 0} artículos</dd></div>
            <div className="md:col-span-2"><dt className="text-slate-500">Notas</dt>
              <dd className="font-medium">{client.notes || "Sin notas"}</dd></div>
          </dl>
          <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
            Los KPIs de arriba son la línea base (dato <Badge tone={b?.source_type || "default"}>{b?.source_type || "sin datos"}</Badge>);
            los resultados proyectados viven en los runs de simulación y no se mezclan con datos reales.
          </p>
        </CardBody></Card>
      )}

      {tab === "Marcas y sucursales" && (
        <div className="space-y-3">
          {client.brands?.map((brand) => (
            <Card key={brand.id}><CardBody>
              <p className="mb-3 font-semibold text-slate-800">{brand.name}</p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="py-2">Sucursal</th><th className="py-2">Ubicación</th>
                    <th className="py-2">Zona horaria</th><th className="py-2">Capacidad</th>
                    <th className="py-2">Artículos</th><th className="py-2">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {brand.branches.map((br) => (
                    <tr key={br.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 font-medium">{br.name}</td>
                      <td className="py-2 text-slate-500">{br.location || "—"}</td>
                      <td className="py-2 text-slate-500">{br.timezone}</td>
                      <td className="py-2">{br.monthly_capacity ?? "—"}</td>
                      <td className="py-2">{br.catalog_count}</td>
                      <td className="py-2"><Badge tone={br.status}>{br.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody></Card>
          ))}
        </div>
      )}

      {tab === "Productos y servicios" && (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="px-5 py-3">Artículo</th><th className="px-3 py-3">Tipo</th>
                <th className="px-3 py-3 text-right">Precio</th><th className="px-3 py-3 text-right">Costo</th>
                <th className="px-3 py-3 text-right">Margen</th><th className="px-3 py-3">Rewards</th>
              </tr>
            </thead>
            <tbody>
              {client.catalog?.map((i) => (
                <tr key={i.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-5 py-2.5 font-medium">{i.name}
                    {i.sku && <span className="ml-2 text-xs text-slate-400">{i.sku}</span>}</td>
                  <td className="px-3 py-2.5 capitalize text-slate-500">{i.type}</td>
                  <td className="px-3 py-2.5 text-right">{money(i.sale_price, client.currency)}</td>
                  <td className="px-3 py-2.5 text-right">{money(i.direct_cost, client.currency)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <span className={parseFloat(i.margin) < 0 ? "text-rose-600" : ""}>
                      {money(i.margin, client.currency)} {i.margin_pct && `(${pct(i.margin_pct)})`}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">{i.reward_eligible ? <Badge tone="active">elegible</Badge> : <Badge>no</Badge>}</td>
                </tr>
              ))}
              {(!client.catalog || client.catalog.length === 0) && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400">Catálogo vacío</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {tab === "Línea base" && (
        <Card><CardBody>
          {b ? (
            <dl className="grid gap-4 text-sm md:grid-cols-3">
              {([
                ["Ventas mensuales", money(b.avg_monthly_sales, client.currency)],
                ["Transacciones mensuales", num(b.avg_monthly_transactions)],
                ["Ticket promedio", money(b.avg_ticket, client.currency)],
                ["Margen elegible", pct(b.margin_pct)],
                ["Consumidores registrados", num(b.registered_consumers)],
                ["Consumidores activos", num(b.active_consumers)],
                ["Compradores mensuales", num(b.monthly_buyers)],
                ["Frecuencia de compra", b.purchase_frequency],
                ["Clasificación", `${b.source_type} · ${b.confidence}% confianza`],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k}><dt className="text-slate-500">{k}</dt><dd className="mt-0.5 font-semibold text-slate-800">{v}</dd></div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-slate-400">Este cliente aún no tiene línea base financiera.</p>
          )}
          <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
            La línea base pondera el perfil por cliente que usa el motor (dato “estimado” en el snapshot).
            Cada campo registró procedencia en FieldProvenance al capturarse.
          </p>
        </CardBody></Card>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><ClientProfile /></Suspense>;
}
