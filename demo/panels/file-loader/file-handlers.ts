export function buildFileSourceFromDisk(file: File): { src: string; label: string; shouldPreferClassification: boolean } {
  const nameLower = file.name.toLowerCase();
  const isCopc =
    nameLower.endsWith(".copc.laz") ||
    nameLower.endsWith(".copc") ||
    nameLower.includes(".copc.");
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const blob = URL.createObjectURL(file);
  const hint = isCopc ? "#.copc.laz"
    : (ext === "las" || ext === "laz" || ext === "pcd" || ext === "e57") ? `#.${ext}`
    : "";
  return {
    src: blob + hint,
    label: file.name,
    shouldPreferClassification: isCopc || ext === "las" || ext === "laz",
  };
}

export function colorByOptionTitle(key: string): string {
  switch (key) {
    case "classification":
      return "Classification (multi-color: ground=brown, vegetation=green, buildings=red)";
    case "intensity":
      return "Intensity (grey-scale: laser return strength)";
    case "return_num":
    case "returnNumber":
      return "Return number (1st, 2nd, 3rd return)";
    case "gps_time":
      return "GPS time (acquisition time)";
    case "z":
      return "Elevation (height along Z)";
    case "rgb":
      return "RGB combined (true colour)";
    case "red":
    case "green":
    case "blue":
      return "RGB (true colour channel)";
    default:
      return key;
  }
}
