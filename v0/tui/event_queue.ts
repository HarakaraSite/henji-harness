/** One consumer waits for events without attaching reactions to every pending source again. */
export class TuiEventQueue<T> {
  private readonly events: T[] = [];
  private waiter: ((event: T) => void) | undefined;
  private closed = false;

  push(event: T): void {
    if (this.closed) return;
    const waiter = this.waiter;
    if (waiter === undefined) this.events.push(event);
    else {
      this.waiter = undefined;
      waiter(event);
    }
  }

  next(): Promise<T> {
    if (this.events.length > 0) return Promise.resolve(this.events.shift()!);
    return new Promise((resolve) => this.waiter = resolve);
  }

  close(): void {
    this.closed = true;
    this.events.length = 0;
    this.waiter = undefined;
  }
}
