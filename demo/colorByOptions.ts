export function colorByKeysFromAttributes(availableAttributes: string[] | null): string[] {
  if (availableAttributes === null) return [];
  if (availableAttributes.length === 0) return ["z"];
  const hasRgb =
    availableAttributes.includes("red") &&
    availableAttributes.includes("green") &&
    availableAttributes.includes("blue");
  const filtered = availableAttributes.filter(
    (k) => (k === "red" || k === "green" || k === "blue") ? hasRgb : true
  );
  if (hasRgb && !filtered.includes("rgb")) filtered.unshift("rgb");
  return filtered.includes("z") ? filtered : ["z", ...filtered];
}
