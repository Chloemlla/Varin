/** Notifications invalidate a read. While it is running, remember one further
 * pass without attaching another callback or losing a wake at settlement. */
export function createResearchScan(scan: () => Promise<void>, stopped: () => boolean, report: (error: unknown) => void) {
  let pending = false;
  let flight: Promise<void> | undefined;
  function request(): Promise<void> {
    if (stopped()) return Promise.resolve();
    pending = true;
    return flight ??= Promise.resolve().then(async () => {
      try {
        while (pending && !stopped()) {
          pending = false;
          try { await scan(); } catch (error) { if (!stopped()) report(error); }
        }
      } finally { flight = undefined; }
    });
  }
  return { request, get pending() { return pending; }, get flight() { return flight; } };
}
