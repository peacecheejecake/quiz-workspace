"""Reranking of search candidates (M2.4). The Qwen3-Reranker adapter ships with ``models``."""

from book_core.reranker.base import Reranker
from book_core.reranker.fake import FakeReranker

__all__ = ["FakeReranker", "Reranker"]
