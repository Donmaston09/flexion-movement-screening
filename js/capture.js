// Flexion — patient capture flow.
// Loads MediaPipe's PoseLandmarker (Tasks Vision, WASM, runs entirely
// in-browser — no video leaves the device for scoring), runs the guided
// movement routine, and produces a session report using js/scoring.js.

import {
  PoseLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const video = document.getElementById("video");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const instructionEl = document.getElementById("instruction");
const metricEl = document.getElementById("liveMetric");
const timerEl = document.getElementById("timer");
const startBtn = document.getElementById("startBtn");
const summaryEl = document.getElementById("summary");
const saveBtn = document.getElementById("saveBtn");
const downloadBtn = document.getElementById("downloadBtn");
const patientNameInput = document.getElementById("patientName");
const trackingQualityEl = document.getElementById("trackingQuality");

// How long good/fair framing must hold before the timed routine begins.
// Standardizing camera setup before scoring starts is a direct response
// to literature calling for protocol standardization (camera position,
// framing, full-body visibility) in virtual MSK exams — see Tanaka et
// al. 2020 and the accuracy-vs-framing findings in Ruder et al. 2026.
const CALIBRATION_HOLD_MS = 1200;

const ROUTINE = [
  {
    key: "squat",
    label: "Bodyweight Squats",
    instruction: "Stand facing the camera, feet hip-width apart. Perform 5 slow squats.",
    kind: "reps",
    target: 5,
    makeTracker: () => FlexionScoring.createSquatTracker(),
    isDone: (tracker) => tracker._state.reps.length >= 5,
    liveText: (tracker) => `Reps: ${tracker._state.reps.length} / 5  ·  Phase: ${tracker._state.phase}`,
  },
  {
    key: "sit_to_stand",
    label: "5x Sit-to-Stand",
    instruction: "Sit in a stable chair, arms crossed if safe. Stand fully upright and sit back down 5 times, as briskly as is safe.",
    kind: "reps",
    target: 5,
    makeTracker: () => FlexionScoring.createSitToStandTracker(),
    isDone: (tracker) => tracker._state.reps.length >= 5,
    liveText: (tracker) => `Reps: ${tracker._state.reps.length} / 5  ·  Phase: ${tracker._state.phase}`,
  },
  {
    key: "arm_raise",
    label: "Arm Raises",
    instruction: "Raise both arms overhead and lower, 3 times, at a comfortable pace.",
    kind: "duration",
    seconds: 15,
    makeTracker: () => FlexionScoring.createArmRaiseTracker(),
    liveText: (tracker) =>
      `Max L: ${Math.round(tracker._state.maxLeft)}°  Max R: ${Math.round(tracker._state.maxRight)}°`,
  },
  {
    key: "balance_left",
    label: "Single-Leg Balance — Left",
    instruction: "Stand on your left leg. Hold as steady as you can.",
    kind: "duration",
    seconds: 10,
    makeTracker: () => FlexionScoring.createBalanceTracker(),
    liveText: (tracker) => `Hold time: ${tracker._state.positions.length} frames`,
  },
  {
    key: "balance_right",
    label: "Single-Leg Balance — Right",
    instruction: "Stand on your right leg. Hold as steady as you can.",
    kind: "duration",
    seconds: 10,
    makeTracker: () => FlexionScoring.createBalanceTracker(),
    liveText: (tracker) => `Hold time: ${tracker._state.positions.length} frames`,
  },
  {
    key: "walk_in_place",
    label: "Walk in Place",
    instruction: "March in place, lifting your knees, for 15 seconds.",
    kind: "duration",
    seconds: 15,
    makeTracker: () => FlexionScoring.createWalkTracker(),
    liveText: (tracker) => `Steps: ${tracker._state.left.steps.length + tracker._state.right.steps.length}`,
  },
];

let poseLandmarker = null;
let running = false;
let mode = "idle"; // idle | calibrating | routine
let stepIndex = -1;
let currentTracker = null;
let stepStartTs = null;
let lastVideoTime = -1;
let calibrationGoodSinceTs = null;
const results = [];

async function initPoseLandmarker() {
  statusEl.textContent = "Loading pose model...";
  const filesetResolver = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  poseLandmarker = await PoseLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numPoses: 1,
  });
  statusEl.textContent = "Model loaded. Click Start Routine.";
}

