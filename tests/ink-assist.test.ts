import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import {
  DrawHold,
  recognizeShape,
  resampleInk,
  smoothInk,
  levelPolygon,
} from '../src/pdf/ink-assist.ts';
import { readTextPdf } from '../src/pdf/text-engine.ts';
import { TextSession } from '../src/pdf/text-session.ts';
import type { Point } from '../src/pdf/ink-engine.ts';
import { HeldShape } from '../src/pdf/held-shape.ts';

const shapes: Record<string, Point[]> = {
  line: [
    [0, 0],
    [20, 1],
    [50, -1],
    [100, 0],
  ],
  rectangle: [
    [0, 0],
    [100, 0],
    [100, 70],
    [0, 70],
    [0, 0],
  ],
  triangle: [
    [0, 0],
    [50, 90],
    [100, 0],
    [0, 0],
  ],
  arrow: [
    [0, 0],
    [100, 0],
    [80, -20],
    [100, 0],
    [80, 20],
  ],
  ellipse: Array.from({ length: 97 }, (_, i) => [
    60 + 50 * Math.cos((i / 96) * Math.PI * 2),
    80 + 30 * Math.sin((i / 96) * Math.PI * 2),
  ]),
};
test('rough drawn loops tolerate rounded corners, imperfect closure and short finishing tails', async () => {
  // Position-normalized geometry from the anonymous development worksheet.
  // These strokes were rejected by 0.7.0 despite passing ideal-shape tests.
  const samples = JSON.parse(
    await readFile(new URL('./fixtures/rough-shapes.json', import.meta.url), 'utf8'),
  ) as { kind: string; points: Point[] }[];
  for (const [i, sample] of samples.entries()) {
    for (const scale of [0.6, 1, 3]) {
      for (const angle of [0, 0.4, 1.57, 2.3]) {
        const points = sample.points.map(
          ([x, y]) =>
            [
              200 + scale * (x * Math.cos(angle) - y * Math.sin(angle)),
              200 + scale * (x * Math.sin(angle) + y * Math.cos(angle)),
            ] as Point,
        );
        assert.equal(
          recognizeShape(points)?.kind,
          sample.kind,
          `sample ${i}, scale ${scale}, rotation ${angle}`,
        );
        assert.equal(
          recognizeShape([...points].reverse())?.kind,
          sample.kind,
          `reversed sample ${i}`,
        );
        const result = recognizeShape(points)!;
        assert(result.points.every((p) => p.every(Number.isFinite)));
        assert.deepEqual(result.points[0], result.points.at(-1));
      }
    }
  }
});
test('shape fitting handles rotated, reversed and unevenly sampled diagrams', () => {
  for (const [kind, source] of Object.entries(shapes)) {
    for (const angle of [0, 0.37, Math.PI / 2, 2.4]) {
      const points = resampleInk(source, 2).map(
        ([x, y], i) =>
          [
            300 + x * Math.cos(angle) - y * Math.sin(angle) + Math.sin(i) * 0.15,
            300 + x * Math.sin(angle) + y * Math.cos(angle) + Math.cos(i) * 0.15,
          ] as Point,
      );
      assert.equal(recognizeShape(points)?.kind, kind, `${kind} at ${angle}`);
      if (kind !== 'arrow') {
        assert.equal(recognizeShape([...points].reverse())?.kind, kind);
      }
      const uneven = points.flatMap((p, i) => (i % 7 === 0 ? [p, p, p, p, p] : [p]));
      assert.equal(recognizeShape(uneven)?.kind, kind);
    }
  }
});
test('shape fitting rejects letters, open loops, spirals, retracing, tiny taps and ambiguous scribbles', () => {
  const negatives: Point[][] = [
    [],
    [[1, 1]],
    [
      [0, 0],
      [2, 1],
    ],
    [
      [0, 0],
      [0, 60],
      [25, 25],
      [50, 60],
      [50, 0],
    ],
    [
      [0, 0],
      [50, 70],
      [0, 70],
      [50, 0],
    ],
    [
      [0, 0],
      [100, 0],
      [0, 0],
      [100, 0],
    ],
    shapes.ellipse!.slice(0, 65),
    Array.from({ length: 100 }, (_, i) => [
      i * Math.cos((i / 99) * Math.PI * 4),
      i * Math.sin((i / 99) * Math.PI * 4),
    ]),
  ];
  for (const points of negatives) {
    assert.equal(recognizeShape(points), null, JSON.stringify(points.slice(0, 4)));
  }
});
test('highlighter hold straightens a wavy stroke while respecting its actual endpoints and angle', () => {
  const points: Point[] = [
    [10, 20],
    [30, 22],
    [60, 30],
    [90, 26],
    [150, 35],
  ];
  assert.deepEqual(recognizeShape(points, true)?.points, [points[0], points.at(-1)]);
  assert.equal(
    recognizeShape(
      [
        [1, 1],
        [2, 2],
      ],
      true,
    ),
    null,
  );
});
test('hold tolerates small jitter but movement restarts the dwell interval', () => {
  const hold = new DrawHold();
  hold.update([0, 0], 0, 2.5);
  assert(!hold.ready(649));
  hold.update([1, 1], 500, 2.5);
  assert(hold.ready(650));
  hold.update([10, 0], 700, 2.5);
  assert(!hold.ready(1200));
  assert(hold.ready(1350));
});
test('smooth ink reduces alternating jitter, keeps endpoints and never changes disabled or tap input', () => {
  const jitter: Point[] = Array.from({ length: 120 }, (_, i) => [
    i,
    i === 0 || i === 119 ? 0 : i % 2 ? 1 : -1,
  ]);
  const smooth = smoothInk(jitter, true);
  assert.deepEqual(smooth[0], jitter[0]);
  assert.deepEqual(smooth.at(-1), jitter.at(-1));
  assert(smooth.reduce((sum, p) => sum + p[1] ** 2, 0) / smooth.length < 0.45);
  assert.deepEqual(smoothInk(jitter, false), jitter);
  assert.deepEqual(smoothInk([[4, 7]], true), [[4, 7]]);
  assert(smooth.every((p) => p.every(Number.isFinite)));
  assert(smooth.every((p) => p[0] >= 0 && p[0] <= 119));
});
test('assisted ink remains editable standard ink with the same geometry after saving and reopening', async () => {
  const font = new Uint8Array(
    await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
  );
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  let bytes = await pdf.save();
  const session = await TextSession.open(
    {
      read: async () => bytes,
      write: async (b) => {
        bytes = b;
      },
      backup: async () => 'original.pdf',
    },
    font,
  );
  const input: Point[] = Array.from({ length: 60 }, (_, i) => [
    50 + i,
    100 + Math.sin(i / 8) * 25 + Math.sin(i) * 2,
  ]);
  const smooth = smoothInk(input, true);
  const shape = recognizeShape(shapes.ellipse!)!;
  session.addStroke(1, 'scribble', smooth, 2);
  session.addStroke(1, 'scribble', shape.points, 2);
  await session.save();
  const reopened = await readTextPdf(bytes);
  assert.equal(reopened.strokes.length, 2);
  for (const [i, points] of [smooth, shape.points].entries()) {
    assert.equal(reopened.strokes[i]!.points.length, points.length);
    reopened.strokes[i]!.points.forEach((point, j) =>
      assert(Math.hypot(point[0] - points[j]![0], point[1] - points[j]![1]) < 0.02),
    );
  }
});

