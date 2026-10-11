import { DatabaseSync } from "node:sqlite";
import { beginWrite, claimWork, withProviderSlot } from "../../src/project-search/source-work.mjs";

const [mode, location] = process.argv.slice(2);
const controller = new AbortController();
let finish;
const gate = new Promise(resolve => { finish = resolve; });
process.on("message", message => {
  if (message === "finish") finish();
  if (message === "abort") controller.abort();
});
const send = event => process.send?.({ event });
try {
  send("started");
  if (mode === "slot") {
    await withProviderSlot(controller.signal, async () => { send("acquired"); await gate; }, { directory: location });
  } else {
    const db = new DatabaseSync(location);
    try {
      const work = await claimWork(db, controller.signal);
      let success = false;
      try {
        await beginWrite(db, controller.signal);
        db.exec("CREATE TABLE IF NOT EXISTS paid_result(id INTEGER PRIMARY KEY)");
        if (db.prepare("SELECT id FROM paid_result").get()) {
          db.exec("COMMIT"); send("cached");
        } else {
          work.network(db); db.exec("COMMIT");
          send("acquired"); await gate;
          await beginWrite(db, controller.signal); work.assert(db);
          db.exec("INSERT INTO paid_result VALUES(1); COMMIT");
        }
        success = true;
      } finally { await work.release(success); }
    } finally { db.close(); }
  }
  send("done");
} catch (error) {
  process.send?.({ event: "error", message: String(error) });
  process.exitCode = 1;
} finally { process.disconnect?.(); }
