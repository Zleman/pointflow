/** Returns true when the point count just dropped to zero — used to detect a buffer reset between frames. */
export function isResetTransition(prevTotalPoints: number, currentTotalPoints: number): boolean {
  return prevTotalPoints > 0 && currentTotalPoints === 0;
}
