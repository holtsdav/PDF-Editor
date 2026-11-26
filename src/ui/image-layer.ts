import type { NativePage } from '../compat/native-pdf';
import { screenRectangle } from '../compat/native-pdf';
import type { Rect } from '../pdf/text-engine';
import type { TextSession } from '../pdf/text-session';
import type { PdfImage } from '../pdf/image-engine';
import type { EditorTool } from './ink-layer';

export interface ImageOptions {
  tool(): EditorTool;
  selected(): string | undefined;
  select(id: string): void;
  /** Object URL for an image store key. */
  url(source: string): string;
  changed(): void;
  error(error: unknown): void;
}
type Point = [number, number];
type Corner = 'nw' | 'ne' | 'sw' | 'se';
interface Gesture {
  pointer: number;
  id: string;
  from: Point;
  to: Point;
  /** Corner kept in place while resizing (PDF points); undefined means moving. */
  anchor?: Point;
  free: boolean;
}

/** Pictures of one page as HTML images over the page, below text boxes and shapes. */
export class ImageLayer {
  readonly element: HTMLElement;
  private page: NativePage;
  private layer: HTMLElement;
  private session: TextSession;
  private options: ImageOptions;
  private gesture?: Gesture;
  private signature = '';
  private cleanups: (() => void)[] = [];

  constructor(page: NativePage, layer: HTMLElement, session: TextSession, options: ImageOptions) {
    this.page = page;
    this.layer = layer;
    this.session = session;
    this.options = options;
    const doc = layer.ownerDocument;
    this.element = doc.createElement('div');
    this.element.className = 'pfs-images';
    layer.prepend(this.element);
    const listen = <K extends keyof HTMLElementEventMap>(
      target: EventTarget,
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
    ) => {
      target.addEventListener(type, handler as EventListener);
      this.cleanups.push(() => target.removeEventListener(type, handler as EventListener));
    };
    listen(this.element, 'pointerdown', (event) => {
      const target = event.target as HTMLElement;
      const id = target.closest<HTMLElement>('[data-image-id]')?.dataset.imageId;
      if (this.options.tool() !== 'select' || event.button !== 0 || !id) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.options.select(id);
      const image = this.session.snapshot.images?.find((item) => item.id === id);
      if (!image || image.locked) {
        return; // Locked pictures can be selected (for the menu) but not changed.
      }
      const point = this.pdfPoint(event);
      const corner = target.dataset.corner as Corner | undefined;
      let anchor: Point | undefined;
      if (corner) {
        // Keep the corner farthest from the pressed handle in place.
        const [x0, y0, x1, y1] = image.box;
        anchor = [
          Math.abs(point[0] - x0) > Math.abs(point[0] - x1) ? x0 : x1,
          Math.abs(point[1] - y0) > Math.abs(point[1] - y1) ? y0 : y1,
        ];
      }
      this.gesture = {
        pointer: event.pointerId,
        id,
        from: point,
        to: point,
        ...(anchor ? { anchor } : {}),
        free: event.shiftKey,
      };
    });
    listen(doc, 'pointermove', (event) => {
      if (this.gesture?.pointer === event.pointerId) {
        this.gesture.to = this.pdfPoint(event);
        this.gesture.free = event.shiftKey;
        this.paint(true);
      }
    });
    listen(doc, 'pointerup', (event) => {
      const gesture = this.gesture;
      if (gesture?.pointer !== event.pointerId) {
        return;
      }
      this.gesture = undefined;
      gesture.to = this.pdfPoint(event);
      const box = this.transformed(gesture);
      const image = this.session.snapshot.images?.find((item) => item.id === gesture.id);
      if (box && image && box.some((value, index) => Math.abs(value - image.box[index]!) > 0.01)) {
        try {
          this.session.updateImage(gesture.id, { box });
          this.options.changed();
        } catch (error) {
          this.options.error(error);
        }
      }
      this.paint(true);
    });
    listen(doc, 'pointercancel', () => {
      this.gesture = undefined;
      this.paint(true);
    });
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
    this.element.remove();
  }

  get interacting(): boolean {
    return !!this.gesture;
  }

  update(page: NativePage, session: TextSession): void {
    this.page = page;
    this.session = session;
    if (!this.element.isConnected) {
      this.layer.prepend(this.element);
    }
    this.paint();
  }

