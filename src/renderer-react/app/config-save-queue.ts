// Serialises user-initiated daemon config saves and remembers which one is the
// latest, so App can (a) never let two saves race on the config file, (b) only
// reload the dashboard after the newest save, and (c) keep an in-flight save
// from being overwritten by a snapshot that started before the click.
export class ConfigSaveQueue<T> {
  private chain: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private inFlight = 0;

  // Saves still running. While > 0, a dashboard snapshot must keep the local
  // config instead of taking the (possibly older) one from disk.
  get pending(): number {
    return this.inFlight;
  }

  // Queues `save` behind every earlier save. Resolves once this save settled;
  // `latest` says whether no newer save was started meanwhile.
  async enqueue(save: () => Promise<T>): Promise<{ ok: boolean; latest: boolean; error: unknown }> {
    const revision = ++this.revision;
    const operation = this.chain.catch(() => {}).then(save);
    this.chain = operation.catch(() => {});
    this.inFlight += 1;
    try {
      await operation;
      return { ok: true, latest: revision === this.revision, error: null };
    } catch (error) {
      return { ok: false, latest: revision === this.revision, error };
    } finally {
      this.inFlight -= 1;
    }
  }
}
