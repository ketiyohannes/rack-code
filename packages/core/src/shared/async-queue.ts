/**
 * Small async queue used to bridge provider streams to application consumers.
 *
 * A producer can publish values before a consumer asks for them. Completion and
 * failure are terminal and wake every pending reader, which lets execution
 * cleanup finish without leaving a UI or test waiting forever.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private completed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.completed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  complete(): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return { done: false, value };
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
    if (this.completed) {
      return { done: true, value: undefined };
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
