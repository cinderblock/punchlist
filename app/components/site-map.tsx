import { useRef } from "react";

import type { SiteMap as SiteMapConfig } from "../../src/config-schema.ts";
import { boundsOf } from "../../src/geometry.ts";

export interface MapPin {
  id: string;
  x: number;
  y: number;
  label: string;
  overdue?: boolean;
}

/**
 * A floor plan, in the deployment's own coordinates. The drawing's units are the
 * map's units, so a tap converts straight back to a point with no scale to keep
 * in step. A map with y growing up (surveyed coordinates) is flipped by negating
 * y when drawing, so text stays the right way up.
 */
export function SiteMap({
  map,
  pins = [],
  selected,
  onPoint,
  onPin,
  highlightZone,
}: {
  map: SiteMapConfig;
  pins?: readonly MapPin[];
  selected?: { x: number; y: number } | null;
  /** Makes the whole map a tap target. */
  onPoint?: (x: number, y: number) => void;
  onPin?: (id: string) => void;
  highlightZone?: string | null;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const b = boundsOf(map.outline);
  const width = b.maxX - b.minX;
  const height = b.maxY - b.minY;
  const pad = Math.max(width, height) * 0.02;
  // Everything drawn is in map units, so sizes are too.
  const unit = Math.max(width, height) / 100;
  const up = map.yAxis === "up";
  const sy = (y: number) => (up ? -y : y);
  const points = (polygon: readonly (readonly [number, number])[]) => polygon.map(([x, y]) => `${x},${sy(y)}`).join(" ");
  const top = up ? -b.maxY : b.minY;

  function tap(event: React.MouseEvent<SVGSVGElement>) {
    if (!onPoint || !svg.current) return;
    const matrix = svg.current.getScreenCTM()?.inverse();
    if (!matrix) return;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    const y = up ? -p.y : p.y;
    if (p.x < b.minX || p.x > b.maxX || y < b.minY || y > b.maxY) return;
    onPoint(p.x, y);
  }

  const centroid = (polygon: readonly (readonly [number, number])[]) => ({
    x: polygon.reduce((n, p) => n + p[0], 0) / polygon.length,
    y: polygon.reduce((n, p) => n + p[1], 0) / polygon.length,
  });

  return (
    <svg
      ref={svg}
      data-testid="site-map"
      role={onPoint ? "application" : "img"}
      aria-label={`Map of ${map.name}`}
      viewBox={`${b.minX - pad} ${top - pad} ${width + 2 * pad} ${height + 2 * pad}`}
      onClick={tap}
      style={{ width: "100%", height: "auto", maxHeight: "70dvh", display: "block", cursor: onPoint ? "crosshair" : "default", touchAction: "manipulation" }}
    >
      <polygon points={points(map.outline)} fill="var(--mantine-color-default)" stroke="var(--mantine-color-text)" strokeWidth={unit * 0.4} />
      {map.zones.map((z) => {
        const c = centroid(z.polygon);
        const on = highlightZone === z.id;
        return (
          <g key={z.id}>
            <polygon
              points={points(z.polygon)}
              fill={z.color ?? "var(--mantine-color-brand-5)"}
              fillOpacity={on ? 0.45 : 0.15}
              stroke="var(--mantine-color-dimmed)"
              strokeWidth={unit * 0.15}
            />
            <text x={c.x} y={sy(c.y)} textAnchor="middle" dominantBaseline="middle" fontSize={unit * 2.4} fill="var(--mantine-color-text)" style={{ pointerEvents: "none" }}>
              {z.name}
            </text>
          </g>
        );
      })}
      {map.places.map((p) => {
        // Toward the middle of the map, so a name by a far wall stays on it.
        const right = p.x < b.minX + width / 2;
        const low = (p.y - b.minY) / height < 0.1;
        return (
        <g key={p.id} style={{ pointerEvents: "none" }}>
          <circle cx={p.x} cy={sy(p.y)} r={unit * 0.6} fill="var(--mantine-color-dimmed)" />
          <text x={p.x + (right ? unit : -unit)} y={sy(p.y) + (up === low ? -unit * 1.5 : 0)} textAnchor={right ? "start" : "end"} dominantBaseline="middle" fontSize={unit * 1.9} fill="var(--mantine-color-dimmed)">
            {p.name}
          </text>
        </g>
        );
      })}
      {pins.map((pin) => (
        <g
          key={pin.id}
          role="link"
          aria-label={pin.label}
          tabIndex={onPin ? 0 : undefined}
          onClick={(event) => {
            event.stopPropagation();
            onPin?.(pin.id);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") onPin?.(pin.id);
          }}
          style={{ cursor: onPin ? "pointer" : "default" }}
        >
          <title>{pin.label}</title>
          {/* The visible dot is small; the invisible one is the tap target. */}
          <circle cx={pin.x} cy={sy(pin.y)} r={unit * 3} fill="transparent" />
          <circle
            cx={pin.x}
            cy={sy(pin.y)}
            r={unit * 1.3}
            fill={pin.overdue ? "var(--mantine-color-red-6)" : "var(--mantine-color-brand-6)"}
            stroke="var(--mantine-color-body)"
            strokeWidth={unit * 0.35}
          />
        </g>
      ))}
      {selected && (
        <circle
          data-testid="map-selected"
          cx={selected.x}
          cy={sy(selected.y)}
          r={unit * 1.5}
          fill="var(--mantine-color-red-6)"
          stroke="var(--mantine-color-body)"
          strokeWidth={unit * 0.4}
          style={{ pointerEvents: "none" }}
        />
      )}
    </svg>
  );
}
