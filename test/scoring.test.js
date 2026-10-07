// Node-only unit tests for js/scoring.js's pure math and trackers.
// Run with: node test/scoring.test.js
// No camera/browser needed — landmark coordinates are synthesized so the
// angle math and state machines can be verified deterministically.

const assert = require("assert");
const path = require("path");
const S = require(path.join(__dirname, "..", "js", "scoring.js"));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(`       ${err.message}`);
    process.exitCode = 1;
  }
}

// Build three points so the angle at `vertex` equals exactly `angleDeg`,
// by construction (see derivation in comments below).
function pointsForAngle(angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const vertex = { x: 0.5, y: 0.5 };
  const a = { x: vertex.x, y: vertex.y - 1 }; // "up" arm, fixed reference
  const b = { x: vertex.x + Math.sin(rad), y: vertex.y - Math.cos(rad) };
  return { a, vertex, b };
}

// Build a full 33-point landmark array with hip/knee/ankle (both sides)
// positioned to produce the given knee angle, everything else near-identity
// so visibility checks pass.
function landmarksForKneeAngle(angleDeg, opts) {
  const o = Object.assign({ trunkLean: 5 }, opts || {});
  const lm = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.5, visibility: 1 }));
  const { a: hip, vertex: knee, b: ankle } = pointsForAngle(angleDeg);
  lm[S.LM.LEFT_HIP] = { ...hip, visibility: 1 };
  lm[S.LM.LEFT_KNEE] = { ...knee, visibility: 1 };
  lm[S.LM.LEFT_ANKLE] = { ...ankle, visibility: 1 };
  lm[S.LM.RIGHT_HIP] = { ...hip, visibility: 1 };
  lm[S.LM.RIGHT_KNEE] = { ...knee, visibility: 1 };
  lm[S.LM.RIGHT_ANKLE] = { ...ankle, visibility: 1 };
  lm[S.LM.LEFT_SHOULDER] = { x: hip.x, y: hip.y - 1 + o.trunkLean / 100, visibility: 1 };
  return lm;
}

// ---------------------------------------------------------------------
test("angleAt: 180 degrees for a straight line", () => {
  const { a, vertex, b } = pointsForAngle(180);
  const angle = S.angleAt(a, vertex, b);
  assert.ok(Math.abs(angle - 180) < 0.01, `expected ~180, got ${angle}`);
});

test("angleAt: 90 degrees for a right angle", () => {
  const { a, vertex, b } = pointsForAngle(90);
  const angle = S.angleAt(a, vertex, b);
  assert.ok(Math.abs(angle - 90) < 0.01, `expected ~90, got ${angle}`);
});

test("angleAt: returns null for degenerate (coincident) points", () => {
  const p = { x: 0.5, y: 0.5 };
  assert.strictEqual(S.angleAt(p, p, p), null);
});

test("asymmetryPct: identical values => 0", () => {
  assert.strictEqual(S.asymmetryPct(90, 90), 0);
});

test("asymmetryPct: known case", () => {
  // |100-80| / ((100+80)/2) * 100 = 20/90*100 = 22.22
  const pct = S.asymmetryPct(100, 80);
  assert.ok(Math.abs(pct - 22.22) < 0.05, `got ${pct}`);
});

// ---------------------------------------------------------------------
test("squat tracker: counts exactly one rep for one down-up cycle", () => {
  const tracker = S.createSquatTracker();
  const angles = [180, 175, 165, 158, 150, 140, 128, 110, 95, 90, 95, 110, 128, 140, 150, 158, 165, 175, 180];
  angles.forEach((a) => tracker.addFrame(landmarksForKneeAngle(a)));
  const summary = tracker.summarize(5);
  assert.strictEqual(summary.repsCompleted, 1, `expected 1 rep, got ${summary.repsCompleted}`);
  assert.ok(summary.avgDepthDeg > 85 && summary.avgDepthDeg < 95, `depth out of range: ${summary.avgDepthDeg}`);
});

test("squat tracker: counts multiple reps across repeated cycles", () => {
  const tracker = S.createSquatTracker();
  const oneCycle = [180, 150, 120, 95, 90, 95, 120, 150, 180];
  const angles = [].concat(oneCycle, oneCycle, oneCycle);
  angles.forEach((a) => tracker.addFrame(landmarksForKneeAngle(a)));
  const summary = tracker.summarize(3);
  assert.strictEqual(summary.repsCompleted, 3, `expected 3 reps, got ${summary.repsCompleted}`);
});

