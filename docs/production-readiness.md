# Shell preparation: readiness and remaining work

Review date: 2026-11-02. The main workflow is preparing an architectural shell
as an editable arrangement of flat physical panels. Laser and paper models are
secondary ways to inspect that design. A valid scale-model net is not evidence
that the full-size stock, joints or machining operations are feasible.

## Supported project baseline

The durable compatibility contract begins with study format **v6 in the final
version deployed on 2026-10-30**. Future versions should preserve the ability to
open that baseline's accepted source geometry, authored layout and settings,
using explicit migrations where necessary. Frozen public fixtures exercise that
contract. The release/build identity in the saved project identifies the exact
producer; this document does not embed its own future commit hash.

Earlier studies are imported on a best-effort basis. Supporting their current
import paths is useful, but there is no promise to reproduce every historical
generator or solver indefinitely. Even for the supported baseline, retaining the
authored design does not promise bit-for-bit identical future fitted solids:
changes must be visible through the saved calculation comparison and current
validation. Unsupported required features must be reported before replacing live
work.

For an illustrated explanation of the calculation and its complexity, read
[From a shell to buildable panels](how-panels-are-fitted.md).

## What each result establishes

| Stage | What is checked | What it does not establish |
| --- | --- | --- |
| Accepted source edit | Attachment to the source mesh, connected regions, shared boundaries and source coverage | That all derived panels can be flat or made from the selected stock |
| Fitted panel | Planarity, outline validity, shared joints and displacement constraints | A closed solid or sufficient material for carving |
| Stock/carved panel | Thickness construction, mesh topology, joint mismatch and selected carving checks | Cutter access, fixtures, grain, structural performance or machine settings |
| Production 3DM | Every exported panel passes the current flat/solid gates; assembly and layout use shared definitions | Native Rhino editing behavior or CAM readiness on a particular machine |
| Repair 3DM | Every panel is represented, with unresolved candidates or source patches explicitly identified | That candidates are solids or that the inspection layout is a cutting layout |

Source geometry, the authored layout and derived fabrication geometry must remain
separate. A rejected calculation must not destroy an accepted source edit or
prevent the designer from saving it. The study JSON is the editable document;
the Rhino export is a downstream handoff. See [the Rhino workflow](rhino-workflow.md).

## Findings and evidence

### Reproduced: a study could save successfully and then exceed Open's limit

Before the durable-project update, Save serialized the study without a matching
byte-size check, while Open refused files larger than 30 MB. An approximately
31.9 MB synthetic study passed the document parser and source geometry
validation but exceeded the UI's Open gate. This is a save/open contract bug,
independent of the panel solver.

The durable-project fix uses a single size policy shared by serialization and opening,
with a useful error before claiming that a usable file was saved. The regression
must test the serialized byte count, not just JavaScript string length. Generated
synthetic geometry is sufficient; private project files are not test fixtures.

### Code-confirmed: unit changes could discard the editing context

The pre-update units-change flow reloads the source through the model-loading
path, which clears layout/history state. That path was identified by code review;
it was not independently reproduced in a real browser during the audit.
The up-axis control changed display orientation and did not use that reset path.

Treat a unit correction as a deliberate source revision. Retain a
recoverable prior document and make the effect on existing edits explicit. Do not
silently reinterpret saved millimetre corner targets against a rescaled mesh.

### Confirmed geometric failure: a short shared edge reverses during fitting

A private diagnostic case had two unresolved panels sharing the same short
source edge. The approximately 6.368 mm edge became approximately 1.190 mm long
with its endpoint order reversed after fitting. One outline overlapped and the
other crossed. This was a real geometric failure, not merely a numerical
tolerance warning. Private source geometry is not included in this repository.

Increasing the existing repair budget alone did not resolve that case. A smaller
initial repair step recovered it in an isolated experiment, but another step size
introduced failures elsewhere. Those experiments did not establish a general
replacement algorithm and are not a reason to weaken export checks.

Future fitting work should preserve edge order and minimum usable features while
solving planarity and joint constraints. Exact predicates can improve geometric
decisions; they cannot make an infeasible arrangement feasible. The failure should
be explained at its shared seam, with both affected panels highlighted.

## Durable-project and feedback implementation

This update introduces bounded calculation evidence in
[`project-feedback.js`](../demo/project-feedback.js):

- Per-panel flat and solid validity, issue codes, planarity and source-to-fitted
  retained-corner displacement. Unknown values remain unknown.
