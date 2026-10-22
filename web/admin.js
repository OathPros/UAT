import { api, $, element, labels, copy, notice } from "./common.js";
let token = "",
  page = 1,
  total = 0,
  loading = false,
  joinCode = "";
const params = () => {
  const p = new URLSearchParams();
  for (const k of [
    "session",
    "team",
    "status",
    "category",
    "test",
    "priority",
    "q",
    "sort",
  ])
    if ($(k).value.trim()) p.set(k, $(k).value.trim());
  return p;
};
const request = (path, options = {}) => api(path, { token, ...options });
function list(id, rows, format) {
  $(id).replaceChildren(
    ...(rows.length
      ? rows.map((r) => element("p", format(r)))
      : [element("p", "None.")]),
  );
}
async function loadSessions() {
  const { sessions } = await request("/api/admin/sessions");
  const value = $("session").value;
  $("session").replaceChildren(element("option", "All sessions"));
  $("session").firstChild.value = "";
  $("sessions").replaceChildren();
  for (const s of sessions) {
    const o = element("option", s.name + (s.active ? "" : " (closed)"));
    o.value = s.id;
    $("session").append(o);
    const row = element(
      "p",
      `${s.name} · ${s.mode} · ${s.assigned} assigned · ${s.active ? "Open" : "Closed"} `,
    );
    const b = element("button", s.active ? "Close" : "Reopen");
    b.onclick = async () => {
      b.disabled = true;
      try {
        await request("/api/admin/sessions/" + s.id, {
          method: "PATCH",
          body: { active: !s.active },
        });
        await loadSessions();
        await refresh();
      } catch (e) {
        notice(e.message);
      } finally {
        b.disabled = false;
      }
    };
    row.append(b);
    $("sessions").append(row);
  }
  $("session").value = value;
}
async function refresh() {
  if (loading) return;
  loading = true;
  $("refresh").disabled = true;
  notice("");
  try {
    const p = params();
    p.set("page", page);
    const [report, { summary: s }] = await Promise.all([
      request("/api/admin/results?" + p),
      request("/api/admin/summary?" + p),
    ]);
    total = report.total;
    $("rows").replaceChildren();
    for (const r of report.rows) {
      const tr = element("tr");
      for (const v of [
        `${r.session_name}\n${r.first_name} ${r.last_initial}`,
        r.team,
        `${r.test_id} · ${r.title}`,
        `${r.category}\n${r.priority}`,
        labels[r.status],
        r.comment,
        r.updated_at,
      ])
        tr.append(element("td", v));
      tr.children[4].replaceChildren(
        element("span", labels[r.status], "badge " + r.status),
      );
      tr.children[5].className = "comment";
      $("rows").append(tr);
    }
    if (!report.rows.length) {
      const tr = element("tr"),
        td = element("td", "No matching confirmed results.");
      td.colSpan = 7;
      tr.append(td);
      $("rows").append(tr);
    }
    $("pageInfo").textContent = `Page ${page} · ${total} matching results`;
    $("prevPage").disabled = page <= 1;
    $("nextPage").disabled = page * 50 >= total;
    const metrics = {
      Participants: s.participants,
      "Assigned cases": s.assignedTests,
      "Expected executions": s.expected,
      Confirmed: s.confirmed,
      Outstanding: s.outstanding,
      "Filtered results": s.filteredResults,
      Pass: s.counts.pass,
      "Partial pass": s.counts.partial_pass,
      Fail: s.counts.fail,
      Skipped: s.counts.skipped,
      Completion: (s.completion * 100).toFixed(1) + "%",
      "Pass rate":
        s.passRate === null ? "—" : (s.passRate * 100).toFixed(1) + "%",
    };
    $("metrics").replaceChildren(
      ...Object.entries(metrics).map(([name, v]) => {
        const d = element("div", undefined, "metric");
        d.append(element("strong", v), element("span", name));
        return d;
      }),
    );
    $("reportNote").textContent =
      "Expected / confirmed / outstanding and completion use session, team and catalogue filters. Outcome counts and pass rate also use outcome/search filters. Pass rate excludes Skipped and not-started.";
    list(
      "recurring",
      s.recurring,
      (r) => `${r.test_id}: ${r.count} issues · ${r.teams.join(", ")}`,
    );
    list("unexecuted", s.unexecuted, (r) => `${r.id} · ${r.title}`);
    list(
      "lastSubmissions",
      s.lastSubmissions,
      (r) =>
        `${r.first_name} ${r.last_initial} · ${r.team} · ${r.last_submission || "No submission"}`,
    );
  } catch (e) {
    notice(e.message + " Retry Refresh.");
  } finally {
    loading = false;
    $("refresh").disabled = false;
  }
}
$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  $("loginButton").disabled = true;
  token = $("adminKey").value;
  $("adminKey").value = "";
  notice("");
  try {
    await loadSessions();
    const { teams } = await api("/api/config");
    $("team").replaceChildren(element("option", "All teams"));
    $("team").firstChild.value = "";
    for (const t of teams) {
      const o = element("option", t);
      o.value = t;
      $("team").append(o);
    }
    $("login").hidden = true;
    $("dashboard").hidden = false;
    await refresh();
  } catch (e) {
    token = "";
    notice(e.message + " You can retry.");
  } finally {
    $("loginButton").disabled = false;
  }
};
$("logout").onclick = () => {
  token = "";
  location.reload();
};
$("refresh").onclick = refresh;
$("apply").onclick = () => {
  page = 1;
  refresh();
};
$("prevPage").onclick = () => {
  page--;
  refresh();
};
$("nextPage").onclick = () => {
  page++;
  refresh();
};
async function exportCsv(issues) {
  notice("");
  try {
    const p = params();
    if (issues) {
      p.delete("status");
      p.set("issues", "1");
    }
    const blob = await request("/api/admin/export.csv?" + p),
      url = URL.createObjectURL(blob),
      a = element("a");
    a.href = url;
    a.download = issues ? "halo-uat-issues.csv" : "halo-uat-results.csv";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    notice(e.message + " Retry export.");
  }
}
$("export").onclick = () => exportCsv(false);
$("exportIssues").onclick = () => exportCsv(true);
$("sessionForm").onsubmit = async (e) => {
  e.preventDefault();
  $("createSession").disabled = true;
  notice("");
  try {
    const data = await request("/api/admin/sessions", {
      method: "POST",
      body: {
        name: $("sessionTitle").value.trim(),
        mode: $("mode").value,
        testIds: $("customIds")
          .value.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      },
    });
    joinCode = data.joinCode;
    $("joinCode").textContent = joinCode;
    $("codePanel").hidden = false;
    await loadSessions();
    await refresh();
  } catch (e) {
    notice(
      e.message +
        " Check sessions before retrying if the request timed out; a session may have been created.",
    );
  } finally {
    $("createSession").disabled = false;
  }
};
$("copyCode").onclick = async () =>
  notice(
    (await copy(joinCode))
      ? "Join code copied. Share privately."
      : "Select and copy the code manually.",
  );
