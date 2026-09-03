// Circuit breaker. Every expensive operation asks permission here first.
//
// Counters are per-UTC-day rows in D1. Two reads and one write per run, not
// per operation — the count is held in memory for the invocation and flushed
// at the end, so the breaker itself costs almost nothing.

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export class Budget {
  constructor(db, limits) {
    this.db = db;
    this.limits = limits;      // { fetch: n, ai: n }
    this.used = {};            // loaded from D1
    this.delta = {};           // accumulated this invocation
    this.day = today();
  }

  static async load(db, limits) {
    const b = new Budget(db, limits);
    const { results } = await db
      .prepare('SELECT metric, used FROM budget WHERE day = ?')
      .bind(b.day)
      .all();
    for (const r of results || []) b.used[r.metric] = r.used;
    return b;
  }

  remaining(metric) {
    const limit = this.limits[metric] ?? 0;
    const spent = (this.used[metric] || 0) + (this.delta[metric] || 0);
    return Math.max(0, limit - spent);
  }

  canSpend(metric, n = 1) {
    return this.remaining(metric) >= n;
  }

  /** Record spend in memory. Call flush() once before the run ends. */
  spend(metric, n = 1) {
    this.delta[metric] = (this.delta[metric] || 0) + n;
  }

  spentThisRun(metric) {
    return this.delta[metric] || 0;
  }

  async flush() {
    const metrics = Object.keys(this.delta).filter((m) => this.delta[m] > 0);
    if (!metrics.length) return;
    await this.db.batch(
      metrics.map((m) =>
        this.db
          .prepare(
            `INSERT INTO budget (day, metric, used) VALUES (?,?,?)
             ON CONFLICT(day, metric) DO UPDATE SET used = used + excluded.used`
          )
          .bind(this.day, m, this.delta[m])
      )
    );
    for (const m of metrics) {
      this.used[m] = (this.used[m] || 0) + this.delta[m];
      this.delta[m] = 0;
    }
  }

  summary() {
    const out = {};
    for (const m of Object.keys(this.limits)) {
      out[m] = {
        limit: this.limits[m],
        used: (this.used[m] || 0) + (this.delta[m] || 0),
        remaining: this.remaining(m),
      };
    }
    return out;
  }
}
