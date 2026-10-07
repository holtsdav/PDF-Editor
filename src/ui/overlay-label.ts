const labels = new WeakMap<HTMLElement, HTMLSpanElement>();

/** Keep PDF overlay controls named for assistive technology without Obsidian's aria-label hover tooltip. */
export function labelOverlay(element: HTMLElement, text: string): void {
  let label = labels.get(element);
  if (!label) {
    label = element.ownerDocument.createElement('span');
    label.hidden = true;
    label.id = `pfs-overlay-label-${globalThis.crypto.randomUUID()}`;
    const host = element.matches('input, textarea') ? element.parentElement : element;
    if (!host) throw new Error('PDF overlay control must be attached before labeling.');
    host.append(label);
    labels.set(element, label);
    element.setAttribute('aria-labelledby', label.id);
  }
  label.textContent = text;
  element.removeAttribute('aria-label');
  element.removeAttribute('title');
}

export function labelSvgOverlay(element: SVGElement, host: HTMLElement, text: string): () => void {
  const label = element.ownerDocument.createElement('span');
  label.hidden = true;
  label.id = `pfs-overlay-label-${globalThis.crypto.randomUUID()}`;
  label.textContent = text;
  host.append(label);
  element.setAttribute('aria-labelledby', label.id);
  element.removeAttribute('aria-label');
  element.removeAttribute('title');
  return () => label.remove();
}
