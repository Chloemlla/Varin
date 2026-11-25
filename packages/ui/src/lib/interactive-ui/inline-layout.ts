// One layout clock per scrolling timeline. Only anchors intersecting its viewport
// need to move with text deltas. The iframe itself remains mounted when parked.
type Reader = () => void;
const roots = new WeakMap<Element, ReturnType<typeof createClock>>();

function createClock(root: Element) {
  let frame: number | undefined;
  const visible = new Set<Reader>();
  const schedule = () => {
    if (frame !== undefined || !visible.size) return;
    frame = requestAnimationFrame(() => { frame = undefined; for (const read of visible) read(); });
  };
  const anchors = new Map<Element, Reader>();
  const sizes = new Map<Element, number>();
  const resize = new ResizeObserver(schedule), mutation = new MutationObserver(schedule);
  mutation.observe(root, { subtree: true, childList: true, characterData: true, attributes: root !== document.body });
  const intersection = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const read = anchors.get(entry.target);
      if (!read) continue;
      if (entry.isIntersecting) visible.add(read);
      else { visible.delete(read); read(); } // Update visibility once as it leaves.
    }
    schedule();
  }, { root }) : undefined;
  window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
  return (anchor: Element, elements: Set<Element>, read: Reader): (() => void) => {
    anchors.set(anchor, read); visible.add(read); intersection?.observe(anchor);
    for (const node of elements) {
      const count = sizes.get(node) ?? 0;
      if (!count) resize.observe(node);
      sizes.set(node, count + 1);
    }
    return () => {
      visible.delete(read); anchors.delete(anchor); intersection?.unobserve(anchor);
      for (const node of elements) {
        const count = sizes.get(node)! - 1;
        if (count) sizes.set(node, count);
        else { sizes.delete(node); resize.unobserve(node); }
      }
      if (anchors.size) return;
      intersection?.disconnect(); resize.disconnect(); mutation.disconnect();
      window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
      roots.delete(root);
    };
  };
}
export function observeInlineLayout(element: HTMLElement, view: HTMLElement, boundary: HTMLElement, read: Reader) {
  const elements = new Set<Element>([element, view, boundary]);
  let root = element.parentElement ?? boundary;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    elements.add(parent);
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) { root = parent; break; }
  }
  let clock = roots.get(root);
  if (!clock) { clock = createClock(root); roots.set(root, clock); }
  return clock(element, elements, read);
}
