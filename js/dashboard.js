// Flexion — provider dashboard (prototype).
// Reads sessions saved to this browser's localStorage by capture.html and
// renders a sortable table plus a trend chart per patient/movement.
// In a production build, this would instead call a backend API that
// stores sessions server-side per authenticated provider/patient — see
// the "Data flow" section of the technical spec for the intended design.

const patientFilter = document.getElementById("patientFilter");
const movementFilter = document.getElementById("movementFilter");
const clearBtn = document.getElementById("clearBtn");
const seedBtn = document.getElementById("seedBtn");
const tableWrap = document.getElementById("tableWrap");
let chart = null;

const KEY_METRIC = {
  squat: (r) => (r.stepKey === "squat" ? r.avgDepthDeg : undefined),
  sit_to_stand: (r) => (r.stepKey === "sit_to_stand" ? r.totalTimeSec : undefined),
  arm_raise: (r) =>
    r.stepKey === "arm_raise" ? round1((r.maxLeftDeg + r.maxRightDeg) / 2) : undefined,
  balance: (r) =>
    r.stepKey === "balance_left" || r.stepKey === "balance_right" ? r.stabilityScore : undefined,
  walk_in_place: (r) => (r.stepKey === "walk_in_place" ? r.cadenceStepsPerMin : undefined),
};

const METRIC_LABEL = {
  squat: "Avg squat depth (deg knee flexion)",
  sit_to_stand: "5x Sit-to-Stand time (sec, lower is better)",
  arm_raise: "Avg max arm-raise ROM (deg)",
  balance: "Balance stability score (0-100)",
  walk_in_place: "Walk cadence (steps/min)",
};

function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

function loadReports() {
  return JSON.parse(localStorage.getItem("flexion_reports") || "[]");
}

function uniquePatients(reports) {
  return [...new Set(reports.map((r) => r.patientName))];
}

function populatePatientFilter(reports) {
  const current = patientFilter.value;
  patientFilter.innerHTML = '<option value="all">All patients</option>';
  uniquePatients(reports).forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    patientFilter.appendChild(opt);
  });
  if ([...patientFilter.options].some((o) => o.value === current)) patientFilter.value = current;
}

function flattenSessions(reports) {
  const rows = [];
  reports.forEach((report) => {
    report.routine.forEach((r) => {
      rows.push({
        patientName: report.patientName,
        capturedAt: report.capturedAt,
        stepKey: r.stepKey,
        stepLabel: r.stepLabel,
        flags: r.flags || [],
        raw: r,
      });
    });
  });
  return rows.sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
}

function renderTable(rows) {
  if (!rows.length) {
    tableWrap.innerHTML = `<div class="empty-state">No sessions yet. Run a routine in the patient capture app (capture.html) and click "Save to Provider Dashboard".</div>`;
    return;
  }
  const html = `
    <table>
      <thead>
        <tr><th>Date</th><th>Patient</th><th>Movement</th><th>Key metric</th><th>Confidence</th><th>Flags</th></tr>
      </thead>
      <tbody>
        ${rows
          .map((row) => {
            const movementKey = movementFamily(row.stepKey);
            const metricFn = KEY_METRIC[movementKey];
            const metric = metricFn ? metricFn(row.raw) : undefined;
            const flagged = row.flags.length > 0;
            const evidence = (typeof FlexionScoring !== "undefined" && FlexionScoring.getEvidence(movementKey)) || row.raw.evidence;
            const confidencePill = evidence
              ? `<span class="confidence-pill tier-${evidence.tier}" title="${escapeHtml(evidence.note)} (${escapeHtml(evidence.citation)})">${evidence.tier}</span>`
              : "—";
            return `<tr class="${flagged ? "flagged" : ""}">
              <td>${new Date(row.capturedAt).toLocaleString()}</td>
              <td>${escapeHtml(row.patientName)}</td>
              <td>${row.stepLabel || row.stepKey}</td>
              <td>${metric ?? "—"}</td>
              <td>${confidencePill}</td>
              <td>${flagged ? row.flags.join(", ").replace(/_/g, " ") : "—"}</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
  tableWrap.innerHTML = html;
}

function movementFamily(stepKey) {
  if (!stepKey) return null;
  if (stepKey.startsWith("balance")) return "balance";
  return stepKey;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderChart(rows) {
  const movementKey = movementFilter.value;
  const metricFn = KEY_METRIC[movementKey];
  const filtered = rows
    .filter((r) => movementFamily(r.stepKey) === movementKey)
    .map((r) => ({ x: new Date(r.capturedAt), y: metricFn(r.raw) }))
    .filter((p) => p.y != null)
    .sort((a, b) => a.x - b.x);

  const ctx = document.getElementById("trendChart");
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          label: METRIC_LABEL[movementKey],
          data: filtered,
          borderColor: "#4fd1c5",
          backgroundColor: "rgba(79,209,197,0.15)",
          tension: 0.25,
          pointRadius: 4,
          fill: true,
        },
      ],
    },
    options: {
      scales: {
        x: { type: "time", time: { unit: "day" }, ticks: { color: "#9fb0c9" }, grid: { color: "#223049" } },
        y: { ticks: { color: "#9fb0c9" }, grid: { color: "#223049" } },
      },
      plugins: { legend: { labels: { color: "#e7ecf5" } } },
    },
  });
}

