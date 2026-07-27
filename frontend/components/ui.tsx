"use client";
/** Componentes UI compartidos: tarjetas, KPIs, badges, botones, estados (9.3). */
import { ReactNode } from "react";
import Link from "next/link";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`bg-white rounded-xl border border-slate-200 shadow-sm ${className}`}>{children}</div>;
}

export function CardBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`p-5 ${className}`}>{children}</div>;
}

export function KpiCard({ label, value, hint, tone = "default" }:
  { label: string; value: ReactNode; hint?: string; tone?: "default" | "good" | "bad" | "muted" }) {
  const toneClass = tone === "good" ? "text-emerald-600" : tone === "bad" ? "text-rose-600"
    : tone === "muted" ? "text-slate-400" : "text-slate-900";
  return (
    <Card>
      <CardBody className="py-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        <p className={`mt-1 text-xl font-semibold ${toneClass}`}>{value}</p>
        {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
      </CardBody>
    </Card>
  );
}

const badgeTones: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  succeeded: "bg-emerald-50 text-emerald-700 border-emerald-200",
  draft: "bg-slate-100 text-slate-600 border-slate-200",
  queued: "bg-amber-50 text-amber-700 border-amber-200",
  running: "bg-blue-50 text-blue-700 border-blue-200",
  onboarding: "bg-blue-50 text-blue-700 border-blue-200",
  failed: "bg-rose-50 text-rose-700 border-rose-200",
  archived: "bg-slate-100 text-slate-500 border-slate-200",
  // clasificación del dato (7.1)
  real: "bg-emerald-50 text-emerald-700 border-emerald-200",
  declarado: "bg-blue-50 text-blue-700 border-blue-200",
  estimado: "bg-orange-50 text-orange-700 border-orange-200",
  hipotesis: "bg-purple-50 text-purple-700 border-purple-200",
  meta: "bg-indigo-50 text-indigo-700 border-indigo-200",
  default: "bg-slate-100 text-slate-600 border-slate-200",
};

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${badgeTones[tone] || badgeTones.default}`}>
      {children}
    </span>
  );
}

export function Button({ children, onClick, href, variant = "primary", disabled = false, type = "button", className = "" }:
  { children: ReactNode; onClick?: () => void; href?: string; disabled?: boolean;
    variant?: "primary" | "secondary" | "ghost" | "danger"; type?: "button" | "submit"; className?: string }) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed";
  const styles = {
    primary: "bg-pigui-600 text-white hover:bg-pigui-700",
    secondary: "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50",
    ghost: "text-pigui-700 hover:bg-pigui-50",
    danger: "bg-rose-600 text-white hover:bg-rose-700",
  }[variant];
  if (href && !disabled) {
    return <Link href={href} className={`${base} ${styles} ${className}`}>{children}</Link>;
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function EmptyState({ title, description, action }:
  { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-14 text-center">
      <p className="text-base font-semibold text-slate-700">{title}</p>
      <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
      <p className="font-medium">Ocurrió un error</p>
      <p className="mt-1">{message}</p>
      {onRetry && <Button variant="secondary" onClick={onRetry} className="mt-3">Reintentar</Button>}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="animate-pulse space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-10 rounded-lg bg-slate-100" />
      ))}
    </div>
  );
}

export function Field({ label, children, error, hint, required = false }:
  { label: string; children: ReactNode; error?: string; hint?: string; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">
        {label} {required && <span className="text-rose-500">*</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-rose-600">{error}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-pigui-500 focus:outline-none focus:ring-1 focus:ring-pigui-500 bg-white";

export function SectionTitle({ title, subtitle, right }:
  { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function StepIndicator({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-2">
      {steps.map((step, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li key={step} className="flex items-center gap-2">
            <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold
              ${state === "done" ? "bg-pigui-600 text-white" : state === "current" ? "border-2 border-pigui-600 text-pigui-700" : "border border-slate-300 text-slate-400"}`}>
              {i + 1}
            </span>
            <span className={`text-sm ${state === "current" ? "font-semibold text-slate-900" : "text-slate-500"}`}>{step}</span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-slate-300" />}
          </li>
        );
      })}
    </ol>
  );
}
