"""Qwen3-Embedding adapter and Qwen3 tokenizer (requires the ``models`` extra).

Follows the model card of ``Qwen/Qwen3-Embedding-0.6B`` (transformers usage):

- queries are prefixed with ``"Instruct: {task}\\nQuery:"``; documents get no instruction;
- the tokenizer pads on the left and appends ``<|endoftext|>`` itself (pinned revision), and the
  embedding is the last token's hidden state (last-token pooling);
- vectors are L2-normalised; MRL truncation keeps the first ``dimension`` components and
  re-normalises (the card allows 32..hidden size).

``transformers`` is used directly rather than sentence-transformers: it is already installed with
Docling (no extra download), and the model card's pipeline is ~20 lines of tokenizer/model calls.
torch/transformers are imported lazily, so this module imports (and its config validates)
without them. Weights come from the Hugging Face cache (``HF_HOME``); ``HF_HUB_OFFLINE=1`` or
``local_files_only=True`` forbids downloads, and missing weights raise ``ModelUnavailableError``.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol

if TYPE_CHECKING:
    import torch
    from transformers import PreTrainedTokenizerBase

DEFAULT_MODEL_ID = "Qwen/Qwen3-Embedding-0.6B"
# Pinned Hub commit (2026-04-20). Changing it changes the vector space: re-index.
DEFAULT_REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
# The model card's retrieval instruction (config_sentence_transformers.json "query" prompt).
DEFAULT_QUERY_INSTRUCTION = (
    "Given a web search query, retrieve relevant passages that answer the query"
)
MIN_DIMENSION = 32

Dtype = Literal["float32", "bfloat16", "float16"]


class ModelUnavailableError(RuntimeError):
    """Model or tokenizer files could not be loaded (not cached while offline, bad id/revision)."""


@dataclass(frozen=True)
class Qwen3EmbedderConfig:
    """Settings of ``Qwen3Embedder``.

    - ``max_length``: tokens per input including the appended end-of-text token; longer inputs
      are truncated. Chunks are budgeted far below it (``ChunkerConfig.max_tokens``).
    - ``dimension``: MRL output size; ``None`` keeps the model's hidden size (1024 for 0.6B).
    - ``query_instruction``: task description for queries; empty embeds queries like documents.
    - ``num_threads``: if set, ``torch.set_num_threads`` at load (process-wide) for reproducible
      CPU timings; numerics are deterministic for identical inputs either way.
    - ``local_files_only``: never contact the Hub (``HF_HUB_OFFLINE=1`` has the same effect).
    """

    model_id: str = DEFAULT_MODEL_ID
    revision: str = DEFAULT_REVISION
    device: str = "cpu"
    dtype: Dtype = "float32"
    batch_size: int = 8
    max_length: int = 2048
    dimension: int | None = None
    query_instruction: str = DEFAULT_QUERY_INSTRUCTION
    num_threads: int | None = None
    cache_dir: Path | None = None
    local_files_only: bool = False

    def __post_init__(self) -> None:
        if not self.model_id.strip():
            raise ValueError("model_id must not be empty")
        if not self.revision.strip():
            raise ValueError("revision must be pinned (a Hub commit hash)")
        if self.dtype not in ("float32", "bfloat16", "float16"):
            raise ValueError(f"unsupported dtype: {self.dtype!r}")
        if self.batch_size < 1:
            raise ValueError("batch_size must be >= 1")
        if self.max_length < 8:
            raise ValueError("max_length must be >= 8")
        if self.dimension is not None and self.dimension < MIN_DIMENSION:
            raise ValueError(f"dimension must be >= {MIN_DIMENSION}")
        if self.num_threads is not None and self.num_threads < 1:
            raise ValueError("num_threads must be >= 1")


class EncoderBackend(Protocol):
    """Tokenizer + transformer forward pass: the only part that needs model weights."""

    @property
    def hidden_size(self) -> int: ...

    def forward(self, texts: list[str]) -> tuple[torch.Tensor, torch.Tensor]:
        """Return ``(last_hidden_state [B, T, H], attention_mask [B, T])`` for a batch."""
        ...


BackendLoader = Callable[[Qwen3EmbedderConfig], EncoderBackend]


def _unavailable(model_id: str, revision: str, exc: Exception) -> ModelUnavailableError:
    return ModelUnavailableError(
        f"cannot load {model_id}@{revision} from the Hugging Face cache or Hub ({exc}). "
        "Download it once with network access (cache: $HF_HOME, default ~/.cache/huggingface): "
        f"`hf download {model_id} --revision {revision}`; with HF_HUB_OFFLINE=1 or "
        "local_files_only=True nothing is downloaded."
    )


def _load_tokenizer(
    model_id: str, revision: str, cache_dir: Path | None, local_files_only: bool
) -> PreTrainedTokenizerBase:
    from transformers import AutoTokenizer

    try:
        tokenizer: PreTrainedTokenizerBase = AutoTokenizer.from_pretrained(
            model_id,
            revision=revision,
            cache_dir=cache_dir,
            local_files_only=local_files_only,
            padding_side="left",
        )
    except OSError as exc:  # huggingface_hub cache misses and HTTP errors are OSErrors
        raise _unavailable(model_id, revision, exc) from exc
    return tokenizer


class _TransformersBackend:
    def __init__(self, config: Qwen3EmbedderConfig) -> None:
        import torch
        from transformers import AutoModel

        if config.num_threads is not None:
            torch.set_num_threads(config.num_threads)
        self._tokenizer = _load_tokenizer(
            config.model_id, config.revision, config.cache_dir, config.local_files_only
        )
        try:
            model = AutoModel.from_pretrained(
                config.model_id,
                revision=config.revision,
                cache_dir=config.cache_dir,
                local_files_only=config.local_files_only,
                dtype=getattr(torch, config.dtype),
            )
        except OSError as exc:
            raise _unavailable(config.model_id, config.revision, exc) from exc
        # eval(): no dropout; inference_mode() in forward(): no autograd state.
        self._model = model.to(config.device).eval()
        self._device = config.device
        self._max_length = config.max_length
        self._hidden_size = int(model.config.hidden_size)

    @property
    def hidden_size(self) -> int:
        return self._hidden_size

    def forward(self, texts: list[str]) -> tuple[torch.Tensor, torch.Tensor]:
        import torch

        batch = self._tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=self._max_length,
            return_tensors="pt",
        ).to(self._device)
        with torch.inference_mode():
            output = self._model(**batch)
        return output.last_hidden_state, batch["attention_mask"]


def last_token_pool(hidden: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
    """Hidden state of each sequence's last real token (left or right padding)."""
    import torch

    if bool((attention_mask[:, -1] == 1).all()):
        return hidden[:, -1]
    lengths = attention_mask.sum(dim=1) - 1
    return hidden[torch.arange(hidden.shape[0], device=hidden.device), lengths]