- A versioned fingerprint of the ordered source/fitted/solid geometry and
  topology, rounded to one millionth of a millimetre. It detects changed results
  without storing the geometry. It is not a cryptographic identity or a proof of
  geometric equivalence; equivalent reindexing can change it.
- Comparison with a previous saved calculation: changed, resolved, newly failed,
  added and removed panel IDs. Incomplete summaries do not make those claims.
- A JSON diagnostic report containing project ID/revision, build, allowlisted
  settings, selected IDs, calculation evidence and the latest edit/rejection.
  It excludes mesh data, coordinates, project names, paths and the complete
  project. Known issues use public text; unfamiliar free-form errors become an
  unclassified issue. Project attachment is a separate explicit UI action.

Summaries are capped at 2,000 panel records and 12 distinct issues per panel.
Counts include panels beyond the record cap, and truncation is explicit. Missing
solid results are not reported as valid or as recovered. The displacement metric
measures corresponding retained corner anchors; it is not the maximum distance
between the complete curved source and the fitted surface.

The document integration stores optional evidence as
`lastCalculation: { revision, build, summary }`, separate from source geometry and
edit history. Reopening recalculates from the authored source and compares the
new result with that evidence. A changed result must be surfaced to the designer;
an old fingerprint must never be used to bypass current validation.

The report is downloaded locally for the user to inspect and choose whether to
share. Generating it does not upload anything. Although geometry and names are
excluded, settings, issue counts and opaque project IDs can still reveal project
characteristics; the report is intentionally compact, not anonymous.

## Local save and resume

The current release implements this workflow. Real Chromium checks cover
automatic reopening, opt-out, before-close warnings, camera/orientation
preservation, and fallback from an invalid saved source to manual recovery.

**Save locally and resume**, in the bottom project bar, defaults to on unless the
user has switched it off. With it enabled, accepted source work and settings are
saved locally. On startup the app attempts to restore the latest available saved
snapshot, including the study's view and camera, then recalculates fitted panels.
An in-progress or rejected source gesture is not an accepted saved layout. A
pending or failed panel calculation does not remove the accepted source work
from that snapshot.

Full study snapshots, including source geometry, are stored in **IndexedDB**.
**localStorage** stores only the boolean on/off preference. The resume snapshot
uses the existing v6 project document, with no change to its format or durable
compatibility baseline. It does not preserve the session Undo/Redo stack,
selection, temporary editing modes, unfinished gestures or explosion amount.

Turning the checkbox off suppresses new local copies and automatic startup
resume. It does not erase copies already stored in **Recovery copies**; those
can still be inspected, restored, downloaded or manually deleted. Local saving
does not upload a project or provide synchronization across devices or browsers.
The preference also updates other open tabs of this site. A write already
underway can finish; queued saves are cancelled. Background fitting alone does
not make an older tab the most recently used project for automatic resume.

