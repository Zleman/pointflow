export function getRenderAdvantagePercent(leftRendered: number, rightRendered: number): string | null {
  if (leftRendered <= 0) return null;
  return ((rightRendered / leftRendered) * 100 - 100).toFixed(0);
}
