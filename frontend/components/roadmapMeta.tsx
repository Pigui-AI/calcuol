/** Metadatos compartidos del roadmap de activación: icono de cada paso y
 *  estilo por estado. Los usan el stepper (RoadmapTutorial) y el mapa del
 *  motor (ConceptMap); el estado siempre viene calculado del servidor. */
import { ReactNode } from "react";

export const ICONS: Record<string, ReactNode> = {
  folder: <path d="M3 7a2 2 0 0 1 2-2h3.6l1.7 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  store: <path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9Zm-1-4h18l-1.2 3.2a2 2 0 0 1-1.9 1.3H6.1a2 2 0 0 1-1.9-1.3L3 5Z" />,
  sliders: <path d="M5 5v14M12 5v14M19 5v14M2.5 9h5M9.5 15h5M16.5 8h5" />,
  trending: <path d="M3 17l5.5-5.5 3.5 3.5L21 6M21 6h-5M21 6v5" />,
  gear: <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-3.5c0 .6-.06 1.1-.16 1.6l2 1.5-2 3.4-2.3-.9c-.8.7-1.7 1.2-2.7 1.5L14.5 22h-4l-.4-2.4c-1-.3-1.9-.8-2.7-1.5l-2.3.9-2-3.4 2-1.5A8.6 8.6 0 0 1 5 12c0-.6.06-1.1.16-1.6l-2-1.5 2-3.4 2.3.9c.8-.7 1.7-1.2 2.7-1.5L10.5 2h4l.4 2.4c1 .3 1.9.8 2.7 1.5l2.3-.9 2 3.4-2 1.5c.1.5.16 1 .16 1.6Z" />,
  play: <path d="M8 5.5v13l11-6.5-11-6.5Z" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  download: <path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 19h16" />,
};

export const STATUS_META: Record<string, { label: string; text: string; ring: string; circle: string }> = {
  completado: {
    label: "Completado", text: "text-emerald-600",
    ring: "border-emerald-500 bg-emerald-500", circle: "text-white",
  },
  en_progreso: {
    label: "En progreso", text: "text-pigui-700",
    ring: "border-pigui-600 bg-pigui-600 ring-4 ring-pigui-100", circle: "text-white",
  },
  pendiente: {
    label: "Pendiente", text: "text-slate-400",
    ring: "border-slate-200 bg-white", circle: "text-slate-300",
  },
};
