"""QuestionExtractor never raises on odd input (M4.3 review fix).

A property-style sweep with a fixed seed: hundreds of small random documents whose lines and
table cells mix ASCII digits, circled digits (①-⑳), fullwidth digits, superscripts, Hangul
labels, punctuation and empty cells, with and without a (random) scripted LLM proposal. The
extractor must always return drafts that satisfy the contract and report problems only as
validation issues.
"""

from __future__ import annotations

import random

import pytest
from book_core.contracts import (
    Block,
    BlockType,
    PageInfo,
    ParsedDocument,
    QuestionDraft,
    SourceLocation,
    TableContent,
)
from book_core.extractor import LLMAnswer, LLMOption, LLMQuestion, QuestionExtractor
from book_core.llm import FakeLLMClient
from book_core.question import answer_option_keys

CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
FULLWIDTH = "".join(chr(0xFF10 + i) for i in range(10))  # fullwidth 0-9
SUPERSCRIPT = "¹²³⁴"
HANGUL = "가나다라마"
TOKENS = [
    *"0123456789",
    *CIRCLED,
    *FULLWIDTH,
    *SUPERSCRIPT,
    *HANGUL,
    *"ABCDEabcde",
    "10",
    "12",
    "999",
    "",
    " ",
    ".",
    ")",
    "(",
    ",",
    "번",
    "정답",
    "번호",
    "문항",
    "답",
    "?",
    "시오.",
    "모두 고르시오.",
    "서술하시오.",
    "[그림 1]",
    "물",
    "응결",
    "　",
]
PREFIXES = [
    "",
    "1. ",
    "2. ",
    "3번 ",
    "문 4. ",
    "Q5. ",
    "\uff11. ",
    "² ",
    "① ",
    "A. ",
    "(1) ",
    "가. ",
]


def _text(rng: random.Random) -> str:
    return rng.choice(PREFIXES) + "".join(
        rng.choice(TOKENS) + rng.choice(["", " "]) for _ in range(rng.randint(0, 6))
    )


def _document(rng: random.Random, seed: int) -> ParsedDocument:
    loc = (SourceLocation(page=1),)
    blocks: list[Block] = []
    for i in range(rng.randint(1, 12)):
        kind = rng.random()
        if kind < 0.12:
            width, height = rng.randint(1, 5), rng.randint(1, 4)
            rows = tuple(
                tuple(rng.choice([*TOKENS, "1", "2", "3", "4"]).strip() for _ in range(width))
                for _ in range(height)
            )
            blocks.append(
                Block(
                    id=f"b{i}",
                    type=BlockType.TABLE,
                    text="\n".join(" | ".join(r) for r in rows),
                    locations=loc,
                    table=TableContent(rows=rows),
                )
            )
        elif kind < 0.18:
            blocks.append(Block(id=f"b{i}", type=BlockType.IMAGE, text="", locations=loc))
        elif kind < 0.25:
            blocks.append(Block(id=f"b{i}", type=BlockType.HEADING, text="정답", locations=loc))
        else:
            lines = "\n".join(_text(rng) for _ in range(rng.randint(1, 3)))
            blocks.append(Block(id=f"b{i}", type=BlockType.TEXT, text=lines, locations=loc))
    return ParsedDocument(
        source_path="fuzz.pdf",
        source_sha256=f"{seed:064x}",
        parser_version="fuzz",
        pages=(PageInfo(page=1, width=595.0, height=842.0),),
        blocks=tuple(blocks),
    )


def _proposal(rng: random.Random) -> LLMQuestion:
    labels = [*CIRCLED[:6], *SUPERSCRIPT, *FULLWIDTH[:4], *HANGUL, "A", "B", "(1)", "", " ", "1 0"]
    options = [
        LLMOption(label=rng.choice(labels), text=_text(rng)) for _ in range(rng.randint(0, 4))
    ]
    answer = rng.choice(
        [
            None,
            LLMAnswer(option_labels=[rng.choice(labels)], text_answers=None),
            LLMAnswer(option_labels=None, text_answers=[_text(rng)]),
            LLMAnswer(option_labels=[], text_answers=[]),
        ]
    )
    return LLMQuestion(
        question_type=rng.choice(["MCQ", "SHORT_ANSWER", "ESSAY"]),
        multi_select=rng.random() < 0.5,
        stem=_text(rng),
        options=options,
        answer=answer,
    )


