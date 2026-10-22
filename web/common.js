import { API_BASE_URL } from "./config.js";
export async function api(path, { token, method = "GET", body, signal } = {}) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 12000);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const r = await fetch(API_BASE_URL.replace(/\/$/, "") + path, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (path.includes("export.csv") && r.ok) return await r.blob();
    const data = await r.json();
    if (!r.ok)
      throw Object.assign(Error(data.error?.message || "Request failed"), {
        status: r.status,
        ...data.error,
      });
    return data;
  } catch (e) {
    if (e.name === "AbortError")
      throw Error("Request timed out. Retry safely.");
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
export const $ = (id) => document.getElementById(id);
export function element(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
export const labels = {
  pass: "Pass",
  partial_pass: "Partial pass",
  fail: "Fail",
  skipped: "Skipped",
};
export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
export function notice(text) {
  $("message").textContent = text;
}
