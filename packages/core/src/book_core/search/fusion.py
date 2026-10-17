"""Reciprocal Rank Fusion (Cormack, Clarke & Buettcher, SIGIR 2009).

``score(d) = sum over rankings r containing d of 1 / (k + rank_r(d))`` with 1-based ranks.
RRF only looks at ranks, so BM25 and cosine scores never have to be normalised against each
other.
"""

from __future__ import annotations

from collections.abc import Hashable, Sequence
from dataclasses import dataclass

DEFAULT_RRF_K = 60


@dataclass(frozen=True, slots=True)
class Fused[K: Hashable]:
    """One fused item: its RRF ``score`` and its 1-based rank in each input ranking (``None``
    when absent from that ranking)."""

    key: K
    score: float
    ranks: tuple[int | None, ...]


def reciprocal_rank_fusion[K: Hashable](
    rankings: Sequence[Sequence[K]], *, k: int = DEFAULT_RRF_K
) -> list[Fused[K]]:
    """Fuse best-first rankings into one best-first list.

    A key repeated within one ranking counts once, at its best (first) rank. Ties on the RRF
    score are broken by the best rank the item reached in any ranking, then by the earliest
    ranking it reached it in (input order), so the output is fully deterministic for a given
    input.
    """
    if isinstance(k, bool) or not isinstance(k, int) or k < 0:
        raise ValueError("rrf k must be an integer >= 0")
    ranks: dict[K, list[int | None]] = {}
    for index, ranking in enumerate(rankings):
        for position, key in enumerate(ranking, start=1):
            slots = ranks.setdefault(key, [None] * len(rankings))
            if slots[index] is None:
                slots[index] = position
    fused = [
        Fused(key=key, score=sum(1.0 / (k + r) for r in slots if r is not None), ranks=tuple(slots))
        for key, slots in ranks.items()
    ]
    fused.sort(key=_tie_break)
    return fused


def _tie_break[K: Hashable](item: Fused[K]) -> tuple[float, int, int]:
    best_rank, best_list = min((r, i) for i, r in enumerate(item.ranks) if r is not None)
    return (-item.score, best_rank, best_list)
