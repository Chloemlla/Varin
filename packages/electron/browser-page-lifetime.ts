/** Presentation is not ownership. A parked page remains available but its normal
 * Chromium scheduler can sleep, except while a real surface operation needs it. */
export class BrowserPageActivity {
  private visible = false;
  private operations = 0;
  private throttled = false; // creation/first blank navigation is foreground work
  constructor(private readonly setThrottled: (throttled: boolean) => void) {}
  present(visible: boolean) { this.visible = visible; this.sync(); }
  hold() {
    this.operations++; this.sync();
    let held = true;
    return () => { if (held) { held = false; this.operations--; this.sync(); } };
  }
  async during<T>(work: () => Promise<T>): Promise<T> {
    const release = this.hold();
    try { return await work(); } finally { release(); }
  }
  private sync() {
    const next = !this.visible && !this.operations;
    if (next !== this.throttled) { this.setThrottled(next); this.throttled = next; }
  }
}

/** Stable identity for live AX nodes. Frame-local snapshot coverage matters:
 * an interesting-only or subtree snapshot cannot invalidate unrelated nodes. */
export class BrowserFrameReferences<F extends object, N> {
  private ids = new Map<string, { frame: F; key: string; node: N; interesting: boolean }>();
  private byFrame = new Map<F, Map<string, string>>();
  private documents = new WeakMap<F, string>();
  constructor(private readonly newId: () => string) {}
  observeDocument(frame: F, loaderId: string) {
    if (this.documents.get(frame) === loaderId) return;
    this.retire(frame);
    this.documents.set(frame, loaderId);
  }
  get(ref: string) { return this.ids.get(ref); }
  record(frame: F, key: string, node: N, interesting: boolean) {
    let index = this.byFrame.get(frame);
    if (!index) { index = new Map(); this.byFrame.set(frame, index); }
    const ref = index.get(key) ?? this.newId();
    index.set(key, ref);
    this.ids.set(ref, { frame, key, node, interesting: interesting || Boolean(this.ids.get(ref)?.interesting) });
    return ref;
  }
  finish(frame: F, seen: Set<string>, fullTree: boolean) {
    const index = this.byFrame.get(frame);
    if (!index) return;
    for (const [key, ref] of index) if (!seen.has(key) && (fullTree || this.ids.get(ref)?.interesting)) {
      index.delete(key); this.ids.delete(ref);
    }
    if (!index.size) this.byFrame.delete(frame);
  }
  retire(frame: F) {
    for (const ref of this.byFrame.get(frame)?.values() ?? []) this.ids.delete(ref);
    this.byFrame.delete(frame);
    this.documents.delete(frame);
  }
}
