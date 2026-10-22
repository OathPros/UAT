import { api, $, element, labels, copy, notice } from "./common.js";
import { resultError } from "./validation.js";
import { SaveQueue } from "./queue.js";
let token = "",
  participant,
  tests = [],
  selected = 0,
  queue,
  joining = false,
  releaseLock;
const storage = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
};
function stored(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function store(k, v) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
    return true;
  } catch {
    return false;
  }
}
const random = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
let registrationKey = stored("halo.registration") || random();
store("halo.registration", registrationKey);
async function lock(t) {
  if (!navigator.locks) {
    notice(
      "This browser cannot prevent simultaneous tabs. Use only one tab for this participant.",
    );
    return;
  }
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(
        "halo.participant." + t,
        { ifAvailable: true },
        async (acquired) => {
          if (!acquired) {
            reject(
              Error(
                "This participant is already open in another tab. Close it before retrying here.",
              ),
            );
            return;
          }
          await new Promise((release) => {
            releaseLock = release;
            resolve();
          });
        },
      )
      .catch(reject);
  });
}
async function enter(t, isNew = false) {
  if (token !== t) {
    releaseLock?.();
    releaseLock = null;
    await lock(t);
  }
  token = t;
  try {
    const [me, catalogue, results] = await Promise.all([
      api("/api/me", { token }),
      api("/api/tests", { token }),
      api("/api/results", { token }),
    ]);
    participant = me.participant;
    tests = catalogue.tests;
    if (!tests.length)
      throw Error(
        "This session has no assigned tests. Contact the administrator.",
      );
    const fingerprint = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      ),
    ]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    queue = new SaveQueue({
      storage,
      key: "halo.queue." + fingerprint,
      send: (id, body) =>
        api("/api/results/" + id, { token, method: "PUT", body }),
      onChange: () => {
        if (queue) renderState();
      },
    });
    queue.merge(results.results);
    $("entry").hidden = true;
    $("tester").hidden = false;
    $("sessionName").textContent = participant.session_name;
    $("welcome").textContent =
      `Welcome, ${participant.first_name} ${participant.last_initial}. · ${participant.team}`;
    $("category").replaceChildren(element("option", "All categories"));
    $("category").firstChild.value = "";
    for (const c of new Set(tests.map((t) => t.category))) {
      const o = element("option", c);
      o.value = c;
      $("category").append(o);
    }
    selected = 0;
    renderCase();
    if (isNew) {
      $("newToken").textContent = token;
      $("recoveryPanel").hidden = false;
    }
    queue.retry();
  } catch (e) {
    releaseLock?.();
    releaseLock = null;
    token = "";
    throw e;
  }
}
function current() {
  return tests[selected];
}
function renderList() {
  const list = $("testList");
  list.replaceChildren();
  const q = $("search").value.toLowerCase(),
    category = $("category").value,
    status = $("statusFilter").value;
  tests.forEach((t, i) => {
    const value = queue.value(t.id);
    if (
      (category && t.category !== category) ||
      (q &&
        !`${t.id} ${t.title} ${t.expected_result}`.toLowerCase().includes(q)) ||
      (status &&
        (status === "unanswered" ? !!value.status : value.status !== status))
    )
      return;
    const b = element("button", `${t.id} · ${t.title}`);
    b.type = "button";
    b.setAttribute("aria-current", String(i === selected));
    b.append(
      element(
        "small",
        `${labels[value.status] || "No outcome"} · ${queue.status(t.id)}`,
      ),
    );
    b.onclick = () => navigate(i);
    list.append(b);
  });
  if (!list.children.length) list.append(element("p", "No matching tests."));
}
function renderState() {
  if (!queue || !tests.length) return;
  const confirmed = Object.keys(queue.state.confirmed).filter((id) =>
      tests.some((t) => t.id === id),
    ).length,
    pending = Object.keys(queue.state.pending).length,
    conflicts = Object.keys(queue.state.conflicts).length;
  $("progressText").textContent =
    `${confirmed} / ${tests.length} confirmed · ${pending} pending · ${conflicts} conflicts`;
  $("progress").max = tests.length;
  $("progress").value = confirmed;
  $("syncText").textContent = queue.error
    ? `Save failed: ${queue.error} Your pending edits are retained.`
    : pending
      ? `${pending} pending save(s). Navigation is available while saving.`
      : "All selected outcomes confirmed by the server.";
  if (!participant.active)
    $("syncText").textContent =
      "Session closed. Confirmed results remain available; pending edits are retained.";
  $("storageWarning").hidden = queue.storageOK;
  const id = current().id;
  $("saveState").textContent = queue.status(id);
  const conflict = queue.state.conflicts[id];
  $("conflict").hidden = !conflict;
  if (conflict)
    $("conflictText").textContent =
      `A different revision is on the server: ${labels[conflict.current?.status] || "No outcome"} — ${conflict.current?.comment || "(no comment)"}. Your pending edit is still shown above. Choose which to retain.`;
  renderList();
}
function renderCase() {
  const t = current(),
    v = queue.value(t.id);
  $("testMeta").textContent =
    `${t.id} · ${t.category} · ${t.tier} · ${t.priority}`;
  $("testTitle").textContent = t.title;
  $("expected").textContent = t.expected_result;
  $("comment").value = v.comment;
  $("validation").textContent = "";
  for (const b of $("outcomes").children)
    b.setAttribute("aria-pressed", String(b.dataset.status === v.status));
  $("previous").disabled = selected === 0;
  $("next").disabled = selected === tests.length - 1;
  renderState();
}
function valid() {
  const v = queue.value(current().id);
  if (!v.status) return true;
  const e = resultError(v.status, v.comment);
  $("validation").textContent = e;
  if (e) {
    $("comment").focus();
    return false;
  }
  return true;
}
function navigate(i) {
  if (i < 0 || i >= tests.length || !valid()) return;
  selected = i;
  renderCase();
}
function edit(status, comment) {
  queue.edit(current().id, status, comment);
  $("validation").textContent = resultError(status, comment);
  for (const b of $("outcomes").children)
    b.setAttribute("aria-pressed", String(b.dataset.status === status));
}
$("outcomes").onclick = (e) => {
  const b = e.target.closest("button[data-status]");
  if (b) edit(b.dataset.status, $("comment").value);
};
$("comment").oninput = () => {
  edit(queue.value(current().id).status, $("comment").value);
};
$("previous").onclick = () => navigate(selected - 1);
$("next").onclick = () => navigate(selected + 1);
for (const id of ["search", "category", "statusFilter"])
  $(id).addEventListener("input", renderList);
