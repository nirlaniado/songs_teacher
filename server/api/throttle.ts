/** Counts failed logins per username, whatever IP they come from. In memory, per process. */
export class LoginThrottle {
  private failures = new Map<string, { count: number; resetAt: number }>();
  constructor(private max = 5, private windowMs = 15 * 60_000, private now = () => Date.now()) {}

  /** Milliseconds until this username may try again, or 0. */
  lockedFor(username: string): number {
    const entry = this.failures.get(username.toLowerCase());
    const left = entry ? entry.resetAt - this.now() : 0;
    return entry && entry.count >= this.max && left > 0 ? left : 0;
  }

  fail(username: string) {
    const key = username.toLowerCase();
    const now = this.now();
    if (this.failures.size > 10_000)
      for (const [k, e] of this.failures) if (e.resetAt <= now) this.failures.delete(k);
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count++;
  }

  succeed(username: string) {
    this.failures.delete(username.toLowerCase());
  }
}
