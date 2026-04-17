export function lasPointDataFormatId(rawByteAt104: number): number {
  return rawByteAt104 & 0x3f;
}
