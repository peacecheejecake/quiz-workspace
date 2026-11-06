"""Question domain helpers shared by import (extractor) and generation (later M4/M6 Tasks)."""

from book_core.question.fingerprint import (
    FINGERPRINT_VERSION,
    normalize_text,
    question_fingerprint,
)
from book_core.question.labels import (
    CIRCLED_DIGITS,
    HANGUL_LABELS,
    answer_option_keys,
    break_stem_items,
    canonical_key,
    has_item_label,
    has_pipe_table,
    leading_item_families,
    loose_text,
    option_id,
    split_option_line,
    split_pipe_blocks,
    stem_item_starts,
)
from book_core.question.validation import issue, structural_issues

__all__ = [
    "CIRCLED_DIGITS",
    "FINGERPRINT_VERSION",
    "HANGUL_LABELS",
    "answer_option_keys",
    "break_stem_items",
    "canonical_key",
    "has_item_label",
    "has_pipe_table",
    "issue",
    "leading_item_families",
    "loose_text",
    "normalize_text",
    "option_id",
    "question_fingerprint",
    "split_option_line",
    "split_pipe_blocks",
    "stem_item_starts",
    "structural_issues",
]
