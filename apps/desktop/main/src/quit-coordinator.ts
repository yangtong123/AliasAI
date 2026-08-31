/**
 * Two-phase quit gate for Electron's before-quit, extracted so the state
 * machine is unit-testable without a real app object.
 *
 * Semantics:
 * - The FIRST before-quit always begins (or joins) a drain: intake closes,
 *   active runs settle, SQLite closes last — even when zero runs are active,
 *   because a zero-count check alone would still race a new start.
 * - EVERY before-quit while draining is prevented: a second quit request
 *   arriving mid-drain must never let the app exit with resources still in
 *   use.
 * - Exactly ONE quit is issued, after shutdown settles; the gate stays open
 *   so that final quit (and any later one) passes through.
 */
export interface QuitShutdownLike {
  shutdown(): Promise<void>
}

export function createQuitCoordinator<TShutdown extends QuitShutdownLike, TEvent>(
  runtime: TShutdown,
  quit: () => void
): {
  /** Returns true when this before-quit was prevented. */
  readonly handleBeforeQuit: (event: TEvent, preventDefault: () => void) => boolean
  /** Test/introspection: drain started, gate not yet open. */
  readonly isDraining: () => boolean
  /** Test/introspection: shutdown settled; quits pass through. */
  readonly isGateOpen: () => boolean
} {
  let draining = false
  let gateOpen = false
  return {
    handleBeforeQuit(event, preventDefault) {
      if (gateOpen) return false
      preventDefault()
      if (draining) return true
      draining = true
      // The rejection is explicitly observed: `finally` alone would return a
      // still-rejected promise (an unhandled rejection and a failed exit
      // code), while swallowing lets the gate open and startup recovery own
      // the abrupt exit.
      runtime
        .shutdown()
        .catch(() => undefined)
        .finally(() => {
          gateOpen = true
          quit()
        })
      return true
    },
    isDraining: () => draining && !gateOpen,
    isGateOpen: () => gateOpen
  }
}
