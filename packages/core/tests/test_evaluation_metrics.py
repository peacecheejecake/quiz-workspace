"""Ranking metrics (M2.6) against hand-computed values."""

from __future__ import annotations

import math

import pytest
from book_core.evaluation import (
    dcg,
    first_relevant_rank,
    mean,
    ndcg_at,
    percentile,
    recall_at,
    reciprocal_rank_at,
)

# Positions: 1 a (grade 2), 2 unjudged, 3 b (grade 1), 4 a again, 5 c (not relevant).
RANKED = ["a", None, "b", "a", "c"]
QRELS = {"a": 2, "b": 1, "d": 1, "z": 0}


def test_recall_counts_unique_relevant_units_within_k() -> None:
    assert recall_at(RANKED, QRELS, 1) == pytest.approx(1 / 3)
    assert recall_at(RANKED, QRELS, 2) == pytest.approx(1 / 3)
    assert recall_at(RANKED, QRELS, 3) == pytest.approx(2 / 3)
    # The repeated "a" at rank 4 adds nothing; "d" is never retrieved.
    assert recall_at(RANKED, QRELS, 5) == pytest.approx(2 / 3)
    assert recall_at(RANKED, QRELS, 100) == pytest.approx(2 / 3)
    assert recall_at([], QRELS, 10) == 0.0


def test_reciprocal_rank_is_the_first_relevant_position_within_k() -> None:
    assert reciprocal_rank_at(RANKED, QRELS, 10) == 1.0
    assert reciprocal_rank_at([None, "x", "b"], QRELS, 10) == pytest.approx(1 / 3)
    assert reciprocal_rank_at([None, "x", "b"], QRELS, 2) == 0.0
    # Grade 0 is not relevant.
    assert reciprocal_rank_at(["z", "b"], QRELS, 10) == 0.5
    assert first_relevant_rank(["z", None, "d"], QRELS) == 3
    assert first_relevant_rank(["z"], QRELS) is None


def test_ndcg_uses_linear_gain_log2_discount_and_the_ideal_of_all_judgements() -> None:
    # Gains [2, 0, 1, 0, 0] -> DCG = 2/log2(2) + 1/log2(4) = 2.5.
    # Ideal [2, 1, 1] -> IDCG = 2 + 1/log2(3) + 1/log2(4) = 3.130930.
    expected = 2.5 / (2 + 1 / math.log2(3) + 0.5)
    assert ndcg_at(RANKED, QRELS, 5) == pytest.approx(expected)
    assert ndcg_at(RANKED, QRELS, 5) == pytest.approx(0.798485, abs=1e-6)
    # Cut at 1: DCG 2, ideal cut at 1: 2.
    assert ndcg_at(RANKED, QRELS, 1) == 1.0
    # Perfect order of every relevant unit.
    assert ndcg_at(["a", "b", "d"], QRELS, 10) == pytest.approx(1.0)
    # Same units, worse order: [1, 1, 2] -> 1 + 1/log2(3) + 2/log2(4).
    worse = (1 + 1 / math.log2(3) + 1) / (2 + 1 / math.log2(3) + 0.5)
    assert ndcg_at(["b", "d", "a"], QRELS, 10) == pytest.approx(worse)
    assert dcg([3, 2]) == pytest.approx(3 + 2 / math.log2(3))


def test_metrics_need_relevant_units_and_a_positive_k() -> None:
    for metric in (recall_at, reciprocal_rank_at, ndcg_at):
        with pytest.raises(ValueError, match="undefined"):
            metric(["a"], {"a": 0}, 5)
        with pytest.raises(ValueError, match="k must be"):
            metric(["a"], {"a": 1}, 0)


def test_mean_and_percentile() -> None:
    assert mean([]) is None
    assert mean([1.0, 2.0]) == 1.5
    assert percentile([], 50) is None
    assert percentile([4.0, 1.0, 3.0, 2.0], 50) == pytest.approx(2.5)
    assert percentile([1.0, 2.0, 3.0, 4.0], 95) == pytest.approx(3.85)
    assert percentile([7.0], 95) == 7.0
    assert percentile([1.0, 2.0], 0) == 1.0
    assert percentile([1.0, 2.0], 100) == 2.0
    with pytest.raises(ValueError, match="within"):
        percentile([1.0], 101)
