/**
 * Writes that skip unchanged values. Chrome re-styles and repaints for every attribute
 * write, even one that sets the same value, and the editor refreshes several times per
 * click; on large PDFs those redundant writes made selecting and typing stutter.
 */
export function setAttr(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

export function setProp<
  T extends HTMLElement,
  K extends 'tabIndex' | 'readOnly' | 'disabled' | 'hidden',
>(element: T, key: K, value: K extends keyof T ? T[K] : never): void {
  const target = element as unknown as Record<string, unknown>;
  if (target[key] !== value) {
    target[key] = value;
  }
}

export function setText(element: Node, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

export function setStyle(element: HTMLElement, name: string, value: string): void {
  if (element.style.getPropertyValue(name) !== value) {
    element.style.setProperty(name, value);
  }
}
