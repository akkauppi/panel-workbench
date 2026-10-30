# Rhino import and production layout

Use `.3dm` to transfer a source mesh or planar boundary curves from Rhino, and
to export panels as linked block instances. Keep the Workbench study JSON as
the editable design document.

## Import a source from Rhino

1. In Rhino, isolate the intended source geometry. Hide unrelated objects and
   layers, or export the selected source to a separate `.3dm` file.
2. In Workbench, choose **File → Open mesh** and select that file.
3. Check the imported dimensions, openings, and orientation before generating
   panels. Rhino document units are converted to millimetres automatically, with
   Z as the vertical axis. Files without usable unit information need correction
   in Rhino before import.

Visible meshes are imported, including meshes inside transformed and nested
blocks. If the file contains surfaces or polysurfaces, each face must already
have a saved render mesh. The browser reads those cached meshes; it cannot
generate Rhino's meshing result for an arbitrary surface. If import reports a
missing mesh, create an explicit mesh in Rhino and save/export that mesh. Saving
with render meshes may also work, but an explicit mesh gives control over the
approximation and avoids dependence on the cache. The underlying API retrieves
existing meshes through [BrepFace.getMesh](https://mcneel.github.io/rhino3dm/javascript/api/classes/BrepFace.html#getMesh).

If there are no surface objects, closed coplanar curves can define one flat
source region, with inner loops for openings. Polylines retain their segments;
supported curved outlines are approximated adaptively at 0.1 mm tolerance.
Open curves, nonplanar curve networks, intersecting loops, and separate outer
regions are not supported by this curve-to-surface import. Create the desired
shell in Rhino and import its mesh when working from general 3D curves.

When surfaces and curves coexist, the surface mesh is the source; curves are
reported as ignored. Imports are processed in the browser, not uploaded to the
hosting service.

## Export the assembly and flat parts

Set thickness, edge rounding, orientation, and carving as required, then let the
current calculation finish. Choose **Export → Rhino production · 3DM**.
Unresolved flat or solid panels must be corrected before this export is available.

The file uses the Rhino 6 format (also readable in Rhino 7 and 8), millimetres, and
Rhino's Z-up coordinates. Every panel has one block
definition, named `P001`, `P002`, and so on. Each definition contains the full
panel mesh and closed nominal outline curves. The mesh preserves the geometry
of the selected settings: carved when carving is enabled, uncarved when it is
disabled, with the calculated thickness, mitres, and rounding.

The app checks the file's actual archive header before downloading, and filenames
end in `-rhino6.3dm`. If an older exporter returns another version, the download
is stopped with a message. The published footer identifies the build by its UTC
date and time; save your study before reopening or refreshing an older page.

| Layer | Contents |
| --- | --- |
| Assembly | One instance of each panel in its assembled position |
| Flat layout | A second instance of the same definition, laid beside the assembly |
| Part geometry | The full panel mesh inside each definition |
| Cutting outlines | Nominal outer and opening curves inside each definition |

The flat placement rotates and translates the physical part; it retains its
thickness and carving. Its lowest point lies at world Z=0. Parts are arranged in
rows with spacing based on their complete footprints. This is a preparation
layout, not optimized sheet nesting.

The closed curves describe the nominal fitted-panel boundary projected to the
bed plane. They are not cutter-compensated paths or a bevel/stock envelope. Use
the full mesh to inspect the actual part, and establish stock, grain, cutter
diameter, tool access, fixtures, and machining operations in the CAM workflow.
The exported part remains a mesh; export does not reconstruct smooth NURBS
surfaces or Rhino polysolids.

## Export unresolved panels for repair

Choose **Export → Rhino repair · 3DM** when some panels remain unresolved and
you want to finish them in Rhino. This explicit repair export includes every
panel; the normal production export still requires resolved geometry. Both
exports use the Rhino 6 file format.

Each panel keeps its `P001`-style name and shared block definition, with an
assembled instance and another instance on **Repair layout** beside it. The
repair layout rotates and translates the same geometry for inspection. A source
patch can remain curved, open, or zero-thickness in that layout.

- A resolved panel retains its actual full part, including the selected carving.
- An unresolved panel with usable solid candidate geometry retains that candidate.
- If no usable solid was produced, its original source mesh patch is included.
  The exporter does not invent thickness or carving for that patch.
- Finite fitted candidate outlines are included on **Repair outlines**, even when
  they cross or are non-planar. They retain their original 3D position and are
  marked as candidates rather than cutting paths. Unusable outlines are recorded
  in the repair notes.

Resolved meshes are on **Resolved parts**; unresolved meshes are orange on
**Unresolved parts**. Select a block or its members and inspect the Rhino
attribute user text for `panel-workbench-status`, `panel-workbench-representation`,
`panel-workbench-flat-issues`, `panel-workbench-solid-issues`, and
`panel-workbench-repair-notes`. The block description also lists the diagnosis.
The same diagnostics are stored on both instances and the shared definition.

Use **BlockEdit** to repair the shared geometry. Changes appear in both
placements. Repair geometry is not a production-ready solid or a planar cutting
layout; verify the result in Rhino before fabrication. If a panel has neither a
usable candidate mesh nor a usable source patch, export fails with its panel
name rather than silently omitting it.

## Edit the linked panels in Rhino

Open the exported file and use **BlockEdit** on either instance of a panel.
Commit the definition edit to update both the assembled and flat instances.
Both refer to the same named definition. Moving or rotating one instance changes
only that instance's placement. Exploding an instance removes that instance's
connection to the shared definition. See Rhino's
[BlockEdit documentation](https://docs.mcneel.com/rhino/8/help/en-us/commands/blockedit.htm).

The mesh and outline curves are separate objects within the definition. Editing
an outline updates that curve in both instances, but does not regenerate the
mesh, bevels, or carving. Edit the necessary objects together, or regenerate the
part from Workbench and export again. Saving a new `.3dm` from Workbench does not
patch an already edited Rhino document automatically.

Reimporting an unmodified Workbench export recognizes its placement metadata and
imports the assembled meshes without duplicating the flat or repair layout. This produces
a new source mesh; it does not restore panel-editing history, settings, or the
authored layout. Use the saved study JSON to resume the Workbench design.

## Verification boundary

Native-file serialization tests check block definitions, shared instance IDs,
units, transforms, geometry, and layout spacing. A manual Rhino open/BlockEdit
check and a CAM check on the intended production setup are still required; those
have not been verified by the browser or serialization tests.
