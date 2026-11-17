export class Choices {
  private index = 0;
  private state: number;
  private readonly tape: readonly number[];

  constructor(seed: number, tape: readonly number[] = []) {
    this.state = seed >>> 0;
    this.tape = tape;
  }

  private random(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(bound: number): number {
    if (bound <= 1) return 0;
    if (this.index < this.tape.length) {
      const value = this.tape[this.index] ?? 0;
      this.index += 1;
      return value % bound;
    }
    return Math.floor(this.random() * bound);
  }

  chance(percent: number): boolean {
    return this.int(100) < percent;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from an empty list");
    return items[this.int(items.length)] as T;
  }

  between(low: number, high: number): number {
    return low + this.int(high - low + 1);
  }
}
