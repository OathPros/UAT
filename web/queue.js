import { resultError } from "./validation.js";
// One persisted operation is kept byte-for-byte until acknowledged. Newer local edits
// remain separate, so a lost acknowledgement can never cause a fresh duplicate write.
export class SaveQueue {
  constructor({
    storage,
    key,
    send,
    onChange = () => {},
    id = () => crypto.randomUUID(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (timer) => clearTimeout(timer),
  }) {
    Object.assign(this, { storage, key, send, onChange, id, schedule, cancel });
    this.storageOK = true;
    this.busy = false;
    this.timer = null;
    this.attempts = 0;
    this.error = "";
    this.state = { confirmed: {}, pending: {}, operation: null, conflicts: {} };
    try {
      const saved = storage.getItem(key);
      if (saved) this.state = JSON.parse(saved);
    } catch {
      this.storageOK = false;
      this.error =
        "Browser storage is unavailable or unreadable. Keep this tab open; copy any unsaved comments before leaving.";
    }
  }
  persist() {
    try {
      this.storage.setItem(this.key, JSON.stringify(this.state));
    } catch {
      this.storageOK = false;
    }
    this.onChange();
  }
  merge(rows) {
    for (const r of rows)
      if ((this.state.confirmed[r.test_id]?.version || 0) <= r.version)
        this.state.confirmed[r.test_id] = r;
    this.persist();
  }
  edit(testId, status, comment) {
    this.state.pending[testId] = { status, comment, generation: this.id() };
    this.persist();
    this.kick(350);
  }
  value(id) {
    return (
      this.state.pending[id] ||
      this.state.confirmed[id] || { status: null, comment: "" }
    );
  }
  status(id) {
    if (this.state.conflicts[id]) return "Save failed — conflict";
    if (this.state.pending[id])
      return this.error ? "Save failed" : "Pending save";
    return this.state.confirmed[id] ? "Confirmed" : "Not started";
  }
  kick(ms = 0) {
    this.cancel(this.timer);
    this.timer = this.schedule(() => this.flush(), ms);
  }
  retry() {
    this.error = "";
    this.attempts = 0;
    this.persist();
    this.kick();
  }
  resolve(id, useLocal) {
    const conflict = this.state.conflicts[id];
    if (!conflict) return;
    if (useLocal) {
      const p = this.state.pending[id];
      if (p) p.generation = this.id();
    } else delete this.state.pending[id];
    delete this.state.conflicts[id];
    this.error = "";
    this.attempts = 0;
    this.persist();
    this.kick();
  }
  async flush() {
    if (this.busy) return;
    let op = this.state.operation;
    if (!op) {
      const entry = Object.entries(this.state.pending).find(
        ([id, p]) =>
          !this.state.conflicts[id] && !resultError(p.status, p.comment),
      );
      if (!entry) return;
      const [testId, p] = entry;
      op = {
        testId,
        generation: p.generation,
        body: {
          status: p.status,
          comment: p.comment.trim(),
          expectedVersion: this.state.confirmed[testId]?.version || 0,
          mutationId: this.id(),
        },
      };
      this.state.operation = op;
      this.persist();
    }
    this.busy = true;
    try {
      const { result } = await this.send(op.testId, op.body);
      if ((this.state.confirmed[op.testId]?.version || 0) <= result.version)
        this.state.confirmed[op.testId] = result;
      if (this.state.pending[op.testId]?.generation === op.generation)
        delete this.state.pending[op.testId];
      this.state.operation = null;
      this.error = "";
      this.attempts = 0;
    } catch (e) {
      this.error = e.message || "Save failed";
      if (e.status === 409) {
        this.state.conflicts[op.testId] = {
          current: e.current || null,
          message: this.error,
        };
        if (e.current) this.state.confirmed[op.testId] = e.current;
        this.state.operation = null;
      } else this.attempts++;
    } finally {
      this.busy = false;
      this.persist();
    }
    if (!this.error) this.kick();
    else if (this.attempts > 0 && this.attempts < 5)
      this.kick(
        Math.min(30000, 500 * 2 ** this.attempts) + Math.random() * 300,
      );
  }
}