@pytest.mark.parametrize("chunk", range(4))
def test_extractor_never_raises_on_random_documents(chunk: int) -> None:
    rng = random.Random(20261017 + chunk)  # noqa: S311 (deterministic fuzzing)
    for seed in range(150):
        document = _document(rng, chunk * 1000 + seed)
        llm = None
        if rng.random() < 0.5:
            llm = FakeLLMClient()
            llm.script("questions.extract", _proposal(rng))
        result = QuestionExtractor(llm).extract(document, document_id="fuzz")

        for question in result.questions:
            draft = QuestionDraft.model_validate(question.draft.model_dump())
            ids = {o.id for o in draft.options}
            assert set(draft.correct_option_ids or ()) <= ids
            assert draft.evidence
        assert type(result).model_validate_json(result.model_dump_json()) == result


@pytest.mark.parametrize(
    "rows",
    [
        (("1", "2", "3", "4"), ("②", "③", "①", "④")),
        (("1", "2", "3", "4"), ("2", "3", "1", "4")),
        (tuple(FULLWIDTH[1:5]), ("②", "③", "①", "④")),
    ],
    ids=["circled-answers", "ascii-answers", "fullwidth-numbers"],
)
def test_horizontal_table_with_option_answers(rows: tuple[tuple[str, ...], ...]) -> None:
    loc = (SourceLocation(page=1),)
    questions = [
        Block(
            id=f"q{n}",
            type=BlockType.TEXT,
            text=f"{n}. 고르시오.\n① 가\n② 나\n③ 다\n④ 라",
            locations=loc,
        )
        for n in (1, 2, 3, 4)
    ]
    document = ParsedDocument(
        source_path="t.pdf",
        source_sha256="4" * 64,
        parser_version="test",
        pages=(PageInfo(page=1, width=595.0, height=842.0),),
        blocks=(
            *questions,
            Block(id="h", type=BlockType.HEADING, text="정답", locations=loc),
            Block(
                id="t",
                type=BlockType.TABLE,
                text="\n".join(" | ".join(r) for r in rows),
                locations=loc,
                table=TableContent(rows=rows),
            ),
        ),
    )
    result = QuestionExtractor().extract(document, document_id="t")
    assert [d.correct_option_ids for d in result.drafts] == [
        ("opt-2",),
        ("opt-3",),
        ("opt-1",),
        ("opt-4",),
    ]
    assert result.warnings == ()


def test_hangul_answer_key_labels_map_to_option_ids() -> None:
    assert answer_option_keys("나") == ("나",)
    assert answer_option_keys("가, 다") == ("가", "다")
    assert answer_option_keys("나무") is None

    client = FakeLLMClient()
    client.script(
        "questions.extract",
        LLMQuestion(
            question_type="MCQ",
            multi_select=False,
            stem="물이 기체가 되는 과정은?",
            options=[LLMOption(label="가", text="응결"), LLMOption(label="나", text="증발")],
            answer=None,
        ),
    )
    loc = (SourceLocation(page=1),)
    document = ParsedDocument(
        source_path="h.pdf",
        source_sha256="5" * 64,
        parser_version="test",
        pages=(PageInfo(page=1, width=595.0, height=842.0),),
        blocks=(
            Block(
                id="q",
                type=BlockType.TEXT,
                text="1. 물이 기체가 되는 과정은? 가. 응결 나. 증발",
                locations=loc,
            ),
            Block(id="h", type=BlockType.HEADING, text="정답", locations=loc),
            Block(id="k", type=BlockType.TEXT, text="1. 나", locations=loc),
        ),
    )
    (draft,) = QuestionExtractor(client).extract(document, document_id="h").drafts
    assert draft.correct_option_ids == ("opt-나",)
