interface ZoomInput {
  zoom(factor: number, x: number, y: number): void;
  interrupt(): void;
  verticalBounds?(): [number, number] | undefined;
}

/** Normalize pixel, line and page wheel deltas into CSS pixels. */
export function wheelPixels(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>,
  height: number,
  lineHeight = 16,
): [number, number] {
  const unit = event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? height : 1;
  return [event.deltaX * unit, event.deltaY * unit];
}

/** Route each vertical delta once, including the remainder when a wheel sequence reaches an edge. */
export function scrollHandoff(
  scroller: HTMLElement,
  target: EventTarget | null,
  dx: number,
  dy: number,
  bounds?: [number, number],
): void {
  const win = scroller.ownerDocument.defaultView!;
  // Horizontal input stays local to the PDF. Vertical leftovers walk the real note ancestor chain.
  scroller.scrollLeft = Math.max(
    0,
    Math.min(scroller.scrollWidth - scroller.clientWidth, scroller.scrollLeft + dx),
  );
  let element = target instanceof win.HTMLElement && scroller.contains(target) ? target : scroller;
  while (element && Math.abs(dy) > 0.001) {
    const style = win.getComputedStyle(element);
    if (element === scroller || /(auto|scroll|overlay)/.test(style.overflowY)) {
      const before = element.scrollTop;
      const [minimum, maximum] =
        element === scroller && bounds
          ? bounds
          : [0, Math.max(0, element.scrollHeight - element.clientHeight)];
      if (maximum > minimum && (dy > 0 ? before < maximum : before > minimum)) {
        element.scrollTop =
          dy > 0 ? Math.min(maximum, before + dy) : Math.max(minimum, before + dy);
      }
      dy -= element.scrollTop - before;
    }
    const parent = element.parentElement;
    if (!parent) {
      break;
    }
    element = parent;
  }
}

/** Chromium trackpad pinches arrive as Ctrl+wheel; two-touch pinches use their midpoint. */
export function bindSurfaceInput(scroller: HTMLElement, input: ZoomInput): () => void {
  const win = scroller.ownerDocument.defaultView!;
  let pinch: { distance: number } | undefined;
  let suppressWheelUntil = 0;
  const events: (() => void)[] = [];
  const listen = (
    target: EventTarget,
    type: string,
    fn: EventListener,
    options?: AddEventListenerOptions | boolean,
  ) => {
    target.addEventListener(type, fn, options);
    events.push(() => target.removeEventListener(type, fn, options));
  };
  const stop = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  listen(
    win,
    'wheel',
    ((raw) => {
      const event = raw as WheelEvent;
      if (
        !(event.target instanceof win.Node) ||
        !scroller.contains(event.target) ||
        event.defaultPrevented ||
        !event.cancelable
      ) {
        return;
      }
      const line = Number.parseFloat(win.getComputedStyle(scroller).lineHeight) || 16;
      const [dx, dy] = wheelPixels(event, scroller.clientHeight, line);
      if (![dx, dy].every(Number.isFinite)) {
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        stop(event);
        if (!pinch && win.performance.now() >= suppressWheelUntil) {
          input.interrupt();
          input.zoom(
            Math.exp(-Math.max(-200, Math.min(200, dy)) * 0.003),
            event.clientX,
            event.clientY,
          );
        }
        return;
      }
      if (pinch) {
        stop(event);
        return;
      }
      // Preserve native horizontal wheel behavior and Shift+wheel translation.
      if (event.shiftKey || Math.abs(dx) > Math.abs(dy) || dy === 0) {
        return;
      }
      stop(event);
      scrollHandoff(scroller, event.target, dx, dy, input.verticalBounds?.());
    }) as EventListener,
    { capture: true, passive: false },
  );
  const touches = (event: TouchEvent) => {
    const a = event.touches[0]!;
    const b = event.touches[1]!;
    return {
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2,
    };
  };
  listen(
    scroller,
    'touchstart',
    ((raw) => {
      const event = raw as TouchEvent;
      if (event.touches.length !== 2 || !event.cancelable) {
        return;
      }
      stop(event);
      input.interrupt();
      const point = touches(event);
      if (point.distance > 0) {
        pinch = { distance: point.distance };
      }
    }) as EventListener,
    { capture: true, passive: false },
  );
  listen(
    scroller,
    'touchmove',
    ((raw) => {
      const event = raw as TouchEvent;
      if (!pinch || event.touches.length !== 2 || !event.cancelable) {
        return;
      }
      stop(event);
      const point = touches(event);
      if (point.distance > 0) {
        input.zoom(point.distance / pinch.distance, point.x, point.y);
        pinch.distance = point.distance;
      }
    }) as EventListener,
    { capture: true, passive: false },
  );
  const reset = () => {
    if (pinch) {
      suppressWheelUntil = win.performance.now() + 150;
    }
    pinch = undefined;
  };
  listen(scroller, 'touchend', reset);
  listen(scroller, 'touchcancel', reset);
  listen(win, 'blur', reset);
  listen(win, 'keydown', ((raw) => {
    if ((raw as KeyboardEvent).key === 'Escape') {
      reset();
    }
  }) as EventListener);
  return () => {
    reset();
    for (const dispose of events) {
      dispose();
    }
  };
}
