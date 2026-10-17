"""Qwen3-Reranker adapter (requires the ``models`` extra).

Follows the model card of ``Qwen/Qwen3-Reranker-0.6B`` (transformers usage):

- each (query, passage) pair is formatted as
  ``"<Instruct>: {instruction}\\n<Query>: {query}\\n<Document>: {passage}"``, tokenized without
  special tokens and truncated to ``max_length`` minus the chat-template prefix/suffix tokens
  (so long passages lose their tail), then wrapped in the fixed system/user/assistant prefix and
  the empty-``<think>`` suffix;
- the causal LM's next-token logits at the last position are read for the tokens ``"yes"`` and
  ``"no"``; the relevance score is ``logit(yes) - logit(no)``.

The card's transformers snippet reports ``P(yes) = softmax([no, yes])[1]``, which equals
``sigmoid(score)``; the sentence-transformers ``CrossEncoder`` of the same repo returns the raw
difference. The difference is returned here: same ordering, but it does not saturate to 1.0 for
several confident passages (which would turn real preferences into ties).

CPU cost (M2.4 measurement, fp32, 8-core Apple CPU shared with other jobs, load average 10-20):
reranking 20 passages of 256 tokens takes ~7 s per query at ``batch_size`` 8 (~8 s at 4, ~13 s
at 1, ~17 s at 20); peak RSS ~4 GB, dominated by loading the fp32 weights, independent of the
batch size. Only the last position's logits are computed (``logits_to_keep=1``).

Loading, offline handling and errors match ``Qwen3Embedder``: torch/transformers are imported
lazily, the Hub revision is pinned, ``HF_HUB_OFFLINE=1`` / ``local_files_only=True`` forbid
downloads, and missing weights raise ``ModelUnavailableError``.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol

from book_core.embedding.qwen3 import _load_tokenizer, _unavailable

if TYPE_CHECKING:
    from transformers import PreTrainedTokenizerBase

DEFAULT_RERANKER_MODEL_ID = "Qwen/Qwen3-Reranker-0.6B"
# Pinned Hub commit (2026-04-16).
DEFAULT_RERANKER_REVISION = "e61197ed45024b0ed8a2d74b80b4d909f1255473"
# The model card's default instruction (config_sentence_transformers.json "query" prompt).
DEFAULT_RERANK_INSTRUCTION = (
    "Given a web search query, retrieve relevant passages that answer the query"
)
PROMPT_PREFIX = (
    "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query "
    'and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n'
    "<|im_start|>user\n"
)
PROMPT_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"

Dtype = Literal["float32", "bfloat16", "float16"]


@dataclass(frozen=True)
class Qwen3RerankerConfig:
    """Settings of ``Qwen3Reranker``.

    - ``max_length``: tokens per (query, passage) prompt including the template; the formatted
      pair is truncated to fit. Search passages are child chunks (~256 tokens) plus a short
      breadcrumb and a query capped by ``max_query_chars``, far below the default.
    - ``instruction``: task description in the prompt (the card advises English instructions,
      also for multilingual use); empty uses the card's default.
    - ``batch_size``: pairs per forward pass; pairs are batched longest-first.
    - ``num_threads``: if set, ``torch.set_num_threads`` at load (process-wide).
    """

    model_id: str = DEFAULT_RERANKER_MODEL_ID
    revision: str = DEFAULT_RERANKER_REVISION
    device: str = "cpu"
    dtype: Dtype = "float32"
    batch_size: int = 8
    max_length: int = 1024
    instruction: str = DEFAULT_RERANK_INSTRUCTION
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
        if self.max_length < 128:
            raise ValueError("max_length must be >= 128 (the prompt template alone is ~60)")
        if self.num_threads is not None and self.num_threads < 1:
            raise ValueError("num_threads must be >= 1")


def format_pair(instruction: str, query: str, passage: str) -> str:
    """The user-turn text of one pair (between the template prefix and suffix)."""
    return f"<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {passage}"


class RerankerBackend(Protocol):
    """Tokenizer + causal LM forward pass: the only part that needs model weights."""

    def yes_no_logits(self, prompts: list[str]) -> list[tuple[float, float]]:
        """Return ``(logit("yes"), logit("no"))`` at the next-token position, per prompt."""
        ...


RerankerLoader = Callable[[Qwen3RerankerConfig], RerankerBackend]


class _TransformersBackend:
    def __init__(self, config: Qwen3RerankerConfig) -> None:
        import torch
        from transformers import AutoModelForCausalLM

        if config.num_threads is not None:
            torch.set_num_threads(config.num_threads)
        tokenizer: PreTrainedTokenizerBase = _load_tokenizer(
            config.model_id, config.revision, config.cache_dir, config.local_files_only
        )
        try:
            model = AutoModelForCausalLM.from_pretrained(
                config.model_id,
                revision=config.revision,
                cache_dir=config.cache_dir,
                local_files_only=config.local_files_only,
                dtype=getattr(torch, config.dtype),
            )
        except OSError as exc:
            raise _unavailable(config.model_id, config.revision, exc) from exc
        self._tokenizer = tokenizer
        module: torch.nn.Module = model
        # eval(): no dropout; inference_mode() when scoring: no autograd state.
        self._model = module.to(config.device).eval()
        self._device = config.device
        self._max_length = config.max_length
        self._prefix: list[int] = tokenizer.encode(PROMPT_PREFIX, add_special_tokens=False)
        self._suffix: list[int] = tokenizer.encode(PROMPT_SUFFIX, add_special_tokens=False)
        self._yes = _single_token(tokenizer, "yes")
        self._no = _single_token(tokenizer, "no")

    def yes_no_logits(self, prompts: list[str]) -> list[tuple[float, float]]:
        import torch

        budget = self._max_length - len(self._prefix) - len(self._suffix)
        encoded = self._tokenizer(
            prompts,
            padding=False,
            truncation="longest_first",
            return_attention_mask=False,
            add_special_tokens=False,
            max_length=budget,
        )
        encoded["input_ids"] = [self._prefix + ids + self._suffix for ids in encoded["input_ids"]]
        batch = self._tokenizer.pad(encoded, padding=True, return_tensors="pt").to(self._device)
        with torch.inference_mode():
            # Only the last position's vocabulary logits are needed: computing all of them would
            # allocate batch x tokens x ~152k floats (~2 GB for 8 passages of 400 tokens).
            logits = self._model(**batch, logits_to_keep=1).logits[:, -1, :]
        pairs = logits[:, [self._yes, self._no]].to(torch.float32).cpu().tolist()
        return [(float(yes), float(no)) for yes, no in pairs]


def _single_token(tokenizer: PreTrainedTokenizerBase, text: str) -> int:
    ids = tokenizer.encode(text, add_special_tokens=False)
    if len(ids) != 1:
        raise ValueError(f"{text!r} is not a single token for this tokenizer")
    return int(ids[0])


class Qwen3Reranker:
    """``Reranker`` on Qwen3-Reranker (CPU by default), loaded lazily on first use.

    Scores are ``logit(yes) - logit(no)`` (``sigmoid`` gives the card's probability), in input
    order. Identical inputs give identical scores (eval mode, no sampling); a pair's score does
    not depend on the other pairs beyond float rounding from left padding in a batch.
    """

    def __init__(
        self,
        config: Qwen3RerankerConfig | None = None,
        *,
        loader: RerankerLoader | None = None,
    ) -> None:
        self._config = config or Qwen3RerankerConfig()
        self._loader: RerankerLoader = loader or _TransformersBackend
        self._backend: RerankerBackend | None = None

    @property
    def config(self) -> Qwen3RerankerConfig:
        return self._config

    @property
    def model_name(self) -> str:
        return f"{self._config.model_id}@{self._config.revision}"

    def prompt(self, query: str, passage: str) -> str:
        """The exact user-turn text a pair is scored as (before template and truncation)."""
        return format_pair(self._config.instruction or DEFAULT_RERANK_INSTRUCTION, query, passage)

    def score(self, query: str, passages: Sequence[str]) -> list[float]:
        prompts = [self.prompt(query, passage) for passage in passages]
        if not prompts:
            return []
        backend = self._load()
        order = sorted(range(len(prompts)), key=lambda i: (-len(prompts[i]), i))
        size = self._config.batch_size
        result = [0.0] * len(prompts)
        for start in range(0, len(order), size):
            indices = order[start : start + size]
            logits = backend.yes_no_logits([prompts[i] for i in indices])
            if len(logits) != len(indices):
                raise RuntimeError("reranker backend returned the wrong number of logits")
            for i, (yes, no) in zip(indices, logits, strict=True):
                result[i] = yes - no
        return result

    def _load(self) -> RerankerBackend:
        if self._backend is None:
            self._backend = self._loader(self._config)
        return self._backend
