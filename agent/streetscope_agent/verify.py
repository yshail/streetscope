"""Number checker: every figure in an answer must come from a tool result or from the question."""

from __future__ import annotations

import re
from typing import Any, Iterable

_NUM = re.compile(r"(?<![\w.])-?\d[\d,]*(?:\.\d+)?")


def numbers_in(text: str) -> list[float]:
    out = []
    for m in _NUM.findall(text):
        try:
            out.append(float(m.replace(",", "")))
        except ValueError:
            pass
    return out


def flatten(obj: Any) -> Iterable[float]:
    if isinstance(obj, bool) or obj is None:
        return
    if isinstance(obj, (int, float)):
        yield float(obj)
    elif isinstance(obj, str):
        yield from numbers_in(obj)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from numbers_in(str(k))
            yield from flatten(v)
    elif isinstance(obj, (list, tuple)):
        yield float(len(obj))
        for v in obj:
            yield from flatten(v)


def _close(a: float, b: float) -> bool:
    a, b = abs(a), abs(b)   # "a 10.7% drop" quotes a change the tool gave as -10.7
    return abs(a - b) <= max(0.051, 0.01 * b) or round(b) == a or round(b, 1) == a


def unverified_numbers(answer: str, tool_outputs: list[Any], question: str = "") -> list[float]:
    """Return numbers in the answer that no tool produced. Zero and the counting words 1 to 3 are allowed."""
    allowed = list(flatten(tool_outputs)) + numbers_in(question)
    bad = []
    for a in numbers_in(answer):
        if a in (0.0, 1.0, 2.0, 3.0):
            continue
        if not any(_close(a, b) for b in allowed):
            bad.append(a)
    return bad
