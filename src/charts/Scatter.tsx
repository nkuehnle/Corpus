import { useEffect, useMemo, useRef, useState } from "react";
import { scaleLinear } from "d3-scale";
import { formatNumber, useChartTheme } from "./theme";

export interface Point {
  x: number;
  y: number;
  label: string | null;
  /** Index into `groups`. */
  group: number;
}

export interface Group {
  name: string;
  color: string;
}

interface Props {
  points: Point[];
  groups: Group[];
  xLabel: string;
  yLabel: string;
  /** Dashed reference lines, in data units. */
  xLines?: number[];
  yLines?: number[];
  /** Replaces the tooltip's value lines, for plots whose axes are transformed. */
  describe?: (p: Point) => string;
}

const H = 300;
const M = { top: 10, right: 12, bottom: 38, left: 48 };
/** A finger lands within this many pixels of the point it meant. */
const REACH = 24;

/** Points on a canvas (tables here run to tens of thousands of rows). Tap or hover for the nearest point. */
export function Scatter({ points, groups, xLabel, yLabel, xLines = [], yLines = [], describe }: Props) {
  const theme = useChartTheme();
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(360);
  const [active, setActive] = useState<Point | null>(null);

  useEffect(() => {
    const obs = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    obs.observe(holder.current!);
    return () => obs.disconnect();
  }, []);

  const { x, y } = useMemo(() => {
    const extent = (get: (p: Point) => number, extra: number[]) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of points) {
        const v = get(p);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      for (const v of extra) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      return lo === hi ? [lo - 1, hi + 1] : [lo, hi];
    };
    return {
      x: scaleLinear()
        .domain(extent((p) => p.x, xLines))
        .nice()
        .range([M.left, width - M.right]),
      y: scaleLinear()
        .domain(extent((p) => p.y, yLines))
        .nice()
        .range([H - M.bottom, M.top]),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, width, xLines.join(), yLines.join()]);

  useEffect(() => {
    const c = canvas.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = width * ratio;
    c.height = H * ratio;
    const g = c.getContext("2d")!;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, H);
    g.font = "10px system-ui, sans-serif";
    g.lineWidth = 1;

    g.textAlign = "right";
    g.textBaseline = "middle";
    for (const t of y.ticks(5)) {
      g.strokeStyle = theme.grid;
      g.beginPath();
      g.moveTo(M.left, y(t));
      g.lineTo(width - M.right, y(t));
      g.stroke();
      g.fillStyle = theme.muted;
      g.fillText(formatNumber(t), M.left - 6, y(t));
    }
    g.textAlign = "center";
    g.textBaseline = "top";
    for (const t of x.ticks(Math.max(3, Math.floor(width / 70)))) {
      g.fillStyle = theme.muted;
      g.fillText(formatNumber(t), x(t), H - M.bottom + 6);
    }
    g.strokeStyle = theme.axis;
    g.beginPath();
    g.moveTo(M.left, H - M.bottom);
    g.lineTo(width - M.right, H - M.bottom);
    g.stroke();

    g.setLineDash([4, 4]);
    g.strokeStyle = theme.muted;
    for (const v of xLines) {
      g.beginPath();
      g.moveTo(x(v), M.top);
      g.lineTo(x(v), H - M.bottom);
      g.stroke();
    }
    for (const v of yLines) {
      g.beginPath();
      g.moveTo(M.left, y(v));
      g.lineTo(width - M.right, y(v));
      g.stroke();
    }
    g.setLineDash([]);

    // Dense plots get smaller, more transparent dots so overplotting still shows density.
    const r = points.length > 5000 ? 1.5 : points.length > 800 ? 2.2 : 3.5;
    g.globalAlpha = points.length > 5000 ? 0.5 : 0.75;
    // The first group is the background (e.g. "not significant"); later groups draw on top.
    for (let gi = 0; gi < groups.length; gi++) {
      g.fillStyle = groups[gi].color;
      g.beginPath();
      for (const p of points) {
        if (p.group !== gi) continue;
        g.moveTo(x(p.x) + r, y(p.y));
        g.arc(x(p.x), y(p.y), r, 0, Math.PI * 2);
      }
      g.fill();
    }
    g.globalAlpha = 1;

    if (active) {
      g.strokeStyle = theme.text;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x(active.x), y(active.y), 6, 0, Math.PI * 2);
      g.stroke();
    }

    g.fillStyle = theme.text;
    g.font = "11px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "bottom";
    g.fillText(xLabel, (M.left + width - M.right) / 2, H - 2);
    g.save();
    g.translate(11, (M.top + H - M.bottom) / 2);
    g.rotate(-Math.PI / 2);
    g.textBaseline = "middle";
    g.fillText(yLabel, 0, 0);
    g.restore();
  }, [points, groups, theme, width, x, y, active, xLabel, yLabel, xLines, yLines]);

  const pick = (e: React.PointerEvent) => {
    const box = holder.current!.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    let best: Point | null = null;
    let bestD = REACH * REACH;
    for (const p of points) {
      const d = (x(p.x) - px) ** 2 + (y(p.y) - py) ** 2;
      if (d < bestD) ((best = p), (bestD = d));
    }
    setActive(best);
  };

  const counts = groups.map((_, i) => points.filter((p) => p.group === i).length);
  return (
    <>
      {groups.length > 1 && (
        <div className="legend">
          {groups.map((g, i) => (
            <span key={g.name}>
              <i style={{ background: g.color }} />
              {g.name} ({counts[i].toLocaleString()})
            </span>
          ))}
        </div>
      )}
      <div
        className="chart"
        ref={holder}
        style={{ height: H }}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setActive(null)}
      >
        <canvas ref={canvas} role="img" aria-label={`${yLabel} against ${xLabel}`} />
        {active && (
          <div
            className="chart-tip"
            style={{
              left: Math.min(Math.max(4, x(active.x) - 80), width - 170),
              top: y(active.y) > H / 2 ? y(active.y) - 70 : y(active.y) + 14,
            }}
          >
            {active.label && <strong>{active.label}</strong>}
            {describe ? (
              <div className="muted">{describe(active)}</div>
            ) : (
              <>
                <div className="muted">
                  {xLabel}: {formatNumber(active.x)}
                </div>
                <div className="muted">
                  {yLabel}: {formatNumber(active.y)}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