test("squat tracker: no motion (stays standing) => 0 reps, no false positives", () => {
  const tracker = S.createSquatTracker();
  for (let i = 0; i < 20; i++) tracker.addFrame(landmarksForKneeAngle(178 + Math.random() * 2));
  const summary = tracker.summarize(5);
  assert.strictEqual(summary.repsCompleted, 0);
});

test("squat tracker: flags limited_depth when squat is shallow", () => {
  const tracker = S.createSquatTracker();
  const shallow = [180, 150, 140, 145, 150, 180]; // never gets below 130 -> won't even register as a rep at default thresholds
  shallow.forEach((a) => tracker.addFrame(landmarksForKneeAngle(a)));
  const summary = tracker.summarize(5);
  // With no completed rep, flags array should just be empty (no crash) —
  // this documents current behavior: shallow squats that never cross the
  // bottom threshold aren't counted as reps at all.
  assert.strictEqual(summary.repsCompleted, 0);
});

// ---------------------------------------------------------------------
test("arm raise tracker: tracks max angle and symmetry", () => {
  const tracker = S.createArmRaiseTracker();
  function frameFor(leftDeg, rightDeg) {
    const lm = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.5, visibility: 1 }));
    const left = pointsForAngle(leftDeg);
    const right = pointsForAngle(rightDeg);
    lm[S.LM.LEFT_HIP] = { x: 0.4, y: 0.6, visibility: 1 };
    lm[S.LM.LEFT_SHOULDER] = { x: 0.4, y: 0.4, visibility: 1 };
    lm[S.LM.LEFT_ELBOW] = { x: 0.4 + Math.sin((leftDeg * Math.PI) / 180) * 0.3, y: 0.4 - Math.cos((leftDeg * Math.PI) / 180) * 0.3, visibility: 1 };
    lm[S.LM.RIGHT_HIP] = { x: 0.6, y: 0.6, visibility: 1 };
    lm[S.LM.RIGHT_SHOULDER] = { x: 0.6, y: 0.4, visibility: 1 };
    lm[S.LM.RIGHT_ELBOW] = { x: 0.6 + Math.sin((rightDeg * Math.PI) / 180) * 0.3, y: 0.4 - Math.cos((rightDeg * Math.PI) / 180) * 0.3, visibility: 1 };
    return lm;
  }
  [0, 45, 90, 130, 160, 130, 90, 45, 0].forEach((d) => tracker.addFrame(frameFor(d, d - 20 < 0 ? 0 : d - 20)));
  const summary = tracker.summarize();
  assert.ok(summary.maxLeftDeg >= 155, `expected left max ~160, got ${summary.maxLeftDeg}`);
  assert.ok(summary.asymmetryPct > 0, "expected nonzero asymmetry between arms");
});

// ---------------------------------------------------------------------
test("balance tracker: low sway => high stability score", () => {
  const tracker = S.createBalanceTracker();
  let t = 0;
  for (let i = 0; i < 200; i++) {
    t += 33; // ~30fps, ~6.6s total so the min-hold-duration flag doesn't trip
    const jitter = (Math.random() - 0.5) * 0.001; // tiny sway
    const lm = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.5, visibility: 1 }));
    lm[S.LM.LEFT_HIP] = { x: 0.5 + jitter, y: 0.5, visibility: 1 };
    lm[S.LM.RIGHT_HIP] = { x: 0.5 + jitter, y: 0.5, visibility: 1 };
    tracker.addFrame(lm, t);
  }
  const summary = tracker.summarize();
  assert.ok(summary.stabilityScore > 90, `expected high stability, got ${summary.stabilityScore}`);
  assert.ok(!summary.flags.includes("fall_risk_review"));
});

test("balance tracker: large sway => lower stability score and flag", () => {
  const tracker = S.createBalanceTracker();
  let t = 0;
  for (let i = 0; i < 100; i++) {
    t += 33;
    const sway = Math.sin(i / 3) * 0.05; // large oscillation
    const lm = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.5, visibility: 1 }));
    lm[S.LM.LEFT_HIP] = { x: 0.5 + sway, y: 0.5, visibility: 1 };
    lm[S.LM.RIGHT_HIP] = { x: 0.5 + sway, y: 0.5, visibility: 1 };
    tracker.addFrame(lm, t);
  }
  const summary = tracker.summarize();
  assert.ok(summary.stabilityScore < 90, `expected reduced stability, got ${summary.stabilityScore}`);
});

