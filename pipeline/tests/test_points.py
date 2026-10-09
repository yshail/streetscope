import numpy as np

from streetscope import points
from streetscope.shade import Grid


def test_classify_trusts_survey_labels_and_fills_the_rest():
    twin = {"buildings": [{"footprint": [[-10, -10], [10, -10], [10, 10], [-10, 10]]}],
            "roads": [{"cls": "main", "width_m": 10.0, "pts": [[-40, 30], [40, 30]]}]}
    grid = Grid(50, 1.0)
    dtm = np.zeros((grid.n, grid.n))
    #            ground-on-road  building(label)  unlabelled-in-footprint  unlabelled-tree  unlabelled-low  odd code 17
    x = np.array([0.0, 0.0, 0.0, 30.0, -30.0, 0.0])
    z = np.array([30.0, 0.0, 0.0, -30.0, -30.0, 0.0])
    h = np.array([0.1, 12.0, 15.0, 6.0, 0.2, 14.0])
    cls = np.array([2, 6, 1, 1, 1, 17])
    nr = np.array([1, 1, 1, 3, 1, 1])
    out, agl = points.classify(x, z, h, cls, nr, twin, dtm, grid)
    assert out[0] == 2                                   # survey ground inside a road width -> road
    assert out[1] == 3                                   # survey building label kept
    assert out[2] == 3 | points.DERIVED                  # unlabelled, inside a footprint, high -> building (ours)
    assert out[3] == 4 | points.DERIVED                  # unlabelled, several returns, above 1.5 m -> vegetation (ours)
    assert out[4] == 1 | points.DERIVED                  # unlabelled, near the ground -> ground (ours)
    assert out[5] == 3 | points.DERIVED                  # non-standard code is not trusted
    assert abs(agl[1] - 12.0) < 1e-9
