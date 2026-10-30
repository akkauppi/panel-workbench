# Laser scale models

Open **Export → Laser scale model**. The first release targets a 400 × 400 mm laser bed and thin plywood tests. Start with **Hinge test coupon** before cutting a model.

## Prepare a model

Choose the scale denominator (1:10 by default), sheet margin and groove width in millimetres on the small model. Click **Prepare sheets**. Each rigid fitted panel is unfolded around shared edges. The algorithm cuts some seams to avoid overlap, break cycles or fit the bed. It packs the resulting connected pieces onto as many sheets as needed. This is a heuristic arrangement, not optimized nesting.

The preview reports panels, connected pieces and sheets. Select a sheet and face, then **Download this SVG**. Download each required sheet and face separately. The files have an explicit 400 × 400 mm document size; check dimensions after import into LightBurn. Panel names remain P001, P002, etc. Matching seam labels identify edges to join with tape or glue; glue tabs are not generated.

Whole model requires all fitted outlines to resolve. **Resolved outlines only (incomplete)** deliberately excludes flagged outlines and lists their IDs in the preview and SVG metadata. Incomplete downloads include `-partial` in the filename. Full-size solid validity is separate: a resolved zero-thickness outline can be used for this scale model even when its thick, mitred or carved production solid fails. Repairs and stock changes invalidate the preview; prepare sheets again before downloading.

## LightBurn operations

The SVG contains vector paths and stroke lettering, so it requires no label font installation. Colours identify separate operations; they do not supply tested machine settings.

| Colour | Geometry | Intended operation |
| --- | --- | --- |
| Black | Net perimeter, openings and cut seams | Through cut, Line |
| Blue | Fold centreline at width 0, or a closed groove band at positive width | Line for centreline; Fill for band |
| Cyan, coupon only | 1, 2 and 3 mm closed groove bands | Fill |
| Red | Panel IDs, paired join IDs and coupon ruler | Light marking, Line |
| Gray | Four common registration references | Setup reference; normally disable output |

LightBurn maps imported colours to its palette and operation layers. Confirm the mapping and mode in **Cuts / Layers**, set operation order and assign your tested power, speed and passes. See LightBurn's [colour palette reference](https://docs.lightburnsoftware.com/2.1/Reference/UI/ColorPalette/) and [importing artwork guide](https://docs.lightburnsoftware.com/latest/GetStarted/CreatingAndImportingArtwork/).

## Front and back

A fold's geometric direction determines which face receives its groove. The back SVG is already mirrored left-to-right about the sheet centre and contains no cutting paths. The Back option is disabled when that sheet has no back grooves.

For two-sided work, engrave the back first, flip the stock in a registered jig, then engrave the front and cut last. Keep the same origin and physical stock position. The gray reference circles give both files common artwork bounds; they do not align the machine or stock automatically. Their output is normally disabled. Validate the jig, origin and flip direction physically before using a model. An already cut loose net cannot be assumed to remain registered for a second pass.

## Plywood hinge test

The coupon compares a centreline and 1, 2 and 3 mm groove bands. Its 50 mm reference checks scale. Test your actual plywood, grain direction and laser settings. Choose the remaining material thickness and test the required fold angle; a scored line alone may crack instead of folding. The app does not simulate plywood bending, compensate kerf or material thickness, calculate bend allowance, or prescribe power, speed, passes or depth.

These SVGs are fabrication experiments based on nominal panel geometry. Software tests check unfolding, geometric overlap, sheet bounds, layer separation and export scaling. They do not establish a successful physical hinge or a LightBurn machine setup. Paper templates and 3D-print exports for scale models remain separate future work.
