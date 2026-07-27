"use client";
/** Pantalla 50 — Centro de supuestos. Ruta estática: /assumptions?project=&scenario= */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, Assumption, Scenario } from "@/lib/api";
import { Badge, Button, Card, ErrorState, SectionTitle, Skeleton, inputClass } from "@/components/ui";

const GROUPS: [string, string][] = [
  ["b2b.", "Clientes B2B y adquisición"],
  ["b2c.", "Consumidores B2C y comportamiento"],
  ["revenue.", "Modelo de ingresos: comisiones"],
  ["payments.", "Rutas de pago y cobranza"],
  ["points.", "Puntos"],
  ["subs.", "Suscripciones"],
  ["tokens.", "IA y tokens"],
  ["finance.", "Finanzas y capital"],
];

function AssumptionCenter() {
  const params = useSearchParams();
  const projectId = params.get("project") ?? "";
  const sid = params.get("scenario") ?? "";
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [assumptions, setAssumptions] = useState<Assumption[] | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(() => {
    if (!sid) return;
    api.get<{ scenario: Scenario; assumptions: Assumption[] }>(`/scenarios/${sid}/assumptions`)
      .then((r) => { setScenario(r.scenario); setAssumptions(r.assumptions); })
      .catch((e) => setError(String(e.message)));
  }, [sid]);
  useEffect(load, [load]);

  const dirty = Object.keys(edits).length > 0;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await api.patch<{ assumptions: Assumption[] }>(`/scenarios/${sid}/assumptions`, {
        changes: edits, source_type: "hipotesis", actor: "usuario",
      });
      setAssumptions(r.assumptions);
      setEdits({});
      setSavedAt(new Date().toLocaleTimeString("es-MX"));
    } catch (e) {
      setSaveError(e instanceof ApiError ? String(e.message) : String(e));
    } finally {
      setSaving(false);
    }
  };

  const grouped = useMemo(() => {
    if (!assumptions) return [];
    const filtered = q
      ? assumptions.filter((a) => a.key.includes(q.toLowerCase()) || a.description.toLowerCase().includes(q.toLowerCase()))
      : assumptions;
    return GROUPS.map(([prefix, label]) => ({
      label,
      items: filtered.filter((a) => a.key.startsWith(prefix)),
    })).filter((g) => g.items.length > 0);
  }, [assumptions, q]);

  if (!sid) return <ErrorState message="Falta el parámetro ?scenario=" />;
  if (error) return <ErrorState message={error} onRetry={() => { setError(null); load(); }} />;
  if (!assumptions || !scenario) return <Skeleton rows={6} />;

  return (
    <div className="mx-auto max-w-4xl">
      <nav className="mb-2 text-xs text-slate-400">
        <Link href={`/project/?id=${projectId}`} className="hover:text-pigui-700">Proyecto</Link> / Centro de supuestos
      </nav>
      <SectionTitle
        title={`Centro de supuestos — ${scenario.name}`}
        subtitle="Resolución por jerarquía: default del motor → proyecto → escenario. Cada cambio crea una nueva versión (nunca sobrescribe)."
        right={
          <div className="flex items-center gap-2">
            {savedAt && !dirty && <span className="text-xs text-emerald-600">Guardado {savedAt}</span>}
            <Button onClick={save} disabled={!dirty || saving}>
              {saving ? "Guardando…" : `Guardar cambios${dirty ? ` (${Object.keys(edits).length})` : ""}`}
            </Button>
          </div>
        }
      />

      <input className={`${inputClass} mb-4 max-w-sm`} placeholder="Buscar supuesto…"
        value={q} onChange={(e) => setQ(e.target.value)} />
      {saveError && <p className="mb-3 text-sm font-medium text-rose-600">{saveError}</p>}

      <div className="space-y-5">
        {grouped.map((group) => (
          <Card key={group.label}>
            <div className="border-b border-slate-100 px-5 py-3">
              <p className="text-sm font-semibold text-slate-800">{group.label}</p>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {group.items.map((a) => {
                  const value = edits[a.key] ?? a.value;
                  const changed = a.key in edits;
                  return (
                    <tr key={a.key} className="border-b border-slate-50 last:border-0">
                      <td className="px-5 py-2.5">
                        <p className="font-medium text-slate-800">{a.description || a.key}</p>
                        <p className="font-mono text-[11px] text-slate-400">{a.key}{a.unit && ` · ${a.unit}`}</p>
                      </td>
                      <td className="w-28 px-3 py-2.5">
                        <Badge tone={a.origin === "escenario" ? "hipotesis" : a.origin === "proyecto" ? "declarado" : "default"}>
                          {a.origin}
                        </Badge>
                      </td>
                      <td className="w-44 px-3 py-2.5">
                        <input
                          className={`${inputClass} ${changed ? "!border-pigui-500 !ring-1 !ring-pigui-500" : ""}`}
                          value={value}
                          onChange={(e) => {
                            const v = e.target.value;
                            setEdits((prev) => {
                              const next = { ...prev };
                              if (v === a.value) delete next[a.key];
                              else next[a.key] = v;
                              return next;
                            });
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        ))}
      </div>

      <p className="mt-4 text-xs text-slate-400">
        Porcentajes en decimal (0.25 = 25%). La distribución Pigui + puntos + negocio debe sumar 100%;
        el servidor valida y rechaza combinaciones inválidas.
      </p>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={6} />}><AssumptionCenter /></Suspense>;
}
