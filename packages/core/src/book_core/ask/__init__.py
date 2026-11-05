"""AI questions over the workspace's documents (ASK-01, questions.md §13).

- ``models``: the attached question's DTO per disclosure level (``HintQuestionContext`` carries no
  answer-identifying field; ``FullQuestionContext``), passages and history turns;
- ``prompts``: ``build_request`` (the `ask.answer/v2` request within the passage, context and
  history budgets);
- ``citations``: ``validate_citations`` (unknown tags dropped, renumbering, ``[NO_ANSWER]``,
  uncited answers);
- ``fake``: the provider adapter and the deterministic APP_ENV=test answerer with its markers.
"""

from book_core.ask.citations import (
    NOT_FOUND_TEXT,
    TRUNCATED_SUFFIX,
    CitationResult,
    display_tags,
    validate_citations,
)
from book_core.ask.fake import (
    DEFAULT_HOLD_DIR,
    DEFAULT_LOG_DIR,
    MARKER_BADCITE,
    MARKER_FAIL,
    MARKER_HOLD,
    MARKER_LEAK_PROBE,
    MARKER_NOANSWER,
    MARKER_SLOW,
    MARKER_UNCITED,
    AskAnswerer,
    AskCallMeta,
    FakeAskAnswerer,
    ProviderAskAnswerer,
    first_sentence,
    markers_of,
)
from book_core.ask.models import (
    ASK_FIELDS_FORBIDDEN_IN_HINT,
    AskSource,
    AttachmentKind,
    Disclosure,
    FullQuestionContext,
    HintOption,
    HintQuestionContext,
    HistoryTurn,
    QuestionContext,
    displayed_options,
    full_context,
    hint_context,
)
from book_core.ask.prompts import (
    DEFAULT_HISTORY_TURNS,
    DEFAULT_MAX_CONTEXT_CHARS,
    DEFAULT_MAX_HISTORY_CHARS,
    DEFAULT_MAX_SOURCE_CHARS,
    NO_ANSWER_MARK,
    PROMPT_VERSION,
    TASK,
    AskRequest,
    build_request,
    fit_history,
    fit_sources,
)

__all__ = [
    "ASK_FIELDS_FORBIDDEN_IN_HINT",
    "DEFAULT_HISTORY_TURNS",
    "DEFAULT_HOLD_DIR",
    "DEFAULT_LOG_DIR",
    "DEFAULT_MAX_CONTEXT_CHARS",
    "DEFAULT_MAX_HISTORY_CHARS",
    "DEFAULT_MAX_SOURCE_CHARS",
    "MARKER_BADCITE",
    "MARKER_FAIL",
    "MARKER_HOLD",
    "MARKER_LEAK_PROBE",
    "MARKER_NOANSWER",
    "MARKER_SLOW",
    "MARKER_UNCITED",
    "NOT_FOUND_TEXT",
    "NO_ANSWER_MARK",
    "PROMPT_VERSION",
    "TASK",
    "TRUNCATED_SUFFIX",
    "AskAnswerer",
    "AskCallMeta",
    "AskRequest",
    "AskSource",
    "AttachmentKind",
    "CitationResult",
    "Disclosure",
    "FakeAskAnswerer",
    "FullQuestionContext",
    "HintOption",
    "HintQuestionContext",
    "HistoryTurn",
    "ProviderAskAnswerer",
    "QuestionContext",
    "build_request",
    "display_tags",
    "displayed_options",
    "first_sentence",
    "fit_history",
    "fit_sources",
    "full_context",
    "hint_context",
    "markers_of",
    "validate_citations",
]