The app requests a browser leave-page warning before closing, reloading or
navigating away when work has not been downloaded or an edit is pending, even if
a local recovery copy has been saved. The browser controls the generic wording
and may suppress the dialog; `beforeunload` is particularly unreliable on mobile
when an app is terminated. It must not be treated as the moment at which all work
will safely be saved. See [MDN's beforeunload usage
notes](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event#usage_notes).

Browser storage has quotas and can be cleared or evicted; private browsing may
discard it when the session ends. Crashes or mobile app termination can also
interrupt a write before it finishes. Local resume is therefore a convenience,
with a downloaded study as the portable backup. See [MDN's storage quotas and
eviction guide](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

The 374 automated tests include preference/storage failures, cross-tab opt-out,
activity ordering, and delayed startup guards. Browserless integration checks
also cover saving through fitting failures, pending-edit close warnings, and
protecting edits begun while manual recovery is being validated. The dedicated
local-save browser script passes 10 scenarios; the existing project browser
script passes 9. These checks do not establish crash recovery on every browser
or device.

## Exploded inspection and assembly guides

**Explode panels** derives a direction from each panel's position relative to the
assembly centre, blended with its outward-oriented face normal. Panel size and
available physical stock determine conservative bounding envelopes. A bounded
repulsion step adds spacing between those envelopes, so adjoining coplanar or
coincident-centre panels can separate instead of moving together along one
normal. IDs determine fallback directions and calculation order, keeping repeated
results deterministic.

The full arrangement is cached for the current geometry. The slider scales those
offsets linearly from exact zero to the full arrangement, without recalculating
directions at intermediate amounts. Cells, Flat and Solid views use the same
offsets while the underlying geometry is unchanged. Releasing the slider frames
all exploded parts; **Fit view** also uses their current positions.

Optional **Assembly guides** draw dashed outlines at the actual assembled
positions of the current representation: source boundaries in Cells, fitted
boundaries in Flat, and physical cap boundaries in Solid. Connecting lines and
endpoint markers link logical cell corners to their exploded positions.
Logical shared junctions and sharp fixed perimeter turns are retained;
intermediate mesh/curve samples are omitted. Because meshes have no CAD curve
semantics, a fixed perimeter turn of at least 30° is the conservative corner
fallback. Solid views use one nominal joint anchor per owner, not both cap meshes
or roundover samples. All assembly outlines, connectors and markers obey depth
testing, so opaque parts hide guides behind them. Selecting parts limits the
connectors to that selection while retaining the assembled outlines.

Whole-model OBJ/STL and selected-part OBJ exports use the same per-panel offsets
as the view. Exporting a selected part does not recompute a different explosion
around that selection. Rhino production and repair exports retain their assembled
positions and separate flat/inspection placements. The explosion never changes
the source, the fitted geometry, its validity or the CNC preparation layout.

This is a presentation heuristic with a fixed work and displacement budget. It
is not an assembly collision check, packing guarantee or promise that every
camera projection will be free of overlap.

Verification includes 14 pure-helper tests covering coplanar splits, unequal
sizes, symmetric arrangements, coincident centres, opposing normals, stacked
faces, stock envelopes, deterministic reordering and exact slider scaling.
Local development measurements were approximately 50 ms for a synthetic
144-panel grid and approximately 45 ms for a private 130-panel case. The grid had
positive conservative-envelope spacing at full explosion. These are one-off
helper timings, not browser frame-rate or general performance guarantees; no
private geometry is included in the repository.

## Implemented workflow and remaining priorities

The durable-project update integrates saving and recovery of accepted source
work, v6 document provenance, saved/current calculation comparison, displacement
feedback and locally downloaded diagnostics. The production-review update adds
named checkpoints, local joint inspection, project limits, source-edit locks,
optional issue attachments and a complete Rhino handoff package. Read the
illustrated [review and handoff guide](project-review-workflow.md) for those
controls and their limits. Release gates must verify these behaviors together.
These are workflow improvements; the fitting algorithm and geometry-library
proposals remain separate work.

| Priority | Next capability | Acceptance checkpoint |
| --- | --- | --- |
| Release gate | Save accepted source work independently of fitting, with explicit recovery | A failed/stale calculation cannot erase accepted edits; interrupted work can be restored; an offered save can be reopened |
| Release gate / extend | Inspect a problem panel with its neighbours and available problem locations | Measured locations receive markers; a panel-level or regional diagnosis is stated honestly when no exact seam is known |
| Release gate / extend | Show source-to-fitted displacement and boundary movement in the view | The designer can distinguish intentional faceting from excess drift and compare named alternatives using the current solver |
| 4 | Preview centre moves and show pending/rejected edit feedback | A local preview never becomes saved authority before source validation; late worker replies cannot replace newer input |
| 5 | Improve coupled fitting using bounded, independently validated trials | No new invalid panels in controls; source coverage, opening constraints, edge order and stock checks remain enforced |
| Release gate | Keep the editable study, exact Rhino file, schedule and manifest together | All files describe one captured revision; hashes match the package; the next export can identify changed, added and removed panel IDs |

These rows describe acceptance goals, not a claim that every interaction or
external workflow is already implemented. Code-level tests, browser checks and
native fabrication checks should be reported separately for each release.

## Offset a fitted panel along its normal

**Offset panel** adds a persistent plane constraint in Flat view. Select one
panel, drag its normal-direction handle or use **Panel offset · mm** and Apply.
Reset, Reset all panel offsets, Undo and Redo remain available after an
unresolved calculation. The source shell and its authored layout stay unchanged.
See the illustrated [offset workflow](offset-panels.md) for directions, saved
values, source/topology edits and practical ways to resolve failures.

The baseline fitted plane provides the zero and signed direction. A nonzero
offset fixes that panel's plane while unconstrained neighbouring planes and
shared corners adjust. The requested distance is not silently reduced to obtain
a valid result. Repeated calculations apply the distance once to the baseline.
An offset can change outlines, panel dimensions and geometry beyond the immediate
neighbours. Changing source or stock settings can change the baseline itself.

The drag preview is a positioning aid. On release, boundary, outline, planarity
and solid checks run again. Failed calculations retain the chosen offset for
editing, saving and Rhino repair; production exports wait for valid current
parts. Failure messages explain the geometric problem and suggest reducing or
resetting nearby offsets, changing source corners/centres, dividing a region or
adjusting stock. A bounded solver failure does not establish that every possible
solution is impossible.

Study v6 uses the required feature `panel-offsets-v1` when nonzero offsets exist.
Older readers reject that feature explicitly instead of dropping the settings.
An offset is independent of exploded inspection and curvature-based generation.

## First real-project session

1. Import the shell, check source units and orientation, then download a study
   file. Keep the original Rhino source alongside it. The build date is visible
   in the footer; the study and feedback report also record the content build.
2. Make a small, representative set of centre/corner moves, merges and divisions.
   Use **Show fitting changes** and the selected corner-shift metric to review
   the fitted result. Save another revision before a large design change.
3. Use **Assembly guides** with exploded panels to inspect where the parts return
   to the assembly. Select a panel to reduce the connecting-line clutter.
4. If something fails or changes unexpectedly, select the affected panel and
   download the feedback report. Share the intended action, expected result and
   actual result with that report. Attach a screenshot or the study privately
   when geometry is needed to reproduce it; the report itself omits geometry.
5. Reopen a saved file and check the source arrangement and calculation comparison.
   Test a Rhino handoff on a representative region before committing a complete
   production job. Keep the exported 3DM with its matching study revision: future
   study readers preserve authored inputs, while fitted parts can be recalculated.

Recovery is a convenience within that browser, not the only project copy. If
local saving is off or storage is unavailable, keep a downloaded study before
replacing the current project. Units changes start a new source interpretation;
retain the previous one in a downloaded study or a completed recovery copy.

## Verification checkpoints

1. **Document tests:** retain frozen durable-v6 fixtures; preserve stable IDs and edit
   provenance; reject unsupported required features; round-trip unresolved source
   layouts; check limits on the exact bytes being downloaded.
   Exercise older best-effort imports separately from the durable contract.
2. **Feedback tests:** detect changes when only solid geometry changes; do not
   treat missing stages as valid; reject corrupt summaries; bound record sizes;
   verify that reports strip coordinates, names, paths and arbitrary error text.
3. **Source/solver tests:** move corners and centres, split/merge and undo; measure
   accepted source coverage separately from flat/solid validity; preserve openings
   and shared boundaries; keep public synthetic cases for known failure classes.
4. **Browser checks:** save during/after a failed calculation; check the default-on
   local-save option, automatic resume and the off state; reload and recover the
   source/settings/view/camera; exercise storage failures and leave-page warnings;
   compare saved/current results, select affected panels and download diagnostics.
   Mocked renderer tests establish wiring, not WebGL performance or visual quality.
5. **Rhino checks:** open in the intended Rhino version, verify millimetres and
   orientation, edit a shared block and inspect both placements. Serialization
   tests alone do not establish the native application result.
6. **Production checks:** establish stock, machining strategy, kerf/tolerances,
   tool access, fixtures and a physical joint test in the intended CAM/material
   workflow. Laser coupons and fold guides do not replace these checks.

## Rhino revision traceability

Current production and repair exports store project ID, revision, build and
export kind in document user text and on every shared block definition, member
and placed instance. Native serialization round-trip tests verify those fields,
shared definitions and Rhino 6 archive format for both exports. Extra project
fields are not copied; malformed identities, revisions and build strings are
rejected. This is implemented metadata linkage, not a claim of native Rhino UI
verification.

The handoff ZIP adds a separate manifest with application/solver versions,
units, settings, panel IDs/fingerprints, calculation validity, project warnings
and SHA-256 hashes of its payload files. It bundles the matching study JSON,
exact Rhino 6 file and panel schedule for one captured revision. Its saved export
history supports the next handoff's changed/added/removed comparison. Hashes
identify files; they do not authenticate approval or replace production checks.
See [the review and handoff guide](project-review-workflow.md) for the contents.

The study JSON is still needed to resume source editing; the 3DM metadata does
not embed that document. See [the Rhino workflow](rhino-workflow.md) for the exact
user-text keys.

Editing an outline within a Rhino block updates that curve in both instances,
but does not regenerate its mesh or carving. Exporting again does not patch an
already edited Rhino document. Keep manual Rhino changes as distinct downstream
revisions; the package does not introduce a bidirectional editing workflow.
