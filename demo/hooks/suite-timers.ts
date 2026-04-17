import type { MutableRefObject } from "react";

export function clearSuiteTimers(params: {
  suiteManualTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  suiteCountdownIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  setSuiteManualCountdownSec: (value: number | null) => void;
}): void {
  const { suiteManualTimerRef, suiteCountdownIntervalRef, setSuiteManualCountdownSec } = params;
  if (suiteManualTimerRef.current) {
    clearTimeout(suiteManualTimerRef.current);
    suiteManualTimerRef.current = null;
  }
  if (suiteCountdownIntervalRef.current) {
    clearInterval(suiteCountdownIntervalRef.current);
    suiteCountdownIntervalRef.current = null;
  }
  setSuiteManualCountdownSec(null);
}

export function startSuiteManualCountdown(params: {
  durationSec: number;
  suiteCountdownIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  suiteManualCountdownSecRef: MutableRefObject<number | null>;
  setSuiteManualCountdownSec: (value: number | null) => void;
  dispatchCountdownTick: (value: number) => void;
}): void {
  const {
    durationSec,
    suiteCountdownIntervalRef,
    suiteManualCountdownSecRef,
    setSuiteManualCountdownSec,
    dispatchCountdownTick,
  } = params;
  if (durationSec <= 0) return;
  setSuiteManualCountdownSec(durationSec);
  if (suiteCountdownIntervalRef.current) clearInterval(suiteCountdownIntervalRef.current);
  suiteCountdownIntervalRef.current = setInterval(() => {
    const prev = suiteManualCountdownSecRef.current;
    if (prev === null || prev <= 1) {
      if (suiteCountdownIntervalRef.current) {
        clearInterval(suiteCountdownIntervalRef.current);
        suiteCountdownIntervalRef.current = null;
      }
      dispatchCountdownTick(0);
    } else {
      dispatchCountdownTick(prev - 1);
    }
  }, 1000);
}
