import { test } from "node:test";
import assert from "node:assert/strict";
import { SaveQueue } from "../../web/queue.js";
import { resultError } from "../../web/validation.js";
function setup(send, storage = new Map()) {
  const adapter = {
    getItem: (k) => storage.get(k),
    setItem: (k, v) => storage.set(k, v),
  };
  const q = new SaveQueue({
    storage: adapter,
    key: "p",
    send,
    schedule: () => 0,
    cancel: () => {},
    id: () => crypto.randomUUID(),
  });
  return { q, storage, adapter };
}
test("invalid fail/partial cannot save; explicit skip only; no answer stays absent", async () => {
  let count = 0;
  const { q } = setup(async () => {
    count++;
    return {
      result: { test_id: "A01", status: "skipped", comment: "", version: 1 },
    };
  });
  await q.flush();
  assert.equal(count, 0);
  for (const s of ["fail", "partial_pass"]) {
    q.edit("A01", s, " a ");
    await q.flush();
    assert.equal(count, 0);
    assert.ok(resultError(s, " a "));
  }
  q.edit("A01", "skipped", "");
  await q.flush();
  assert.equal(count, 1);
  assert.equal(q.status("A01"), "Confirmed");
});
test("rapid edits coalesce; in-flight old acknowledgement never removes newer pending edit", async () => {
  let resolve;
  const sent = [];
  const { q } = setup((id, body) => {
    sent.push(body);
    return new Promise((r) => (resolve = r));
  });
  q.edit("A01", "pass", "");
  const first = q.flush();
  q.edit("A01", "fail", "broken");
  q.edit("A01", "partial_pass", "latest");
  await q.flush();
  assert.equal(sent.length, 1);
  resolve({
    result: { test_id: "A01", status: "pass", comment: "", version: 1 },
  });
  await first;
  assert.equal(q.value("A01").comment, "latest");
  const second = q.flush();
  assert.equal(sent[1].expectedVersion, 1);
  resolve({
    result: {
      test_id: "A01",
      status: "partial_pass",
      comment: "latest",
      version: 2,
    },
  });
  await second;
  assert.equal(q.status("A01"), "Confirmed");
});
test("outage, lost acknowledgement and refresh retain identical mutation; restored confirmed data cannot overwrite pending", async () => {
  let mutation;
  const { q, adapter } = setup(async (id, b) => {
    mutation = b;
    throw Error("offline");
  });
  q.edit("A01", "fail", "retained");
  await q.flush();
  assert.equal(q.status("A01"), "Save failed");
  assert.equal(q.state.confirmed.A01, undefined);
  let actual;
  const refreshed = new SaveQueue({
    storage: adapter,
    key: "p",
    send: async (id, b) => {
      actual = b;
      return {
        result: {
          test_id: "A01",
          status: "fail",
          comment: "retained",
          version: 1,
        },
      };
    },
    schedule: () => 0,
    cancel: () => {},
  });
  refreshed.merge([
    { test_id: "A01", status: "pass", comment: "old server data", version: 1 },
  ]);
  assert.equal(refreshed.value("A01").comment, "retained");
  await refreshed.flush();
  assert.deepEqual(actual, mutation);
  assert.equal(refreshed.status("A01"), "Confirmed");
});
test("conflict keeps both versions and requires explicit choice", async () => {
  const { q } = setup(async () => {
    throw Object.assign(Error("conflict"), {
      status: 409,
      current: {
        test_id: "A01",
        status: "pass",
        comment: "other tab",
        version: 4,
      },
    });
  });
  q.edit("A01", "fail", "local");
  await q.flush();
  assert.equal(q.value("A01").comment, "local");
  assert.equal(q.state.conflicts.A01.current.comment, "other tab");
  q.resolve("A01", true);
  let body;
  q.send = async (id, b) => {
    body = b;
    return {
      result: { test_id: id, status: b.status, comment: b.comment, version: 5 },
    };
  };
  await q.flush();
  assert.equal(body.expectedVersion, 4);
  assert.equal(q.status("A01"), "Confirmed");
});
test("storage failure is explicit but saving remains available", async () => {
  const q = new SaveQueue({
    storage: {
      getItem() {
        throw Error();
      },
      setItem() {
        throw Error();
      },
    },
    key: "p",
    send: async () => ({
      result: { test_id: "A01", status: "pass", comment: "", version: 1 },
    }),
    schedule: () => 0,
    cancel: () => {},
  });
  q.edit("A01", "pass", "");
  assert.equal(q.storageOK, false);
  await q.flush();
  assert.equal(q.state.confirmed.A01.version, 1);
});
test("client and server validation rules stay identical", async () => {
  const fs = await import("node:fs/promises");
  assert.equal(
    await fs.readFile(
      new URL("../../web/validation.js", import.meta.url),
      "utf8",
    ),
    await fs.readFile(new URL("../src/validation.js", import.meta.url), "utf8"),
  );
});
test("retry cap leaves visible failure and frozen operation, recovery retry can confirm", async () => {
  let count = 0;
  const { q } = setup(async () => {
    count++;
    throw Error("offline");
  });
  q.edit("A01", "pass", "");
  for (let i = 0; i < 5; i++) await q.flush();
  assert.equal(count, 5);
  assert.equal(q.attempts, 5);
  assert.equal(q.status("A01"), "Save failed");
  assert.ok(q.state.operation);
  q.retry();
  q.send = async (id, b) => ({
    result: { test_id: id, status: b.status, comment: b.comment, version: 1 },
  });
  await q.flush();
  assert.equal(q.status("A01"), "Confirmed");
});