async function initCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((resolve) => (video.onloadedmetadata = resolve));
  video.play();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

function drawFrame(landmarkResult) {
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (landmarkResult && landmarkResult.landmarks && landmarkResult.landmarks[0]) {
    const drawer = new DrawingUtils(ctx);
    drawer.drawLandmarks(landmarkResult.landmarks[0], { radius: 3 });
    drawer.drawConnectors(landmarkResult.landmarks[0], PoseLandmarker.POSE_CONNECTIONS);
  }
  ctx.restore();
}

function updateTrackingQualityUI(quality) {
  if (!trackingQualityEl) return;
  trackingQualityEl.textContent = `Tracking: ${quality.tier} (${quality.visibleCount}/${quality.totalRequired} key points, ${quality.ratioPct}%)`;
  trackingQualityEl.className = `tracking-quality tier-${quality.tier}`;
}

function renderLoop() {
  if (!running) return;
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const nowMs = performance.now();
    const result = poseLandmarker.detectForVideo(video, nowMs);
    drawFrame(result);

    const lm = result.landmarks && result.landmarks[0];
    const quality = FlexionScoring.computeFrameQuality(lm);
    updateTrackingQualityUI(quality);

    if (mode === "calibrating") {
      runCalibrationFrame(quality, nowMs);
    } else if (mode === "routine") {
      const step = ROUTINE[stepIndex];
      if (step && currentTracker) {
        currentTracker.addFrame(lm, nowMs);
        metricEl.textContent = step.liveText(currentTracker);

        const elapsed = (nowMs - stepStartTs) / 1000;
        if (step.kind === "duration") {
          const remaining = Math.max(0, step.seconds - elapsed);
          timerEl.textContent = `${remaining.toFixed(1)}s`;
          if (remaining <= 0) advanceStep();
        } else if (step.kind === "reps") {
          timerEl.textContent = `${currentTracker._state.reps.length}/${step.target} reps`;
          if (step.isDone(currentTracker)) advanceStep();
          if (elapsed > 60) advanceStep(); // safety timeout
        }
      }
    }
  }
  requestAnimationFrame(renderLoop);
}

// Requires "good" or "fair" full-body framing to hold for
// CALIBRATION_HOLD_MS before the timed routine starts, so a poor camera
// setup doesn't silently produce unreliable scores (see literature note
// on framing/space constraints in Ruder et al. 2026 and Tanaka et al.
// 2020's call for standardized virtual-exam setup).
function runCalibrationFrame(quality, nowMs) {
  const framingOk = quality.tier === "good" || quality.tier === "fair";
  if (framingOk) {
    if (calibrationGoodSinceTs == null) calibrationGoodSinceTs = nowMs;
    const heldMs = nowMs - calibrationGoodSinceTs;
    const remaining = Math.max(0, CALIBRATION_HOLD_MS - heldMs);
    instructionEl.textContent = "Great — hold still, starting the routine...";
    timerEl.textContent = remaining > 0 ? `${(remaining / 1000).toFixed(1)}s` : "";
    if (heldMs >= CALIBRATION_HOLD_MS) {
      mode = "routine";
      timerEl.textContent = "";
      advanceStep();
    }
  } else {
    calibrationGoodSinceTs = null;
    timerEl.textContent = "";
    instructionEl.textContent =
      quality.tier === "no_pose"
        ? "No one detected. Step into frame, facing the camera."
        : "Step back so your whole body — shoulders to ankles — is visible in the frame.";
  }
}

