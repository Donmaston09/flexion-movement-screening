/**
 * Flexion — pure movement-scoring logic.
 *
 * These functions take MediaPipe Pose landmark arrays (33 landmarks,
 * normalized x/y/z/visibility, BlazePose indexing) and turn a sequence of
 * frames into clinical-style scores: joint angles, range of motion (ROM),
 * left/right symmetry, rep counts, and stability metrics.
 *
 * Deliberately framework-free and dependency-free so the exact same file
 * runs in the browser (as a <script>, exposing `window.FlexionScoring`)
 * and in Node for unit testing (via `module.exports`).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = mod;
  } else {
    root.FlexionScoring = mod;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // BlazePose / MediaPipe Pose Landmarker indices we use.
  const LM = {
    LEFT_SHOULDER: 11,
    RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13,
    RIGHT_ELBOW: 14,
    LEFT_WRIST: 15,
    RIGHT_WRIST: 16,
    LEFT_HIP: 23,
    RIGHT_HIP: 24,
    LEFT_KNEE: 25,
    RIGHT_KNEE: 26,
    LEFT_ANKLE: 27,
    RIGHT_ANKLE: 28,
  };

  /** Angle at vertex b, formed by points a-b-c, in degrees [0,180]. */
  function angleAt(a, b, c) {
    const ab = { x: a.x - b.x, y: a.y - b.y };
    const cb = { x: c.x - b.x, y: c.y - b.y };
    const magAB = Math.hypot(ab.x, ab.y);
    const magCB = Math.hypot(cb.x, cb.y);
    if (magAB === 0 || magCB === 0) return null;
    let cos = (ab.x * cb.x + ab.y * cb.y) / (magAB * magCB);
    cos = Math.min(1, Math.max(-1, cos));
    return (Math.acos(cos) * 180) / Math.PI;
  }

  function visible(lm, idx, minVisibility) {
    const p = lm[idx];
    return !!p && (p.visibility === undefined || p.visibility >= (minVisibility ?? 0.5));
  }

  function mean(arr) {
    if (!arr.length) return null;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  function stdev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(mean(arr.map((v) => (v - m) ** 2)));
  }

  /** Percent difference between two positive magnitudes, 0-100+. */
  function asymmetryPct(left, right) {
    if (left == null || right == null) return null;
    const denom = (Math.abs(left) + Math.abs(right)) / 2;
    if (denom === 0) return 0;
    return (Math.abs(left - right) / denom) * 100;
  }

  // ---------------------------------------------------------------------
  // Evidence grading
  // ---------------------------------------------------------------------
  // Not every movement Flexion scores is backed by the same strength of
  // published evidence, and the literature is specific about *why*:
  // single-camera markerless capture is strongest for spatiotemporal gait
  // measures and sagittal-plane hip/knee kinematics, weaker for ankle,
  // frontal/transverse-plane, and complex multi-directional movement, and
  // dynamic transitional tasks (like standing up) show much wider
  // measurement error than static/near-static joint positions even when
  // the underlying system is otherwise accurate. Rather than presenting
  // every score with the same implied confidence, each movement carries
  // an explicit evidence tier so a provider knows what to trust today and
  // what is still directional pending Flexion's own pilot validation
  // (see the Technical Spec, Section 7).
  const EVIDENCE = {
    squat: {
      tier: "high",
      label: "High confidence",
      note:
        "Sagittal-plane knee flexion captured at a controlled, near-static position (the bottom of a squat) is the accuracy profile the literature supports best: mean error <1.1° and limits of agreement <5° against lab-based marker systems, even in space-constrained clinical settings.",
      citation: "Ruder et al. 2026; Scataglini et al. 2024",
    },
    arm_raise: {
      tier: "moderate",
      label: "Moderate confidence",
      note:
        "Simple flexion/abduction (what Flexion measures) shows good-to-excellent validity in single-camera systems. This should not be read as validated for rotational or multi-planar shoulder mobility, which remains inconsistent across studies.",
      citation: "Lee et al. 2025",
    },
    balance: {
      tier: "exploratory",
      label: "Exploratory",
      note:
        "Balance and functional movement scoring is the least evidence-covered domain reviewed for Flexion. Treat the stability score as a within-patient trend indicator, not an absolute clinical measurement, until pilot-validated against a clinical balance assessment.",
      citation: "Flexion literature evidence review, 2026",
    },
    walk_in_place: {
      tier: "high",
      label: "High confidence (cadence & step count)",
      note:
        "Spatiotemporal gait parameters — step count, cadence, timing — are the best-validated markerless outputs in the literature, with inter-rater reliability and concurrent validity reaching good-to-excellent ICC (0.81–0.98). Step-height asymmetry is a secondary kinematic proxy and carries lower confidence.",
      citation: "Scataglini et al. 2024",
    },
    sit_to_stand: {
      tier: "high",
      label: "High confidence (reps & time)",
      note:
        "Scored as repetitions and total time — the established Five-Times-Sit-to-Stand functional/fall-risk metric — rather than knee-angle depth. Transitional sit-to-stand joint angles showed wide limits of agreement (12–20°) even in studies where other markerless measures were reliable, so Flexion deliberately does not report STS joint angle.",
      citation: "Ruder et al. 2026; Zischke et al. 2021",
    },
  };

  function getEvidence(movementKey) {
    return EVIDENCE[movementKey] || null;
  }

  // ---------------------------------------------------------------------
  // Frame / tracking quality
  // ---------------------------------------------------------------------
  // Literature on markerless capture in real clinical spaces (vs. a lab)
  // finds accuracy holds up when the full body stays in frame and well
  // lit, and degrades with occlusion and poor framing. Rather than let a
  // bad camera setup silently produce bad scores, Flexion checks how many
  // of the key landmarks needed for scoring are actually visible.
  const REQUIRED_FOR_QUALITY = [
    "LEFT_SHOULDER", "RIGHT_SHOULDER", "LEFT_HIP", "RIGHT_HIP",
    "LEFT_KNEE", "RIGHT_KNEE", "LEFT_ANKLE", "RIGHT_ANKLE",
  ].map((k) => LM[k]);

  function computeFrameQuality(lm, opts) {
    const o = Object.assign({ minVisibility: 0.5 }, opts);
    if (!lm) return { visibleCount: 0, totalRequired: REQUIRED_FOR_QUALITY.length, ratioPct: 0, tier: "no_pose" };
    const visibleCount = REQUIRED_FOR_QUALITY.filter((idx) => visible(lm, idx, o.minVisibility)).length;
    const ratio = visibleCount / REQUIRED_FOR_QUALITY.length;
    let tier = "poor";
    if (ratio >= 0.95) tier = "good";
    else if (ratio >= 0.75) tier = "fair";
    return { visibleCount, totalRequired: REQUIRED_FOR_QUALITY.length, ratioPct: round1(ratio * 100), tier };
  }

  // ---------------------------------------------------------------------
  // Squat module
  // ---------------------------------------------------------------------
  // Knee flexion angle = interior angle at the knee (hip-knee-ankle).
  // ~175-180 deg standing, ~80-100 deg at a clinically "full" squat.
  // We track a simple state machine to count reps and capture the angle
  // at the bottom of each rep on both sides plus trunk lean (compensation).

  function createSquatTracker(opts) {
    const o = Object.assign({ topAngle: 160, bottomAngle: 130, minVisibility: 0.5 }, opts);
    const state = {
      phase: "top", // top -> descending -> bottom -> ascending -> top
      reps: [],
      currentMin: { left: 180, right: 180, trunkLean: 0 },
      frames: 0,
    };

    function addFrame(lm) {
      if (!lm) return null;
      state.frames += 1;
      const haveLeft =
        visible(lm, LM.LEFT_HIP, o.minVisibility) &&
        visible(lm, LM.LEFT_KNEE, o.minVisibility) &&
        visible(lm, LM.LEFT_ANKLE, o.minVisibility);
      const haveRight =
        visible(lm, LM.RIGHT_HIP, o.minVisibility) &&
        visible(lm, LM.RIGHT_KNEE, o.minVisibility) &&
        visible(lm, LM.RIGHT_ANKLE, o.minVisibility);

      const leftAngle = haveLeft ? angleAt(lm[LM.LEFT_HIP], lm[LM.LEFT_KNEE], lm[LM.LEFT_ANKLE]) : null;
      const rightAngle = haveRight ? angleAt(lm[LM.RIGHT_HIP], lm[LM.RIGHT_KNEE], lm[LM.RIGHT_ANKLE]) : null;

      // Trunk lean: angle of the shoulder-hip line from vertical (0 = upright).
      let trunkLean = null;
      if (visible(lm, LM.LEFT_SHOULDER, o.minVisibility) && visible(lm, LM.LEFT_HIP, o.minVisibility)) {
        const sh = lm[LM.LEFT_SHOULDER];
        const hip = lm[LM.LEFT_HIP];
        trunkLean = (Math.atan2(Math.abs(sh.x - hip.x), Math.abs(sh.y - hip.y)) * 180) / Math.PI;
      }

      const drivingAngle = mean([leftAngle, rightAngle].filter((v) => v != null));
      if (drivingAngle == null) return null;

      // State machine on the driving (average) knee angle.
      if (state.phase === "top" && drivingAngle < o.topAngle) {
        state.phase = "descending";
        state.currentMin = { left: leftAngle ?? 180, right: rightAngle ?? 180, trunkLean: trunkLean ?? 0 };
      } else if (state.phase === "descending") {
        if (leftAngle != null) state.currentMin.left = Math.min(state.currentMin.left, leftAngle);
        if (rightAngle != null) state.currentMin.right = Math.min(state.currentMin.right, rightAngle);
        if (trunkLean != null) state.currentMin.trunkLean = Math.max(state.currentMin.trunkLean, trunkLean);
        if (drivingAngle < o.bottomAngle) state.phase = "bottom";
      } else if (state.phase === "bottom") {
        if (leftAngle != null) state.currentMin.left = Math.min(state.currentMin.left, leftAngle);
        if (rightAngle != null) state.currentMin.right = Math.min(state.currentMin.right, rightAngle);
        if (trunkLean != null) state.currentMin.trunkLean = Math.max(state.currentMin.trunkLean, trunkLean);
        if (drivingAngle > o.bottomAngle) state.phase = "ascending";
      } else if (state.phase === "ascending" && drivingAngle > o.topAngle) {
        state.phase = "top";
        state.reps.push({
          repIndex: state.reps.length + 1,
          leftKneeFlexionDeg: round1(180 - state.currentMin.left),
          rightKneeFlexionDeg: round1(180 - state.currentMin.right),
          trunkLeanDeg: round1(state.currentMin.trunkLean),
          asymmetryPct: round1(asymmetryPct(180 - state.currentMin.left, 180 - state.currentMin.right)),
        });
      }

      return { phase: state.phase, leftAngle, rightAngle, trunkLean };
    }

    function summarize(targetReps) {
      const reps = state.reps;
      const depth = mean(reps.map((r) => Math.max(r.leftKneeFlexionDeg, r.rightKneeFlexionDeg)));
      const asym = mean(reps.map((r) => r.asymmetryPct));
      const trunk = mean(reps.map((r) => r.trunkLeanDeg));
      return {
        movement: "squat",
        repsCompleted: reps.length,
        repsTarget: targetReps ?? null,
        reps,
        avgDepthDeg: depth != null ? round1(depth) : null,
        avgAsymmetryPct: asym != null ? round1(asym) : null,
        avgTrunkLeanDeg: trunk != null ? round1(trunk) : null,
        flags: buildSquatFlags(depth, asym, trunk),
        evidence: EVIDENCE.squat,
      };
    }

    return { addFrame, summarize, _state: state };
  }

  function buildSquatFlags(depth, asym, trunk) {
    const flags = [];
    if (depth != null && depth < 70) flags.push("limited_depth");
    if (asym != null && asym > 15) flags.push("left_right_asymmetry");
    if (trunk != null && trunk > 35) flags.push("excess_trunk_lean");
    return flags;
  }

  // ---------------------------------------------------------------------
  // Arm raise (shoulder abduction/flexion) module
  // ---------------------------------------------------------------------
  // Angle at the shoulder between the torso (hip->shoulder line extended)
  // and the upper arm (shoulder->elbow). ~0 deg arm at side, ~180 deg
  // fully overhead.

  function createArmRaiseTracker(opts) {
    const o = Object.assign({ minVisibility: 0.5 }, opts);
    const state = { maxLeft: 0, maxRight: 0, samplesLeft: [], samplesRight: [], frames: 0 };

    function shoulderAngle(lm, side) {
      const SH = side === "left" ? LM.LEFT_SHOULDER : LM.RIGHT_SHOULDER;
      const EL = side === "left" ? LM.LEFT_ELBOW : LM.RIGHT_ELBOW;
      const HP = side === "left" ? LM.LEFT_HIP : LM.RIGHT_HIP;
      if (!visible(lm, SH, o.minVisibility) || !visible(lm, EL, o.minVisibility) || !visible(lm, HP, o.minVisibility)) {
        return null;
      }
      // Virtual point above the shoulder, opposite the hip, to represent
      // the upright torso line so angleAt gives 0 deg for "arm at side".
      const sh = lm[SH];
      const hip = lm[HP];
      const torsoTop = { x: sh.x + (sh.x - hip.x), y: sh.y + (sh.y - hip.y) };
      return angleAt(torsoTop, sh, lm[EL]);
    }

    function addFrame(lm) {
      if (!lm) return null;
      state.frames += 1;
      const left = shoulderAngle(lm, "left");
      const right = shoulderAngle(lm, "right");
      if (left != null) {
        state.maxLeft = Math.max(state.maxLeft, left);
        state.samplesLeft.push(left);
      }
      if (right != null) {
        state.maxRight = Math.max(state.maxRight, right);
        state.samplesRight.push(right);
      }
      return { left, right };
    }

    function summarize() {
      return {
        movement: "arm_raise",
        maxLeftDeg: round1(state.maxLeft),
        maxRightDeg: round1(state.maxRight),
        asymmetryPct: round1(asymmetryPct(state.maxLeft, state.maxRight)),
        smoothnessLeft: round1(stdev(diffs(state.samplesLeft))),
        smoothnessRight: round1(stdev(diffs(state.samplesRight))),
        flags: buildArmFlags(state.maxLeft, state.maxRight),
        evidence: EVIDENCE.arm_raise,
      };
    }

    return { addFrame, summarize, _state: state };
  }

  function buildArmFlags(maxLeft, maxRight) {
    const flags = [];
    const asym = asymmetryPct(maxLeft, maxRight);
    if (Math.min(maxLeft, maxRight) < 120) flags.push("reduced_rom");
    if (asym != null && asym > 15) flags.push("left_right_asymmetry");
    return flags;
  }

  function diffs(arr) {
    const out = [];
    for (let i = 1; i < arr.length; i++) out.push(arr[i] - arr[i - 1]);
    return out;
  }

  // ---------------------------------------------------------------------
  // Single-leg balance module
  // ---------------------------------------------------------------------
  // Uses the midpoint of the hips as a center-of-mass proxy while the
  // patient stands on one leg. Sway = normalized horizontal displacement
  // of that point across the hold. Lower sway = more stable.

  function createBalanceTracker(opts) {
    const o = Object.assign({ minVisibility: 0.5 }, opts);
    const state = { positions: [], startTime: null, lastTime: null };

    function addFrame(lm, timestampMs) {
      if (!lm) return null;
      if (!visible(lm, LM.LEFT_HIP, o.minVisibility) || !visible(lm, LM.RIGHT_HIP, o.minVisibility)) return null;
      const mid = {
        x: (lm[LM.LEFT_HIP].x + lm[LM.RIGHT_HIP].x) / 2,
        y: (lm[LM.LEFT_HIP].y + lm[LM.RIGHT_HIP].y) / 2,
      };
      if (state.startTime == null) state.startTime = timestampMs;
      state.lastTime = timestampMs;
      state.positions.push(mid);
      return mid;
    }

    function summarize() {
      const xs = state.positions.map((p) => p.x);
      const ys = state.positions.map((p) => p.y);
      let pathLength = 0;
      for (let i = 1; i < state.positions.length; i++) {
        pathLength += Math.hypot(
          state.positions[i].x - state.positions[i - 1].x,
          state.positions[i].y - state.positions[i - 1].y
        );
      }
      const durationSec = state.startTime != null ? (state.lastTime - state.startTime) / 1000 : 0;
      const swayStdX = stdev(xs);
      const swayStdY = stdev(ys);
      // Normalized 0-100 stability score: less sway path per second => higher score.
      const swayRate = durationSec > 0 ? pathLength / durationSec : pathLength;
      const stabilityScore = round1(Math.max(0, 100 - swayRate * 400));
      return {
        movement: "balance",
        holdDurationSec: round1(durationSec),
        swayPathLength: round1(pathLength),
        swayStdX: round1(swayStdX),
        swayStdY: round1(swayStdY),
        stabilityScore,
        flags: durationSec < 5 || stabilityScore < 60 ? ["fall_risk_review"] : [],
        evidence: EVIDENCE.balance,
      };
    }

    return { addFrame, summarize, _state: state };
  }

  // ---------------------------------------------------------------------
  // Walk-in-place (gait proxy) module
  // ---------------------------------------------------------------------
  // Counts steps from vertical ankle oscillation and compares left/right
  // step heights and cadence regularity as a coarse gait symmetry proxy.

  function createWalkTracker(opts) {
    const o = Object.assign({ minVisibility: 0.5, riseThreshold: 0.02 }, opts);
    const state = {
      left: { phase: "down", steps: [], baseline: null, peak: null },
      right: { phase: "down", steps: [], baseline: null, peak: null },
      startTime: null,
      lastTime: null,
    };

    function trackAnkle(side, y, t) {
      const s = state[side];
      if (s.baseline == null) s.baseline = y;
      // y grows downward in normalized image coords; a step lifts the
      // ankle so y decreases.
      s.baseline = Math.max(s.baseline, y * 0.02 + s.baseline * 0.98); // slow follow of the "down" floor
      if (s.phase === "down" && s.baseline - y > o.riseThreshold) {
        s.phase = "up";
        s.peak = y;
      } else if (s.phase === "up") {
        s.peak = Math.min(s.peak, y);
        if (y >= s.baseline - o.riseThreshold / 2) {
          s.phase = "down";
          s.steps.push({ heightNorm: round1((s.baseline - s.peak) * 1000) / 1000, t });
        }
      }
    }

    function addFrame(lm, timestampMs) {
      if (!lm) return null;
      if (state.startTime == null) state.startTime = timestampMs;
      state.lastTime = timestampMs;
      if (visible(lm, LM.LEFT_ANKLE, o.minVisibility)) trackAnkle("left", lm[LM.LEFT_ANKLE].y, timestampMs);
      if (visible(lm, LM.RIGHT_ANKLE, o.minVisibility)) trackAnkle("right", lm[LM.RIGHT_ANKLE].y, timestampMs);
      return { leftSteps: state.left.steps.length, rightSteps: state.right.steps.length };
    }

    function summarize() {
      const durationSec = state.startTime != null ? (state.lastTime - state.startTime) / 1000 : 0;
      const leftHeights = state.left.steps.map((s) => s.heightNorm);
      const rightHeights = state.right.steps.map((s) => s.heightNorm);
      const totalSteps = state.left.steps.length + state.right.steps.length;
      const cadenceSpm = durationSec > 0 ? round1((totalSteps / durationSec) * 60) : 0;
      return {
        movement: "walk_in_place",
        durationSec: round1(durationSec),
        leftSteps: state.left.steps.length,
        rightSteps: state.right.steps.length,
        cadenceStepsPerMin: cadenceSpm,
        avgLeftStepHeight: leftHeights.length ? round1(mean(leftHeights)) : null,
        avgRightStepHeight: rightHeights.length ? round1(mean(rightHeights)) : null,
        stepHeightAsymmetryPct: round1(asymmetryPct(mean(leftHeights), mean(rightHeights))),
        flags: buildWalkFlags(mean(leftHeights), mean(rightHeights), totalSteps),
        evidence: EVIDENCE.walk_in_place,
      };
    }

    return { addFrame, summarize, _state: state };
  }

  function buildWalkFlags(leftH, rightH, totalSteps) {
    const flags = [];
    const asym = asymmetryPct(leftH, rightH);
    if (asym != null && asym > 20) flags.push("gait_asymmetry");
    if (totalSteps < 6) flags.push("low_step_count");
    return flags;
  }

  // ---------------------------------------------------------------------
  // Five-Times-Sit-to-Stand (FTSTS) module
  // ---------------------------------------------------------------------
  // A widely used clinical functional/fall-risk test: stand up and sit
  // back down five times, as fast as safely possible. Deliberately scored
  // by rep count and total elapsed time only — see EVIDENCE.sit_to_stand
  // for why Flexion does not report a knee-angle depth for this movement.
  // Tracked via the hip midpoint's vertical position: standing raises the
  // hip landmark toward the top of frame (smaller normalized y).

  function createSitToStandTracker(opts) {
    const o = Object.assign({ minVisibility: 0.5, riseThreshold: 0.06 }, opts);
    const state = {
      phase: "seated", // seated -> standing -> seated (one cycle = one rep)
      reps: [],
      baselineSeatedY: null,
      firstRepStartTs: null,
      frames: 0,
    };

    function addFrame(lm, timestampMs) {
      if (!lm) return null;
      if (!visible(lm, LM.LEFT_HIP, o.minVisibility) || !visible(lm, LM.RIGHT_HIP, o.minVisibility)) return null;
      state.frames += 1;
      const hipY = (lm[LM.LEFT_HIP].y + lm[LM.RIGHT_HIP].y) / 2;

      if (state.baselineSeatedY == null) state.baselineSeatedY = hipY;
      if (state.phase === "seated") {
        // Slow-follow the seated baseline so gradual drift/re-settling
        // doesn't get mistaken for a stand.
        state.baselineSeatedY = state.baselineSeatedY * 0.9 + hipY * 0.1;
      }

      const risen = state.baselineSeatedY - hipY; // positive while standing

      if (state.phase === "seated" && risen > o.riseThreshold) {
        state.phase = "standing";
        if (state.firstRepStartTs == null) state.firstRepStartTs = timestampMs;
      } else if (state.phase === "standing" && risen < o.riseThreshold * 0.4) {
        state.phase = "seated";
        state.reps.push({ repIndex: state.reps.length + 1, completedAtMs: timestampMs });
      }

      return { phase: state.phase, risen };
    }

    function summarize() {
      const reps = state.reps;
      const totalTimeSec =
        reps.length && state.firstRepStartTs != null
          ? (reps[reps.length - 1].completedAtMs - state.firstRepStartTs) / 1000
          : null;
      return {
        movement: "sit_to_stand",
        repsCompleted: reps.length,
        totalTimeSec: totalTimeSec != null ? round1(totalTimeSec) : null,
        avgTimePerRepSec: totalTimeSec != null && reps.length ? round1(totalTimeSec / reps.length) : null,
        flags: buildSitToStandFlags(reps.length, totalTimeSec),
        evidence: EVIDENCE.sit_to_stand,
      };
    }

    return { addFrame, summarize, _state: state };
  }

  function buildSitToStandFlags(repsCompleted, totalTimeSec) {
    const flags = [];
    if (repsCompleted < 5) flags.push("incomplete_reps");
    // A slower-than-typical five-times-sit-to-stand time is a commonly
    // used directional fall-risk signal in the clinical FTSTS literature;
    // the exact cutoff should be confirmed against established norms
    // during Flexion's pilot rather than hard-coded from this review.
    if (repsCompleted >= 5 && totalTimeSec != null && totalTimeSec > 12) flags.push("slow_sit_to_stand_time");
    return flags;
  }

  function round1(v) {
    if (v == null || Number.isNaN(v)) return null;
    return Math.round(v * 10) / 10;
  }

  return {
    LM,
    angleAt,
    asymmetryPct,
    EVIDENCE,
    getEvidence,
    computeFrameQuality,
    createSquatTracker,
    createArmRaiseTracker,
    createBalanceTracker,
    createWalkTracker,
    createSitToStandTracker,
  };
});
