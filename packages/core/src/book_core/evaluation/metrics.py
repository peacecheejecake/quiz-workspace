"""Ranking metrics over a ranked list of unit ids and graded judgements (qrels).

Conventions follow ``trec_eval`` / ``ir-measures`` (``R@k``, ``RR@k``, ``nDCG@k``):

- ``ranked`` is best-first; ranks are 1-based. ``None`` marks an unjudged position.
- A unit id repeated in ``ranked`` counts only at its first position: later repeats keep their
  rank slot but gain nothing (search hits are chunks, judgements are sections, so two chunks of
  one judged section must not count twice).
- ``qrels`` maps unit id -> grade; grades ``<= 0`` are non-relevant.
- nDCG uses linear gain (the grade) and the ``log2(rank + 1)`` discount, normalised by the ideal
  ordering of all judged units (``trec_eval ndcg_cut``).
- A query without relevant units has every metric undefined; ``mean`` callers skip such queries.

``ir-measures`` itself is not a dependency: these few formulas are tested against hand-computed
values instead (``tests/test_evaluation_metrics.py``).
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence

Ranked = Sequence[str | None]
Qrels = Mapping[str, int]


def _check_k(k: int) -> None:
    if isinstance(k, bool) or not isinstance(k, int) or k < 1:
        raise ValueError("k must be an integer >= 1")


def _first_gains(ranked: Ranked, qrels: Qrels, k: int) -> list[int]:
    """Grade of each of the first ``k`` positions; repeats and unjudged positions gain 0."""
    seen: set[str] = set()
    gains: list[int] = []
    for unit in ranked[:k]:
        if unit is None or unit in seen:
            gains.append(0)
            continue
        seen.add(unit)
        gains.append(max(qrels.get(unit, 0), 0))
    return gains


def relevant_count(qrels: Qrels) -> int:
    return sum(1 for grade in qrels.values() if grade > 0)


def recall_at(ranked: Ranked, qrels: Qrels, k: int) -> float:
    """Share of the relevant units found in the first ``k`` positions."""
    _check_k(k)
    total = relevant_count(qrels)
    if total == 0:
        raise ValueError("recall is undefined without relevant units")
    return sum(1 for gain in _first_gains(ranked, qrels, k) if gain > 0) / total


def reciprocal_rank_at(ranked: Ranked, qrels: Qrels, k: int) -> float:
    """``1 / rank`` of the first relevant unit within ``k`` positions, else 0."""
    _check_k(k)
    if relevant_count(qrels) == 0:
        raise ValueError("reciprocal rank is undefined without relevant units")
    for rank, gain in enumerate(_first_gains(ranked, qrels, k), start=1):
        if gain > 0:
            return 1.0 / rank
    return 0.0


def dcg(gains: Iterable[float]) -> float:
    return sum(gain / math.log2(rank + 1) for rank, gain in enumerate(gains, start=1))


def ndcg_at(ranked: Ranked, qrels: Qrels, k: int) -> float:
    """Normalised discounted cumulative gain of the first ``k`` positions (linear gain)."""
    _check_k(k)
    ideal = sorted((g for g in qrels.values() if g > 0), reverse=True)[:k]
    if not ideal:
        raise ValueError("nDCG is undefined without relevant units")
    return dcg(_first_gains(ranked, qrels, k)) / dcg(ideal)


def first_relevant_rank(ranked: Ranked, qrels: Qrels) -> int | None:
    for rank, gain in enumerate(_first_gains(ranked, qrels, len(ranked)), start=1):
        if gain > 0:
            return rank
    return None


def mean(values: Sequence[float]) -> float | None:
    return sum(values) / len(values) if values else None


def percentile(values: Sequence[float], q: float) -> float | None:
    """Linear-interpolated percentile (``q`` in [0, 100]), as numpy's default method."""
    if not 0 <= q <= 100:
        raise ValueError("q must be within [0, 100]")
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * q / 100
    lower = math.floor(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)
