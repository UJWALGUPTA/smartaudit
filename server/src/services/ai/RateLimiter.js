/**
 * Token bucket shared by all worker slots, so N concurrent jobs can never
 * exceed the provider's requests-per-minute budget. `acquire()` waits (FIFO)
 * instead of failing, which turns bursts into a smooth request stream.
 */
export class RateLimiter {
  constructor({ ratePerMinute, burst = Math.max(1, Math.ceil(ratePerMinute / 6)) }) {
    this.capacity = burst;
    this.tokens = burst;
    this.refillPerMs = ratePerMinute / 60_000;
    this.last = Date.now();
    this.waiters = [];
    this.timer = null;
  }

  #refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
  }

  #drain() {
    this.timer = null;
    this.#refill();
    while (this.waiters.length && this.tokens >= 1) {
      this.tokens -= 1;
      this.waiters.shift()();
    }
    if (this.waiters.length) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      this.timer = setTimeout(() => this.#drain(), waitMs);
    }
  }

  acquire() {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      if (!this.timer) this.#drain();
    });
  }
}
