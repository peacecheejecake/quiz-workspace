"""Plain-text streaming over an LLM provider (ASK-B: AI questions, AI explanations).

``TextStreamClient.stream_text`` yields the answer as it is produced: ``TextDelta`` events, then
exactly one ``TextStreamEnd`` with the stop reason and token usage. A client that knows part of the
usage early says so in a ``TextStreamUsage`` (a caller that closes the stream gets no end event);
callers that read the stream to its end ignore it. Closing the generator early
(``close()``) aborts the provider stream. Errors are :class:`LLMProviderError` whose message is
built from metadata only (status, error type, stop reason), never prompt or output text.

Retries are the caller's: only the caller knows whether a delta already reached the user (a
retried answer after the first delta would repeat text), so the provider client never retries a
stream on its own.

``FakeTextStreamClient`` is a scripted stand-in for unit tests. The provider client
(``AnthropicTextStreamClient`` in ``book_core.llm.anthropic_stream``) needs the ``llm`` extra and is
built through ``create_text_stream_client(LLMConfig.from_env())``.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, Protocol, runtime_checkable

from book_core.llm.base import LLMProviderError, LLMUsage

if TYPE_CHECKING:
    from book_core.llm.config import Effort, LLMConfig

Role = Literal["user", "assistant"]


@dataclass(frozen=True, slots=True)
class TextMessage:
    role: Role
    content: str


@dataclass(frozen=True, slots=True)
class TextStreamRequest:
    """One streamed completion. ``task`` / ``prompt_version`` name the caller for logs."""

    task: str
    prompt_version: str
    system: str
    messages: tuple[TextMessage, ...]
    max_tokens: int
    effort: Effort | None = None

    def __post_init__(self) -> None:
        if not self.messages or self.messages[-1].role != "user":
            raise ValueError("a text stream request ends with a user message")
        if self.max_tokens < 1:
            raise ValueError("max_tokens must be >= 1")


@dataclass(frozen=True, slots=True)
class TextDelta:
    text: str


@dataclass(frozen=True, slots=True)
class TextStreamEnd:
    """The end of a stream: ``stop_reason`` as the provider reports it (``end_turn``,
    ``max_tokens``, ...), the model that answered and the usage of the whole call."""

    model: str
    stop_reason: str | None
    usage: LLMUsage = field(default_factory=LLMUsage)
    provider_request_id: str | None = None

    @property
    def truncated(self) -> bool:
        return self.stop_reason == "max_tokens"


@dataclass(frozen=True, slots=True)
class TextStreamUsage:
    """The usage known so far: the input side as the provider reports it when the call starts."""

    usage: LLMUsage


TextStreamEvent = TextDelta | TextStreamUsage | TextStreamEnd


@runtime_checkable
class TextStreamClient(Protocol):
    @property
    def model_name(self) -> str: ...

    def stream_text(self, request: TextStreamRequest) -> Iterator[TextStreamEvent]: ...


class FakeTextStreamClient:
    """Streams scripted chunks (unit tests). ``error`` raises before the first chunk; ``calls``
    records every request."""

    def __init__(
        self,
        chunks: Sequence[str] = ("fake answer",),
        *,
        model_name: str = "fake-stream",
        stop_reason: str = "end_turn",
        error: LLMProviderError | None = None,
    ) -> None:
        self._chunks = tuple(chunks)
        self._model_name = model_name
        self._stop_reason = stop_reason
        self._error = error
        self.calls: list[TextStreamRequest] = []

    @property
    def model_name(self) -> str:
        return self._model_name

    def stream_text(self, request: TextStreamRequest) -> Iterator[TextStreamEvent]:
        self.calls.append(request)
        return self._stream(request)

    def _stream(self, request: TextStreamRequest) -> Iterator[TextStreamEvent]:
        if self._error is not None:
            raise self._error
        for chunk in self._chunks:
            yield TextDelta(chunk)
        prompt = request.system + "".join(m.content for m in request.messages)
        yield TextStreamEnd(
            model=self._model_name,
            stop_reason=self._stop_reason,
            usage=LLMUsage(
                input_tokens=estimate_tokens(prompt),
                output_tokens=estimate_tokens("".join(self._chunks)),
            ),
        )


def estimate_tokens(text: str) -> int:
    """A deterministic token estimate (UTF-8 bytes / 4, at least 1) for fakes."""
    return max(1, -(-len(text.encode("utf-8")) // 4))


def create_text_stream_client(config: LLMConfig) -> TextStreamClient:
    """The configured provider's streaming client. Needs the ``llm`` extra (imported lazily)."""
    from book_core.llm.config import LLMConfigError, LLMProvider

    if config.provider is LLMProvider.ANTHROPIC:
        from book_core.llm.anthropic_stream import AnthropicTextStreamClient

        return AnthropicTextStreamClient(config)
    raise LLMConfigError(f"unsupported LLM provider: {config.provider}")  # pragma: no cover
