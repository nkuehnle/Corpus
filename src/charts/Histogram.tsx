import { useMemo, useState } from "react";
import { bin } from "d3-array";
import { scaleLinear } from "d3-scale";
import { formatNumber, useChartTheme } from "./theme";

const W = 360;
const H = 220;
const M = { top: 10, right: 12, bottom: 34, left: 44 };

/** How a column's values are spread. Tap a bar for its range and count. */
export function Histogram({ values, label }: { values: number[]; label: string }) {
  const theme = useChartTheme();
  const [active, setActive] = useState<number | null>(null);

  const { bins, x, y } = useMemo(() => {
    const x = scaleLinear()
      .domain([Math.min(...values), Math.max(...values)])
      .nice();
    const bins = bin()
      .domain(x.domain() as [number, number])
      .thresholds(x.ticks(24))(values);
    const y = scaleLinear()
      .domain([0, Math.max(...bins.map((b) => b.length))])
      .nice()
      .range([H - M.bottom, M.top]);
    x.range([M.left, W - M.right]);
    return { bins, x, y };
  }, [values]);

  const tip = active != null ? bins[active] : null;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Distribution of ${label}`} onPointerLeave={() => setActive(null)}>
        {y.ticks(4).map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke={theme.grid} />
            <text x={M.left - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill={theme.muted}>
              {formatNumber(t)}
            </text>
          </g>
        ))}
        {bins.map((b, i) => {
          const x0 = x(b.x0!);
          const w = Math.max(1, x(b.x1!) - x0 - 2);
          const top = y(b.length);
          const h = y(0) - top;
          const r = Math.min(4, w / 2, h);
          return (
            <g key={i} onPointerEnter={() => setActive(i)} onPointerDown={() => setActive(i)}>
              {/* The hit area is the full column, so short bars are still easy to tap. */}
              <rect x={x0} y={M.top} width={w + 2} height={H - M.top - M.bottom} fill="transparent" />
              {b.length > 0 && (
                <path
                  d={`M${x0 + 1},${y(0)} V${top + r} q0,${-r} ${r},${-r} H${x0 + 1 + w - r} q${r},0 ${r},${r} V${y(0)} Z`}
                  fill={theme.mark}
                  opacity={active == null || active === i ? 1 : 0.45}
                />
              )}
            </g>
          );
        })}
        <line x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} stroke={theme.axis} />
        {x.ticks(5).map((t) => (
          <text key={t} x={x(t)} y={H - M.bottom + 14} textAnchor="middle" fontSize="10" fill={theme.muted}>
            {formatNumber(t)}
          </text>
        ))}
        <text x={(M.left + W - M.right) / 2} y={H - 4} textAnchor="middle" fontSize="11" fill={theme.text}>
          {label}
        </text>
      </svg>
      {tip && (
        <div className="chart-tip" style={{ left: `${Math.min(60, (x(tip.x0!) / W) * 100)}%`, top: 0 }}>
          <strong>{tip.length.toLocaleString()}</strong> rows
          <div className="muted">
            {formatNumber(tip.x0!)} to {formatNumber(tip.x1!)}
          </div>
        </div>
      )}
    </div>
  );
}
