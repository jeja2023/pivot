# DrawingML preset geometry

Apache POI

Copyright 2003-2025 The Apache Software Foundation

This product includes software developed at The Apache Software Foundation
(https://www.apache.org/).

`preset-shapes.json` is a compact, mechanically transformed representation of
Apache POI 5.4.1 `presetShapeDefinitions.xml`, commit
`4554f204cbbf00ecbcaed134fe57e43a1779a612`, source path
`poi/src/main/resources/org/apache/poi/sl/draw/geom/presetShapeDefinitions.xml`.
The normalized source SHA-256 is
`4a762444d8d85876881c02a5b1dedf6f73006fcd8acb7b4e393435615b37c780`.
See LICENSE-APACHE-2.0.txt. The transformation is reproducible through
`scripts/build_presentation_shapes.js`.

The data was reviewed through PPT Master commit
`769547394107870a0c7b5ad8d1c0c75035123aef`. The geometry implementation was
informed by its documented DrawingML formula and elliptical-arc behavior.
PPT Master: Copyright (c) 2025-2026 Hugo He, MIT;
see LICENSE-PPT-MASTER-MIT.txt.

Pivot's JavaScript runtime evaluates the geometry for the actual frame and
adjustments. It does not use an atlas of stretched square thumbnails.