class Qwen3Embedder:
    """``Embedder`` on Qwen3-Embedding (CPU by default), loaded lazily on first use.

    ``model_name`` identifies the vector space: model id, pinned revision and MRL dimension.
    Inputs are batched longest-first (less padding); output order matches input order.
    """

    def __init__(
        self,
        config: Qwen3EmbedderConfig | None = None,
        *,
        loader: BackendLoader | None = None,
    ) -> None:
        self._config = config or Qwen3EmbedderConfig()
        self._loader: BackendLoader = loader or _TransformersBackend
        self._backend: EncoderBackend | None = None

    @property
    def config(self) -> Qwen3EmbedderConfig:
        return self._config

    @property
    def model_name(self) -> str:
        name = f"{self._config.model_id}@{self._config.revision}"
        if self._config.dimension is not None:
            name += f"/mrl-{self._config.dimension}"
        return name

    @property
    def dimension(self) -> int:
        if self._config.dimension is not None:
            return self._config.dimension
        return self._load().hidden_size

    def query_text(self, text: str) -> str:
        """The exact input string a query is embedded as."""
        instruction = self._config.query_instruction
        return f"Instruct: {instruction}\nQuery:{text}" if instruction else text

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return self._encode(list(texts))

    def embed_query(self, text: str) -> list[float]:
        return self._encode([self.query_text(text)])[0]

    def _load(self) -> EncoderBackend:
        if self._backend is None:
            backend = self._loader(self._config)
            dim = self._config.dimension
            if dim is not None and dim > backend.hidden_size:
                raise ValueError(
                    f"dimension {dim} exceeds the model's hidden size {backend.hidden_size}"
                )
            self._backend = backend
        return self._backend

    def _encode(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        import torch
        from torch.nn.functional import normalize

        backend = self._load()
        order = sorted(range(len(texts)), key=lambda i: (-len(texts[i]), i))
        size = self._config.batch_size
        result: list[list[float]] = [[] for _ in texts]
        for start in range(0, len(order), size):
            indices = order[start : start + size]
            hidden, mask = backend.forward([texts[i] for i in indices])
            pooled = last_token_pool(hidden, mask).to(torch.float32)
            if self._config.dimension is not None:
                pooled = pooled[:, : self._config.dimension]
            vectors = normalize(pooled, p=2, dim=1).cpu().tolist()
            for i, vector in zip(indices, vectors, strict=True):
                result[i] = vector
        return result


class Qwen3Tokenizer:
    """Chunker ``Tokenizer`` counting Qwen3 tokens (no special tokens), loaded lazily.

    The embedder appends one end-of-text token per input on top of this count.
    """

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL_ID,
        revision: str = DEFAULT_REVISION,
        *,
        cache_dir: Path | None = None,
        local_files_only: bool = False,
    ) -> None:
        if not model_id.strip() or not revision.strip():
            raise ValueError("model_id and a pinned revision are required")
        self._model_id = model_id
        self._revision = revision
        self._cache_dir = cache_dir
        self._local_files_only = local_files_only
        self._tokenizer: PreTrainedTokenizerBase | None = None

    @property
    def name(self) -> str:
        return f"hf:{self._model_id}@{self._revision[:12]}"

    def count(self, text: str) -> int:
        if self._tokenizer is None:
            self._tokenizer = _load_tokenizer(
                self._model_id, self._revision, self._cache_dir, self._local_files_only
            )
        ids = self._tokenizer(text, add_special_tokens=False)["input_ids"]
        return len(ids)
