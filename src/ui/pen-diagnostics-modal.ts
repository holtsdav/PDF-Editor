import { App, Modal, Setting } from 'obsidian';

interface Sample { x: number; y: number; pressure: number }

export class PenDiagnosticsModal extends Modal {
  private cleanup?: () => void;

  constructor(app: App) { super(app); }

  onOpen(): void {
    this.setTitle('Pen input test');
    this.contentEl.createEl('p', {
      text: 'Draw below with your tablet. Vary your pressure to check what reaches Obsidian. Strokes stay in this test pad and disappear when you close it.'
    });
    const canvas = this.contentEl.createEl('canvas', { cls: 'pdf-form-studio-pen-pad' });
    canvas.width = 1000;
    canvas.height = 500;
    canvas.setAttribute('aria-label', 'Pen input test drawing area');
    const status = this.contentEl.createEl('p', { text: 'Waiting for a pen or mouse stroke.' });
    status.setAttribute('role', 'status');
    const context = canvas.getContext('2d');
    if (!context) {
      status.setText('A drawing canvas is unavailable in this environment.');
      return;
    }
    context.strokeStyle = '#2463eb';
    context.fillStyle = '#2463eb';
    context.lineCap = 'round';
    context.lineJoin = 'round';
    let pointer: number | undefined;
    let previous: Sample | undefined;
    let minimum = 1;
    let maximum = 0;
    let samples = 0;
    let inputType: string | undefined;
    const controller = new AbortController();
    const options = { signal: controller.signal };

    const draw = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const current = {
        x: (event.clientX - rect.left) * canvas.width / rect.width,
        y: (event.clientY - rect.top) * canvas.height / rect.height,
        pressure: event.pressure
      };
      minimum = Math.min(minimum, event.pressure);
      maximum = Math.max(maximum, event.pressure);
      samples++;
      const width = event.pointerType === 'pen' && current.pressure > 0 ? 1.5 + current.pressure * 7 : 3;
      context.lineWidth = width;
      context.beginPath();
      if (previous) {
        context.moveTo(previous.x, previous.y);
        context.lineTo(current.x, current.y);
        context.stroke();
      } else {
        context.arc(current.x, current.y, width / 2, 0, Math.PI * 2);
        context.fill();
      }
      previous = current;
      status.setText(`Input: ${event.pointerType || 'unknown'} · pressure ${minimum.toFixed(3)}–${maximum.toFixed(3)} · ${samples} samples · tilt ${event.tiltX}/${event.tiltY}`);
    };

    canvas.addEventListener('pointerdown', event => {
      if (pointer !== undefined || event.pointerType === 'touch' || event.button !== 0) return;
      event.preventDefault();
      pointer = event.pointerId;
      previous = undefined;
      if (inputType !== event.pointerType) {
        inputType = event.pointerType;
        minimum = 1;
        maximum = 0;
        samples = 0;
      }
      canvas.setPointerCapture(event.pointerId);
      draw(event);
    }, options);
    canvas.addEventListener('pointermove', event => {
      if (pointer !== event.pointerId) return;
      event.preventDefault();
      const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
      for (const sample of coalesced.length ? coalesced : [event]) draw(sample);
    }, options);
    const finish = (event: PointerEvent): void => {
      if (pointer !== event.pointerId) return;
      pointer = undefined;
      previous = undefined;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    canvas.addEventListener('pointerup', finish, options);
    canvas.addEventListener('pointercancel', finish, options);
    canvas.addEventListener('lostpointercapture', finish, options);
    new Setting(this.contentEl).addButton(button => button.setButtonText('Clear test pad').onClick(() => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      previous = undefined;
      minimum = 1;
      maximum = 0;
      samples = 0;
      status.setText('Waiting for a pen or mouse stroke.');
    }));
    this.cleanup = () => {
      controller.abort();
      if (pointer !== undefined && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    };
  }

  onClose(): void {
    this.cleanup?.();
    this.cleanup = undefined;
    this.contentEl.empty();
  }
}