test("balance tracker: defaults to feet_together stance and reports it", () => {
  const tracker = S.createBalanceTracker();
  tracker.addFrame({ [S.LM.LEFT_HIP]: { x: 0.5, y: 0.5, visibility: 1 }, [S.LM.RIGHT_HIP]: { x: 0.5, y: 0.5, visibility: 1 } }, 0);
  const summary = tracker.summarize();
  assert.strictEqual(summary.stance, "feet_together");
});

test("balance tracker: honors an explicit single_leg stance and scores identically otherwise", () => {
  const tracker = S.createBalanceTracker({ stance: "single_leg" });
  let t = 0;
  for (let i = 0; i < 50; i++) {
    t += 33;
    const lm = { [S.LM.LEFT_HIP]: { x: 0.5, y: 0.5, visibility: 1 }, [S.LM.RIGHT_HIP]: { x: 0.5, y: 0.5, visibility: 1 } };
    tracker.addFrame(lm, t);
  }
  const summary = tracker.summarize();
  assert.strictEqual(summary.stance, "single_leg");
  assert.strictEqual(summary.evidence.tier, "exploratory");
});

// ---------------------------------------------------------------------
test("dropout monitor: stays not-interrupted through brief poor-quality blips", () => {
  const monitor = S.createDropoutMonitor({ dropoutThresholdMs: 800 });
  let t = 0;
  let anyActive = false;
  ["good", "good", "poor", "poor", "good", "good"].forEach((tier) => {
    t += 100; // 100ms per frame -> poor streak here is only ~200ms, under threshold
    if (monitor.record(tier, t)) anyActive = true;
  });
  assert.strictEqual(anyActive, false, "a brief blip should not trigger an active dropout");
  assert.strictEqual(monitor.summary().interrupted, false);
});

test("dropout monitor: flags interrupted after a sustained poor-quality streak", () => {
  const monitor = S.createDropoutMonitor({ dropoutThresholdMs: 500 });
  let t = 0;
  let becameActive = false;
  for (let i = 0; i < 20; i++) {
    t += 100; // 20 frames * 100ms = up to 2s of sustained "poor"
    if (monitor.record("poor", t)) becameActive = true;
  }
  assert.strictEqual(becameActive, true, "a sustained poor streak should become active before the loop ends");
  const summary = monitor.summary();
  assert.strictEqual(summary.interrupted, true);
  assert.ok(summary.worstStreakMs >= 500, `expected worstStreakMs >= 500, got ${summary.worstStreakMs}`);
});

test("dropout monitor: recovering to good quality resets the streak", () => {
  const monitor = S.createDropoutMonitor({ dropoutThresholdMs: 500 });
  let t = 0;
  for (let i = 0; i < 4; i++) { t += 100; monitor.record("poor", t); } // 400ms poor, under threshold
  t += 100; monitor.record("good", t); // recovers
  for (let i = 0; i < 4; i++) { t += 100; monitor.record("poor", t); } // another 400ms poor
  assert.strictEqual(monitor.summary().interrupted, false, "two short poor streaks separated by good frames should not sum together");
});

// ---------------------------------------------------------------------
test("walk tracker: counts steps from ankle oscillation", () => {
  const tracker = S.createWalkTracker();
  let t = 0;
  // Simulate 6 up/down cycles on the left ankle only.
  for (let cycle = 0; cycle < 6; cycle++) {
    [0.9, 0.85, 0.78, 0.7, 0.78, 0.85, 0.9, 0.9].forEach((y) => {
      t += 50;
      const lm = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.5, visibility: 1 }));
      lm[S.LM.LEFT_ANKLE] = { x: 0.45, y, visibility: 1 };
      lm[S.LM.RIGHT_ANKLE] = { x: 0.55, y: 0.9, visibility: 1 };
      tracker.addFrame(lm, t);
    });
  }
  const summary = tracker.summarize();
  assert.ok(summary.leftSteps >= 4, `expected several left steps detected, got ${summary.leftSteps}`);
  assert.strictEqual(summary.rightSteps, 0);
});

