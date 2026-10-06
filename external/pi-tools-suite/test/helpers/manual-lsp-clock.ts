export class ManualLspClock {
  now = 0;
  readonly tasks: { at: number; callback: () => void; cancelled: boolean }[] = [];
  schedule = (callback: () => void, delayMs: number): (() => void) => {
    const task = { at: this.now + delayMs, callback, cancelled: false };
    this.tasks.push(task);
    return () => { task.cancelled = true; };
  };
  get pending(): number { return this.tasks.filter((task) => !task.cancelled).length; }
  advance(ms: number): void {
    this.now += ms;
    for (const task of [...this.tasks]) {
      if (task.cancelled || task.at > this.now) continue;
      task.cancelled = true;
      task.callback();
    }
  }
}
