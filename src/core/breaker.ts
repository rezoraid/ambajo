/** Circuit breaker sederhana: buka setelah N gagal berturut-turut, coba 1 probe setelah cooldown. */
export class CircuitBreaker {
  private failures = 0
  private openedAt = 0
  private probing = false

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000
  ) {}

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.failures < this.threshold) return 'closed'
    return Date.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open'
  }

  /** Non-mutating: apakah request kemungkinan diizinkan. */
  get available(): boolean {
    const s = this.state
    return s === 'closed' || (s === 'half-open' && !this.probing)
  }

  /** Mutating: dipanggil tepat sebelum request. */
  canRequest(): boolean {
    const s = this.state
    if (s === 'closed') return true
    if (s === 'half-open' && !this.probing) {
      this.probing = true
      return true
    }
    return false
  }

  success() {
    this.failures = 0
    this.probing = false
  }

  failure() {
    this.failures++
    this.probing = false
    if (this.failures >= this.threshold) this.openedAt = Date.now()
  }
}
