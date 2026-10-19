/** Defers restarting media work until a canceled exit attempt restores the app. */
export class MediaExitRecoveryQueue {
  private readonly deferredIds = new Set<string>();

  collect(ids: unknown, exitInProgress: boolean): string[] {
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === 'string' && id.length > 0) this.deferredIds.add(id);
      }
    }

    if (exitInProgress) return [];

    const ready = Array.from(this.deferredIds);
    this.deferredIds.clear();
    return ready;
  }
}