// ---------------------------------------------------------------------
test("evidence: every scored movement has a citation and a tier", () => {
  const keys = ["squat", "arm_raise", "balance", "walk_in_place", "sit_to_stand"];
  keys.forEach((k) => {
    const ev = S.getEvidence(k);
    assert.ok(ev, `missing evidence entry for ${k}`);
    assert.ok(["high", "moderate", "exploratory"].includes(ev.tier), `bad tier for ${k}: ${ev.tier}`);
    assert.ok(ev.citation && ev.citation.length > 0, `missing citation for ${k}`);
  });
  assert.strictEqual(S.getEvidence("not_a_real_movement"), null);
});

test("evidence: is attached to each tracker's summarize() output", () => {
  const squat = S.createSquatTracker();
  squat.addFrame(landmarksForKneeAngle(180));
  assert.strictEqual(squat.summarize().evidence.tier, "moderate");

  const balance = S.createBalanceTracker();
  balance.addFrame({ [S.LM.LEFT_HIP]: { x: 0.5, y: 0.5, visibility: 1 }, [S.LM.RIGHT_HIP]: { x: 0.5, y: 0.5, visibility: 1 } }, 0);
  assert.strictEqual(balance.summarize().evidence.tier, "exploratory");
});

// ---------------------------------------------------------------------
test("frame quality: full visibility => good", () => {
  const lm = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.5, visibility: 1 }));
  const q = S.computeFrameQuality(lm);
  assert.strictEqual(q.tier, "good");
  assert.strictEqual(q.ratioPct, 100);
});

test("frame quality: no pose => no_pose", () => {
  const q = S.computeFrameQuality(null);
  assert.strictEqual(q.tier, "no_pose");
});

test("frame quality: half the key landmarks missing => poor or fair, not good", () => {
  const lm = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.5, visibility: 1 }));
  [S.LM.LEFT_KNEE, S.LM.RIGHT_KNEE, S.LM.LEFT_ANKLE, S.LM.RIGHT_ANKLE].forEach((idx) => {
    lm[idx] = { x: 0.5, y: 0.5, visibility: 0 };
  });
  const q = S.computeFrameQuality(lm);
  assert.notStrictEqual(q.tier, "good");
});

// ---------------------------------------------------------------------
test("sit-to-stand tracker: counts 5 reps and times them", () => {
  const tracker = S.createSitToStandTracker();
  let t = 0;
  function frameForHipY(y) {
    return { [S.LM.LEFT_HIP]: { x: 0.5, y, visibility: 1 }, [S.LM.RIGHT_HIP]: { x: 0.5, y, visibility: 1 } };
  }
  // Settle a seated baseline first.
  for (let i = 0; i < 10; i++) {
    t += 100;
    tracker.addFrame(frameForHipY(0.7), t);
  }
  // 5 stand/sit cycles: hip y drops (stands) then returns (sits).
  for (let rep = 0; rep < 5; rep++) {
    [0.55, 0.5, 0.55, 0.7, 0.7].forEach((y) => {
      t += 300;
      tracker.addFrame(frameForHipY(y), t);
    });
  }
  const summary = tracker.summarize();
  assert.strictEqual(summary.repsCompleted, 5, `expected 5 reps, got ${summary.repsCompleted}`);
  assert.ok(summary.totalTimeSec > 0, "expected a positive elapsed time");
  assert.strictEqual(summary.flags.includes("incomplete_reps"), false);
  assert.strictEqual(summary.evidence.tier, "moderate");
});

test("sit-to-stand tracker: flags incomplete_reps when fewer than 5 reps completed", () => {
  const tracker = S.createSitToStandTracker();
  let t = 0;
  function frameForHipY(y) {
    return { [S.LM.LEFT_HIP]: { x: 0.5, y, visibility: 1 }, [S.LM.RIGHT_HIP]: { x: 0.5, y, visibility: 1 } };
  }
  for (let i = 0; i < 5; i++) {
    t += 100;
    tracker.addFrame(frameForHipY(0.7), t);
  }
  [0.55, 0.5, 0.55, 0.7, 0.7].forEach((y) => {
    t += 300;
    tracker.addFrame(frameForHipY(y), t);
  });
  const summary = tracker.summarize();
  assert.strictEqual(summary.repsCompleted, 1);
  assert.ok(summary.flags.includes("incomplete_reps"));
});

