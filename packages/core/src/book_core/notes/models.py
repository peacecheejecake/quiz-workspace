"""Chapter note data: the LLM output schema, the questions a note is made from and the result.

The LLM output (CHNOTE.0 assumption N7, tests/e2e/fixtures/chapter-notes.ts) is a proposal:
``{sections: [{heading, items: [{text, tags: ["Q1", ...], quote: str | null}]}]}``. Tags are
the input tags of the request's questions (``Q1``..``Qk``); :mod:`book_core.notes.validation`
keeps only items whose citations check out, so no stored item ever cites a question outside the
input (docs/screens/chapter-notes.md CHNOTE-01-C02).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from pydantic import BaseModel, ConfigDict, Field

# Large chapters are split into contiguous batches of at most this many questions / input
# characters (CHNOTE-01-C04, assumption N10).
MAX_BATCH_QUESTIONS = 120
MAX_BATCH_CHARS = 60_000
# The chapter's published text given as reference (quotes are checked against all of it).
MAX_REFERENCE_CHARS = 20_000


class LLMNoteItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str
    tags: list[str] = Field(default_factory=list)
    quote: str | None = None


class LLMNoteSection(BaseModel):
    model_config = ConfigDict(extra="ignore")

    heading: str
    items: list[LLMNoteItem] = Field(default_factory=list)


class LLMNoteOutput(BaseModel):
    """The structured output of task ``chapter_notes.generate``."""

    model_config = ConfigDict(extra="ignore")

    sections: list[LLMNoteSection] = Field(default_factory=list)


@dataclass(frozen=True)
class NoteOption:
    text: str
    correct: bool


@dataclass(frozen=True)
class NoteQuestion:
    """One CONFIRMED question revision of the chapter, in Heatmap order.

    ``tag`` is chapter-wide (``Q1``..``Qn``); a batch re-tags its questions ``Q1``..``Qk`` in the
    request and the merge maps them back.
    """

    tag: str
    label: str
    question_type: str
    stem: str
    options: tuple[NoteOption, ...] = ()
    accepted_answers: tuple[str, ...] = ()
    explanation: str | None = None
    # ESSAY: the model answer / grading criteria (the editor's "채점 기준"), often the only answer.
    rubric: str | None = None


@dataclass(frozen=True)
class NoteItem:
    text: str
    tags: tuple[str, ...]


@dataclass(frozen=True)
class NoteSection:
    heading: str
    items: tuple[NoteItem, ...]


@dataclass
class NoteUsage:
    """Counts only (stored on the note row and in the job result; never text)."""

    llm_calls: int = 0
    batches: int = 0
    items: int = 0
    dropped_items: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None

    def as_dict(self) -> dict[str, int | float | None]:
        return {
            "llm_calls": self.llm_calls,
            "batches": self.batches,
            "items": self.items,
            "dropped_items": self.dropped_items,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": self.cost_usd,
        }


@dataclass(frozen=True)
class NoteResult:
    sections: tuple[NoteSection, ...]
    usage: NoteUsage
    model: str | None = None
    prompt_version: str | None = None
    rejected_codes: tuple[str, ...] = field(default_factory=tuple)

    def body(self) -> dict[str, object]:
        """The stored body: ``{sections: [{heading, items: [{text, tags}]}]}``."""
        return {
            "sections": [
                {
                    "heading": s.heading,
                    "items": [{"text": i.text, "tags": list(i.tags)} for i in s.items],
                }
                for s in self.sections
            ]
        }
