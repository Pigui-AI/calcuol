"use client";
/** Pantalla 52 — Ejecutar simulación. Ruta estática: /simulate?project=&scenario= */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, Client, Project, Run } from "@/lib/api";
import { Badge, Button, Card, CardBody, ErrorState, SectionTitle, Skeleton } from "@/components/ui";

function SimulatePage() {
  const params = useSearchParams();
  const projectId = params.get("project") ?? "";
  const sid = params.get("scenario") ?? "";
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [clientCount, setClientCount] = useState<number | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    if (!projectId) return;
    api.get<Project>(`/projects/${projectId}`).then(setProject).catch((e) => setError(String(e.message)));
    api.get<{ clients: Client[] }>(`/projects/${projectId}/clients`)
      .then((r) => setClientCount(r.clients.length)).catch(() => setClientCount(0));
  }, [projectId]);
  useEffect(load, [load]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const launch = async () => {
    setLaunching(true);
    setError(null);
    try {
      const created = await api.post<Run>("/simulation-runs", { scenario_id: sid },
        { "Idempotency-Key": `ui-${sid}-${Date.now()}` });
      setRun(created);
      pollRef.current = setInterval(async () => {
        const status = await api.get<Run>(`/simulation-runs/${created.id}`);
        setRun(status);
        if (status.status === "succeeded") {
          if (pollRef.current) clearInterval(pollRef.current);
          router.push(`/run/?project=${projectId}&id=${created.id}`);
        }
        if (status.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setLaunching(false);
        }
      }, 700);
    } catch (e) {
      setError(String((e as Error).message));
      setLaunching(false);
    }
  };

  if (!projectId || !sid) return <ErrorState message="Faltan parámetros ?project= y ?scenario=" />;
  if (error && !run) return <ErrorState message={error} onRetry={() => { setError(null); load(); }} />;
  if (!project || clientCount === null) return <Skeleton rows={5} />;

  const scenario = project.scenarios.find((s) => s.id === sid);
  const checks: { label: string; ok: boolean; detail: string }[] = [
    { label: "Escenario válido", ok: !!scenario, detail: scenario ? `${scenario.name} (${scenario.type})` : "No encontrado" },
    { label: "Horizonte configurado", ok: [12, 36, 60].includes(project.horizon_months), detail: `${project.horizon_months} meses desde ${project.start_month}` },
    { label: "Moneda principal", ok: !!project.base_currency, detail: project.base_currency },
    {
      label: "Portafolio de clientes", ok: true,
      detail: clientCount > 0
        ? `${clientCount} cliente(s): el motor estima el perfil por cliente del portafolio`
        : "Sin clientes: el motor usará los supuestos del proyecto (advertencia no bloqueante)",
    },
  ];
  const allOk = checks.every((c) => c.ok);

  return (
    <div className="mx-auto max-w-2xl">
      <nav className="mb-2 text-xs text-slate-400">
        <Link href={`/project/?id=${projectId}`} className="hover:text-pigui-700">Proyecto</Link> / Ejecutar simulación
      </nav>
      <SectionTitle
        title={`Ejecutar simulación — ${scenario?.name ?? ""}`}
        subtitle="Se crea un snapshot inmutable de supuestos, costos y portafolio; el mismo snapshot siempre produce el mismo hash de salida."
      />

      <Card>
        <CardBody className="space-y-3">
          {checks.map((c) => (
            <div key={c.label} className="flex items-start justify-between gap-4 rounded-lg border border-slate-100 p-3">
              <div>
                <p className="text-sm font-medium text-slate-800">{c.label}</p>
                <p className="text-xs text-slate-500">{c.detail}</p>
              </div>
              <Badge tone={c.ok ? "active" : "failed"}>{c.ok ? "OK" : "Falta"}</Badge>
            </div>
          ))}
        </CardBody>
      </Card>

      <div className="mt-5 flex items-center justify-between">
        <Button variant="secondary" href={`/assumptions/?project=${projectId}&scenario=${sid}`}>
          Revisar supuestos
        </Button>
        <Button onClick={launch} disabled={!allOk || launching}>
          {launching ? "Ejecutando…" : "Ejecutar simulación"}
        </Button>
      </div>

      {run && (
        <Card className="mt-5">
          <CardBody>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-800">Run {run.id.slice(0, 12)}…</p>
                <p className="text-xs text-slate-500">Snapshot {run.input_hash.slice(0, 16)}… · motor v{run.engine_version}</p>
              </div>
              <Badge tone={run.status}>{run.status}</Badge>
            </div>
            {(run.status === "queued" || run.status === "running") && (
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full w-1/2 animate-pulse rounded-full bg-pigui-500" />
              </div>
            )}
            {run.status === "failed" && (
              <p className="mt-3 text-sm text-rose-600">{run.error || "Error desconocido"} — puedes reintentar.</p>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton rows={5} />}><SimulatePage /></Suspense>;
}