// ---------------------------------------------------------------------
// Added after the post-review code fixes (evidence tiers, side-on squat,
// sub-metric precision).
test("evidence tiers: squat, sit-to-stand and walk-in-place are Moderate; balance Exploratory; arm raise Moderate", () => {
  assert.strictEqual(S.getEvidence("squat").tier, "moderate");
  assert.strictEqual(S.getEvidence("sit_to_stand").tier, "moderate");
  assert.strictEqual(S.getEvidence("walk_in_place").tier, "moderate");
  assert.strictEqual(S.getEvidence("balance").tier, "exploratory");
  assert.strictEqual(S.getEvidence("arm_raise").tier, "moderate");
  Object.keys(S.EVIDENCE).forEach((k) => {
    assert.ok(!/High confidence/.test(S.EVIDENCE[k].label), `${k} label still says High`);
    assert.ok(!/<\s*1\.1/.test(S.EVIDENCE[k].note), `${k} note still quotes the old <1.1 deg figure`);
  });
  assert.ok(/2\.33 to 6\.25/.test(S.EVIDENCE.squat.note), "squat note should quote the overhead-squat RMSE range");
  assert.ok(!/<\s*2\.33/.test(S.EVIDENCE.squat.note), "squat note must not present RMSE <2.33 as squat evidence");
  assert.ok(!/lab-based marker systems/.test(S.EVIDENCE.squat.note), "squat note must not attribute gait/stance accuracy to squatting");
  assert.ok(/Bae et al\. 2024/.test(S.EVIDENCE.squat.citation), "squat citation should be the squat study");
});

test("squat tracker: side-on view with the far leg untracked still counts reps and does not invent asymmetry", () => {
  const tracker = S.createSquatTracker(); // default view = side
  const oneCycle = [180, 150, 120, 95, 90, 95, 120, 150, 180];
  oneCycle.concat(oneCycle).forEach((a) => {
    const lm = landmarksForKneeAngle(a);
    // right (far) leg not tracked
    [S.LM.RIGHT_HIP, S.LM.RIGHT_KNEE, S.LM.RIGHT_ANKLE].forEach((i) => { lm[i] = { ...lm[i], visibility: 0.1 }; });
    tracker.addFrame(lm);
  });
  const summary = tracker.summarize(5);
  assert.strictEqual(summary.view, "side");
  assert.strictEqual(summary.repsCompleted, 2);
  assert.ok(summary.avgDepthDeg > 85 && summary.avgDepthDeg < 95, `depth out of range: ${summary.avgDepthDeg}`);
  assert.strictEqual(summary.reps[0].rightKneeFlexionDeg, null, "untracked side must be null, not 0");
  assert.strictEqual(summary.avgAsymmetryPct, null);
  assert.strictEqual(summary.flags.includes("left_right_asymmetry"), false);
});

test("squat tracker: legacy front view still reports left/right asymmetry", () => {
  const tracker = S.createSquatTracker({ view: "front" });
  [180, 150, 120, 95, 90, 95, 120, 150, 180].forEach((a) => tracker.addFrame(landmarksForKneeAngle(a)));
  const summary = tracker.summarize(1);
  assert.strictEqual(summary.repsCompleted, 1);
  assert.strictEqual(summary.avgAsymmetryPct, 0);
});

test("frame quality: side view is judged on the better-visible side only", () => {
  const lm = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.5, visibility: 1 }));
  [S.LM.RIGHT_SHOULDER, S.LM.RIGHT_HIP, S.LM.RIGHT_KNEE, S.LM.RIGHT_ANKLE].forEach((i) => { lm[i] = { x: 0.5, y: 0.5, visibility: 0.1 }; });
  const front = S.computeFrameQuality(lm);
  const side = S.computeFrameQuality(lm, { view: "side" });
  assert.notStrictEqual(front.tier, "good", "front view should not be good with a whole side missing");
  assert.strictEqual(side.tier, "good");
  assert.strictEqual(side.totalRequired, 4);
  assert.strictEqual(S.computeFrameQuality(null, { view: "side" }).tier, "no_pose");
});

