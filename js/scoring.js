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
      tier: "moderate",
      label: "Moderate confidence",
      note:
        "Squat-specific evidence is limited. A deep-learning markerless system showed excellent agreement with a marker-based reference during an overhead squat (RMSE 2.33 to 6.25° across joints; Bae et al. 2024), and sagittal-plane knee kinematics at a controlled, near-static position are among the better-supported markerless outputs in gait studies. Those figures come from multi-camera or non-BlazePose systems, not from a single consumer webcam with Flexion's lite pose model; single-smartphone gait systems report errors of several degrees (Horsak et al. 2023). Flexion therefore asks for a side-on (sagittal) view; a front-on view under-estimates knee flexion. Rated Moderate rather than High because this has not been validated in Flexion's own setup (single consumer webcam, lite pose model, unsupervised placement). Left/right squat asymmetry is not reported, because the far leg is not reliably visible side-on.",
      citation: "Bae et al. 2024; Horsak et al. 2023; Scataglini et al. 2024",
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
        "Balance and functional movement scoring is the least evidence-covered domain reviewed for Flexion. This applies equally regardless of stance (single-leg or feet-together/tandem) — the underlying sway measurement is the same computation, only the starting posture differs. Treat the stability score as a within-patient trend indicator, not an absolute clinical measurement, until pilot-validated against a clinical balance assessment (e.g. force-plate center-of-pressure comparison).",
      citation: "Flexion literature evidence review, 2026",
    },
    walk_in_place: {
      tier: "moderate",
      label: "Moderate confidence (cadence & step count)",
      note:
        "Spatiotemporal gait parameters — step count, cadence, timing — are among the best-supported markerless outputs in laboratory gait studies, with inter-rater reliability and concurrent validity reaching good-to-excellent ICC (0.81–0.98). Flexion applies this to marching in place, using a simple ankle-height threshold from a single webcam, which has not been validated; it is therefore rated Moderate. Step-height asymmetry is a secondary kinematic proxy and carries lower confidence.",
      citation: "Scataglini et al. 2024",
    },
    sit_to_stand: {
      tier: "moderate",
      label: "Moderate confidence (reps & time)",
      note:
        "Scored as repetitions and total time — the established Five-Times-Sit-to-Stand functional/fall-risk metric — rather than knee-angle depth. Transitional sit-to-stand joint angles showed wide limits of agreement (12–20°) even in studies where other markerless measures were reliable, so Flexion deliberately does not report STS joint angle. Rated Moderate: Flexion's automated rep counting and timing from hip height has not yet been validated against manual timing.",
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

  // Per-side landmark sets, used when a movement is filmed side-on (view
  // "side"): only the camera-facing side is expected to be tracked
  // reliably, so quality is judged on whichever side is better visible.
  const REQUIRED_LEFT_SIDE = ["LEFT_SHOULDER", "LEFT_HIP", "LEFT_KNEE", "LEFT_ANKLE"].map((k) => LM[k]);
  const REQUIRED_RIGHT_SIDE = ["RIGHT_SHOULDER", "RIGHT_HIP", "RIGHT_KNEE", "RIGHT_ANKLE"].map((k) => LM[k]);

  function computeFrameQuality(lm, opts) {
    const o = Object.assign({ minVisibility: 0.5, view: "front" }, opts);
    const sets = o.view === "side" ? [REQUIRED_LEFT_SIDE, REQUIRED_RIGHT_SIDE] : [REQUIRED_FOR_QUALITY];
    const totalRequired = sets[0].length;
    if (!lm) return { visibleCount: 0, totalRequired, ratioPct: 0, tier: "no_pose" };
    const visibleCount = Math.max(...sets.map((set) => set.filter((idx) => visible(lm, idx, o.minVisibility)).length));
    const ratio = visibleCount / totalRequired;
    let tier = "poor";
    if (ratio >= 0.95) tier = "good";
    else if (ratio >= 0.75) tier = "fair";
    return { visibleCount, totalRequired, ratioPct: round1(ratio * 100), tier };
  }

  // ---------------------------------------------------------------------
  // Tracking dropout monitor
  // ---------------------------------------------------------------------
  // A movement being scored shouldn't silently keep counting through a
  // real-world interruption — the patient steps out of view, or part of
  // them is hidden, or the camera loses them. This monitor watches the
  // per-frame tracking-quality tier (from computeFrameQuality) across a
  // step and reports whether tracking dropped out for long enough to cast
  // doubt on that step's result, so the caller (capture.js) can both pause
  // scoring while it's happening and flag the result afterward rather than
  // reporting a number as if nothing went wrong.
  //
  // What it does NOT detect: a second person. If another person is fully
  // visible and the pose model follows them instead, the frame still looks
  // like a "good" frame of a body, so this monitor stays silent. That case
  // is handled separately by createPersonTracker() (identity lock) above.
  // Likewise it only sees poor tracking; it cannot tell whether there was
  // enough room (see createSetupMonitor()).
  function createDropoutMonitor(opts) {
    const o = Object.assign({ minVisibility: 0.5, dropoutThresholdMs: 800 }, opts);
    const state = {
      lastTimestampMs: null,
      poorStreakStartMs: null,
      worstStreakMs: 0,
      totalPoorMs: 0,
      totalMs: 0,
    };

    function isPoor(tier) {
      return tier === "poor" || tier === "no_pose";
    }

    // Returns true while a dropout is *currently in progress and has
    // already exceeded the threshold* — useful for the caller to decide,
    // frame by frame, whether to pause feeding data to the movement
    // tracker right now.
    function record(tier, timestampMs) {
      if (state.lastTimestampMs != null) {
        const dt = Math.max(0, timestampMs - state.lastTimestampMs);
        state.totalMs += dt;
        if (isPoor(tier)) state.totalPoorMs += dt;
      }
      state.lastTimestampMs = timestampMs;

      if (isPoor(tier)) {
        if (state.poorStreakStartMs == null) state.poorStreakStartMs = timestampMs;
        const streakMs = timestampMs - state.poorStreakStartMs;
        state.worstStreakMs = Math.max(state.worstStreakMs, streakMs);
        return streakMs >= o.dropoutThresholdMs;
      }
      state.poorStreakStartMs = null;
      return false;
    }

    function summary() {
      return {
        interrupted: state.worstStreakMs >= o.dropoutThresholdMs,
        worstStreakMs: Math.round(state.worstStreakMs),
        totalPoorMs: Math.round(state.totalPoorMs),
        totalMs: Math.round(state.totalMs),
      };
    }

    return { record, summary };
  }

  // ---------------------------------------------------------------------
  // People in view: who is being assessed?
  // ---------------------------------------------------------------------
  // The pose model is asked for up to two people per frame. Previously it
  // was asked for one, so if a helper (or anyone else) was fully visible
  // the model could quietly switch to them: framing looked "good", the
  // dropout monitor stayed silent, and the wrong person's movement was
  // scored. The person tracker below keeps the identity of the person who
  // was in view at set-up and only feeds *that* person's landmarks to the
  // movement trackers. It is a simple geometric heuristic (position and
  // size continuity of the torso), not a re-identification model: it has
  // been tested on synthetic landmark sequences, and its behaviour with
  // real people and real devices is the subject of the device test
  // protocol, not a validated property.

  const TORSO_SHOULDERS = [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER];
  const TORSO_HIPS = [LM.LEFT_HIP, LM.RIGHT_HIP];
  const MIN_PERSON_SCALE = 0.05; // in image units; smaller = too small/far to count as a person

  // Where a pose sits in the image (centre of the visible torso points)
  // and how big it is (torso length / shoulder width). Needs at least one
  // visible shoulder and one visible hip; otherwise it is not countable.
  function personAnchor(lm, minVisibility) {
    if (!lm) return null;
    const mv = minVisibility == null ? 0.5 : minVisibility;
    const sh = TORSO_SHOULDERS.filter((i) => visible(lm, i, mv)).map((i) => lm[i]);
    const hp = TORSO_HIPS.filter((i) => visible(lm, i, mv)).map((i) => lm[i]);
    if (!sh.length || !hp.length) return null;
    const mid = (pts) => ({ x: mean(pts.map((p) => p.x)), y: mean(pts.map((p) => p.y)) });
    const s = mid(sh);
    const h = mid(hp);
    const torsoLen = Math.hypot(s.x - h.x, s.y - h.y);
    const shoulderWidth = sh.length === 2 ? Math.hypot(sh[0].x - sh[1].x, sh[0].y - sh[1].y) : 0;
    const scale = Math.max(torsoLen, shoulderWidth, 1e-6);
    return { x: (s.x + h.x) / 2, y: (s.y + h.y) / 2, scale };
  }

  function createPersonTracker(opts) {
    const o = Object.assign(
      {
        minVisibility: 0.5,
        minScale: MIN_PERSON_SCALE,
        baseGate: 0.8, // allowed jump between frames, in torso lengths
        gatePerSec: 0.5, // extra allowance per second since the last match (lets a patient who stepped out and back in be re-found near where they were)
        maxGate: 1.5, // never accept someone further than this from the last known position: a person across the room is a different person
        scaleRatioMin: 0.6,
        scaleRatioMax: 1.7,
        ambiguityMargin: 0.35, // two candidates this close in cost = cannot tell them apart
        othersMinMs: 500, // a second person must be in view this long to be flagged
        identityMinMs: 800, // identity uncertain this long in one stretch to be flagged
        policy: "flag", // "flag": keep scoring the locked person; "pause": withhold scoring while anyone else is in view
      },
      opts
    );

    let ref = null; // { x, y, scale } of the locked person
    let lastTs = null;
    let lastMatchTs = null;
    let stats;

    function freshStats() {
      return { totalMs: 0, maxPeople: 0, otherPersonMs: 0, uncertainMs: 0, uncertainStreakMs: 0, worstUncertainMs: 0 };
    }
    stats = freshStats();

    function result(status, lm, extra) {
      return Object.assign({ status, lm: lm || null, lockedIndex: -1, peopleCount: 0, otherCount: 0, locked: !!ref }, extra);
    }

    // poses: array of landmark arrays (one per detected person).
    function update(poses, timestampMs) {
      const dtMs = lastTs == null ? 0 : Math.max(0, timestampMs - lastTs);
      lastTs = timestampMs;
      stats.totalMs += dtMs;

      const cands = (poses || [])
        .map((lm, index) => ({ lm, index, a: personAnchor(lm, o.minVisibility) }))
        .filter((c) => c.a && c.a.scale >= o.minScale);
      const peopleCount = cands.length;
      stats.maxPeople = Math.max(stats.maxPeople, peopleCount);

      const finish = (res, uncertain) => {
        res.peopleCount = peopleCount;
        res.locked = !!ref;
        if (uncertain) {
          stats.uncertainMs += dtMs;
          stats.uncertainStreakMs += dtMs;
          stats.worstUncertainMs = Math.max(stats.worstUncertainMs, stats.uncertainStreakMs);
        } else {
          stats.uncertainStreakMs = 0;
        }
        return res;
      };

      if (!ref) {
        if (peopleCount === 0) return finish(result("no_person"), false);
        if (peopleCount > 1) return finish(result("multiple_unlocked"), false);
        ref = { x: cands[0].a.x, y: cands[0].a.y, scale: cands[0].a.scale };
        lastMatchTs = timestampMs;
        return finish(result("single", cands[0].lm, { lockedIndex: cands[0].index }), false);
      }

      if (peopleCount === 0) return finish(result("lost"), false);

      const sinceMatchSec = Math.max(0, timestampMs - (lastMatchTs == null ? timestampMs : lastMatchTs)) / 1000;
      const gate = Math.min(o.maxGate, o.baseGate + o.gatePerSec * sinceMatchSec);
      const scored = cands
        .map((c) => ({
          c,
          cost: Math.hypot(c.a.x - ref.x, c.a.y - ref.y) / ref.scale,
          ratio: c.a.scale / ref.scale,
        }))
        .filter((s) => s.cost <= gate && s.ratio >= o.scaleRatioMin && s.ratio <= o.scaleRatioMax)
        .sort((a, b) => a.cost - b.cost);

      if (!scored.length) return finish(result("identity_lost", null, { otherCount: peopleCount }), true);
      if (scored.length > 1 && scored[1].cost - scored[0].cost < o.ambiguityMargin) {
        return finish(result("ambiguous", null, { otherCount: peopleCount - 1 }), true);
      }

      const best = scored[0].c;
      ref = {
        x: best.a.x,
        y: best.a.y,
        scale: 0.7 * ref.scale + 0.3 * best.a.scale,
      };
      lastMatchTs = timestampMs;
      const otherCount = peopleCount - 1;
      if (otherCount > 0) stats.otherPersonMs += dtMs;
      if (otherCount > 0 && o.policy === "pause") {
        return finish(result("others_present", null, { lockedIndex: best.index, otherCount }), false);
      }
      return finish(
        result(otherCount > 0 ? "locked_others" : "single", best.lm, { lockedIndex: best.index, otherCount }),
        false
      );
    }

    function summary() {
      return {
        maxPeopleInView: stats.maxPeople,
        otherPersonMs: Math.round(stats.otherPersonMs),
        identityUncertainMs: Math.round(stats.uncertainMs),
        worstIdentityUncertainMs: Math.round(stats.worstUncertainMs),
        totalMs: Math.round(stats.totalMs),
        secondPersonInView: stats.otherPersonMs >= o.othersMinMs,
        identityUncertain: stats.worstUncertainMs >= o.identityMinMs,
      };
    }

    // Clears the per-step counters but keeps the lock.
    function resetStats() {
      stats = freshStats();
    }

    // Forgets who was locked (call at the start of set-up).
    function reset() {
      ref = null;
      lastTs = null;
      lastMatchTs = null;
      stats = freshStats();
    }

    function setPolicy(policy) {
      o.policy = policy === "pause" ? "pause" : "flag";
    }

    return { update, summary, resetStats, reset, setPolicy, _options: o };
  }

  // Flags for a finished step, from createPersonTracker().summary().
  function peopleFlags(sum) {
    const flags = [];
    if (sum && sum.identityUncertain) flags.push("identity_uncertain");
    if (sum && sum.secondPersonInView) flags.push("second_person_in_view");
    return flags;
  }

  // ---------------------------------------------------------------------
  // Space and set-up check
  // ---------------------------------------------------------------------
  // The only way to find out whether there is enough room for the whole
  // body to fit in the camera view is to see whether it fits. diagnoseFraming
  // says *why* a frame does not give full-body tracking, and
  // createSetupMonitor accumulates that over the set-up period so the app
  // can stop with a specific reason ("not enough space") instead of
  // looping on "step back" indefinitely, and record that reason in the report.

  function diagnoseFraming(lm, opts) {
    const o = Object.assign({ minVisibility: 0.5, edge: 0.03 }, opts);
    if (!lm) return { reasons: ["no_pose"], needsMoreSpace: false, bodyHeightFrac: null };
    const reasons = [];
    const pts = lm.filter((p) => p && (p.visibility === undefined || p.visibility >= o.minVisibility));
    let bodyHeightFrac = null;
    if (pts.length >= 2) {
      const ys = pts.map((p) => p.y);
      bodyHeightFrac = Math.max(...ys) - Math.min(...ys);
    }
    // An ankle counts as "cut off" when it is tracked but at the very
    // bottom edge, or is not tracked and its estimated position is at or
    // beyond the bottom of the frame. An ankle that is simply not tracked
    // while its estimated position is well inside the frame is an
    // occlusion/lighting/clothing problem, not a space problem.
    const ankles = [LM.LEFT_ANKLE, LM.RIGHT_ANKLE];
    const cutAnkle = ankles.some((i) => {
      const p = lm[i];
      if (!p) return true;
      const ok = visible(lm, i, o.minVisibility);
      return ok ? p.y > 1 - o.edge : p.y > 0.93;
    });
    const ankleNotTracked = !cutAnkle && ankles.some((i) => !visible(lm, i, o.minVisibility));
    const nose = lm[0];
    const headCut = !!nose && nose.y < o.edge;
    const torso = [...TORSO_SHOULDERS, ...TORSO_HIPS].filter((i) => visible(lm, i, o.minVisibility)).map((i) => lm[i]);
    const sideCut = torso.some((p) => p.x < o.edge || p.x > 1 - o.edge);
    if (cutAnkle) reasons.push("feet_cut_off");
    if (ankleNotTracked) reasons.push("feet_not_tracked");
    if (headCut) reasons.push("head_cut_off");
    if (sideCut) reasons.push("side_cut_off");
    if (bodyHeightFrac != null && bodyHeightFrac > 0.92) reasons.push("too_close");
    if (!cutAnkle && !headCut && bodyHeightFrac != null && bodyHeightFrac < 0.3) reasons.push("too_far");
    const needsMoreSpace = cutAnkle || headCut;
    return { reasons, needsMoreSpace, bodyHeightFrac: bodyHeightFrac == null ? null : roundTo(bodyHeightFrac, 3) };
  }

  const SESSION_FAILURE = {
    not_enough_space: {
      label: "Not enough space",
      patient:
        "The camera could not see your whole body. There was probably not enough room between you and the camera. Try a larger space, or ask someone to place the device further back, then try again.",
      clinician:
        "Set-up timed out: the full body (shoulders to ankles) could not be brought into view, most often because the person could not get far enough from the camera.",
    },
    multiple_people: {
      label: "More than one person in view",
      patient:
        "More than one person was in view during set-up, so the camera could not tell who to follow. Please make sure only the person being assessed is in view, then try again.",
      clinician: "Set-up timed out: more than one person was in view and the person being assessed could not be identified.",
    },
    no_person_detected: {
      label: "No one detected",
      patient: "The camera could not find anyone. Check that the camera is on and pointing at the room, that the room is well lit, then try again.",
      clinician: "Set-up timed out: no person was detected.",
    },
    too_far_from_camera: {
      label: "Too far from the camera",
      patient: "You appeared too small in the picture for the camera to track reliably. Move closer to the camera, then try again.",
      clinician: "Set-up timed out: the person appeared too small in frame for reliable tracking.",
    },
    tracking_unreliable: {
      label: "Tracking not reliable",
      patient:
        "The camera could not follow your body reliably. Good lighting and plain, contrasting clothing and background can help. Please try again.",
      clinician: "Set-up timed out: landmarks were not reliably visible although the whole body appeared to be in frame (lighting, clothing, occlusion or device limits).",
    },
  };

  function describeFailure(reason) {
    return SESSION_FAILURE[reason] || null;
  }

  function createSetupMonitor(opts) {
    const o = Object.assign({ timeoutMs: 30000, hintAfterMs: 10000 }, opts);
    let startTs = null;
    let lastTs = null;
    const ms = { ok: 0, space: 0, multiple: 0, no_person: 0, too_far: 0, tracking: 0 };

    // tier: computeFrameQuality tier; framing: diagnoseFraming result;
    // peopleStatus: person-tracker status.
    function record(tier, framing, peopleStatus, timestampMs) {
      if (startTs == null) startTs = timestampMs;
      const dt = lastTs == null ? 0 : Math.max(0, timestampMs - lastTs);
      lastTs = timestampMs;
      let cat;
      if (peopleStatus === "multiple_unlocked") cat = "multiple";
      else if (tier === "no_pose") cat = "no_person";
      else if (framing && framing.needsMoreSpace) cat = "space"; // even if most landmarks are visible, ankles/head beyond the frame means the body does not fit
      else if (tier === "good" || tier === "fair") cat = "ok";
      else if (framing && framing.reasons && framing.reasons.indexOf("too_far") >= 0) cat = "too_far";
      else cat = "tracking";
      ms[cat] += dt;
      return cat;
    }

    function dominant() {
      let best = null;
      let bestMs = 0;
      ["space", "multiple", "no_person", "too_far", "tracking"].forEach((k) => {
        if (ms[k] > bestMs) {
          best = k;
          bestMs = ms[k];
        }
      });
      return best;
    }

    const REASON = {
      space: "not_enough_space",
      multiple: "multiple_people",
      no_person: "no_person_detected",
      too_far: "too_far_from_camera",
      tracking: "tracking_unreliable",
    };

    function status(timestampMs) {
      const elapsedMs = startTs == null ? 0 : Math.max(0, timestampMs - startTs);
      const dom = dominant();
      return {
        elapsedMs: Math.round(elapsedMs),
        shouldHint: elapsedMs >= o.hintAfterMs && dom != null,
        hintReason: dom ? REASON[dom] : null,
        failed: elapsedMs >= o.timeoutMs && dom != null,
        failureReason: dom ? REASON[dom] : "no_person_detected",
      };
    }

    function diagnostics() {
      return {
        okMs: Math.round(ms.ok),
        notEnoughSpaceMs: Math.round(ms.space),
        multiplePeopleMs: Math.round(ms.multiple),
        noPersonMs: Math.round(ms.no_person),
        tooFarMs: Math.round(ms.too_far),
        trackingPoorMs: Math.round(ms.tracking),
      };
    }

    return { record, status, diagnostics };
  }

  // Latency / frame-interval summary for device testing.
  function summariseTimings(samples) {
    const a = (samples || []).filter((v) => typeof v === "number" && isFinite(v)).sort((x, y) => x - y);
    if (!a.length) return { n: 0, medianMs: null, p95Ms: null, maxMs: null };
    const pct = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
    return { n: a.length, medianMs: round1(pct(0.5)), p95Ms: round1(pct(0.95)), maxMs: round1(a[a.length - 1]) };
  }

  // ---------------------------------------------------------------------
  // Squat module
  // ---------------------------------------------------------------------
  // Knee flexion angle = interior angle at the knee (hip-knee-ankle).
  // ~175-180 deg standing, ~80-100 deg at a clinically "full" squat.
  // We track a simple state machine to count reps and capture the angle
  // at the bottom of each rep on both sides plus trunk lean (compensation).

  function minOrSet(current, value) {
    return current == null ? value : Math.min(current, value);
  }

  function createSquatTracker(opts) {
    // view: "side" (default) = filmed side-on, which is the view the cited
    // sagittal-plane validation studies support. L/R asymmetry is not
    // reported in that view (the far leg is occluded / poorly tracked).
    // view: "front" keeps the legacy frontal behaviour incl. asymmetry.
    const o = Object.assign({ topAngle: 160, bottomAngle: 130, minVisibility: 0.5, view: "side" }, opts);
    const state = {
      phase: "top", // top -> descending -> bottom -> ascending -> top
      reps: [],
      currentMin: { left: null, right: null, trunkLean: 0 },
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
        state.currentMin = { left: leftAngle, right: rightAngle, trunkLean: trunkLean ?? 0 };
      } else if (state.phase === "descending") {
        if (leftAngle != null) state.currentMin.left = minOrSet(state.currentMin.left, leftAngle);
        if (rightAngle != null) state.currentMin.right = minOrSet(state.currentMin.right, rightAngle);
        if (trunkLean != null) state.currentMin.trunkLean = Math.max(state.currentMin.trunkLean, trunkLean);
        if (drivingAngle < o.bottomAngle) state.phase = "bottom";
      } else if (state.phase === "bottom") {
        if (leftAngle != null) state.currentMin.left = minOrSet(state.currentMin.left, leftAngle);
        if (rightAngle != null) state.currentMin.right = minOrSet(state.currentMin.right, rightAngle);
        if (trunkLean != null) state.currentMin.trunkLean = Math.max(state.currentMin.trunkLean, trunkLean);
        if (drivingAngle > o.bottomAngle) state.phase = "ascending";
      } else if (state.phase === "ascending" && drivingAngle > o.topAngle) {
        state.phase = "top";
        // A side that was never visible during the rep stays null (rather
        // than being reported as 0 degrees of flexion).
        const flexLeft = state.currentMin.left != null ? 180 - state.currentMin.left : null;
        const flexRight = state.currentMin.right != null ? 180 - state.currentMin.right : null;
        state.reps.push({
          repIndex: state.reps.length + 1,
          leftKneeFlexionDeg: round1(flexLeft),
          rightKneeFlexionDeg: round1(flexRight),
          trunkLeanDeg: round1(state.currentMin.trunkLean),
          asymmetryPct: o.view === "side" ? null : round1(asymmetryPct(flexLeft, flexRight)),
        });
      }

      return { phase: state.phase, leftAngle, rightAngle, trunkLean };
    }

    function summarize(targetReps) {
      const reps = state.reps;
      const depth = mean(
        reps
          .map((r) => Math.max(...[r.leftKneeFlexionDeg, r.rightKneeFlexionDeg].filter((v) => v != null)))
          .filter(Number.isFinite)
      );
      const asym = mean(reps.map((r) => r.asymmetryPct).filter((v) => v != null));
      const trunk = mean(reps.map((r) => r.trunkLeanDeg));
      return {
        movement: "squat",
        view: o.view,
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
  // patient stands on one leg. Sway = normalized 2-D (x and y) path length
  // of that point across the hold: 2-D (x and y) path length in normalised image units. Lower sway = more stable.

  function createBalanceTracker(opts) {
    // `stance` describes the starting posture the patient was instructed
    // into — "feet_together" (the default, safer test for a falls-risk /
    // older-adult population; a Romberg-style tandem/feet-together static
    // stance) or "single_leg" (the higher-difficulty variant, gated behind
    // the "advanced movements" option — see capture.js). The sway
    // computation itself (hip-midpoint path length) is identical either
    // way; only the label and clinical framing change.
    const o = Object.assign({ minVisibility: 0.5, stance: "feet_together" }, opts);
    const state = { positions: [], startTime: null, lastTime: null, stance: o.stance };

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
        stance: state.stance,
        holdDurationSec: round1(durationSec),
        swayPathLength: roundTo(pathLength, 4),
        swayStdX: roundTo(swayStdX, 4),
        swayStdY: roundTo(swayStdY, 4),
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
          s.steps.push({ heightNorm: roundTo(s.baseline - s.peak, 4), t });
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
        avgLeftStepHeight: leftHeights.length ? roundTo(mean(leftHeights), 4) : null,
        avgRightStepHeight: rightHeights.length ? roundTo(mean(rightHeights), 4) : null,
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

  // ---------------------------------------------------------------------
  // Session context: walking aids and plain-language summary
  // ---------------------------------------------------------------------
  // Added after group feedback (Oct 2026): older adults often already use
  // a walking aid, and the people who see the result are not only
  // clinicians but also the older adult and their carer.

  const WALKING_AIDS = ["none", "stick", "frame", "other"];

  // Missing/empty -> "none"; anything unrecognised -> "other" (so it is
  // still recorded as "an aid was involved" rather than silently dropped).
  function normaliseWalkingAid(value) {
    if (value == null || value === "") return "none";
    const v = String(value).toLowerCase();
    return WALKING_AIDS.indexOf(v) >= 0 ? v : "other";
  }

  // Shown with the results when an aid was used. A stick or frame can hide
  // or be mistaken for part of a leg, and aided performance is not
  // comparable with unaided performance; Flexion does not model either.
  function walkingAidNote(aid) {
    const a = normaliseWalkingAid(aid);
    if (a === "none") return null;
    return "This session was recorded with a walking aid (" + a + "). The aid can hide or be mistaken for part of a leg by the camera, and results with an aid should only be compared with other sessions recorded with the same aid. Flexion does not adjust for walking aids.";
  }

  const PLAIN_FLAG_TEXT = {
    incomplete_reps: "Not all of the movements were completed.",
    slow_sit_to_stand_time: "The chair stands took longer than a clinician would usually expect.",
    fall_risk_review: "Balance looked less steady than expected, or could not be held for the full time.",
    reduced_rom: "One or both arms did not reach as high as expected.",
    left_right_asymmetry: "One side moved differently from the other.",
    gait_asymmetry: "One side stepped differently from the other.",
    low_step_count: "Fewer steps were counted than expected.",
    limited_depth: "The squat was shallower than expected.",
    excess_trunk_lean: "You leaned forward more than expected during the squat.",
    tracking_interrupted: "The camera lost sight of you during this step, so the result may not be reliable. It can be repeated.",
    identity_uncertain: "The camera could not be sure which person it was following during this step, so the result may not be reliable. It can be repeated.",
    second_person_in_view: "Another person was in view of the camera during this step. The result is for the person being assessed, but a clinician may want to check it.",
  };

  // Builds a short, number-free summary for the person who did the
  // movements (and their carer). It never says the person is well: a
  // result with no flags is not evidence that nothing is wrong, and the
  // prototype is not validated. It also never shows evidence tiers or
  // citations; those stay in the clinician-facing report.
  function plainLanguageSummary(results, context) {
    const ctx = context || {};
    const list = Array.isArray(results) ? results : [];
    const completed = [];
    const flaggedItems = [];
    list.forEach(function (r) {
      const label = String(r.stepLabel || r.movement || "movement").replace(/_/g, " ");
      completed.push(label);
      (r.flags || []).forEach(function (f) {
        flaggedItems.push({
          movement: label,
          text: PLAIN_FLAG_TEXT[f] || "Something in this step was flagged for a clinician to look at.",
        });
      });
    });
    const failure = ctx.failureReason ? describeFailure(ctx.failureReason) : null;
    const headline = failure
      ? "This session could not be completed. " + failure.patient
      : flaggedItems.length
      ? "Some parts of this session were flagged for a clinician to look at."
      : "No parts of this session were flagged, but this does not mean that nothing is wrong.";
    return {
      incomplete: !!failure,
      headline: headline,
      completed: completed,
      flaggedItems: flaggedItems,
      aidNote: walkingAidNote(ctx.walkingAid),
      nextSteps: [
        failure
          ? "Tell the GP, physiotherapist or clinical team who asked you to do this that it could not be completed, so they can arrange another way to assess you if needed."
          : "Share these results with the GP, physiotherapist or clinical team who asked you to do them. They can decide whether anything more is needed.",
        "Contact your GP or physiotherapist sooner if you have had a fall, feel unsteady, or had pain during any movement.",
        "Stop any movement that feels unsafe or painful.",
      ],
      disclaimer: "Flexion is a research prototype. It is not a diagnosis and it cannot tell you that you are well. It has not been validated for clinical use.",
    };
  }

  function round1(v) {
    if (v == null || Number.isNaN(v)) return null;
    return Math.round(v * 10) / 10;
  }

  // Round to `digits` decimal places. Used for sub-metrics expressed in
  // normalised image units (fractions of frame width/height, typically
  // 0.001-0.1), where round1() would collapse almost every value to 0.0.
  function roundTo(v, digits) {
    if (v == null || Number.isNaN(v)) return null;
    const f = 10 ** digits;
    return Math.round(v * f) / f;
  }

  return {
    LM,
    angleAt,
    asymmetryPct,
    EVIDENCE,
    getEvidence,
    computeFrameQuality,
    createDropoutMonitor,
    personAnchor,
    createPersonTracker,
    peopleFlags,
    diagnoseFraming,
    createSetupMonitor,
    describeFailure,
    SESSION_FAILURE,
    summariseTimings,
    createSquatTracker,
    createArmRaiseTracker,
    createBalanceTracker,
    createWalkTracker,
    createSitToStandTracker,
    WALKING_AIDS,
    normaliseWalkingAid,
    walkingAidNote,
    plainLanguageSummary,
  };
});
