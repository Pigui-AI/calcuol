"use client";
/** Pantallas 08–12 — Asistente para agregar cliente B2B. Ruta estática: /clients/new?project= */
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, Client } from "@/lib/api";
import { money, num, pct, INDUSTRIES } from "@/lib/format";
import { Badge, Button, Card, CardBody, Field, SectionTitle, Skeleton, StepIndicator, inputClass } from "@/components/ui";

const STEPS = ["Información del negocio", "Marca y sucursales", "Catálogo", "Línea base financiera", "Revisión"];

interface BranchDraft { name: string; location: string; timezone: string; monthly_capacity: string; }
interface ItemDraft { type: string; name: string; sku: string; sale_price: string; direct_cost: string; reward_eligible: boolean; }

function NewClientWizard() {
  const projectId = useSearchParams().get("project") ?? "";
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [info, setInfo] = useState({
    trade_name: "", legal_name: "", industry: "restaurante", currency: "MXN",
    onboarding_date: "", contact_name: "", contact_email: "", contact_phone: "", notes: "",
  });
  const [brandName, setBrandName] = useState("");
  const [branches, setBranches] = useState<BranchDraft[]>([
    { name: "Principal", location: "", timezone: "America/Mexico_City", monthly_capacity: "" },
  ]);
  const [items, setItems] = useState<ItemDraft[]>([
    { type: "producto", name: "", sku: "", sale_price: "", direct_cost: "", reward_eligible: true },
  ]);
  const [baseline, setBaseline] = useState({
    avg_monthly_sales: "", avg_monthly_transactions: "", avg_ticket: "",
    margin_pct: "0.35", registered_consumers: "", active_consumers: "",
    monthly_buyers: "", purchase_frequency: "1.5", source_type: "declarado", confidence: "80",
  });

  const derivedTicket = (() => {
    const s = Number(baseline.avg_monthly_sales), t = Number(baseline.avg_monthly_transactions);
    return s > 0 && t > 0 ? (s / t) : null;
  })();

  const catalogMargin = (() => {
    const valid = items.filter((i) => Number(i.sale_price) > 0);
    if (!valid.length) return null;
    const m = valid.reduce((acc, i) => acc + (Number(i.sale_price) - Number(i.direct_cost)) / Number(i.sale_price), 0);
    return m / valid.length;
  })();

  const validateStep = (): boolean => {
    const e: Record<string, string> = {};
    if (step === 0) {
      if (!info.trade_name.trim()) e.trade_name = "Obligatorio";
      if (!info.legal_name.trim()) e.legal_name = "Obligatorio";
      if (info.contact_email && !/^\S+@\S+\.\S+$/.test(info.contact_email)) e.contact_email = "Email inválido";
    }
    if (step === 1) {
      if (branches.length === 0) e.branches = "Se requiere al menos una sucursal";
      branches.forEach((b, i) => {
        if (!b.name.trim()) e[`branch_${i}`] = "Nombre de sucursal obligatorio";
        if (!b.timezone.trim()) e[`branch_tz_${i}`] = "Zona horaria obligatoria";
      });
    }
    if (step === 2) {
      const valid = items.filter((i) => i.name.trim());
      if (valid.length === 0) e.items = "Agrega al menos un producto o servicio";
      valid.forEach((it, i) => {
        if (Number(it.sale_price) <= 0) e[`item_price_${i}`] = "Precio > 0";
        if (Number(it.direct_cost) < 0) e[`item_cost_${i}`] = "Costo ≥ 0";
        if (Number(it.direct_cost) > Number(it.sale_price)) e[`item_margin_${i}`] = "Margen negativo: confirma precio/costo";
      });
    }
    if (step === 3) {
      if (Number(baseline.avg_monthly_sales) <= 0) e.avg_monthly_sales = "Ventas mensuales requeridas";
      if (Number(baseline.avg_monthly_transactions) < 0) e.avg_monthly_transactions = "No negativo";
      const reg = Number(baseline.registered_consumers), act = Number(baseline.active_consumers), buy = Number(baseline.monthly_buyers);
      if (act > reg && reg > 0) e.active_consumers = "Activos no pueden superar registrados";
      if (buy > act && act > 0) e.monthly_buyers = "Compradores no pueden superar activos";
      const m = Number(baseline.margin_pct);
      if (!(m >= 0 && m <= 1)) e.margin_pct = "Entre 0 y 1";
      if (derivedTicket && baseline.avg_ticket && Math.abs(derivedTicket - Number(baseline.avg_ticket)) / derivedTicket > 0.25) {
        e.avg_ticket = `Difiere >25% del derivado (${money(derivedTicket)})`;
      }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const next = () => { if (validateStep()) setStep((s) => s + 1); };

  const submit = async (activate: boolean) => {
    setSubmitting(true);
    setApiError(null);
    try {
      const client = await api.post<Client>("/clients", {
        project_id: projectId, ...info,
        onboarding_date: info.onboarding_date || null,
        brand_name: brandName || info.trade_name,
        branches: branches.map((b) => ({
          name: b.name, location: b.location, timezone: b.timezone,
          monthly_capacity: b.monthly_capacity ? Number(b.monthly_capacity) : null,
        })),
        catalog_items: items.filter((i) => i.name.trim()).map((i) => ({
          type: i.type, name: i.name, sku: i.sku, sale_price: i.sale_price,
          direct_cost: i.direct_cost || "0", reward_eligible: i.reward_eligible,
        })),
        baseline: {
          avg_monthly_sales: baseline.avg_monthly_sales,
          avg_monthly_transactions: baseline.avg_monthly_transactions || "0",
          avg_ticket: baseline.avg_ticket || (derivedTicket ? String(derivedTicket.toFixed(2)) : "0"),
          margin_pct: baseline.margin_pct,
          registered_consumers: Number(baseline.registered_consumers) || 0,
          active_consumers: Number(baseline.active_consumers) || 0,
          monthly_buyers: Number(baseline.monthly_buyers) || 0,
          purchase_frequency: baseline.purchase_frequency || "1",
          source_type: baseline.source_type, confidence: Number(baseline.confidence) || 80,
        },
        activate,
      });
      router.push(`/client/?project=${projectId}&id=${client.id}`);
    } catch (err) {
      setApiError(err instanceof ApiError ? String(err.message) : String(err));
      setSubmitting(false);
    }
  };

  if (!projectId) return <p className="text-sm text-rose-600">Falta el parámetro ?project=</p>;

  return (
    <div className="mx-auto max-w-3xl">
      <nav className="mb-2 text-xs text-slate-400">
        <Link href={`/clients/?project=${projectId}`} className="hover:text-pigui-700">Portafolio</Link> / Agregar cliente
      </nav>
      <SectionTitle title="Agregar cliente B2B"
        subtitle="El cliente alimenta la línea base del motor; cada campo conserva procedencia." />
      <StepIndicator steps={STEPS} current={step} />

      <Card>
        <CardBody className="space-y-4">
          {step === 0 && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="Nombre comercial" required error={errors.trade_name}>
                <input className={inputClass} value={info.trade_name}
                  onChange={(e) => setInfo({ ...info, trade_name: e.target.value })} />
              </Field>
              <Field label="Razón social" required error={errors.legal_name}>
                <input className={inputClass} value={info.legal_name}
                  onChange={(e) => setInfo({ ...info, legal_name: e.target.value })} />
              </Field>
              <Field label="Industria">
                <select className={inputClass} value={info.industry}
                  onChange={(e) => setInfo({ ...info, industry: e.target.value })}>
                  {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
                </select>
              </Field>
              <Field label="Moneda">
                <select className={inputClass} value={info.currency}
                  onChange={(e) => setInfo({ ...info, currency: e.target.value })}>
                  <option>MXN</option><option>USD</option>
                </select>
              </Field>
              <Field label="Fecha de onboarding">
                <input type="date" className={inputClass} value={info.onboarding_date}
                  onChange={(e) => setInfo({ ...info, onboarding_date: e.target.value })} />
              </Field>
              <Field label="Contacto">
                <input className={inputClass} value={info.contact_name}
                  onChange={(e) => setInfo({ ...info, contact_name: e.target.value })} />
              </Field>
              <Field label="Email" error={errors.contact_email}>
                <input className={inputClass} value={info.contact_email}
                  onChange={(e) => setInfo({ ...info, contact_email: e.target.value })} />
              </Field>
              <Field label="Teléfono">
                <input className={inputClass} value={info.contact_phone}
                  onChange={(e) => setInfo({ ...info, contact_phone: e.target.value })} />
              </Field>
            </div>
          )}

          {step === 1 && (
            <>
              <Field label="Marca principal" hint="Si se deja vacío se usa el nombre comercial.">
                <input className={inputClass} value={brandName} placeholder={info.trade_name}
                  onChange={(e) => setBrandName(e.target.value)} />
              </Field>
              {errors.branches && <p className="text-xs text-rose-600">{errors.branches}</p>}
              {branches.map((b, i) => (
                <div key={i} className="rounded-lg border border-slate-200 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-700">Sucursal {i + 1}</p>
                    {branches.length > 1 && (
                      <button className="text-xs text-rose-600 hover:underline"
                        onClick={() => setBranches(branches.filter((_, j) => j !== i))}>Eliminar</button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Nombre" required error={errors[`branch_${i}`]}>
                      <input className={inputClass} value={b.name}
                        onChange={(e) => setBranches(branches.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                    </Field>
                    <Field label="Dirección / ubicación">
                      <input className={inputClass} value={b.location}
                        onChange={(e) => setBranches(branches.map((x, j) => j === i ? { ...x, location: e.target.value } : x))} />
                    </Field>
                    <Field label="Zona horaria" required error={errors[`branch_tz_${i}`]}>
                      <input className={inputClass} value={b.timezone}
                        onChange={(e) => setBranches(branches.map((x, j) => j === i ? { ...x, timezone: e.target.value } : x))} />
                    </Field>
                    <Field label="Capacidad mensual (tx)" hint="Opcional">
                      <input type="number" className={inputClass} value={b.monthly_capacity}
                        onChange={(e) => setBranches(branches.map((x, j) => j === i ? { ...x, monthly_capacity: e.target.value } : x))} />
                    </Field>
                  </div>
                </div>
              ))}
              <Button variant="secondary" onClick={() =>
                setBranches([...branches, { name: "", location: "", timezone: "America/Mexico_City", monthly_capacity: "" }])}>
                + Agregar sucursal
              </Button>
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-xs text-slate-500">
                El catálogo alimenta márgenes, elegibilidad de rewards y transacciones. Margen = precio − costo.
              </p>
              {errors.items && <p className="text-xs text-rose-600">{errors.items}</p>}
              {items.map((it, i) => {
                const margin = Number(it.sale_price) > 0 ? (Number(it.sale_price) - Number(it.direct_cost)) : null;
                return (
                  <div key={i} className="rounded-lg border border-slate-200 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-sm font-semibold text-slate-700">Artículo {i + 1}
                        {margin !== null && (
                          <span className={`ml-2 text-xs font-normal ${margin < 0 ? "text-rose-600" : "text-slate-400"}`}>
                            margen {money(margin)} ({pct(margin / Number(it.sale_price))})
                          </span>
                        )}
                      </p>
                      {items.length > 1 && (
                        <button className="text-xs text-rose-600 hover:underline"
                          onClick={() => setItems(items.filter((_, j) => j !== i))}>Eliminar</button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      <Field label="Tipo">
                        <select className={inputClass} value={it.type}
                          onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}>
                          <option value="producto">Producto</option>
                          <option value="servicio">Servicio</option>
                        </select>
                      </Field>
                      <Field label="Nombre" required>
                        <input className={inputClass} value={it.name}
                          onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                      </Field>
                      <Field label="Precio" error={errors[`item_price_${i}`]}>
                        <input type="number" className={inputClass} value={it.sale_price}
                          onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, sale_price: e.target.value } : x))} />
                      </Field>
                      <Field label="Costo directo" error={errors[`item_cost_${i}`] || errors[`item_margin_${i}`]}>
                        <input type="number" className={inputClass} value={it.direct_cost}
                          onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, direct_cost: e.target.value } : x))} />
                      </Field>
                    </div>
                    <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                      <input type="checkbox" checked={it.reward_eligible} className="accent-pigui-600"
                        onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, reward_eligible: e.target.checked } : x))} />
                      Elegible para recompensas
                    </label>
                  </div>
                );
              })}
              <Button variant="secondary" onClick={() =>
                setItems([...items, { type: "producto", name: "", sku: "", sale_price: "", direct_cost: "", reward_eligible: true }])}>
                + Agregar artículo
              </Button>
            </>
          )}

          {step === 3 && (
            <>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                <Field label="Ventas mensuales promedio" required error={errors.avg_monthly_sales}>
                  <input type="number" className={inputClass} value={baseline.avg_monthly_sales}
                    onChange={(e) => setBaseline({ ...baseline, avg_monthly_sales: e.target.value })} />
                </Field>
                <Field label="Transacciones mensuales" error={errors.avg_monthly_transactions}>
                  <input type="number" className={inputClass} value={baseline.avg_monthly_transactions}
                    onChange={(e) => setBaseline({ ...baseline, avg_monthly_transactions: e.target.value })} />
                </Field>
                <Field label="Ticket promedio" error={errors.avg_ticket}
                  hint={derivedTicket ? `Derivado: ${money(derivedTicket)}` : undefined}>
                  <input type="number" className={inputClass} value={baseline.avg_ticket}
                    onChange={(e) => setBaseline({ ...baseline, avg_ticket: e.target.value })} />
                </Field>
                <Field label="Margen (0–1)" error={errors.margin_pct}
                  hint={catalogMargin ? `Catálogo sugiere ${pct(catalogMargin)}` : "0.35 = 35%"}>
                  <input className={inputClass} value={baseline.margin_pct}
                    onChange={(e) => setBaseline({ ...baseline, margin_pct: e.target.value })} />
                </Field>
                <Field label="Consumidores registrados">
                  <input type="number" className={inputClass} value={baseline.registered_consumers}
                    onChange={(e) => setBaseline({ ...baseline, registered_consumers: e.target.value })} />
                </Field>
                <Field label="Consumidores activos" error={errors.active_consumers}>
                  <input type="number" className={inputClass} value={baseline.active_consumers}
                    onChange={(e) => setBaseline({ ...baseline, active_consumers: e.target.value })} />
                </Field>
                <Field label="Compradores mensuales" error={errors.monthly_buyers}>
                  <input type="number" className={inputClass} value={baseline.monthly_buyers}
                    onChange={(e) => setBaseline({ ...baseline, monthly_buyers: e.target.value })} />
                </Field>
                <Field label="Frecuencia de compra">
                  <input className={inputClass} value={baseline.purchase_frequency}
                    onChange={(e) => setBaseline({ ...baseline, purchase_frequency: e.target.value })} />
                </Field>
                <Field label="Confianza del dato (%)">
                  <input type="number" min={0} max={100} className={inputClass} value={baseline.confidence}
                    onChange={(e) => setBaseline({ ...baseline, confidence: e.target.value })} />
                </Field>
              </div>
              <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
                Estos valores se registran como <Badge tone="declarado">declarado</Badge> con procedencia
                (quién, cuándo, confianza). La importación desde archivos con IA llega en la Fase 8.
              </p>
            </>
          )}

          {step === 4 && (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <ReviewBlock title="Negocio" onEdit={() => setStep(0)} rows={[
                  ["Nombre", `${info.trade_name} (${info.legal_name})`],
                  ["Industria", info.industry], ["Moneda", info.currency],
                ]} />
                <ReviewBlock title="Marca y sucursales" onEdit={() => setStep(1)} rows={[
                  ["Marca", brandName || info.trade_name],
                  ["Sucursales", `${branches.length}: ${branches.map((b) => b.name).join(", ")}`],
                ]} />
                <ReviewBlock title="Catálogo" onEdit={() => setStep(2)} rows={[
                  ["Artículos", String(items.filter((i) => i.name.trim()).length)],
                  ["Margen promedio", catalogMargin ? pct(catalogMargin) : "—"],
                ]} />
                <ReviewBlock title="Línea base" onEdit={() => setStep(3)} rows={[
                  ["Ventas/mes", money(baseline.avg_monthly_sales)],
                  ["Transacciones/mes", num(baseline.avg_monthly_transactions)],
                  ["Consumidores activos", num(baseline.active_consumers)],
                  ["Margen", pct(baseline.margin_pct)],
                ]} />
              </div>
              <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
                Validaciones automáticas: sucursal ≥ 1, catálogo ≥ 1, línea base con ventas.
                “Crear y activar” incorpora al cliente al escenario; “Guardar borrador” lo deja en estado Draft.
              </div>
              {apiError && <p className="text-sm font-medium text-rose-600">{apiError}</p>}
            </>
          )}
        </CardBody>
      </Card>

      <div className="mt-5 flex items-center justify-between">
        <Button variant="secondary" href={`/clients/?project=${projectId}`}>Cancelar</Button>
        <div className="flex gap-2">
          {step > 0 && <Button variant="secondary" onClick={() => setStep((s) => s - 1)}>Volver</Button>}
          {step < STEPS.length - 1 && <Button onClick={next}>Guardar y continuar</Button>}
          {step === STEPS.length - 1 && (
            <>
              <Button variant="secondary" disabled={submitting} onClick={() => submit(false)}>Guardar borrador</Button>
              <Button disabled={submitting} onClick={() => submit(true)}>
                {submitting ? "Creando…" : "Crear cliente B2B"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewBlock({ title, rows, onEdit }: { title: string; rows: [string, string][]; onEdit: () => void }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        <button onClick={onEdit} className="text-xs font-medium text-pigui-700 hover:underline">Editar</button>
      </div>
      <dl className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 text-sm">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-right font-medium text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><NewClientWizard /></Suspense>;
}