$("retrySaves").onclick = () => queue.retry();
$("keepLocal").onclick = () => {
  queue.resolve(current().id, true);
  renderCase();
};
$("useServer").onclick = () => {
  queue.resolve(current().id, false);
  renderCase();
};
$("copyRecovery").onclick = async () =>
  notice(
    (await copy(token))
      ? "Recovery code copied. Keep it private."
      : "Copy the code manually from the panel.",
  );
$("dismissRecovery").onclick = () => {
  $("newToken").textContent = "";
  $("recoveryPanel").hidden = true;
};
$("leave").onclick = () => {
  if (
    Object.keys(queue.state.pending).length &&
    !confirm(
      "Pending edits will stay on this device, but need your recovery code to resume. Leave?",
    )
  )
    return;
  store("halo.token", null);
  location.reload();
};
$("joinForm").onsubmit = async (e) => {
  e.preventDefault();
  if (joining) return;
  joining = true;
  $("joinButton").disabled = true;
  notice("");
  try {
    const data = await api("/api/join", {
      method: "POST",
      body: {
        sessionCode: $("sessionCode").value.trim(),
        firstName: $("firstName").value.trim(),
        lastInitial: $("lastInitial").value.trim(),
        team: $("team").value,
        registrationKey,
      },
    });
    if ($("remember").checked) {
      if (!store("halo.token", data.recoveryToken))
        notice("Recovery code could not be remembered. Save it privately.");
    } else store("halo.token", null);
    await enter(data.recoveryToken, true);
    // Retain the registration key until successful entry; retries after response loss recover the same identity.
    registrationKey = random();
    store("halo.registration", registrationKey);
  } catch (e) {
    notice(e.message + " You can retry.");
  } finally {
    joining = false;
    $("joinButton").disabled = false;
  }
};
$("restoreForm").onsubmit = async (e) => {
  e.preventDefault();
  $("restoreButton").disabled = true;
  notice("");
  try {
    const t = $("recovery").value.trim();
    if (!/^[a-f0-9]{64}$/.test(t))
      throw Error("Enter the full 64-character recovery code");
    await enter(t);
    if ($("remember").checked) store("halo.token", t);
    $("recovery").value = "";
  } catch (e) {
    notice(e.message + " You can retry.");
  } finally {
    $("restoreButton").disabled = false;
  }
};
async function restoreSaved() {
  const t = stored("halo.token");
  if (!t) return;
  $("retryRestore").hidden = false;
  $("retryRestore").disabled = true;
  try {
    await enter(t);
    $("retryRestore").hidden = true;
    notice("");
  } catch (e) {
    notice(
      "Could not restore saved participant: " +
        e.message +
        " Pending edits remain on this device. Retry below.",
    );
  } finally {
    $("retryRestore").disabled = false;
  }
}
$("retryRestore").onclick = restoreSaved;
window.addEventListener("online", () => queue?.retry());
window.addEventListener("beforeunload", (e) => {
  if (queue && Object.keys(queue.state.pending).length) {
    e.preventDefault();
    e.returnValue = "";
  }
});
async function config() {
  try {
    const { teams } = await api("/api/config");
    $("team").replaceChildren(
      ...teams.map((t) => {
        const o = element("option", t);
        o.value = t;
        return o;
      }),
    );
  } catch (e) {
    notice("Could not load teams: " + e.message);
    $("team").replaceChildren();
    const b = element("button", "Retry loading teams");
    b.type = "button";
    b.onclick = () => {
      b.remove();
      config();
    };
    $("team").after(b);
  }
}
await config();
await restoreSaved();
