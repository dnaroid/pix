/** Event-driven coalescing, one owned operation and one dirty follow-up. */
export class SessionChunkSync {
  constructor(run, signal, failed = () => {}) {
    this.run = run; this.signal = signal; this.failed = failed;
    this.dirty = false; this.stopped = false; this.incomplete = false;
    this.failureBackoffMs = 0;
    this.abort = () => { this.stopped = true; clearTimeout(this.timer); };
    signal.addEventListener("abort",this.abort,{once:true});
  }
  changed() {
    if(this.stopped || this.signal.aborted) return;
    // A real source/config/session change is a reason to retry immediately.
    this.failureBackoffMs = 0;
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(()=>this.start(),250);
    this.timer.unref?.();
  }
  /** Retry an operationally incomplete pass more slowly without treating it
   * as a thrown error. Deferred/immature sessions should not call this. */
  noteIncomplete() { this.incomplete = true; }
  advanceBackoff() {
    this.failureBackoffMs = Math.min(this.failureBackoffMs ? this.failureBackoffMs * 2 : 120_000, 900_000);
  }
  start() {
    if(this.stopped || this.signal.aborted || this.worker || !this.dirty) return;
    this.dirty = false; this.incomplete = false;
    this.worker = this.run(this.signal).then(()=>{
      if(this.incomplete) this.advanceBackoff();
      else this.failureBackoffMs = 0;
    },e=>{
      if(!this.signal.aborted) {
        // Preserve periodic recovery, but never retry a persistent failure
        // every 30 seconds (which can reattempt paid/provider operations).
        this.advanceBackoff();
        this.failed(e);
      }
    }).finally(()=>{
      this.worker = undefined;
      if(this.dirty) this.changed();
      else if (!this.stopped && !this.signal.aborted) {
        // Recheck persisted inactivity across hosts without paying for unchanged revisions.
        this.timer = setTimeout(() => { this.dirty = true; this.start(); }, this.failureBackoffMs || 30_000);
        this.timer.unref?.();
      }
    });
  }
  async dispose() {
    this.abort(); this.signal.removeEventListener("abort",this.abort); await this.worker;
  }
}
