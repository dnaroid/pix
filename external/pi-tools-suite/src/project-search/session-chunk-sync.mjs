/** Event-driven coalescing, one owned operation and one dirty follow-up. */
export class SessionChunkSync {
  constructor(run, signal, failed = () => {}) {
    this.run = run; this.signal = signal; this.failed = failed;
    this.dirty = false; this.stopped = false;
    this.abort = () => { this.stopped = true; clearTimeout(this.timer); };
    signal.addEventListener("abort",this.abort,{once:true});
  }
  changed() {
    if(this.stopped || this.signal.aborted) return;
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(()=>this.start(),250);
    this.timer.unref?.();
  }
  start() {
    if(this.stopped || this.signal.aborted || this.worker || !this.dirty) return;
    this.dirty = false;
    this.worker = this.run(this.signal).catch(e=>{if(!this.signal.aborted)this.failed(e);}).finally(()=>{
      this.worker = undefined;
      if(this.dirty) this.changed();
      else if (!this.stopped && !this.signal.aborted) {
        // Recheck persisted inactivity across hosts without paying for unchanged revisions.
        this.timer = setTimeout(() => { this.dirty = true; this.start(); }, 30_000);
        this.timer.unref?.();
      }
    });
  }
  async dispose() {
    this.abort(); this.signal.removeEventListener("abort",this.abort); await this.worker;
  }
}