test('near-circular loops become exact circles, distinct from elongated ellipses', () => {
  for (const ratio of [1, 1.1, 1.2]) {
    const points: Point[] = Array.from({ length: 97 }, (_, i) => [
      200 + 50 * Math.cos((i / 96) * Math.PI * 2),
      200 + (50 / ratio) * Math.sin((i / 96) * Math.PI * 2),
    ]);
    const shape = recognizeShape(points)!;
    assert.equal(shape.kind, 'circle');
    const center: Point = [
      (Math.min(...shape.points.map((p) => p[0])) + Math.max(...shape.points.map((p) => p[0]))) / 2,
      (Math.min(...shape.points.map((p) => p[1])) + Math.max(...shape.points.map((p) => p[1]))) / 2,
    ];
    const radii = shape.points.map(([x, y]) => Math.hypot(x - center[0], y - center[1]));
    assert(Math.max(...radii) - Math.min(...radii) < 0.001);
  }
  assert.equal(
    recognizeShape(
      Array.from({ length: 97 }, (_, i) => [
        200 + 80 * Math.cos((i / 96) * Math.PI * 2),
        200 + 30 * Math.sin((i / 96) * Math.PI * 2),
      ]),
    )?.kind,
    'ellipse',
  );
});
test('held line endpoint follows movement, stays snapped and reverses without accumulated drift', () => {
  const base = {
    kind: 'line' as const,
    points: [
      [30, 40],
      [120, 80],
    ] as Point[],
  };
  const hold = new HeldShape(base, [120, 80]);
  assert.deepEqual(hold.resize([200, 150], [0, 0, 600, 800]).points, [
    [30, 40],
    [200, 150],
  ]);
  for (let i = 0; i < 1000; i++) {
    hold.resize([120 + (i % 300), 100], [0, 0, 600, 800]);
  }
  assert.deepEqual(hold.resize([120, 80], [0, 0, 600, 800]), base);
});
test('held closed shapes resize in both directions and stay inside the page without changing kind', () => {
  const inputs: Point[][] = [
    [
      [100, 100],
      [220, 100],
      [220, 200],
      [100, 200],
      [100, 100],
    ],
    [
      [100, 100],
      [180, 220],
      [240, 100],
      [100, 100],
    ],
    Array.from({ length: 97 }, (_, i) => [
      200 + 60 * Math.cos((i / 96) * Math.PI * 2),
      200 + 60 * Math.sin((i / 96) * Math.PI * 2),
    ]),
    Array.from({ length: 97 }, (_, i) => [
      200 + 80 * Math.cos((i / 96) * Math.PI * 2),
      200 + 30 * Math.sin((i / 96) * Math.PI * 2),
    ]),
    [
      [100, 100],
      [220, 100],
      [190, 80],
      [220, 100],
      [190, 120],
    ],
  ];
  for (const points of inputs) {
    const shape = recognizeShape(points)!;
    const pointer = points.at(-1)!;
    const hold = new HeldShape(shape, pointer);
    for (const delta of [
      [50, 40],
      [-50, -30],
      [2000, 2000],
      [-2000, -2000],
    ]) {
      const resized = hold.resize(
        [pointer[0] + delta[0]!, pointer[1] + delta[1]!],
        [0, 0, 600, 800],
      );
      assert.equal(resized.kind, shape.kind);
      assert.notDeepEqual(resized.points, shape.points);
      assert(
        resized.points.every(
          ([x, y]) =>
            Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 600 && y >= 0 && y <= 800,
        ),
      );
      if (shape.kind !== 'arrow') {
        assert.deepEqual(resized.points[0], resized.points.at(-1));
      }
    }
    assert.deepEqual(hold.resize(pointer, [0, 0, 600, 800]).points, shape.points);
  }
});

