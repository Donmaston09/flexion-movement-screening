# Device test protocol (summary)

Full protocol and recording sheets: `Flexion-Device-Test-Protocol-v0.1.docx`
(kept with the project documents). This is a one-page summary.

**Purpose.** Technical feasibility only: does the app start and run on each
device, is a whole body found and followed, is a helper kept separate from the
person being assessed, and does set-up stop with a recorded reason when there
is not enough space. It does not test accuracy, validity or usability with
older adults.

**Tool.** Open `device-check.html` on each device. It runs the same pose model
as the app for 10 to 30 seconds and records device details, GPU or CPU,
camera resolution, frame rate, detection latency, how often a person and a
whole body are found, and second-person and identity-uncertain percentages.
It stores no video, images or landmark coordinates. Use "Copy all runs" or
"Download all runs" to save the JSON.

**Scenarios.** S1 baseline; S2 helper beside; S3 person leaves and helper
remains; S4 limited space (use `capture.html`; expect the session to stop at
about 30 s with "not enough space" recorded); S5 low light; S6 bright window
behind; S7 portrait; S8 landscape; S9 end-to-end core routine.

**Criteria** (proposed, to be agreed before testing): S1 whole body in view in
at least 90% of frames, at least 10 frames per second, median detection time
100 ms or less; S2 and S3 the helper is never followed; S4 stops within 35 s
with the correct reason.

**Status.** None of this has been run yet.
