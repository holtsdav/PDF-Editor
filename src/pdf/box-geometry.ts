import type { Rect } from './text-engine.ts';

export type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
const directions: Record<ResizeHandle, [number, number]> = {
  n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1]
};
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

/** Convert a handle on a rotated text box to the corresponding page-screen edges. */
export function rotatedHandle(handle: ResizeHandle, angle: number): ResizeHandle {
  const [x, y] = directions[handle];
  const radians = angle * Math.PI / 180;
  const a = Math.round(x * Math.cos(radians) - y * Math.sin(radians));
  const b = Math.round(x * Math.sin(radians) + y * Math.cos(radians));
  return Object.entries(directions).find(([, direction]) => direction[0] === a && direction[1] === b)![0] as ResizeHandle;
}

/** Move/resize within page bounds without changing the opposite resize edge. */
export function transformBox(rect: Rect, bounds: Rect, delta: [number, number], handle?: ResizeHandle, minimum: [number, number] = [40, 20]): Rect {
  const [dx, dy] = delta;
  if (!handle) {
    const x = clamp(dx, bounds[0] - rect[0], bounds[2] - rect[2]);
    const y = clamp(dy, bounds[1] - rect[1], bounds[3] - rect[3]);
    return [rect[0] + x, rect[1] + y, rect[2] + x, rect[3] + y];
  }
  const [x, y] = directions[handle];
  const result: Rect = [...rect];
  if (x < 0) result[0] = clamp(rect[0] + dx, bounds[0], rect[2] - Math.min(minimum[0], rect[2] - bounds[0]));
  if (x > 0) result[2] = clamp(rect[2] + dx, rect[0] + Math.min(minimum[0], bounds[2] - rect[0]), bounds[2]);
  if (y < 0) result[1] = clamp(rect[1] + dy, bounds[1], rect[3] - Math.min(minimum[1], rect[3] - bounds[1]));
  if (y > 0) result[3] = clamp(rect[3] + dy, rect[1] + Math.min(minimum[1], bounds[3] - rect[1]), bounds[3]);
  return result;
}

/** Grow in the text's local downward direction, even on quarter-turned pages. */
export function growBox(rect: Rect, bounds: Rect, height: number, angle: number): Rect {
  const result: Rect = [...rect];
  switch ((angle % 360 + 360) % 360) {
    case 0: result[3] = Math.min(bounds[3], Math.max(rect[3], rect[1] + height)); break;
    case 90: result[0] = Math.max(bounds[0], Math.min(rect[0], rect[2] - height)); break;
    case 180: result[1] = Math.max(bounds[1], Math.min(rect[1], rect[3] - height)); break;
    case 270: result[2] = Math.min(bounds[2], Math.max(rect[2], rect[0] + height)); break;
  }
  return result;
}
