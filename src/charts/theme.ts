import { useEffect, useState } from "react";

/** Colors a chart needs, resolved to hex because canvas can't read CSS variables.
 *  The palette is the validated one FitLedger uses (dataviz reference palette). */
export interface ChartTheme {
  surface: string;
  text: string;
  muted: string;
  grid: string;
  axis: string;
  /** Single-series marks. */
  mark: string;
  /** Diverging pair for signed effects, with a neutral for "no change". */
  down: string;
  up: string;
  neutral: string;
  /** Up to three groups on one scatter plot; more than that cannot be told apart reliably. */
  categorical: string[];
}

export const LIGHT: ChartTheme = {
  surface: "#ffffff",
  text: "#16191e",
  muted: "#5d6572",
  grid: "#eceef2",
  axis: "#d5d9e0",
  mark: "#2a78d6",
  down: "#2a78d6",
  up: "#e34948",
  neutral: "#b4b9c2",
  categorical: ["#2a78d6", "#eb6834", "#1baf7a"],
};

export const DARK: ChartTheme = {
  surface: "#181b21",
  text: "#e7e9ee",
  muted: "#98a0ac",
  grid: "#23272e",
  axis: "#343a44",
  mark: "#3987e5",
  down: "#3987e5",
  up: "#e66767",
  neutral: "#565d69",
  categorical: ["#3987e5", "#d95926", "#199e70"],
};

function currentMode(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Follows the app theme (system or chosen). */
export function useChartTheme(): ChartTheme {
  const [mode, setMode] = useState(currentMode);
  useEffect(() => {
    const update = () => setMode(currentMode());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", update);
      obs.disconnect();
    };
  }, []);
  return mode === "dark" ? DARK : LIGHT;
}

export function formatNumber(n: number): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e6 || abs < 1e-3) return n.toExponential(2);
  return String(Number(n.toPrecision(4)));
}
