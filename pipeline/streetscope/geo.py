"""Small geometry helpers: local metre frame and real sun position."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone

EARTH_R = 6371008.8


@dataclass(frozen=True)
class Frame:
    """Local frame in metres around (lat0, lon0). x points east, z points south, y is up.

    Accurate to well under a metre for a few hundred metres, which is all a junction needs.
    """

    lat0: float
    lon0: float

    @property
    def _kx(self) -> float:
        return math.cos(math.radians(self.lat0)) * math.pi / 180.0 * EARTH_R

    @property
    def _kz(self) -> float:
        return math.pi / 180.0 * EARTH_R

    def to_xz(self, lat: float, lon: float) -> tuple[float, float]:
        return ((lon - self.lon0) * self._kx, -(lat - self.lat0) * self._kz)

    def to_latlon(self, x: float, z: float) -> tuple[float, float]:
        return (self.lat0 - z / self._kz, self.lon0 + x / self._kx)


def polyline_length(pts: list[tuple[float, float]]) -> float:
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))


def polygon_area(pts: list[tuple[float, float]]) -> float:
    """Absolute area of a simple polygon (shoelace)."""
    s = 0.0
    for (x1, z1), (x2, z2) in zip(pts, pts[1:] + pts[:1]):
        s += x1 * z2 - x2 * z1
    return abs(s) / 2.0


def solar_position(lat: float, lon: float, when_utc: datetime) -> tuple[float, float]:
    """Return (azimuth, elevation) in degrees. Azimuth is clockwise from north.

    NOAA general solar position formulas. Good to about half a degree, plenty for shade.
    """
    if when_utc.tzinfo is None:
        when_utc = when_utc.replace(tzinfo=timezone.utc)
    when_utc = when_utc.astimezone(timezone.utc)
    n = when_utc.timetuple().tm_yday
    frac = when_utc.hour + when_utc.minute / 60.0 + when_utc.second / 3600.0
    g = 2.0 * math.pi / 365.0 * (n - 1 + (frac - 12.0) / 24.0)
    eqtime = 229.18 * (
        0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
        - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g)
    )
    decl = (
        0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g)
        - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
        - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g)
    )
    tst = frac * 60.0 + eqtime + 4.0 * lon
    ha = math.radians(tst / 4.0 - 180.0)
    lat_r = math.radians(lat)
    cos_zen = math.sin(lat_r) * math.sin(decl) + math.cos(lat_r) * math.cos(decl) * math.cos(ha)
    zen = math.acos(max(-1.0, min(1.0, cos_zen)))
    elevation = 90.0 - math.degrees(zen)
    a = math.atan2(math.sin(ha), math.cos(ha) * math.sin(lat_r) - math.tan(decl) * math.cos(lat_r))
    azimuth = (math.degrees(a) + 180.0) % 360.0
    return azimuth, elevation


def sun_dir_xz(azimuth_deg: float) -> tuple[float, float]:
    """Unit vector pointing toward the sun in the (x east, z south) frame."""
    az = math.radians(azimuth_deg)
    return (math.sin(az), -math.cos(az))
