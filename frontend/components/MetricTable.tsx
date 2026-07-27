"use client";
/** Tabla mensual con primera columna fija y scroll horizontal (pantallas 53/56/57). */
import { money, num, pct, monthName } from "@/lib/format";

export interface MetricRowDef {
  label: string;
  key: string;
  kind?: "money" | "count" | "pct" | "ratio";
  strong?: boolean;
}

export default function MetricTable({ months, metrics, rows, currency }: {
  months: string[];
  metrics: Record<string, (string | null)[]>;
  rows: MetricRowDef[];
  currency: string;
}) {
  const fmt = (kind: MetricRowDef["kind"], v: string | null) => {
    if (v === null || v === undefined) return "—";
    switch (kind) {
      case "count": return num(v, 1);
      case "pct": return pct(v);
      case "ratio": return num(v, 2);
      default: return money(v, currency);
    }
  };
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="min-w-max text-xs">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            <th className="sticky left-0 z-10 bg-slate-50 px-4 py-2.5 text-left font-semibold text-slate-600">
              Concepto
            </th>
            {months.map((m, i) => (
              <th key={m} className={`px-2.5 py-2.5 text-right font-medium text-slate-500 ${(i + 1) % 12 === 0 ? "border-r border-slate-200" : ""}`}>
                {monthName(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-slate-100 last:border-0 hover:bg-pigui-50/30">
              <td className={`sticky left-0 z-10 bg-white px-4 py-2 text-left ${r.strong ? "font-semibold text-slate-900" : "text-slate-600"}`}>
                {r.label}
              </td>
              {months.map((m, i) => {
                const v = metrics[r.key]?.[i] ?? null;
                const negative = v !== null && parseFloat(v) < 0;
                return (
                  <td key={m} className={`px-2.5 py-2 text-right tabular-nums ${negative ? "text-rose-600" : "text-slate-700"} ${r.strong ? "font-semibold" : ""} ${(i + 1) % 12 === 0 ? "border-r border-slate-100" : ""}`}>
                    {fmt(r.kind, v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
