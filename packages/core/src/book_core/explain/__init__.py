"""AI explanations of a question after submission (AIEXPL-01, questions.md §13).

- ``models``: the explanation's input DTO (the question revision only: never a user's answer);
- ``prompts``: ``build_request`` (the `question.ai_explain/v3` request and its tagged output
  format, passage budgets, the coverage re-request note);
- ``output``: streaming display text with the early answer check, parsing, validation (answer
  mismatch, option coverage) and citation renumbering (the ASK rules);
- ``fake``: the provider adapter and the deterministic APP_ENV=test explainer with its markers.
"""

from book_core.explain.fake import (
    DEFAULT_HOLD_DIR,
    DEFAULT_LOG_DIR,
    FAKE_MODEL,
    FAKE_RAW_SENTINEL,
    LOG_SUBDIR,
    MARKER_FAIL,
    MARKER_HOLD,
    MARKER_HOLDMID,
    MARKER_MISMATCH,
    MARKER_MISSING_OPTION,
    MARKER_SLOW,
    ExplainCallMeta,
    Explainer,
    FakeExplainer,
    ProviderExplainer,
    markers_of,
)
from book_core.explain.models import (
    ExplainKind,
    ExplainOption,
    ExplainQuestion,
    ExplainSource,
    explain_question,
)
from book_core.explain.output import (
    ANSWER_MISMATCH,
    INCOMPLETE,
    TRUNCATED_SUFFIX,
    AnswerMismatchError,
    ExplanationStream,
    FinishedExplanation,
    ParsedExplanation,
    finish_explanation,
    parse_output,
)
from book_core.explain.prompts import (
    DEFAULT_MAX_CONTEXT_CHARS,
    DEFAULT_MAX_SOURCE_CHARS,
    NO_EVIDENCE_TEXT,
    PROMPT_VERSION,
    READABLE_PROMPT_VERSIONS,
    TASK,
    ExplainRequest,
    build_request,
)

__all__ = [
    "ANSWER_MISMATCH",
    "DEFAULT_HOLD_DIR",
    "DEFAULT_LOG_DIR",
    "DEFAULT_MAX_CONTEXT_CHARS",
    "DEFAULT_MAX_SOURCE_CHARS",
    "FAKE_MODEL",
    "FAKE_RAW_SENTINEL",
    "INCOMPLETE",
    "LOG_SUBDIR",
    "MARKER_FAIL",
    "MARKER_HOLD",
    "MARKER_HOLDMID",
    "MARKER_MISMATCH",
    "MARKER_MISSING_OPTION",
    "MARKER_SLOW",
    "NO_EVIDENCE_TEXT",
    "PROMPT_VERSION",
    "READABLE_PROMPT_VERSIONS",
    "TASK",
    "TRUNCATED_SUFFIX",
    "AnswerMismatchError",
    "ExplainCallMeta",
    "ExplainKind",
    "ExplainOption",
    "ExplainQuestion",
    "ExplainRequest",
    "ExplainSource",
    "Explainer",
    "ExplanationStream",
    "FakeExplainer",
    "FinishedExplanation",
    "ParsedExplanation",
    "ProviderExplainer",
    "build_request",
    "explain_question",
    "finish_explanation",
    "markers_of",
    "parse_output",
]
