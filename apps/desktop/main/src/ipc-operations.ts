/**
 * Registry of in-flight IPC operations. Shutdown must not only drain the
 * automatic-analysis runner: AI executions, diagnostic stage runs, imports,
 * and replacements all keep async work (network, Python workers, native
 * dialogs) alive across awaits, and their completion writes to SQLite. The
 * runtime therefore refuses NEW operations first, awaits everything still
 * registered, and only then closes the database.
 *
 * Instances live on the runtime (one per app process / test runtime).
 */
export class IpcOperationTracker {
  readonly #inFlight = new Set<Promise<unknown>>()
  #closed = false

  /** True once shutdown started; every new operation fails fast from now on. */
  get closed(): boolean {
    return this.#closed
  }

  /** Number of operations currently registered. */
  get activeCount(): number {
    return this.#inFlight.size
  }

  /**
   * Runs one IPC operation under shutdown protection. The returned promise
   * always settles with the handler's own result: registration bookkeeping
   * can never turn a handler failure into an unhandled rejection here.
   */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      throw new IpcShutdownError()
    }
    const tracked = operation()
    const bookkeeping = tracked.catch(() => undefined)
    this.#inFlight.add(bookkeeping)
    try {
      return await tracked
    } finally {
      this.#inFlight.delete(bookkeeping)
    }
  }

  /** Stops accepting new operations; in-flight ones keep running. */
  close(): void {
    this.#closed = true
  }

  /** Resolves once every registered operation has settled. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight])
    }
  }
}

/** Raised for operations arriving after shutdown began. */
export class IpcShutdownError extends Error {
  readonly code = 'APP_SHUTTING_DOWN'
  constructor() {
    super('The application is shutting down')
    this.name = 'IpcShutdownError'
  }
}
