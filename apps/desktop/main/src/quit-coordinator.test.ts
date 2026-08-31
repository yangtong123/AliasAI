import { describe, expect, it, vi } from 'vitest'
import { createQuitCoordinator } from './quit-coordinator'

function deferredShutdown() {
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const shutdown = vi.fn(() => gate)
  return { shutdown, release }
}

describe('createQuitCoordinator', () => {
  it('prevents every quit request while draining and fires exactly one quit after', async () => {
    const { shutdown, release } = deferredShutdown()
    const quit = vi.fn()
    const coordinator = createQuitCoordinator({ shutdown }, quit)
    const prevent = vi.fn()
    const event = {}

    // First quit request mid-run: prevented, drain begins.
    expect(coordinator.handleBeforeQuit(event, prevent)).toBe(true)
    expect(prevent).toHaveBeenCalledTimes(1)
    expect(shutdown).toHaveBeenCalledTimes(1)

    // Second (and third) quit requests during the SAME drain: still
    // prevented, and no second shutdown is started.
    expect(coordinator.handleBeforeQuit(event, prevent)).toBe(true)
    expect(coordinator.handleBeforeQuit(event, prevent)).toBe(true)
    expect(prevent).toHaveBeenCalledTimes(3)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(coordinator.isDraining()).toBe(true)
    expect(quit).not.toHaveBeenCalled()

    // Drain settles: exactly one quit, gate opens for the final pass-through.
    release()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    expect(coordinator.isGateOpen()).toBe(true)
    expect(coordinator.isDraining()).toBe(false)

    // The coordinator-issued quit (and anything later) passes through.
    expect(coordinator.handleBeforeQuit(event, prevent)).toBe(false)
    expect(prevent).toHaveBeenCalledTimes(3)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('drains even with zero active runs so intake always closes first', async () => {
    // shutdown resolves immediately; the coordinator must still route through
    // it (closing runner intake) instead of skipping straight to quit.
    const shutdown = vi.fn(async () => undefined)
    const quit = vi.fn()
    const coordinator = createQuitCoordinator({ shutdown }, quit)
    const prevent = vi.fn()

    expect(coordinator.handleBeforeQuit({}, prevent)).toBe(true)
    expect(prevent).toHaveBeenCalledTimes(1)
    expect(shutdown).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    expect(coordinator.isGateOpen()).toBe(true)
  })

  it('keeps preventing quits when shutdown rejects', async () => {
    const shutdown = vi.fn(async () => {
      throw new Error('synthetic shutdown failure')
    })
    const quit = vi.fn()
    const coordinator = createQuitCoordinator({ shutdown }, quit)
    const prevent = vi.fn()

    coordinator.handleBeforeQuit({}, prevent)
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    // The failed drain still opens the gate via finally — quitting is better
    // than hanging forever, and startup recovery covers the abrupt exit.
    expect(coordinator.isGateOpen()).toBe(true)
    expect(prevent).toHaveBeenCalledTimes(1)
  })
})
