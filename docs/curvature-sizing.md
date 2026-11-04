# Curvature sizing for shell arrangements

Curvature sizing gives tighter bends more, smaller cells and flatter regions
fewer, larger cells. It is an optional way to prepare a new **organic** or
**regularized** arrangement. It does not change the imported shell or automatically
replace an accepted arrangement.

Use the regularized pattern when you want the centres to settle into a more even
local distribution while retaining this change in size. Its Regularity control
still balances movement toward cell centres against attachment to the initial
sites. More regularity does not mean every cell should have the same area.

## Choosing the size range

Enable **Adapt to curvature**, set **Minimum target** and **Maximum target** in
millimetres, then choose **New arrangement**. The smaller value
controls how densely the tightest bends may be sampled; the larger value controls
flatter regions. These are targets for centre spacing, not guaranteed minimum or
maximum panel-edge lengths. Clipping at openings and boundaries, the arrangement
of neighbours, and subsequent planar fitting all affect the actual parts.

The sizing rule uses a nominal **20° change in the surface normal**:

```text
target spacing h = clamp((20° in radians) / estimated curvature,
                         minimum spacing, maximum spacing)
```

A flat region uses the maximum spacing. The angle is an internal design
heuristic, not a certified bound on the angle within a finished panel or on the
distance between a panel and the source shell. Reducing the minimum only has an
effect where the estimated bend calls for smaller cells.

### Choose a generation limit

**Maximum generated cells** controls the limit for a new Organic or Regularized
arrangement, with uniform or curvature-based spacing. The default is **240**;
choose a whole number from **12 to 500**, then use **New arrangement** to apply it
with the other layout settings. Changing the number alone keeps the current
layout intact. Raising the limit allows more cells when the chosen spacing calls
for them; it does not require the generator to use that many cells.

A curvature-based request exceeding the chosen maximum is rejected explicitly.
Increase the target spacing or raise the maximum; the generator must not silently
discard adaptive cells or pretend that a capped count still meets the requested
spacing. Uniform generation uses the maximum as its count cap. Larger counts and
more detailed source meshes take longer, and other calculation limits can still
reject a costly request. The accepted layout remains available until a
replacement is accepted.

This is a generation preference. The separate **500-cell editing limit** also
covers later divisions and structured patterns. Lowering the generation setting
does not remove cells from an already accepted layout. Hexagonal and Geodesic
patterns use their own spacing or subdivision controls and retain their separate
500-cell limit.

## Why relaxation uses a different density from initial sampling

On a two-dimensional surface, halving a typical spacing needs roughly four times
as many centres per unit area. Initial allocation therefore follows `1/h²`.

