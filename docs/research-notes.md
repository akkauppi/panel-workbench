# Research notes: robust shell preparation

Reviewed 2026-10-30 against the projects' own repositories, documentation and
author publications. The main goal is designer-controlled preparation of an
architectural shell: surface-attached layout editing, feasible planar panels,
matched joints and inspectable physical parts. Scale-model unfolding is a
secondary consumer of those results.

The curvature-sizing assessment below was added on 2026-11-02. It supports an
optional initial-arrangement method; it does not change the role of authored
source geometry or replace coupled panel fitting.

The integration costs below are engineering assessments, not measured estimates
or completed integrations. None of these libraries alone replaces the coupled
panel-fitting problem.

## 1. Robust predicates: a small, direct improvement

[robust-predicates](https://github.com/mourner/robust-predicates) provides adaptive
`orient2d`, `orient3d`, `incircle` and `insphere` tests in JavaScript, with browser
builds. It follows the **Unlicense**. Its foundation is Jonathan Shewchuk's
[Adaptive Precision Floating-Point Arithmetic and Fast Robust Geometric
Predicates](https://www.cs.cmu.edu/~quake/robust.html), published in 1997 after the
1996 technical report.

**Fit:** use reliable signs for near-collinear clipping, segment classification
and topology decisions. Those are relevant to the small slivers and near-zero
orientations encountered while editing source cells.

**Cost:** low packaging cost; moderate care at call sites. The JavaScript API's
coordinate/sign convention differs from Shewchuk's original implementation, so
existing y-up tests must be explicit. Keep geometric tolerances for design intent
separate from the exact sign decision.

**Gap:** predicates answer geometric questions for the represented inputs. They
do not produce exact constructed intersection coordinates, preserve shared IDs,
or prevent an optimizer from reversing a real short edge. Do not replace every
tolerance with an exact-zero comparison indiscriminately.

## 2. Geometry-central: movement and measurements on the shell

[geometry-central](https://github.com/nmwsharp/geometry-central) is a **MIT** C++
surface-processing library. Its
[SurfacePoint](https://geometry-central.net/surface/utilities/surface_point/)
represents a vertex, an edge parameter or a barycentric point inside a face.
[Geodesic tracing](https://geometry-central.net/surface/algorithms/geodesic_paths/)
advances a point in a tangent direction across mesh faces, can return the complete
path, and stops at boundaries or chosen barrier edges. The trace API requires a
manifold surface mesh.

The library also provides [polyhedral and heat-method
distances](https://geometry-central.net/surface/algorithms/geodesic_distance/).
The heat method is approximate and reuses precomputation for repeated queries;
the polyhedral algorithm answers a different accuracy/performance requirement.
They should not be described as interchangeable exact geometry operations.

**Fit:** a strong research candidate for corner sliding, centre movement, seam
transport and measurements on curved shells beyond one projected local chart.
The surface-point model fits persistent source attachment well.

**Cost:** medium to high. The documented public interface is C++; a narrowly
scoped native helper is a reasonable first experiment. Browser deployment would
need a tested WASM binding and memory/data-transfer boundary. No ready-made
official browser package was established in this review.

**Gap:** surface movement does not enforce planarity, avoid intersecting authored
seams automatically, or ensure manufacturable joints. Persisted source anchors
still need stable identities and transfer rules if the source is remeshed.

## 3. Geogram: initial partitions and robust mesh operations

[Geogram](https://github.com/BrunoLevy/geogram) has a
[BSD-3 core license](https://github.com/BrunoLevy/geogram/blob/main/LICENSE).
Its [restricted Voronoi
API](https://brunolevy.github.io/geogram/classGEO_1_1RestrictedVoronoiDiagram.html)
provides surface-cell intersections, symbolic polygon callbacks, individual-cell
construction and an exact-predicate option.
[Remeshing](https://github.com/BrunoLevy/geogram/wiki/Remeshing) uses centroidal
Voronoi methods and supports density and curvature adaptation; the author's page
links the underlying RVD/CVT research.

**Fit:** initial shell partitions, reference results for clipping, and explicit
mesh-preparation tools. Per-intersection information is promising for tracking
which source triangles contributed to a panel.

**Cost:** high for replacing an editable partition implementation. Native and
[Emscripten builds](https://github.com/BrunoLevy/geogram/wiki/compiling_Emscripten)
are documented. The upstream project links a separate
[Rosetta binding](https://github.com/rosetta-bindings/geogram-rosetta) for
JavaScript/WASM/TypeScript and other languages. Its currently documented bound
operations include mesh repair, remeshing, parameterization and Booleans; direct
restricted-Voronoi editing is not listed. Do not assume that binding already
exports the API needed by this application.

**Gap:** Voronoi optimization tends toward its mathematical objective; it is not
a replacement for an irregular authored arrangement. A remesh changes source
triangles and therefore needs explicit provenance/anchor transfer. Browser
performance must be benchmarked on the intended interactive operations.

The [dependency inventory](https://github.com/BrunoLevy/geogram/wiki/ThirdParty)
lists optional Triangle with separate commercial-use restrictions and TetGen
under AGPL. A core BSD license does not imply that every optional build has the
same license; select and record the actual build configuration.

## 4. Manifold: downstream physical parts

[Manifold](https://github.com/elalish/manifold) uses **Apache-2.0** and maintains
official JS/TS/WASM bindings through `manifold-3d`. It operates on manifold
triangle meshes and offers Boolean operations with a manifold-output guarantee
under its input contract. Arbitrary imported meshes can be rejected when they
do not meet that contract; the documented merge aid is not a general repair of
all open or invalid meshes.

**Fit:** future carving, connector pockets, clipping and closed-stock Boolean
operations after the fitted panel geometry is valid. This is relevant to full
production parts as well as later printing support.

**Cost:** medium; browser packaging is more direct than a new C++ binding.
Benchmark the actual stock sizes and preserve panel/face provenance across
operations.

**Gap:** an open shell patch is not a solid. Manifold does not decide a panel's
layout, solve planarity or design mitres. Keep it downstream of source editing
and constrained fitting rather than using it to mask invalid panels.

## Alternative: CGAL as a native reference or helper

CGAL is worth evaluating for exact constructions and broader mesh-processing
tasks, but the scope and licensing should be chosen at package level.
[CGAL's official license explanation](https://www.cgal.org/license.html)
distinguishes generally LGPL kernel/support libraries from many GPL higher-level
packages and offers commercial licensing. It is not a uniformly permissive
dependency. This review did not establish a ready browser integration for our
required editing operations.

## Curvature sizing and density-weighted relaxation

The optional [curvature-sizing workflow](curvature-sizing.md) allocates more
cells around tighter bends before planar fitting. It adds no external geometry
library. Its versioned policy applies to organic and regularized generation;
accepted source graphs remain authoritative after generation and manual editing.

[Du, Faber and Gunzburger's CVT survey](https://people.sc.fsu.edu/~jburkardt/classes/urop_2016/du_faber_gunzburger.pdf)
provides the weighted-centroid/quadratic-energy basis. For a locally smooth
two-dimensional field, the asymptotic spacing relation gives relaxation density
`rho ∝ h^-4`; initial centre allocation instead follows `h^-2`.
[Fu, Hu and Adams](https://www.sciencedirect.com/science/article/pii/S0021999117300670)
state the general dimension-dependent relation. Anchoring, approximate surface
distances and a bounded iteration count limit how closely the application
approaches that ideal.

[Dunyach et al.](https://ls7-gv.cs.tu-dortmund.de/publications/2013-remeshing.pdf)
derive bounded triangle spacing from curvature and an approximation tolerance.
Our nominal 20° normal-turn heuristic is a different choice, not their error
formula. [CGAL's adaptive sizing field](https://doc.cgal.org/latest/PMP_Remeshing/classCGAL_1_1Polygon__mesh__processing_1_1Adaptive__sizing__field.html)
is a useful reference implementation for future comparisons, with explicit
minimum/maximum lengths and curvature-estimation neighbourhood parameters.

Evaluate actual size allocation on mixed flat/bent shells, sensitivity to
triangulation and noise, source coverage, and fitted/solid failures separately.
Curvature adaptation neither aligns seams to every crease nor guarantees valid
flat panels. An increase in global cell-area variation can be intentional; it
must not automatically be scored as deterioration.

## The separate planar-fitting research question

Two primary references are particularly relevant:

- [Shape-Up: Shaping Discrete Geometry with
  Projections](https://onlinelibrary.wiley.com/doi/10.1111/j.1467-8659.2012.03171.x)
  combines local constraint projections with a global reconciliation step.
  [libigl's `shapeup.h`](https://github.com/libigl/libigl/blob/main/include/igl/shapeup.h)
  offers a C++/Eigen implementation under MPL-2.0 for that module. Treat it as a
  prototype foundation: our constraints, browser binding and acceptance checks
  would still be needed. Projection-based optimization does not by itself
  guarantee valid outlines, preserved edge order or feasible thick joints.
- Tang and colleagues' 2014 [interactive planar polygon-mesh form-finding
  paper](https://www.geometrie.tugraz.at/wallner/formfinding2.pdf) studies guided
  projection with vertex positions and face normals, including proximity and
  bounding constraints. Its formulation is closer to architectural panel fitting
  than a generic mesh Boolean. Evaluate how it handles our authored topology,
  short edges, source openings and permitted displacement before choosing an
  implementation strategy.

The remaining short-edge reversal demonstrates a coupled constraint problem:
panel planes, junction positions, edge order, source proximity, opening boundaries
and stock feasibility interact. More accurate predicates help identify invalid
geometry but do not solve those constraints. Investigate constrained planar-mesh
optimization separately, with explicit feasibility and displacement limits.

An algorithm that reduces total error can still make a previously usable panel
unusable. Compare outcomes by stable panel and seam IDs, including newly failed
neighbors, rather than reporting only a global energy or invalid-panel count.
Designer-authored irregularity should remain an input, not be erased by automatic
regularization without a deliberate operation.

## Adoption and project-compatibility checkpoints

1. Keep the authoritative document independent of library mesh handles: original
   source mesh and units, stable panel/seam IDs, barycentric source attachments,
   authored operations and their provenance.
2. Version generator and fitting settings. Record optional previous-calculation
   evidence, but recalculate and validate it when opening with another engine.
   Never silently substitute cached solids for accepted source geometry.
   The supported durable baseline is study v6 from the final deployed version on
   2026-10-30, maintained with frozen public fixtures. Earlier projects remain
   best-effort imports; this is not a commitment to retain every historical
   generator indefinitely.
3. Use an adapter for each geometry library. Start with one operation and compare
   old/new results against public synthetic fixtures: near-collinear slivers,
   curved rims, openings, short shared edges and high-valence junctions.
4. Measure source coverage, corner displacement, opening-boundary violations,
   flat/solid validity and newly failed panels independently. Include deterministic
   small and substantial edits; compare cold and repeated calculations.
5. Measure full browser interaction cost: worker time, transfer/copying, memory,
   cancellation and preview latency. A native benchmark is not proof of a
   responsive browser workflow.
6. Keep a manual Rhino/CAM/physical checkpoint. A robust kernel and passing unit
   tests do not establish machining access, material behavior or native CAD
   interoperability.

Recommended order: introduce robust predicates at proven numerical failure
points; prototype geometry-central for source-attached movement; evaluate Geogram
for an explicitly chosen partition/preparation task; add Manifold when a concrete
closed-stock operation needs it. Keep coupled planar fitting as its own research
and validation track. See [production readiness](production-readiness.md) for the
current evidence and remaining workflow priorities.
