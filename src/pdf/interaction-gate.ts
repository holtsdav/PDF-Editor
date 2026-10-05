/** Shared by every editor of a document: automatic writes wait for interactions. */
export class InteractionGate {
  private active = 0;
  private waiters = new Set<() => void>();
  generation = 0;

  begin(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.active === 0) this.wake();
    };
  }

  async whenIdle(generation: number): Promise<void> {
    // Recheck after waking: moving directly between two inputs briefly blurs
    // the first before focus enters the second in the same browser event.
    while (this.active && generation === this.generation) {
      await new Promise<void>(resolve => this.waiters.add(resolve));
    }
  }

  isIdle(generation: number): boolean { return !this.active || generation !== this.generation; }

  flush(): void { this.generation++; this.wake(); }
  private wake(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}