function refresh() {
  const reports = loadReports();
  populatePatientFilter(reports);
  let rows = flattenSessions(reports);
  if (patientFilter.value !== "all") rows = rows.filter((r) => r.patientName === patientFilter.value);
  renderTable(rows);
  renderChart(rows);
}

patientFilter.addEventListener("change", refresh);
movementFilter.addEventListener("change", refresh);
clearBtn.addEventListener("click", () => {
  if (confirm("Clear all demo session data from this browser?")) {
    localStorage.removeItem("flexion_reports");
    refresh();
  }
});

seedBtn.addEventListener("click", () => {
  seedSampleData();
  refresh();
});

// Generates 6 weekly sessions of synthetic-but-plausible data for a demo
// chronic-low-back-pain patient, showing gradual improvement in squat
// depth and a mild persistent L/R asymmetry flag — the kind of trend a
// provider would want to see between visits.
function seedSampleData() {
  const existing = loadReports();
  const patientName = "Demo Patient — J. Alvarez";
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const sessions = [];
  for (let week = 5; week >= 0; week--) {
    const capturedAt = new Date(now - week * weekMs).toISOString();
    const progress = (5 - week) / 5; // 0 -> 1 improvement over 6 weeks
    const squatDepth = 62 + progress * 30 + rand(-3, 3);
    const asym = Math.max(4, 22 - progress * 14 + rand(-2, 2));
    const stsTime = Math.max(8, 16 - progress * 6 + rand(-1, 1));
    const armRom = 110 + progress * 45 + rand(-4, 4);
    const stability = 55 + progress * 30 + rand(-5, 5);
    const cadence = 70 + progress * 20 + rand(-5, 5);

    const evidence = (typeof FlexionScoring !== "undefined" && FlexionScoring.EVIDENCE) || {};

    const routine = [
      {
        movement: "squat", stepKey: "squat", stepLabel: "Bodyweight Squats",
        repsCompleted: 5, repsTarget: 5,
        avgDepthDeg: round1(squatDepth), avgAsymmetryPct: round1(asym), avgTrunkLeanDeg: round1(18 - progress * 6),
        flags: asym > 15 ? ["left_right_asymmetry"] : [],
        evidence: evidence.squat,
      },
      {
        movement: "sit_to_stand", stepKey: "sit_to_stand", stepLabel: "5x Sit-to-Stand",
        repsCompleted: 5, totalTimeSec: round1(stsTime), avgTimePerRepSec: round1(stsTime / 5),
        flags: stsTime > 12 ? ["slow_sit_to_stand_time"] : [],
        evidence: evidence.sit_to_stand,
      },
      {
        movement: "arm_raise", stepKey: "arm_raise", stepLabel: "Arm Raises",
        maxLeftDeg: round1(armRom + rand(-3, 3)), maxRightDeg: round1(armRom + rand(-3, 3)),
        asymmetryPct: round1(rand(2, 9)), flags: [],
        evidence: evidence.arm_raise,
      },
      {
        movement: "balance", stepKey: "balance_left", stepLabel: "Single-Leg Balance — Left",
        holdDurationSec: 10, stabilityScore: round1(stability), flags: stability < 60 ? ["fall_risk_review"] : [],
        evidence: evidence.balance,
      },
      {
        movement: "balance", stepKey: "balance_right", stepLabel: "Single-Leg Balance — Right",
        holdDurationSec: 10, stabilityScore: round1(stability + rand(-4, 4)), flags: [],
        evidence: evidence.balance,
      },
      {
        movement: "walk_in_place", stepKey: "walk_in_place", stepLabel: "Walk in Place",
        durationSec: 15, cadenceStepsPerMin: round1(cadence), stepHeightAsymmetryPct: round1(rand(3, 12)), flags: [],
        evidence: evidence.walk_in_place,
      },
    ];

    sessions.push({
      reportId: `flexion-seed-${week}`,
      patientName,
      capturedAt,
      routine,
      fhirObservations: routine.map((r) => ({
        resourceType: "Observation",
        status: "final",
        code: { text: `Flexion movement screen — ${r.movement}` },
        effectiveDateTime: capturedAt,
        valueString: JSON.stringify(r),
        note: r.evidence ? [{ text: `${r.evidence.label}: ${r.evidence.note} (${r.evidence.citation})` }] : undefined,
      })),
    });
  }
  localStorage.setItem("flexion_reports", JSON.stringify([...existing, ...sessions]));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

// Chart.js time scale needs the date adapter.
const adapterScript = document.createElement("script");
adapterScript.src = "https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js";
adapterScript.onload = refresh;
document.head.appendChild(adapterScript);
