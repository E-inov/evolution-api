import { configService, Reconnect } from '@config/env.config';
import { Logger } from '@config/logger.config';

const logger = new Logger('ReconnectGate');

// A slot is held from the moment connectToWhatsapp() is called until the socket
// reports 'open' or 'close'. If neither ever arrives (socket stuck mid-handshake)
// the slot would pin the queue forever, so it is force-released after this long.
const MAX_SLOT_HOLD_MS = 120_000;

const DEFAULT_MAX_CONCURRENT = 4;

function resolveMaxConcurrent(): number {
  const configured = configService.get<Reconnect>('RECONNECT').MAX_CONCURRENT;

  // 0 or a negative value would park every reconnection forever.
  return configured > 0 ? configured : DEFAULT_MAX_CONCURRENT;
}

/**
 * Process-wide limiter for WhatsApp reconnections.
 *
 * One Evolution process hosts dozens of Baileys instances (28–37 per host in
 * production) and they all leave through the same outbound proxy. When that
 * proxy blips, every instance is closed within the same millisecond and every
 * one of them schedules a reconnect from an identical starting point. Without
 * a limiter they rebuild socket + auth state + contact resync all at once,
 * which spikes RSS past the droplet's RAM and pushes the process into swap.
 * Observed on 2026-08-12: ~130 instances reconnecting across 4 hosts inside
 * two minutes, memory utilisation at ~97%.
 *
 * The gate keeps a small number of reconnections in flight and queues the
 * rest, turning one avalanche into a series of small waves. An instance that
 * drops on its own never waits — it takes a free slot immediately — so the
 * common case is unaffected.
 *
 * Tune with RECONNECT_MAX_CONCURRENT (positive integer, default 4).
 */
class ReconnectGate {
  private readonly maxConcurrent = resolveMaxConcurrent();
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  /**
   * Waits for a free slot and returns the function that gives it back. The
   * returned function is idempotent, so callers can release from several code
   * paths (open, close, error) without double counting.
   */
  public async acquire(instanceName: string): Promise<() => void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
    } else {
      logger.info(
        `All ${this.maxConcurrent} reconnect slots busy, queueing ${instanceName} at position ${this.waiting.length + 1}`,
      );

      // The slot is handed over directly by release(), so inFlight is already
      // accounted for once this resolves.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    return this.buildRelease(instanceName);
  }

  private buildRelease(instanceName: string): () => void {
    let released = false;

    const release = () => {
      if (released) {
        return;
      }

      released = true;
      clearTimeout(holdTimer);

      const next = this.waiting.shift();

      if (next) {
        // Hand the slot straight to the next instance in line instead of
        // decrementing: keeps inFlight at the cap while anyone is waiting.
        next();
      } else {
        this.inFlight = Math.max(0, this.inFlight - 1);
      }
    };

    // Declared after release() on purpose: release() only ever runs once this
    // function has returned, so the reference is always assigned by then.
    const holdTimer = setTimeout(() => {
      logger.warn(
        `Reconnect slot held by ${instanceName} for more than ${MAX_SLOT_HOLD_MS}ms, releasing it so the queue keeps moving`,
      );
      release();
    }, MAX_SLOT_HOLD_MS);

    // Never keep the event loop alive just for this watchdog.
    holdTimer.unref();

    return release;
  }
}

export const reconnectGate = new ReconnectGate();