Centroidal relaxation minimizes a sum of squared distances weighted over the
surface. Its density has a different role. For a small, approximately uniform
cell, squared distance contributes a factor `h²` and area contributes another
`h²`. Equal local contributions therefore suggest `rho × h⁴` approximately
constant, or **`rho ∝ 1/h⁴`**. This is the local, asymptotic sizing relationship
for quadratic CVT; it is not an exact prescription for a finite arrangement.
The density-weighted centroid and quadratic objective are described by
[Du, Faber and Gunzburger](https://people.sc.fsu.edu/~jburkardt/classes/urop_2016/du_faber_gunzburger.pdf);
the dimension-dependent spacing relation is stated explicitly by
[Fu, Hu and Adams](https://www.sciencedirect.com/science/article/pii/S0021999117300670).

The workbench normalizes the density as `(minimum spacing / h)⁴` and uses the
same density in the centroid calculation, its acceptance
objective and the mass attached to the initial-site penalty. Otherwise a
uniform-area relaxation would work against the deliberately denser initial
sampling. A single overall multiplier does not change the relative weighting.

Surface distances, projection and a finite iteration budget remain numerical
approximations. The solver checks proposed changes rather than claiming exact
intrinsic CVT convergence. Physical cell-area variation is expected: compare
local spacing against the requested field, coverage and part validity rather
than treating the lowest overall area variation as the best adaptive result.

## What the source mesh can tell us

Curvature is estimated from the represented shell. A coarse mesh cannot reveal
a bend absent from its geometry, while a noisy mesh can suggest bends that do
not belong to the intended design. Reversing the shell's overall orientation
must not change the amount of refinement. Open boundaries must not be mistaken
for high curvature simply because triangles are missing beyond them.

Neighbourhood-based curvature estimates can reduce sensitivity to noise and
triangle layout; [CGAL's corrected-curvature
documentation](https://doc.cgal.org/latest/Polygon_mesh_processing/group__PMP__corrected__curvatures__grp.html)
describes a radius over which face measures are accumulated. This is a research
reference, not a new dependency in the workbench.

Sharp creases need separate design judgement. Adding small cells around a crease
does not ensure that a seam follows it. Nor should nearby opposing sheets share
curvature measurements merely because they are close in space: connectivity
along the shell matters.

An alternative research approach derives spacing from a geometric approximation
tolerance. [Dunyach and colleagues](https://ls7-gv.cs.tu-dortmund.de/publications/2013-remeshing.pdf)
use maximum absolute principal curvature and bounded target triangle sizes.
Their paper also reports that the maximum geometric error can exceed the chosen
tolerance. The workbench's 20° rule is a different heuristic; it does not
implement that paper's error-based remesher.

## Saved projects and fabrication checks

The policy is versioned with the source-generation recipe. Existing studies
without it retain uniform sizing. A saved adaptive layout retains its accepted
source graph; changing stock thickness should refit that graph rather than
regenerate a different partition. The study-v6 required-feature mechanism must
reject unsupported adaptive projects instead of silently treating them as
uniform projects. The durable v6 baseline remains supported.

The applied generation maximum is saved with the design. Opening a study, Undo,
Redo and checkpoint restoration bring it back with the corresponding layout;
an uncommitted value in the Layout controls is only a draft. Older studies use
the default of 240. Studies with a different maximum declare the
`generation-budget-v1` feature, so an older reader stops instead of silently
discarding that setting. Opening a new source model resets the maximum to 240.

Smaller cells can reduce how much curvature each part spans, but there is no
promise that every resulting polygon can be fitted as a valid planar panel, or
that every mitre, roundover or carved part is feasible. Inspect source-to-panel
movement and unresolved parts, then run the same production checks and export
gates as for any other arrangement. See
[From a shell to buildable panels](how-panels-are-fitted.md).

## Verification checkpoints

The adaptive path is checked separately from the unchanged uniform path. Useful
fixtures include a flat sheet with an opening; a flat region joined smoothly to
a cylindrical bend; a saddle; differently triangulated versions of the same
surface; and close but disconnected or folded sheets.

For generation, check finite sizes within the requested range, appropriate
allocation to curved regions, complete source coverage and deterministic
results. For relaxation, check retention of the size gradient, bounded movement
and decreasing values of the same weighted objective. For production, record
fitted displacement and invalid flat/solid counts separately. A lower
relaxation energy alone is not evidence that a part is easier to manufacture.

The 2026-11-02 release checks passed 399 automated tests, the browserless editing
suite and 10 real Chromium workflow checks. On the synthetic flat-to-bent shell,
the browser test measured median bend-cell area at 22.8% of the flat-region
median, with complete source coverage and all 60 flat/solid panels resolved.
These checks do not establish physical fabrication accuracy or a fit improvement
for every shell.

The adjustable-maximum browser regression uses a public 1.2 × 1.2 m gridded
sheet. With 76 mm target spacing and a maximum of 300, Regularized generated
288 panels with complete source coverage and all flat/solid checks passing.
The check also verifies draft controls, invalid values, Undo, study download and
reopening, checkpoint restoration and a new source returning to the default.
This is a reproducible limit test; complex curved shells still need their own
geometry and performance review.
