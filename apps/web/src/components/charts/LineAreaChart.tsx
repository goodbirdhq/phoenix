import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { curvePath, niceScale, smoothCurve } from "@t3tools/shared/lineAreaGeometry";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

export interface LineAreaSeries {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly icon?: ReactNode;
  /** One nonnegative finite value per period; zero represents known inactivity. */
  readonly values: readonly number[];
}
interface ChartColumn {
  readonly bands: readonly { readonly seriesId: string; readonly value: number }[];
  readonly total: number;
}

/** Shared, unstacked monotone line/area chart. Domain formatting belongs to its caller. */
export function LineAreaChart({
  periods,
  series: seriesData,
  label,
  format,
  formatPeriod,
  formatTooltipPeriod = formatPeriod,
}: {
  readonly periods: readonly string[];
  readonly series: readonly LineAreaSeries[];
  readonly label: string;
  readonly format: (value: number) => string;
  readonly formatPeriod: (period: string) => string;
  readonly formatTooltipPeriod?: (period: string) => string;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const { paths, ticks, stepX, toY, series } = useMemo(() => {
    if (periods.length === 0) {
      return {
        paths: [],
        series: [] as readonly ChartColumn[],
        stepX: 0,
        ticks: [0] as readonly number[],
        toY: () => VIEW_HEIGHT,
      };
    }

    const columns = periods.map((_, index) => ({
      bands: seriesData.map((entry) => ({ seriesId: entry.id, value: entry.values[index] ?? 0 })),
      total: seriesData.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0),
    }));
    const peak = columns.reduce(
      (max, column) => column.bands.reduce((inner, band) => Math.max(inner, band.value), max),
      0,
    );
    const { max, ticks: tickValues } = niceScale(peak, TICK_COUNT);
    const step = periods.length === 1 ? 0 : VIEW_WIDTH / (periods.length - 1);
    const toY = (value: number) =>
      max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);
    const built = seriesData.map((entry) => {
      const points = periods.map((_, index) => ({
        x: periods.length === 1 ? VIEW_WIDTH / 2 : index * step,
        y: toY(entry.values[index] ?? 0),
      }));
      const line = curvePath(smoothCurve(points));
      return {
        seriesId: entry.id,
        color: entry.color,
        total: entry.values.reduce((sum, value) => sum + value, 0),
        point: points.length === 1 ? points[0] : undefined,
        area: line === "" ? "" : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`,
        line,
      };
    });

    // Paint the heavier series first so the lighter one is not buried.
    return {
      paths: built.toSorted((a, b) => b.total - a.total),
      series: columns,
      stepX: step,
      ticks: tickValues,
      toY,
    };
  }, [periods, seriesData]);

  const positionTooltip = useCallback(() => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const hoverPosition = hoverPositionRef.current;
    if (plot === null || tooltip === null || hoverPosition === null) return;

    const gap = 12;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const plotWidth = plot.clientWidth;
    const plotHeight = plot.clientHeight;
    const preferredLeft =
      hoverPosition.x + gap + tooltipWidth <= plotWidth
        ? hoverPosition.x + gap
        : hoverPosition.x - gap - tooltipWidth;
    const preferredTop =
      hoverPosition.y + gap + tooltipHeight <= plotHeight
        ? hoverPosition.y + gap
        : hoverPosition.y - gap - tooltipHeight;
    const left = Math.min(Math.max(0, preferredLeft), Math.max(0, plotWidth - tooltipWidth));
    const top = Math.min(Math.max(0, preferredTop), Math.max(0, plotHeight - tooltipHeight));
    plot.style.setProperty("--chart-tooltip-left", `${left}px`);
    plot.style.setProperty("--chart-tooltip-top", `${top}px`);
  }, []);

  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();

    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(positionTooltip);
    observer.observe(plot);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [hoverIndex, positionTooltip]);

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const plot = plotRef.current;
      if (plot === null || periods.length === 0) return;
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0) return;
      const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
      const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
      const fraction = localX / bounds.width;
      const index = Math.round(fraction * (periods.length - 1));
      hoverPositionRef.current = { x: localX, y: localY };
      positionTooltip();
      setHoverIndex(Math.min(periods.length - 1, Math.max(0, index)));
    },
    [periods.length, positionTooltip],
  );

  const hoveredPeriod = hoverIndex === null ? undefined : periods[hoverIndex];
  const hoveredColumn = hoverIndex === null ? undefined : series[hoverIndex];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {/* Axis labels sit outside the plot so they stay aligned to gridlines. */}
        <div className="relative h-56 w-14 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>

        <div
          ref={plotRef}
          className="relative h-56 min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          tabIndex={periods.length === 0 ? -1 : 0}
          role="group"
          aria-label={`${label}. Use left and right arrow keys to inspect values.`}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
            event.preventDefault();
            if (event.key === "Escape") {
              setHoverIndex(null);
              return;
            }
            const index =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? periods.length - 1
                  : Math.min(
                      periods.length - 1,
                      Math.max(0, (hoverIndex ?? 0) + (event.key === "ArrowRight" ? 1 : -1)),
                    );
            hoverPositionRef.current = {
              x: (index / Math.max(1, periods.length - 1)) * (plotRef.current?.clientWidth ?? 0),
              y: 0,
            };
            setHoverIndex(index);
          }}
          onBlur={() => setHoverIndex(null)}
          onMouseMove={handleMove}
          onMouseLeave={() => {
            hoverPositionRef.current = null;
            setHoverIndex(null);
          }}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={label}
          >
            {ticks.map((tick) => {
              const y = toY(tick);
              return (
                <line
                  key={tick}
                  x1={0}
                  x2={VIEW_WIDTH}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={1}
                  className="text-border"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            {/* Fills first, then every stroke, so no series covers another's line. */}
            {paths.map(({ seriesId, color, area }) => (
              <path key={seriesId} d={area} fill={color} fillOpacity={0.055} />
            ))}
            {paths.map(({ seriesId, color, line }) => (
              <path
                key={seriesId}
                d={line}
                fill="none"
                stroke={color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {paths.map(({ seriesId, color, point }) =>
              point === undefined ? null : (
                <circle key={seriesId} cx={point.x} cy={point.y} r={3} fill={color} />
              ),
            )}
            {hoverIndex === null ? null : (
              <line
                x1={periods.length === 1 ? VIEW_WIDTH / 2 : hoverIndex * stepX}
                x2={periods.length === 1 ? VIEW_WIDTH / 2 : hoverIndex * stepX}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {hoveredPeriod === undefined ? null : (
            <div
              ref={tooltipRef}
              role="status"
              className="surface-glass pointer-events-none absolute z-10 min-w-36 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={{
                left: "var(--chart-tooltip-left, 0px)",
                top: "var(--chart-tooltip-top, 0px)",
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatTooltipPeriod(hoveredPeriod)}</div>
              {seriesData.map(({ id: seriesId, label, color, icon }) => {
                return (
                  <div key={seriesId} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      {icon ?? (
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: color }}
                        />
                      )}
                      {label}
                    </span>
                    <span className="text-foreground tabular-nums">
                      {format(
                        hoveredColumn?.bands.find((band) => band.seriesId === seriesId)?.value ?? 0,
                      )}
                    </span>
                  </div>
                );
              })}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                <span className="text-muted-foreground">Total</span>
                <span className="text-foreground tabular-nums">
                  {format(hoveredColumn?.total ?? 0)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-between pl-16 text-[10px] text-muted-foreground uppercase">
        <span>{periods[0] === undefined ? "" : formatPeriod(periods[0])}</span>
        <span>
          {periods[Math.floor(periods.length / 2)] === undefined
            ? ""
            : formatPeriod(periods[Math.floor(periods.length / 2)] ?? "")}
        </span>
        <span>
          {periods[periods.length - 1] === undefined
            ? ""
            : formatPeriod(periods[periods.length - 1] ?? "")}
        </span>
      </div>
    </div>
  );
}