test('near-level polygons snap to exact page axes and stay level while held; intentional rotations remain', () => {
  for (const kind of ['rectangle', 'triangle'] as const) {
    for (const degrees of [-7, -3, 3, 7, 87, 93, 15, 35]) {
      const vertices: Point[] =
        kind === 'rectangle'
          ? [
              [-70, -30],
              [70, -30],
              [70, 30],
              [-70, 30],
              [-70, -30],
            ]
          : [
              [-70, -30],
              [70, -30],
              [0, 65],
              [-70, -30],
            ];
      const angle = (degrees * Math.PI) / 180;
      const points = vertices.map<Point>(([x, y]) => [
        200 + x * Math.cos(angle) - y * Math.sin(angle),
        200 + x * Math.sin(angle) + y * Math.cos(angle),
      ]);
      const shape = levelPolygon({ kind, points });
      const near = Math.abs(degrees) <= 7 || Math.abs(degrees - 90) <= 7;
      const axisEdge = (input: Point[]) =>
        input
          .slice(1)
          .some(
            (p, i) => Math.min(Math.abs(p[0] - input[i]![0]), Math.abs(p[1] - input[i]![1])) < 1e-8,
          );
      assert.equal(axisEdge(shape.points), near, `${kind} ${degrees}`);
      if (near) {
        const held = new HeldShape(shape, shape.points.at(-1)!);
        assert(
          axisEdge(
            held.resize([shape.points[0]![0] + 40, shape.points[0]![1] + 30], [0, 0, 600, 800])
              .points,
          ),
        );
      } else {
        assert.deepEqual(shape.points, points);
      }
    }
  }
});

test('recognition itself levels slightly tilted rectangles and triangles', () => {
  for (const input of [
    [
      [100, 100],
      [250, 100],
      [250, 180],
      [100, 180],
      [100, 100],
    ],
    [
      [100, 100],
      [260, 100],
      [180, 220],
      [100, 100],
    ],
  ] as Point[][]) {
    const angle = (4 * Math.PI) / 180;
    const shape = recognizeShape(
      input.map<Point>(([x, y]) => [
        200 + (x - 180) * Math.cos(angle) - (y - 150) * Math.sin(angle),
        200 + (x - 180) * Math.sin(angle) + (y - 150) * Math.cos(angle),
      ]),
    )!;
    assert(shape.kind === 'rectangle' || shape.kind === 'triangle');
    assert(shape.points.slice(1).some((p, i) => Math.abs(p[1] - shape.points[i]![1]) < 1e-8));
  }
});
