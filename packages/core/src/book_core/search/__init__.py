"""Keyword / semantic / hybrid search with RRF and published-revision filters (Task M2.3) and
paragraph-complete excerpts via ``ExcerptResolver`` (Task M2.5)."""

from book_core.search.excerpt import (
    UNIT_SEPARATOR,
    ExcerptConfig,
    ExcerptError,
    ExcerptResolver,
    QueryTerms,
    query_terms,
    term_spans,
)
from book_core.search.fusion import DEFAULT_RRF_K, Fused, reciprocal_rank_fusion
from book_core.search.query import (
    DEFAULT_MAX_QUERY_CHARS,
    InvalidQueryError,
    PreparedQuery,
    detect_language,
    prepare_query,
)
from book_core.search.service import (
    DEGRADED_DENSE_UNAVAILABLE,
    MAX_CANDIDATES,
    MAX_RESULTS,
    RankedHit,
    RerankMode,
    SearchFilters,
    SearchLimits,
    SearchResult,
    SearchScopeError,
    SearchService,
)

__all__ = [
    "DEFAULT_MAX_QUERY_CHARS",
    "DEFAULT_RRF_K",
    "DEGRADED_DENSE_UNAVAILABLE",
    "MAX_CANDIDATES",
    "MAX_RESULTS",
    "UNIT_SEPARATOR",
    "ExcerptConfig",
    "ExcerptError",
    "ExcerptResolver",
    "Fused",
    "InvalidQueryError",
    "PreparedQuery",
    "QueryTerms",
    "RankedHit",
    "RerankMode",
    "SearchFilters",
    "SearchLimits",
    "SearchResult",
    "SearchScopeError",
    "SearchService",
    "detect_language",
    "prepare_query",
    "query_terms",
    "reciprocal_rank_fusion",
    "term_spans",
]
