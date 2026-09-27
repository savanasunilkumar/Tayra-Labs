"use strict";

const $ = (id) => document.getElementById(id);
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const types = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
const state = { token: "", config: null, health: null, file: null, fileURL: null, duration: null,
  tooLong: false, busy: false, result: null, tab: "answer", job: null, pending: null, pollVersion: 0 };
let toastTimer;

function showError(message) {
  $("error-banner").textContent = message;
  $("error-banner").hidden = false;
}
function clearError() { $("error-banner").hidden = true; }
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4000);
}
function storageRead(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveRecent(job, label) {
  const old = storageRead("video-lab-recent", []);
  const rows = (Array.isArray(old) ? old : []).filter((item) => item.id !== job.id);
  rows.unshift({ id: job.id, label: label || "Video analysis", status: job.status, date: Date.now() });
  try { localStorage.setItem("video-lab-recent", JSON.stringify(rows.slice(0, 8))); } catch { /* Optional history. */ }
  renderHistory();
}
function rememberPending() {
  try {
    if (state.pending) sessionStorage.setItem("video-lab-pending", JSON.stringify(state.pending));
    else sessionStorage.removeItem("video-lab-pending");
  } catch { /* Existing idempotency key remains in memory. */ }
}
function loadPending() {
  try {
    const value = JSON.parse(sessionStorage.getItem("video-lab-pending"));
    if (value?.key && value?.body?.asset_id && typeof value.body.prompt === "string") state.pending = value;
  } catch { /* No pending submission. */ }
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: {
    "X-Playground-Token": state.token,
    ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers,
  } });
  let data;
  try { data = response.status === 204 ? {} : await response.json(); }
  catch { throw new Error("The local bridge returned an unreadable response. Try reconnecting."); }
  if (!response.ok) {
    const error = new Error(typeof data.error === "string" ? data.error : `Request failed (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function updateControls() {
  const canRetry = Boolean(state.pending);
  $("run-button").disabled = state.busy || (!canRetry && (!state.health?.analysis_enabled || !state.file
    || state.tooLong || !$("prompt").value.trim()));
  $("run-label").textContent = state.busy ? "Please wait…" : canRetry ? "Retry existing request" : "Analyze video";
  ["sample-button", "dropzone", "remove-file", "prompt", "max-tokens", "saved-test", "empty-saved-test"]
    .forEach((id) => { $(id).disabled = state.busy || (canRetry && !["saved-test", "empty-saved-test"].includes(id)); });
  document.querySelectorAll("[data-prompt]").forEach((button) => { button.disabled = state.busy || canRetry; });
  $("sample-button").disabled ||= !state.config?.sample_available;
  $("prompt-count").textContent = `${$("prompt").value.length.toLocaleString()} / 4,000`;
  if (state.busy) $("run-hint").textContent = "One request in progress. You can reopen it from Recent tests.";
  else if (canRetry) $("run-hint").textContent = "Submission was interrupted. Retry uses the same job request and idempotency key.";
  else if (!state.health) $("run-hint").textContent = "Connect to the API to submit a test. Your video stays on this device.";
  else if (!state.health.analysis_enabled) $("run-hint").textContent = "GPU paused. Preview videos or explore a saved result—no new inference.";
  else if (state.tooLong) $("run-hint").textContent = "This clip exceeds the five-minute limit. Choose a shorter video.";
  else if (!state.file) $("run-hint").textContent = "Select a video to get started. Nothing is uploaded yet.";
  else $("run-hint").textContent = "Uploads and inference are real and may incur cloud charges.";
}

async function connect() {
  $("reconnect").disabled = true;
  $("connection-label").textContent = "Connecting to API";
  try {
    const response = await fetch("/api/session");
    if (!response.ok) throw new Error("Open this interface using its localhost address.");
    state.config = await response.json();
    state.token = state.config.token;
    state.health = await api("/health");
    $("connection-dot").className = "connection-dot connected";
    $("connection-label").textContent = "Private API connected";
    const enabled = state.health.analysis_enabled === true;
    $("service-notice").classList.toggle("available", enabled);
    $("notice-symbol").textContent = enabled ? "✓" : "◷";
    $("notice-title").textContent = enabled ? "Analysis is enabled" : "GPU paused · preview mode";
    $("notice-description").textContent = enabled
      ? "New tests use real compute. An enabled API does not guarantee a warm GPU; cold starts can take several minutes."
      : "Preview a clip or read saved results. New analysis is disabled until the backend is resumed.";
    clearError();
  } catch (error) {
    state.health = null;
    $("connection-dot").className = "connection-dot disconnected";
    $("connection-label").textContent = "Connection unavailable";
    $("notice-title").textContent = "Reconnect to your private API";
    $("notice-description").textContent = "Use the refresh icon after checking your local Google login. Video preview works offline.";
    $("service-notice").classList.remove("available");
    showError(error.message);
  } finally {
    $("reconnect").disabled = false;
    updateControls();
  }
}

function fileMeta() {
  if (!state.file) return;
  const size = state.file.size < 1024 * 1024 ? `${(state.file.size / 1024).toFixed(0)} KiB`
    : `${(state.file.size / 1024 / 1024).toFixed(1)} MiB`;
  const seconds = Number.isFinite(state.duration) ? ` · ${state.duration.toFixed(1)} seconds` : "";
  $("file-meta").textContent = `${size}${seconds} · Not uploaded until analysis starts`;
}
function selectFile(file) {
  if (state.busy || state.pending || !file) return;
  clearError();
  const extension = file.name.split(".").pop().toLowerCase();
  if (!types[extension]) return showError("Please choose an MP4, MOV, or WebM video.");
  if (!file.size || file.size > 500 * 1024 * 1024) return showError("Choose a non-empty video no larger than 500 MiB.");
  if (state.fileURL) URL.revokeObjectURL(state.fileURL);
  state.file = file;
  state.duration = null;
  state.tooLong = false;
  state.fileURL = URL.createObjectURL(file);
  $("video-preview").src = state.fileURL;
  $("video-selected").hidden = false;
  $("dropzone").hidden = true;
  $("preview-warning").hidden = true;
  $("file-name").textContent = file.name;
  fileMeta();
  updateControls();
}
function removeFile() {
  if (state.busy || state.pending) return;
  $("video-preview").pause();
  $("video-preview").removeAttribute("src");
  $("video-preview").load();
  if (state.fileURL) URL.revokeObjectURL(state.fileURL);
  state.file = state.fileURL = state.duration = null;
  state.tooLong = false;
  $("video-file").value = "";
  $("video-selected").hidden = true;
  $("dropzone").hidden = false;
  updateControls();
}
async function useSample() {
  if (state.busy || state.pending) return;
  $("sample-button").disabled = true;
  try {
    const response = await fetch("/sample/video");
    if (!response.ok) throw new Error("The local sample is unavailable. Choose a video from your computer instead.");
    selectFile(new File([await response.blob()], "penguins-10s.mp4", { type: "video/mp4" }));
  } catch (error) { showError(error.message); }
  finally { updateControls(); }
}

function selectTab(tab) {
  state.tab = tab;
  $("answer-tab").setAttribute("aria-selected", String(tab === "answer"));
  $("json-tab").setAttribute("aria-selected", String(tab === "json"));
  $("answer-view").hidden = !state.result || tab !== "answer";
  $("json-view").hidden = !state.result || tab !== "json";
}
function showProgress(title, detail, percent = 0) {
  state.result = null;
  $("empty-output").hidden = true;
  $("processing-view").hidden = false;
  $("processing-title").textContent = title;
  $("processing-detail").textContent = detail;
  $("upload-progress").style.width = `${percent}%`;
  $("output-status").textContent = title.toUpperCase();
  $("output-status").className = "output-status working";
  $("copy-result").disabled = $("download-result").disabled = true;
  selectTab("answer");
}
function showResult(result, saved) {
  state.result = result;
  $("processing-view").hidden = $("empty-output").hidden = true;
  $("output-status").textContent = saved ? "SAVED RESULT" : "COMPLETED";
  $("output-status").className = "output-status done";
  $("answer-origin").textContent = saved ? "PREVIOUS TEST · NOT A NEW ANALYSIS" : "MOLMO2-8B RESPONSE";
  $("answer-text").textContent = result.output?.text || "No text was returned by the model.";
  const metrics = result.metrics || {};
  const seconds = (n, divisor = 1) => Number.isFinite(n) ? `${(n / divisor).toFixed(2)}s` : "—";
  $("metric-video").textContent = seconds(metrics.video_seconds);
  $("metric-worker").textContent = seconds(metrics.worker_ms, 1000);
  $("metric-generation").textContent = seconds(metrics.gpu_execution_ms, 1000);
  $("metric-tokens").textContent = metrics.output_tokens ?? "—";
  $("detail-job").textContent = result.job_id || "—";
  $("detail-model").textContent = result.model_id || "—";
  $("detail-revision").textContent = result.model_revision || "—";
  $("json-output").textContent = JSON.stringify(result, null, 2);
  $("copy-result").disabled = $("download-result").disabled = false;
  $("cancel-job").hidden = true;
  selectTab("answer");
}
function failedOutput(message) {
  $("processing-view").hidden = true;
  $("empty-output").hidden = false;
  $("output-status").textContent = "NEEDS ATTENTION";
  $("output-status").className = "output-status";
  showError(message);
}
function uploadVideo(assetId, file) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", `/api/assets/${assetId}/content`);
    request.setRequestHeader("X-Playground-Token", state.token);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.timeout = 660000;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = Math.round(event.loaded / event.total * 100);
        showProgress("Uploading video", percent === 100 ? "Finishing the private cloud upload…" : `${percent}% sent to the local bridge`, percent);
      }
    };
    request.onload = () => {
      let data;
      try { data = JSON.parse(request.responseText); } catch { data = {}; }
      if (request.status >= 200 && request.status < 300) resolve(data);
      else reject(new Error(data.error || "Upload failed. Select your video again and retry."));
    };
    request.onerror = () => reject(new Error("The upload connection was interrupted. No analysis was submitted."));
    request.ontimeout = () => reject(new Error("Video upload timed out. No analysis was submitted."));
    request.send(file);
  });
}

async function pollJob(job, label, saved = false) {
  const version = ++state.pollVersion;
  state.job = job;
  saveRecent(job, label);
  const deadline = Date.now() + 9300000;
  let failures = 0;
  while (!terminal.has(job.status)) {
    if (version !== state.pollVersion) return;
    if (Date.now() >= deadline) throw new Error("Polling stopped after the queue deadline. Reopen this job from Recent tests; do not submit a duplicate.");
    const running = job.status === "running";
    const cancelling = job.status === "cancel_requested";
    showProgress(cancelling ? "Cancellation requested" : running ? "Analyzing video" : "Waiting for a worker",
      cancelling ? "Running work may finish at a safe boundary and can still incur charges."
        : running ? "Molmo is examining the video. This page will update when it finishes."
          : "Your job is queued. A cold worker may take several minutes to load the model.");
    $("cancel-job").hidden = false;
    $("cancel-job").disabled = cancelling;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      job = (await api(`/jobs/${job.id}`)).job;
      state.job = job;
      failures = 0;
    } catch (error) {
      failures++;
      if (failures >= 3) throw new Error(`${error.message} Reopen the existing job from Recent tests to continue checking.`);
    }
  }
  $("cancel-job").hidden = true;
  saveRecent(job, label);
  if (job.status === "succeeded") {
    showProgress("Loading result", "Fetching the saved response from private storage.");
    showResult(await api(`/jobs/${job.id}/result`), saved);
  } else {
    throw new Error(job.error?.message || `This analysis ${job.status.replaceAll("_", " ")}. No new job was submitted.`);
  }
}

async function analyze() {
  if ($("run-button").disabled) return;
  clearError();
  state.busy = true;
  state.job = null;
  updateControls();
  let assetId = null;
  try {
    if (!state.pending) {
      showProgress("Preparing upload", "Checking the API and registering your video.");
      const file = state.file;
      const extension = file.name.split(".").pop().toLowerCase();
      const created = await api("/assets", { method: "POST", body: JSON.stringify({
        filename: file.name, content_type: types[extension], size_bytes: file.size,
      }) });
      assetId = created.asset.id;
      showProgress("Uploading video", "Sending your file to private Cloud Storage.");
      await uploadVideo(assetId, file);
      state.pending = { key: crypto.randomUUID(), label: file.name, body: {
        asset_id: assetId, prompt: $("prompt").value.trim(), max_new_tokens: Number($("max-tokens").value),
      } };
      rememberPending();
    }
    showProgress("Submitting analysis", "Creating one job with a stable idempotency key.");
    const label = state.pending.label;
    const data = await api("/jobs", { method: "POST", headers: { "Idempotency-Key": state.pending.key },
      body: JSON.stringify(state.pending.body) });
    // Keep the same request after any ambiguous submission error; never silently duplicate inference.
    state.pending = null;
    rememberPending();
    await pollJob(data.job, label);
  } catch (error) {
    if (assetId && !state.pending && !state.job) {
      // Upload failed before a job was attempted. Best-effort cleanup of this new source only.
      try { await api(`/assets/${assetId}`, { method: "DELETE" }); } catch { /* Normal retention is the backstop. */ }
    }
    failedOutput(error.message);
  } finally {
    state.busy = false;
    updateControls();
  }
}

async function openJob(id, label) {
  if (state.busy) return toast("Wait for the current operation to finish before opening another result.");
  if (!state.token) return showError("Connect to the local bridge first.");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return showError("That saved job ID is invalid.");
  clearError();
  state.busy = true;
  updateControls();
  showProgress("Loading saved test", "Reading an existing job. This does not run inference.");
  try {
    const { job } = await api(`/jobs/${id}`);
    await pollJob(job, label, true);
  } catch (error) { failedOutput(error.message); }
  finally { state.busy = false; updateControls(); }
}
function openPilot() { if (state.config) openJob(state.config.saved_job, "Penguins & places"); }
function renderHistory() {
  $("history-list").querySelectorAll(".local-history").forEach((item) => item.remove());
  const rows = storageRead("video-lab-recent", []);
  if (!Array.isArray(rows)) return;
  rows.filter((item) => item.id !== state.config?.saved_job).slice(0, 8).forEach((item) => {
    if (typeof item.id !== "string" || typeof item.label !== "string") return;
    const button = document.createElement("button");
    button.className = "history-item local-history";
    const icon = document.createElement("span"); icon.className = "history-icon"; icon.textContent = "↗";
    const body = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = item.label;
    const detail = document.createElement("small");
    detail.textContent = `${new Date(item.date).toLocaleString()} · ${item.id.slice(0, 8)}`;
    body.append(title, detail);
    const badge = document.createElement("span"); badge.className = "history-badge"; badge.textContent = item.status || "Open job";
    const arrow = document.createElement("span"); arrow.className = "history-arrow"; arrow.textContent = "→";
    button.append(icon, body, badge, arrow);
    button.addEventListener("click", () => openJob(item.id, item.label));
    $("history-list").append(button);
  });
}

$("dropzone").addEventListener("click", () => $("video-file").click());
$("video-file").addEventListener("change", (event) => selectFile(event.target.files[0]));
$("dropzone").addEventListener("dragover", (event) => { event.preventDefault(); $("dropzone").classList.add("dragging"); });
$("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("dragging"));
$("dropzone").addEventListener("drop", (event) => { event.preventDefault(); $("dropzone").classList.remove("dragging"); selectFile(event.dataTransfer.files[0]); });
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());
$("remove-file").addEventListener("click", removeFile);
$("sample-button").addEventListener("click", useSample);
$("video-preview").addEventListener("loadedmetadata", () => {
  state.duration = $("video-preview").duration;
  state.tooLong = Number.isFinite(state.duration) && state.duration > 300;
  fileMeta(); updateControls();
  if (state.tooLong) showError("This video is longer than five minutes. Choose a shorter clip.");
});
$("video-preview").addEventListener("error", () => {
  if (!state.file) return;
  $("preview-warning").textContent = "Your browser cannot preview this codec. The worker will validate it before analysis.";
  $("preview-warning").hidden = false;
});
$("prompt").addEventListener("input", updateControls);
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
  $("prompt").value = button.dataset.prompt; updateControls();
}));
$("run-button").addEventListener("click", analyze);
$("reconnect").addEventListener("click", connect);
$("saved-test").addEventListener("click", openPilot);
$("empty-saved-test").addEventListener("click", openPilot);
$("pilot-history").addEventListener("click", openPilot);
$("answer-tab").addEventListener("click", () => selectTab("answer"));
$("json-tab").addEventListener("click", () => selectTab("json"));
[$("answer-tab"), $("json-tab")].forEach((tab) => tab.addEventListener("keydown", (event) => {
  if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault(); selectTab(state.tab === "answer" ? "json" : "answer");
    $(state.tab === "answer" ? "answer-tab" : "json-tab").focus();
  }
}));
$("copy-result").addEventListener("click", async () => {
  if (!state.result) return;
  try {
    await navigator.clipboard.writeText(state.tab === "json" ? JSON.stringify(state.result, null, 2) : state.result.output.text);
    toast("Result copied.");
  } catch { toast("Clipboard access is unavailable. Use Download JSON instead."); }
});
$("download-result").addEventListener("click", () => {
  if (!state.result) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(state.result, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `molmo-${state.result.job_id}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("cancel-job").addEventListener("click", async () => {
  if (!state.job || !window.confirm("Request cancellation? Work already running can still incur charges.")) return;
  $("cancel-job").disabled = true;
  try {
    state.job = (await api(`/jobs/${state.job.id}/cancel`, { method: "POST" })).job;
    toast("Cancellation requested. Running work may stop at a safe boundary.");
  } catch (error) { showError(error.message); $("cancel-job").disabled = false; }
});
$("history-nav").addEventListener("click", () => $("history-section").scrollIntoView({ behavior: "smooth" }));
$("guide-open").addEventListener("click", () => $("guide-dialog").showModal());
$("guide-close").addEventListener("click", () => $("guide-dialog").close());
$("guide-dialog").addEventListener("click", (event) => {
  if (event.target === $("guide-dialog")) {
    const box = $("guide-dialog").getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $("guide-dialog").close();
  }
});
window.addEventListener("beforeunload", (event) => { if (state.busy) { event.preventDefault(); event.returnValue = ""; } });
loadPending();
if (state.pending) $("prompt").value = state.pending.body.prompt;
updateControls();
connect().then(renderHistory);