  private pdfPoint(event: PointerEvent): Point {
    const box = this.layer.getBoundingClientRect();
    const { viewport } = this.page;
    const [x, y] = viewport.convertToPdfPoint(
      ((event.clientX - box.left) * viewport.width) / (box.width || viewport.width),
      ((event.clientY - box.top) * viewport.height) / (box.height || viewport.height),
    );
    return [x!, y!];
  }

  /** Box during a gesture, or undefined when it would leave the page. */
  private transformed(gesture: Gesture): Rect | undefined {
    const image = this.session.snapshot.images?.find((item) => item.id === gesture.id);
    if (!image) {
      return undefined;
    }
    const bounds = this.session.snapshot.pages[image.page - 1]!;
    const [x0, y0, x1, y1] = image.box;
    let box: Rect;
    if (!gesture.anchor) {
      // Move, sliding along the page edge instead of leaving it.
      const dx = Math.max(
        bounds[0] - x0,
        Math.min(bounds[2] - x1, gesture.to[0] - gesture.from[0]),
      );
      const dy = Math.max(
        bounds[1] - y0,
        Math.min(bounds[3] - y1, gesture.to[1] - gesture.from[1]),
      );
      box = [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
    } else {
      const [ax, ay] = gesture.anchor;
      let w = Math.abs(gesture.to[0] - ax);
      let h = Math.abs(gesture.to[1] - ay);
      if (!gesture.free) {
        // Keep the picture's proportions unless Shift is held.
        const scale = Math.max(w / (x1 - x0), h / (y1 - y0));
        w = (x1 - x0) * scale;
        h = (y1 - y0) * scale;
      }
      w = Math.max(4, w);
      h = Math.max(4, h);
      const left = gesture.to[0] < ax ? ax - w : ax;
      const bottom = gesture.to[1] < ay ? ay - h : ay;
      box = [left, bottom, left + w, bottom + h];
    }
    return box[0] >= bounds[0] - 0.01 &&
      box[1] >= bounds[1] - 0.01 &&
      box[2] <= bounds[2] + 0.01 &&
      box[3] <= bounds[3] + 0.01
      ? box
      : undefined;
  }

  paint(force = false): void {
    const images = (this.session.snapshot.images ?? []).filter(
      (image) => image.page === this.page.number,
    );
    const gesture = this.gesture;
    const { viewport } = this.page;
    const signature = JSON.stringify([
      images,
      this.options.selected(),
      gesture && this.transformed(gesture),
      viewport.width,
      viewport.height,
      viewport.rotation,
    ]);
    if (!force && signature === this.signature) {
      return;
    }
    this.signature = signature;
    const doc = this.element.ownerDocument;
    this.element.replaceChildren();
    for (const image of images) {
      const box = (gesture?.id === image.id ? this.transformed(gesture) : undefined) ?? image.box;
      this.element.append(this.picture(doc, image, box, viewport));
    }
  }

  private picture(
    doc: Document,
    image: PdfImage,
    box: Rect,
    viewport: NativePage['viewport'],
  ): HTMLElement {
    const [left, top, right, bottom] = screenRectangle(viewport, box);
    const frame = doc.createElement('div');
    frame.className = 'pfs-image';
    frame.dataset.imageId = image.id;
    const selected = this.options.selected() === image.id;
    frame.classList.toggle('is-selected', selected);
    frame.classList.toggle('is-locked', !!image.locked);
    const width = right - left;
    const height = bottom - top;
    Object.assign(frame.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    // Page rotation turns the picture clockwise; its own quarter turns are counter-clockwise.
    const turn = ((((viewport.rotation ?? 0) - (image.rotation ?? 0)) % 360) + 360) % 360;
    const sideways = turn === 90 || turn === 270;
    const picture = doc.createElement('img');
    picture.alt = '';
    picture.draggable = false;
    picture.src = this.options.url(image.source);
    Object.assign(picture.style, {
      width: `${sideways ? height : width}px`,
      height: `${sideways ? width : height}px`,
      transform: `translate(-50%, -50%) rotate(${turn}deg)`,
    });
    frame.append(picture);
    if (selected && !image.locked) {
      for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
        const handle = doc.createElement('div');
        handle.className = `pfs-image-handle is-${corner}`;
        handle.dataset.corner = corner;
        frame.append(handle);
      }
    }
    return frame;
  }
}
