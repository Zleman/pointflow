export function runDeferredRefresh(refresh: () => void): void {
  setTimeout(() => { refresh(); }, 0);
}
