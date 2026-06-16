// Downsample an already-sorted series to at most `maxPoints` evenly-spaced
// elements, always keeping the first and last (endpoints). Used by depth-limited
// providers (e.g. Alpha Vantage) so a sparse series still spans the full range.
export function spaceSeries<T>(points: T[], maxPoints: number): T[] {
  if (maxPoints <= 0) return [];
  if (points.length <= maxPoints) return points;
  if (maxPoints === 1) return [points[points.length - 1]];
  const n = points.length;
  const seen = new Set<number>();
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round((i * (n - 1)) / (maxPoints - 1));
    if (!seen.has(idx)) {
      seen.add(idx);
      out.push(points[idx]);
    }
  }
  return out;
}
