"""Collection naming and versioning.

Readers address the stable alias (``documents_v1``); points live in a physical collection named
after the alias and the *model key* (``documents_v1__<model-key>``, optionally ``__g<n>`` for a
rebuild of the same vector space). The model key identifies everything that makes stored vectors
incompatible: the dense embedder's ``model_name`` (model id, pinned revision, MRL size), its
dimension, the sparse (BM25) encoder version and the point payload schema version.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from book_core.embedding import Embedder
from book_core.indexing.sparse import BM25_VERSION

PAYLOAD_SCHEMA_VERSION = 1
DOCUMENTS_ALIAS = "documents_v1"

_NON_SLUG = re.compile(r"[^a-z0-9]+")
_NAME = re.compile(r"^[A-Za-z0-9_-]+$")
_MAX_SLUG = 40


def model_key(model_name: str, dimension: int) -> str:
    """``<slug>-d<dim>-<hash>``: readable, collision-safe and valid in a collection name."""
    if dimension < 1:
        raise ValueError("dimension must be >= 1")
    slug = _NON_SLUG.sub("-", model_name.casefold()).strip("-")[:_MAX_SLUG].strip("-") or "model"
    identity = f"{model_name}\x1f{dimension}\x1f{BM25_VERSION}\x1fpayload-v{PAYLOAD_SCHEMA_VERSION}"
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:10]
    return f"{slug}-d{dimension}-{digest}"


def embedder_model_key(embedder: Embedder) -> str:
    return model_key(embedder.model_name, embedder.dimension)


@dataclass(frozen=True, slots=True)
class CollectionNames:
    """``prefix`` namespaces the alias and every physical collection (tests, previews)."""

    base: str = DOCUMENTS_ALIAS
    prefix: str = ""

    def __post_init__(self) -> None:
        if not _NAME.match(self.base) or (self.prefix and not _NAME.match(self.prefix)):
            raise ValueError("collection names may only use letters, digits, '_' and '-'")

    @property
    def alias(self) -> str:
        return f"{self.prefix}{self.base}"

    def physical(self, key: str, generation: int = 1) -> str:
        if generation < 1:
            raise ValueError("generation must be >= 1")
        name = f"{self.alias}__{key}"
        return name if generation == 1 else f"{name}__g{generation}"

    def owns(self, collection: str) -> bool:
        """Whether ``collection`` is a physical collection behind this alias."""
        return collection.startswith(f"{self.alias}__")