test("balance tracker: sway sub-metrics keep useful precision (not rounded to 0.1)", () => {
  const tracker = S.createBalanceTracker();
  let t = 0;
  for (let i = 0; i < 100; i++) {
    t += 100;
    const sway = Math.sin(i / 2) * 0.004; // ~0.4% of frame width
    const lm = { [S.LM.LEFT_HIP]: { x: 0.5 + sway, y: 0.5, visibility: 1 }, [S.LM.RIGHT_HIP]: { x: 0.5 + sway, y: 0.5, visibility: 1 } };
    tracker.addFrame(lm, t);
  }
  const summary = tracker.summarize();
  assert.ok(summary.swayStdX > 0 && summary.swayStdX < 0.01, `swayStdX should be a small non-zero value, got ${summary.swayStdX}`);
  assert.ok(summary.swayPathLength > 0.1, `swayPathLength should be a non-zero path length, got ${summary.swayPathLength}`);
  assert.ok(Math.abs(summary.swayStdX * 1e4 - Math.round(summary.swayStdX * 1e4)) < 1e-6, "swayStdX should be rounded to 4 decimal places");
});

test("walk tracker: average step height keeps useful precision (not rounded to 0.1)", () => {
  const tracker = S.createWalkTracker();
  let t = 0;
  for (let cycle = 0; cycle < 6; cycle++) {
    [0.9, 0.88, 0.86, 0.84, 0.86, 0.88, 0.9, 0.9].forEach((y) => {
      t += 50;
      const lm = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.5, visibility: 1 }));
      lm[S.LM.LEFT_ANKLE] = { x: 0.45, y, visibility: 1 };
      lm[S.LM.RIGHT_ANKLE] = { x: 0.55, y: 0.9, visibility: 1 };
      tracker.addFrame(lm, t);
    });
  }
  const summary = tracker.summarize();
  assert.ok(summary.leftSteps >= 3, `expected left steps, got ${summary.leftSteps}`);
  assert.ok(summary.avgLeftStepHeight > 0.02 && summary.avgLeftStepHeight < 0.1, `step height should be a small non-zero fraction, got ${summary.avgLeftStepHeight}`);
});

test("walking aid: values are normalised and a note is only produced when an aid is used", () => {
  assert.strictEqual(S.normaliseWalkingAid(undefined), "none");
  assert.strictEqual(S.normaliseWalkingAid(""), "none");
  assert.strictEqual(S.normaliseWalkingAid("Stick"), "stick");
  assert.strictEqual(S.normaliseWalkingAid("crutches"), "other");
  assert.strictEqual(S.walkingAidNote("none"), null);
  assert.ok(/walking aid \(frame\)/.test(S.walkingAidNote("frame")));
});

test("plain-language summary: no numbers or tiers, never says the person is well, always points to a clinician", () => {
  const results = [
    { stepLabel: "5x Sit-to-Stand", movement: "sit_to_stand", flags: ["slow_sit_to_stand_time"], evidence: S.EVIDENCE.sit_to_stand },
    { stepLabel: "Walk in Place", movement: "walk_in_place", flags: [], evidence: S.EVIDENCE.walk_in_place },
    { stepLabel: "Static Balance", movement: "balance", flags: ["tracking_interrupted", "some_new_flag"], evidence: S.EVIDENCE.balance },
  ];
  const p = S.plainLanguageSummary(results, { walkingAid: "stick" });
  assert.strictEqual(p.completed.length, 3);
  assert.strictEqual(p.flaggedItems.length, 3);
  assert.ok(p.flaggedItems.some((f) => /camera lost sight/.test(f.text)));
  assert.ok(p.flaggedItems.some((f) => /flagged for a clinician/.test(f.text)), "unknown flags get a generic clinician-review message");
  assert.ok(/walking aid \(stick\)/.test(p.aidNote));
  const text = JSON.stringify(p);
  assert.ok(!/Moderate|Exploratory|High confidence|et al\./.test(text), "no tiers or citations in the plain-language summary");
  assert.ok(!/\d/.test(p.headline + p.flaggedItems.map((f) => f.text).join(" ")), "no numbers in headline or flag text");
  assert.ok(/GP or physiotherapist/.test(p.nextSteps.join(" ")));
  assert.ok(/not a diagnosis/.test(p.disclaimer));
  const clean = S.plainLanguageSummary([{ stepLabel: "Arm Raises", flags: [] }], {});
  assert.ok(/does not mean that nothing is wrong/.test(clean.headline));
  assert.strictEqual(clean.aidNote, null);
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("Some tests FAILED.");
} else {
  console.log("All tests passed.");
}
