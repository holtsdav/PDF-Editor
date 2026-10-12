import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { bindSurfaceInput, scrollHandoff, wheelPixels } from '../src/ui/surface-input.ts';

/** Bind real input routing to a disposable nested PDF/note DOM with controlled scroll ranges. */
function fixture() {
  const dom = new JSDOM('<main style="overflow-y:auto"><div class="pdf" style="overflow-y:auto"><div id="page"></div></div></main>', { pretendToBeVisual: true });
  const doc = dom.window.document, note = doc.querySelector<HTMLElement>('main')!, pdf = doc.querySelector<HTMLElement>('.pdf')!, page = doc.querySelector<HTMLElement>('#page')!;
  Object.defineProperties(note, { clientHeight: { value: 300 }, scrollHeight: { value: 1800 } });
  Object.defineProperties(pdf, { clientHeight: { value: 400 }, scrollHeight: { value: 1200, configurable: true }, clientWidth: { value: 600 }, scrollWidth: { value: 1000 } });
  const zooms: number[][] = [], actions: string[] = []; let interrupts = 0, bubbled = 0;
  note.addEventListener('wheel', () => bubbled++);
  const stop = bindSurfaceInput(pdf, { zoom: (...values) => { actions.push('zoom'); zooms.push(values); }, interrupt: () => { actions.push('interrupt'); interrupts++; } });
  const wheel = (dy: number, dx = 0, extra: WheelEventInit = {}) => {
    const event = new dom.window.WheelEvent('wheel', { deltaY: dy, deltaX: dx, bubbles: true, cancelable: true, ...extra }); page.dispatchEvent(event); return event;
  };
  const touch = (type: string, points: [number, number][]) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) }); pdf.dispatchEvent(event); return event;
  };
  return { dom, doc, note, pdf, page, wheel, touch, zooms, actions, stop, interrupts: () => interrupts, bubbled: () => bubbled, dispose: () => { stop(); dom.window.close(); } };
}

test('one continuing wheel sequence hands only its remaining delta to the note at either PDF boundary', () => {
  const f = fixture(); try {
    f.note.scrollTop = 500; f.pdf.scrollTop = 10;
    assert(f.wheel(-30).defaultPrevented); assert.equal(f.pdf.scrollTop, 0); assert.equal(f.note.scrollTop, 480);
    for (const dy of [-8, -5, -2, -1]) f.wheel(dy); assert.equal(f.note.scrollTop, 464);
    f.wheel(12); assert.equal(f.pdf.scrollTop, 12); assert.equal(f.note.scrollTop, 464);
    f.pdf.scrollTop = 790; f.wheel(30); assert.equal(f.pdf.scrollTop, 800); assert.equal(f.note.scrollTop, 484);
    f.wheel(15); assert.equal(f.note.scrollTop, 499); assert.equal(f.bubbled(), 0);
  } finally { f.dispose(); }
});

test('zoom anchor margins do not create vertical wheel traps or jumps outside actual PDF bounds', () => {
  const f = fixture(); try {
    f.note.scrollTop = 100; f.pdf.scrollTop = 200;
    scrollHandoff(f.pdf, f.page, 0, -25, [400, 800]); assert.equal(f.pdf.scrollTop, 200); assert.equal(f.note.scrollTop, 75);
    scrollHandoff(f.pdf, f.page, 0, 10, [400, 800]); assert.equal(f.pdf.scrollTop, 210); assert.equal(f.note.scrollTop, 75);
    scrollHandoff(f.pdf, f.page, 0, 20, [400, 400]); assert.equal(f.pdf.scrollTop, 210); assert.equal(f.note.scrollTop, 95);
    f.pdf.scrollTop = 900; scrollHandoff(f.pdf, f.page, 0, 10, [400, 800]); assert.equal(f.note.scrollTop, 105); assert.equal(f.pdf.scrollTop, 900);
  } finally { f.dispose(); }
});

test('a PDF without a vertical range scrolls the note; horizontal, Shift and nested text scrolling stay usable', () => {
  const f = fixture(); try {
    Object.defineProperty(f.pdf, 'scrollHeight', { value: 400 }); f.note.scrollTop = 100; f.wheel(-25); assert.equal(f.note.scrollTop, 75);
    assert.equal(f.wheel(0, 40).defaultPrevented, false); assert.equal(f.wheel(30, 0, { shiftKey: true }).defaultPrevented, false);
    const text = f.doc.createElement('textarea'); text.style.overflowY = 'auto'; f.page.append(text);
    Object.defineProperties(text, { clientHeight: { value: 40 }, scrollHeight: { value: 100 } });
    text.dispatchEvent(new f.dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 10 }));
    assert.equal(text.scrollTop, 10); assert.equal(f.note.scrollTop, 75);
    assert.deepEqual(wheelPixels({ deltaX: 2, deltaY: -1, deltaMode: 1 }, 400), [32, -16]);
    assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 400), [0, 400]);
  } finally { f.dispose(); }
});

test('Cmd and Ctrl wheel zoom own only their PDF window, reverse smoothly and never scroll the note', () => {
  const f = fixture(); try {
    f.note.scrollTop = 200;
    for (const extra of [{ metaKey: true }, { ctrlKey: true }]) {
      assert(f.wheel(-20, 0, { ...extra, clientX: 75, clientY: 125 }).defaultPrevented);
      f.wheel(20, 0, extra);
    }
    assert.equal(f.zooms.length, 4); assert(Math.abs(f.zooms[0]![0]! * f.zooms[1]![0]! - 1) < 1e-8);
    assert.deepEqual(f.actions, Array.from({ length: 4 }, () => ['interrupt', 'zoom']).flat());
    assert.deepEqual(f.zooms[0]!.slice(1), [75, 125]); assert.equal(f.note.scrollTop, 200); assert.equal(f.pdf.scrollTop, 0);
    f.note.dispatchEvent(new f.dom.window.WheelEvent('wheel', { ctrlKey: true, bubbles: true, cancelable: true, deltaY: -20 })); assert.equal(f.zooms.length, 4);
    assert.equal(f.interrupts(), 4);
    f.stop(); assert.equal(f.wheel(-20, 0, { ctrlKey: true }).defaultPrevented, false);
  } finally { f.dispose(); }
});

test('two-touch pinch uses its midpoint, cancels editing gestures, ignores overlapping wheel and releases on interruption', () => {
  const f = fixture(); try {
    f.touch('touchstart', [[10, 20], [110, 20]]); assert.equal(f.interrupts(), 1);
    assert(f.touch('touchmove', [[0, 20], [120, 20]]).defaultPrevented);
    assert.deepEqual(f.zooms[0], [1.2, 60, 20]);
    f.wheel(-100, 0, { ctrlKey: true }); assert.equal(f.zooms.length, 1);
    assert.equal(f.interrupts(), 1);
    f.dom.window.dispatchEvent(new f.dom.window.Event('blur')); f.touch('touchmove', [[0, 0], [150, 0]]); assert.equal(f.zooms.length, 1);
    f.wheel(-100, 0, { metaKey: true }); assert.equal(f.zooms.length, 1); assert.equal(f.interrupts(), 1);
    f.wheel(15); assert.equal(f.pdf.scrollTop, 15);
    f.touch('touchstart', [[0, 0], [100, 0]]); f.touch('touchcancel', []);
    f.touch('touchstart', [[0, 0], [100, 0]]); f.dom.window.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(f.touch('touchmove', [[0, 0], [200, 0]]).defaultPrevented, false);
  } finally { f.dispose(); }
});