function advanceStep() {
  if (stepIndex >= 0 && currentTracker) {
    const finishedStep = ROUTINE[stepIndex];
    const summary = currentTracker.summarize();
    summary.stepKey = finishedStep.key; // disambiguates e.g. balance_left vs balance_right
    summary.stepLabel = finishedStep.label;
    results.push(summary);
  }
  stepIndex += 1;
  if (stepIndex >= ROUTINE.length) {
    finishRoutine();
    return;
  }
  const step = ROUTINE[stepIndex];
  currentTracker = step.makeTracker();
  stepStartTs = performance.now();
  instructionEl.textContent = `${stepIndex + 1}/${ROUTINE.length} — ${step.label}: ${step.instruction}`;
}

function finishRoutine() {
  running = false;
  instructionEl.textContent = "Routine complete.";
  timerEl.textContent = "";
  metricEl.textContent = "";
  renderSummary();
}

function renderSummary() {
  summaryEl.innerHTML = "";
  results.forEach((r) => {
    const card = document.createElement("div");
    card.className = "score-card";
    const flagsHtml = r.flags && r.flags.length
      ? `<div class="flags">⚠ ${r.flags.join(", ").replace(/_/g, " ")}</div>`
      : `<div class="flags ok">No flags</div>`;
    const evidenceHtml = r.evidence ? formatEvidence(r.evidence) : "";
    card.innerHTML = `<h3>${(r.stepLabel || r.movement).replace(/_/g, " ")}</h3>${evidenceHtml}${formatMetrics(r)}${flagsHtml}`;
    summaryEl.appendChild(card);
  });
  saveBtn.disabled = false;
  downloadBtn.disabled = false;
}

function formatEvidence(ev) {
  return `<div class="evidence evidence-${ev.tier}">
    <span class="evidence-badge">${ev.label}</span>
    <p class="evidence-note">${ev.note}</p>
    <p class="evidence-citation">${ev.citation}</p>
  </div>`;
}

function formatMetrics(r) {
  const skip = new Set(["movement", "flags", "reps", "stepKey", "stepLabel", "evidence"]);
  return Object.entries(r)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `<div class="metric-row"><span>${labelize(k)}</span><span>${v ?? "—"}</span></div>`)
    .join("");
}

function labelize(k) {
  return k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function buildReport() {
  const patientName = patientNameInput.value.trim() || "Unnamed Patient";
  return {
    reportId: `flexion-${Date.now()}`,
    patientName,
    capturedAt: new Date().toISOString(),
    routine: results,
    // Mock FHIR-style observations so a real integration can map 1:1
    // onto Observation resources pushed to the patient's record. The
    // evidence tier/citation rides along as a note so a clinician reading
    // this in the EHR sees the same confidence framing as the dashboard,
    // not a bare number presented as if every movement were equally
    // well-validated.
    fhirObservations: results.map((r) => ({
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "exam" }] }],
      code: { text: `Flexion movement screen — ${r.movement}` },
      effectiveDateTime: new Date().toISOString(),
      valueString: JSON.stringify(r),
      note: r.evidence
        ? [{ text: `${r.evidence.label}: ${r.evidence.note} (${r.evidence.citation})` }]
        : undefined,
    })),
  };
}

function saveReport() {
  const report = buildReport();
  const all = JSON.parse(localStorage.getItem("flexion_reports") || "[]");
  all.push(report);
  localStorage.setItem("flexion_reports", JSON.stringify(all));
  statusEl.textContent = "Saved. Provider dashboard will show this session.";
}

function downloadReport() {
  const report = buildReport();
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${report.reportId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  results.length = 0;
  stepIndex = -1;
  calibrationGoodSinceTs = null;
  summaryEl.innerHTML = "";
  saveBtn.disabled = true;
  downloadBtn.disabled = true;
  try {
    if (!poseLandmarker) await initPoseLandmarker();
    await initCamera();
    running = true;
    mode = "calibrating";
    instructionEl.textContent = "Step back so your whole body — shoulders to ankles — is visible in the frame.";
    renderLoop();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}. Camera access is required.`;
  } finally {
    startBtn.disabled = false;
  }
});

saveBtn.addEventListener("click", saveReport);
downloadBtn.addEventListener("click", downloadReport);

initPoseLandmarker().catch((err) => {
  statusEl.textContent = `Could not load pose model: ${err.message}`;
});
