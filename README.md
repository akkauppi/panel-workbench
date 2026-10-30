# Panel Workbench

Arrange panels on a surface, edit shared corners, and inspect flat panels and solids in your browser.

**Use the tool:** https://akkauppi.github.io/panel-workbench/

No installation is needed for the hosted tool. Choose an example, or open your own Rhino 3DM, OBJ mesh or saved study. Model imports and geometry calculations run locally in the browser. Save a study JSON before closing the page; send it privately to share an arrangement. Use a current desktop browser with WebGL enabled.

## Manual arrangement

In Cells, choose Drag corners. Adjoining seams and translucent cells follow the handle. Release to validate the arrangement; then continue moving corners while panel fitting runs in the background. Alt suppresses proximity snapping. Escape cancels the current gesture, clears selection and switches off the editing tools. Amber endpoints follow the perimeter. Concave and irregular layouts remain allowed. Crossings, folded editing charts, and invalid panels receive diagnostics. Save preserves the accepted source layout while panels refit; fabrication exports require the current calculation and their relevant validity checks.

Move cells remains available after corner edits, merges and for structured layouts. In these layouts, a centre handle moves the cell's shared corners together on the shell while preserving the authored seams and generator provenance. Boundary junctions slide along the source perimeter, so a boundary cell's centre may travel less than the handle. Release applies the checked edit as one undo step; crossing or collapsing seams are rejected without changing the accepted layout. Organic layouts without direct edits or merges retain their seed-based centre movement.

Select one cell and choose **Divide cell**. Drag a line inside it to set a divider; the preview extends to its boundary and follows the source shell. Release creates two cells as one Undo step. Cuts that make disconnected pieces or unusable slivers are rejected with an explanation. The new panel has a stable ID, and saved studies retain the split and original generator provenance.

**Explode panels** spreads parts using their positions, sizes and outward
directions, including adjoining coplanar panels. Release the slider to frame the
spread. Optional **Assembly guides** show dashed assembled outlines and lines
between logical cell corners. Intermediate curved-edge samples are omitted,
and parts hide guides behind them. Select panels to limit the connecting lines. Placement stays consistent across Cells, Flat and Solid views. OBJ/STL
exports retain the exploded positions, including selected-part exports; Rhino
exports retain the assembly and their separate part layouts. Explosion is an
inspection aid: overlap can remain in some camera projections, and it is not a
collision test.

Read [From a shell to buildable panels](docs/how-panels-are-fitted.md) for an illustrated explanation of the algorithm, why neighbouring flat parts must be solved together, and what makes some arrangements difficult.

## Saved projects, recovery and feedback

Studies store the source mesh, authored layout, settings, project ID and revision.
You can save accepted source work even when fitting is pending or unsuccessful.
Local recovery copies help restore interrupted work; browser storage can be
cleared, so download study files for portable backups.

The durable compatibility baseline is **study v6 from the final version deployed
on 2026-10-30**. Future versions must retain that authored design through supported
readers or migrations; older studies remain best-effort imports. Fitted parts are
recalculated on opening, and a saved calculation summary identifies changed,
resolved or newly unresolved panels. This does not promise identical geometry
from every future solver.

Use the fitting overlay and selected-panel corner displacement to inspect how
the fitted parts depart from their source anchors. A downloaded feedback report
includes revision/build, settings and panel checks, without the source mesh,
coordinates or project name. Review it and choose whether to share it; a study
file is a separate attachment and includes your geometry. Neither action uploads
files automatically.

Read [production readiness](docs/production-readiness.md) for the confirmed gaps,
verification checkpoints and current versus planned capabilities, and
[research notes](docs/research-notes.md) for the shell-preparation algorithms and
libraries being considered. No new geometry library has been adopted by this
durability update.

## Laser scale models

