import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
import { curvePath, smoothCurve } from "@t3tools/shared/lineAreaGeometry";

export function LineAreaChart({
  periods,
  series,
  height,
  label,
}: {
  readonly periods: readonly string[];
  readonly series: readonly {
    readonly id: string;
    readonly color: string;
    readonly values: readonly number[];
  }[];
  readonly height: number;
  readonly label: string;
}) {
  const paths = useMemo(() => {
    const max = Math.max(1, ...series.flatMap((row) => row.values));
    return series.map((row) => {
      const points = periods.map((_, index) => ({
        x: periods.length === 1 ? 480 : (index * 960) / (periods.length - 1),
        y: 180 - ((row.values[index] ?? 0) / max) * 172,
      }));
      const line = curvePath(smoothCurve(points));
      return { ...row, points, line, area: line ? `${line} L960,180 L0,180 Z` : "" };
    });
  }, [periods, series]);
  return (
    <View
      style={{ height }}
      accessible
      accessibilityLabel={`${label} over ${periods.length} periods`}
    >
      <Svg width="100%" height={height} viewBox="0 0 960 184" preserveAspectRatio="none">
        {paths.map((row) => (
          <Path key={`area:${row.id}`} d={row.area} fill={row.color} opacity={0.055} />
        ))}
        {paths.map((row) =>
          row.points.length === 1 ? (
            <Circle key={row.id} cx={480} cy={row.points[0]!.y} r={3} fill={row.color} />
          ) : (
            <Path key={row.id} d={row.line} fill="none" stroke={row.color} strokeWidth={2} />
          ),
        )}
      </Svg>
    </View>
  );
}
