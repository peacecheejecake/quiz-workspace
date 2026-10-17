"""Keyword / semantic / hybrid search with RRF and published-revision filters (Task M2.3) and
paragraph-complete excerpts via ``ExcerptResolver`` (Task M2.5)."""

from book_core.search.fusion import DEFAULT_RRF_K, Fused, reciprocal_rank_fusion
from book_core.search.query import (
    DEFAULT_MAX_QUERY_CHARS,
    InvalidQueryError,
    PreparedQuery,
    detect_language,
    prepare_query,
)
from book_core.search.service import (
    MAX_CANDIDATES,
    MAX_RESULTS,
    RankedHit,
    SearchFilters,
    SearchLimits,
    SearchResult,
    SearchScopeError,
    SearchService,
)

__all__ = [
    "DEFAULT_MAX_QUERY_CHARS",
    "DEFAULT_RRF_K",
    "MAX_CANDIDATES",
    "MAX_RESULTS",
    "Fused",
    "InvalidQueryError",
    "PreparedQuery",
    "RankedHit",
    "SearchFilters",
    "SearchLimits",
    "SearchResult",
    "SearchScopeError",
    "SearchService",
    "detect_language",
    "prepare_query",
    "reciprocal_rank_fusion",
]
