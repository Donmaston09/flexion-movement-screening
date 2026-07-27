# Flexion — Remote Movement Screening Prototype

A working, browser-only prototype of the concept: a patient films a short
guided movement routine on a webcam, on-device pose estimation scores
range of motion / symmetry / stability in real time, and a provider
dashboard shows the results as numbers and trends — each one labeled
with how much the published literature actually supports trusting it.

This is a functional demo of the core mechanic (pose detection → clinical
scoring), not a finished clinical product. See
`Flexion-Technical-Spec.docx` for the production architecture, data model,
EHR integration, and validation plan, and `literature_research_on_the_app.docx`
/ `literature_citations_on_app.csv` for the literature review this version
is built on.

## What changed in this pass

A structured literature review (20 papers on telehealth MSK exams and
markerless/single-camera motion capture) surfaced a specific, actionable
finding: accuracy in this field is not uniform across movements or metrics.
Spatiotemporal gait measures and sagittal-plane hip/knee kinematics are
well-supported; frontal/transverse-plane and complex multi-directional
movement are not; and *dynamic transitional* tasks (like standing up) show
much wider measurement error than static or near-static joint positions,
even on otherwise-accurate systems. Three concrete changes came out of that:

1. **Evidence-graded confidence, per movement, in the product itself.**
   Every score Flexion produces now carries a tier — High / Moderate /
   Exploratory — plus the specific finding and citation behind it. This
   isn't a marketing badge; it's `js/scoring.js` refusing to imply the same
   confidence for a squat-depth reading (mean error <1.1°, per
   Ruder et al. 2026) as for a balance-stability score (the least
   evidence-covered domain in the review). See `EVIDENCE` in
   `js/scoring.js`.
2. **A new movement: the Five-Times-Sit-to-Stand test.** This is a real,
   widely used clinical functional/fall-risk measure. Flexion scores it by
   rep count and total time — not knee-angle depth — because the
   literature specifically flags sit-to-stand joint angles as having wide
   limits of agreement (12–20°) even when other markerless measures are
   reliable (Ruder et al. 2026). Scoring what the evidence says is
   trustworthy, rather than everything the pose model happens to output,
   is the whole point of this change.
3. **A camera framing / tracking-quality check before scoring starts.**
   Accuracy in the literature depends on the full body staying in frame;
   the app now requires good/fair landmark visibility to hold for ~1.2s
   before the timed routine begins, and shows a live tracking-quality
   readout throughout, instead of silently scoring a poorly-framed video.

## What's here

- `index.html` + `js/capture.js` — patient-facing capture app. Runs a
  6-movement routine (squat, 5x sit-to-stand, arm raise, single-leg
  balance x2, walk in place), overlays the detected skeleton live, checks
  camera framing before starting, and produces a session report with an
  evidence tier attached to every movement.
- `dashboard.html` + `js/dashboard.js` — provider dashboard. Reads saved
  sessions and renders a table (with a confidence-tier column) plus a
  trend chart per patient/movement. Includes a "Load sample patient
  history" button that seeds 6 weeks of synthetic data so you can see the
  trend view without recording anything.
- `js/scoring.js` — the actual clinical math: joint-angle calculation,
  rep counting, ROM, left/right symmetry, sway-based stability score,
  gait cadence, sit-to-stand timing, frame-quality check, and the
  evidence-tier table. Framework-free so it runs identically in the
  browser and in Node.
- `test/scoring.test.js` — unit tests for the scoring math, run with
  `node test/scoring.test.js` (20 tests, no camera needed).
- `literature_research_on_the_app.docx` / `literature_citations_on_app.csv`
  — the literature review this version of the app is grounded in.

## Running it

Camera access and ES module imports both require a real HTTP origin —
opening `index.html` directly as a `file://` URL will not work. From this
folder, run a local server:

```
python3 -m http.server 8000
```

Then open:
- `http://localhost:8000/index.html` — patient capture (needs a webcam)
- `http://localhost:8000/dashboard.html` — provider dashboard

Grant camera permission when prompted. The pose model
(`pose_landmarker_lite`) loads from Google's CDN on first run. You'll be
asked to step back until your whole body is visible before the routine
starts — that's the new framing check, not a bug.

## How the scoring works (short version)

- **Squat** — *High confidence*. Interior angle at the knee
  (hip–knee–ankle). ~180° standing, lower = deeper flexion. A state
  machine (top → descending → bottom → ascending → top) counts reps and
  captures the angle minimum per rep on each leg, plus trunk lean as a
  compensation signal. Near-static bottom-of-squat angle is the accuracy
  profile the literature supports best.
- **5x Sit-to-Stand** — *High confidence (reps & time only)*. A hip-height
  state machine counts stand/sit cycles and times the first 5. Deliberately
  does not report a knee angle for this movement — see "What changed"
  above.
- **Arm raise** — *Moderate confidence*. Angle at the shoulder between the
  torso line and the upper arm (flexion/abduction only). Tracks max angle
  reached per side and the L/R difference. Not validated for rotational or
  multi-planar shoulder mobility.
- **Balance** — *Exploratory*. Hip-midpoint position sampled every frame
  while on one leg; total sway path length per second of hold converts to
  a 0–100 stability score. The least evidence-covered domain reviewed —
  treat as a trend indicator, not an absolute measurement.
- **Walk in place** — *High confidence (cadence/step count)*, moderate for
  step-height asymmetry. Counts vertical ankle oscillations per side to
  get step count, cadence, and a left/right step-height asymmetry proxy.

All of this runs from a single library, `js/scoring.js`, that takes plain
landmark objects (`{x, y, visibility}`) — see `test/scoring.test.js` for
how frames are constructed synthetically without a real pose model, and
`FlexionScoring.EVIDENCE` for the full citation text behind each tier.

## Known limitations (by design, for a prototype)

- Single camera, 2D landmarks only — no depth, so angles are estimates
  and sensitive to camera angle (this is exactly what the pilot study in
  the spec doc is meant to quantify against real PT assessments).
- The evidence tiers describe what the *published literature* supports for
  markerless motion capture in general — they are not yet a product-specific
  validation of Flexion. That's what the pilot in the spec doc is for.
- No real backend: reports are saved to the browser's `localStorage`, not
  a server or EHR. `buildReport()` in `capture.js` already shapes each
  result as a mock FHIR `Observation` (with the evidence tier riding along
  as a `note`), so wiring in a real store is a matter of swapping the
  save/read calls for API calls.
- No authentication, multi-provider routing, or PHI handling — those are
  out of scope for a local demo and covered as requirements in the spec.
- Thresholds (rep detection angles, flag cutoffs, the sit-to-stand slow-time
  cutoff) are reasonable starting points, not clinically validated numbers.
  That validation is the explicit purpose of the pilot.