**Export → Laser scale model** prepares connected nets on 400 × 400 mm sheets, with separate cut, fold-groove and label colours for LightBurn. Preview and download each sheet and face as SVG. For paper/cardboard, enable all hinge guides on the cutting side; reverse folds use a separate green layer. A hinge coupon compares four groove widths. Start with a physical plywood test; laser settings and material bending are not simulated. Read the [laser model workflow](docs/laser-models.md) for layers, front/back registration and incomplete exports.

## Develop locally

Use Node.js 24 or newer. The runtime and geometry tests have no npm dependencies; Three.js is vendored with its licence.

```sh
npm start
# Open http://localhost:8787
npm test
npm run build:public
npm run build:pages
```

The optional browserless interaction suite needs jsdom. Install it separately and run `JSDOM_MODULE=/path/to/jsdom/lib/api.js npm run test:ui`. That suite mocks rendering; it does not verify actual WebGL appearance or hardware frame rate.

Real Chromium checks are available in `scripts/check-project-browser.cjs` (editing, downloads and recovery), `scripts/check-recovery-browser.cjs` (large snapshots and storage transactions), and `scripts/check-explode-browser.cjs` (exploded view, guides and matching downloads). They use an optional Playwright installation; see each script header for environment variables. Use `PANEL_BROWSER_URL` with the project check to test the packaged or deployed site.

This repository is self-contained: app source is in demo/, serving code in server.mjs, synthetic tests alongside the app, and packaging tools in scripts/. GitHub Actions runs the tests and publishes only the reviewed static app from dist/panel-workbench-pages/ to Pages on each main-branch push. Configure Settings > Pages > Source as GitHub Actions.

## Geometry limits

Surface partitions, jointly fitted flat panels, and thick solids are separate stages. Shared edges remain matched; fitting may offset panels from the reference shell. Some strongly folded regions cannot use the current local editing chart. Check planarity, surface deviation, stock thickness, and solid validity. Outlines are not optimized sheet nesting or CNC toolpaths. Fasteners, grain, assembly sequence, tool access, and all inter-panel collisions are not solved.

Fitting detects planar opening rims and keeps their trim planes through flat fitting and stock generation. Rim edges follow straight approximations of the source boundary; curved openings cannot be reproduced exactly by flat panels. Where the source lies entirely on one side of an opening plane, panels extending through that opening remain invalid. A bounded repair search adjusts neighbouring planes together and checks the stock geometry before accepting an improvement. Remaining failures stay visible under Panels to resolve and can be exported for Rhino repair. The source arrangement is retained, and the same inputs produce the same fit regardless of editing history.

The gallery uses procedural synthetic examples. No private reference models, saved studies, credentials, or previous project history are included. Third-party Three.js licensing is in demo/vendor/THREE-LICENSE.txt.

## Rhino files and production blocks

Use **Open mesh** for a Rhino `.3dm` containing mesh geometry or closed coplanar source curves. **Export → Rhino production · 3DM** writes each valid full part as one named block definition with an assembled and a flat instance. The actual carving setting is preserved. Read the [Rhino workflow](docs/rhino-workflow.md) for supported source objects, shared-block editing, and CAM preparation limits. Native file reading/writing uses bundled rhino3dm 8.35.0 (MIT); see demo/vendor/rhino3dm/NOTICE.txt.

Both Rhino exports use Rhino 6 format, also readable in Rhino 7 and 8. **Panels to resolve** lists individual outline and solid failures. **Rhino repair · 3DM** explicitly exports every panel with diagnostic user text and shared assembly/inspection blocks; where no solid exists, it includes the source patch and available candidate outlines for editing in Rhino. These repair candidates require geometry checks before fabrication.

Downloads verify the actual 3DM archive header and include `-rhino6` in the filename. The published footer shows the UTC build date and time. Each deployment loads its application, workers and CAD runtime from one versioned asset directory, preventing an updated page from mixing with cached export code. Save your study before reloading an already-open older page.

Both Rhino exports carry the project ID, revision and build in document user text
and on their shared block definitions, members and instances. Keep the matching
study file: those identifiers trace the handoff but do not embed the editable
project or regenerate meshes after Rhino edits.
