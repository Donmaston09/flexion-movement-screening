# Flexion — Remote Movement Screening Prototype

**Author:** Anthony Onoja, Ph.D. — School of Health Sciences, Faculty of
Health and Medical Sciences, University of Surrey, United Kingdom.
Contact: [a.onoja@surrey.ac.uk](mailto:a.onoja@surrey.ac.uk) ·
[donmaston09@gmail.com](mailto:donmaston09@gmail.com)

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

- `index.html` — landing page. Introduces Flexion, surfaces the
  evidence-tier summary and the default-vs-advanced movement split, and
  links to the patient capture demo and provider dashboard. This is the
  front door for anyone (partners, reviewers) landing on the deployed site.
- `capture.html` + `js/capture.js` — patient-facing capture app. Runs a
  4-movement default routine scoped to older-adult/falls-risk screening
  (5x sit-to-stand, arm raise, feet-together static balance, walk in
  place), with squat and single-leg balance (both sides) available via an
  "Include advanced movements" checkbox. Overlays the detected skeleton
  live, checks camera framing before starting, speaks instructions aloud
  (toggleable) alongside the on-screen text, pauses scoring and flags a
  step if tracking is lost mid-movement, and produces a session report
  with an evidence tier attached to every movement.
- `dashboard.html` + `js/dashboard.js` — provider dashboard. Reads saved
  sessions and renders a table (with a confidence-tier column) plus a
  trend chart per patient/movement. Includes a "Load sample patient
  history" button that seeds 6 weeks of synthetic data so you can see the
  trend view without recording anything.
- `js/scoring.js` — the actual clinical math: joint-angle calculation,
  rep counting, ROM, left/right symmetry, sway-based stability score,
  gait cadence, sit-to-stand timing, frame-quality check, tracking-dropout
  monitoring, and the evidence-tier table. Framework-free so it runs
  identically in the browser and in Node.
- `test/scoring.test.js` — unit tests for the scoring math, run with
  `node test/scoring.test.js` (25 tests, no camera needed).
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
- `http://localhost:8000/index.html` — home page (evidence summary + links)
- `http://localhost:8000/capture.html` — patient capture (needs a webcam)
- `http://localhost:8000/dashboard.html` — provider dashboard

Grant camera permission when prompted. The pose model
(`pose_landmarker_lite`) loads from Google's CDN on first run. You'll be
asked to step back until your whole body is visible before the routine
starts — that's the new framing check, not a bug.

## Clinical review pass (Aug 2026)

A physiotherapist review of the working prototype (thank you, Danny) surfaced
one structural problem worth fixing before anything else: the original
six-movement battery mixed movements suited to a frail-elderly population
(sit-to-stand, gait) with movements that could themselves be a fall risk for
that same population (an unmodified single-leg balance test, a full
bodyweight squat) — serving no single population well, and potentially
unsafely. Three changes came out of that review:

1. **One coherent default population.** The default routine is now scoped to
   older-adult / falls-risk and general functional screening: 5x
   sit-to-stand, arm raise, feet-together static balance, and walk-in-place.
   Squat and single-leg balance (both sides) are still fully implemented and
   scored, but moved behind an explicit **"Include advanced movements"**
   checkbox on the capture page for fitter, younger, or post-surgical
   patients where they're clinically appropriate — opt-in rather than
   default. See `CORE_MOVEMENTS` / `ADVANCED_MOVEMENTS` /
   `buildActiveRoutine()` in `js/capture.js`.
2. **Feet-together balance is now the default stance**, not single-leg — a
   safer, more clinically standard fall-risk test for a general/older-adult
   population (closer to a Romberg/tandem-stance test). `createBalanceTracker`
   in `js/scoring.js` takes a `stance` option (`"feet_together"` default,
   `"single_leg"` for the advanced variant); the underlying sway computation
   is identical either way, so the evidence tier doesn't change — only the
   starting posture and clinical framing do.
3. **Spoken instructions + tracking-interruption handling.** The framing
   check asks patients to stand far enough back for full-body tracking,
   which is often too far to read on-screen text — instructions are now
   also spoken aloud (Web Speech API), with an on/off toggle. Separately,
   real sessions aren't clean lab recordings (someone walks past, a pet
   wanders into frame); `FlexionScoring.createDropoutMonitor()` watches
   per-frame tracking quality during a step, pauses scoring while tracking
   is lost rather than silently miscounting through it, and flags the
   result (`tracking_interrupted`) if a step was affected — see
   `js/capture.js`'s `renderLoop()` and `advanceStep()`.

A known limitation not yet fixed in code: on some MacBooks, the camera
appears to auto-frame on the face rather than the full body (likely macOS's
Center Stage), making full-body framing difficult even at distance —
`capture.html` now shows a setup tip suggesting Center Stage be turned off,
but the app itself has no way to detect or disable an OS-level camera
feature from the browser.

## How the scoring works (short version)

- **Sit-to-stand** — *High confidence (reps & time only)*. A hip-height
  state machine counts stand/sit cycles and times the first 5. Deliberately
  does not report a knee angle for this movement — see "What changed"
  above. Part of the default battery.
- **Arm raise** — *Moderate confidence*. Angle at the shoulder between the
  torso line and the upper arm (flexion/abduction only). Tracks max angle
  reached per side and the L/R difference. Not validated for rotational or
  multi-planar shoulder mobility. Part of the default battery.
- **Static balance** — *Exploratory*. Hip-midpoint position sampled every
  frame while holding a stance; total sway path length per second of hold
  converts to a 0–100 stability score. Feet-together by default (part of
  the default battery); single-leg, both sides, is available as an advanced
  option. The least evidence-covered domain reviewed — treat as a trend
  indicator, not an absolute measurement, regardless of stance.
- **Walk in place** — *High confidence (cadence/step count)*, moderate for
  step-height asymmetry. Counts vertical ankle oscillations per side to
  get step count, cadence, and a left/right step-height asymmetry proxy.
  Part of the default battery.
- **Squat** — *High confidence*. Interior angle at the knee
  (hip–knee–ankle). ~180° standing, lower = deeper flexion. A state
  machine (top → descending → bottom → ascending → top) counts reps and
  captures the angle minimum per rep on each leg, plus trunk lean as a
  compensation signal. Near-static bottom-of-squat angle is the accuracy
  profile the literature supports best. **Advanced/optional** — not part
  of the default elderly/falls-risk battery.

All of this runs from a single library, `js/scoring.js`, that takes plain
landmark objects (`{x, y, visibility}`) — see `test/scoring.test.js` for
how frames are constructed synthetically without a real pose model, and
`FlexionScoring.EVIDENCE` for the full citation text behind each tier.

## Mobile / iPhone

The app is responsive and works on phones — the layout collapses to a
single column, controls stack for touch, and the pose model automatically
falls back from GPU to CPU inference if a device's browser doesn't support
the GPU delegate (this matters on some iOS Safari versions).

To add it to a phone's home screen so it opens full-screen like an app:

- **iPhone/iPad:** open `capture.html` in **Safari** → tap **Share** →
  **Add to Home Screen**.
- **Android:** open `capture.html` in **Chrome** → tap **⋮** → **Add to
  Home screen** (or **Install app**).

This is a standard "Add to Home Screen" web app (manifest + Apple meta
tags in `manifest.json`/each page's `<head>`), not an App Store app — no
install review, no download, just a bookmark with an icon. Camera access
still requires the page to be served over HTTPS (or `localhost`); once
deployed (e.g. to Render, as this project is), that's automatic.

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
