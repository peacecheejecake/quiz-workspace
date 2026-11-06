"""Import-provenance regions and figures of a question (QSRC-API, UX12-REEXTRACT;
docs/questions.md §16)."""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from typing import Any

from book_core.extractor import has_inline_answer
from sqlalchemy import text
from sqlalchemy.orm import Session

# Stored edges are rounded independently of the union they belong to (PDF points).
_EDGE_TOLERANCE = 0.5

_Edges = tuple[float, float, float, float]


@dataclass(frozen=True)
class Region:
    document_id: uuid.UUID
    document_revision_id: uuid.UUID | None
    page: int
    x0: float
    y0: float
    x1: float
    y1: float


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) else None


def _box(location: Any) -> tuple[int, float, float, float, float] | None:
    if not isinstance(location, dict):
        return None
    page, bbox = location.get("page"), location.get("bbox")
    if isinstance(page, bool) or not isinstance(page, int) or page < 1:
        return None
    if not isinstance(bbox, dict):
        return None
    edges = [_num(bbox.get(k)) for k in ("x0", "y0", "x1", "y1")]
    if any(e is None for e in edges):
        return None
    x0, y0, x1, y1 = (float(e) for e in edges if e is not None)
    if x1 <= x0 or y1 <= y0:
        return None
    return page, x0, y0, x1, y1


def _block_id(location: Any) -> str | None:
    block_id = location.get("block_id") if isinstance(location, dict) else None
    return block_id if isinstance(block_id, str) and block_id else None


def _within(box: _Edges, outer: list[float] | None) -> bool:
    if outer is None:
        return False
    x0, y0, x1, y1 = box
    return (
        x0 >= outer[0] - _EDGE_TOLERANCE
        and y0 >= outer[1] - _EDGE_TOLERANCE
        and x1 <= outer[2] + _EDGE_TOLERANCE
        and y1 <= outer[3] + _EDGE_TOLERANCE
    )


def _reaches(union: list[float], answers: list[_Edges | None]) -> bool:
    """`union` overlaps one of the answer lines (touching edges do not count)."""
    for answer in answers:
        if answer is None:
            return True
        x0, y0, x1, y1 = answer
        if (
            x0 < union[2] - _EDGE_TOLERANCE
            and x1 > union[0] + _EDGE_TOLERANCE
            and y0 < union[3] - _EDGE_TOLERANCE
            and y1 > union[1] + _EDGE_TOLERANCE
        ):
            return True
    return False


def _grow(unions: dict[Any, list[float]], key: Any, box: _Edges) -> None:
    x0, y0, x1, y1 = box
    cur = unions.get(key)
    if cur is None:
        unions[key] = [x0, y0, x1, y1]
    else:
        cur[0], cur[1] = min(cur[0], x0), min(cur[1], y0)
        cur[2], cur[3] = max(cur[2], x1), max(cur[3], y1)


class SourceRegionRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def question_view(
        self, workspace_id: uuid.UUID, question_id: uuid.UUID
    ) -> tuple[list[Region], list[Region]]:
        """The question's regions and figures (QSRC-01-C01/C06, UX12-REEXTRACT-C05).

        Regions: per-(document, page) bbox unions of the question's own locations, page ascending.
        A location with a `block_id` comes from an evidence entry past the first; it is not part
        of the question's own blocks (those are stored as per-page unions without one) and may
        have been read after the inline answer, so it never widens a region. A page whose union
        touches an answer line has no region: the parser can keep the line in the question's last
        block, and a question wrapping between columns crosses it. Soft-deleted documents and
        locations without a valid bbox count as no source.

        Figures: of those block locations, the `image` blocks inside a region, by page, top,
        left. Only the image's own bbox is returned, so no neighbouring text is cropped in."""
        rows = self._session.execute(
            text(
                "select s.document_id, s.document_revision_id, s.locations "
                "from public.question_sources s "
                "join public.documents d on d.id = s.document_id "
                "and d.workspace_id = s.workspace_id and d.deleted_at is null "
                "where s.workspace_id = :w and s.question_id = :q "
                "and s.import_run_id is not null and s.document_id is not null "
                "order by s.created_at, s.id"
            ),
            {"w": workspace_id, "q": question_id},
        )
        unions: dict[tuple[uuid.UUID, uuid.UUID, int], list[float]] = {}
        candidates: list[tuple[str, uuid.UUID, uuid.UUID, int, _Edges]] = []
        for row in rows:
            if row.document_revision_id is None:
                continue  # No blocks to check the answer lines against.
            for location in row.locations or []:
                box = _box(location)
                if box is None:
                    continue
                page, x0, y0, x1, y1 = box
                block_id = _block_id(location)
                if block_id is None:
                    key = (row.document_id, row.document_revision_id, page)
                    _grow(unions, key, (x0, y0, x1, y1))
                else:
                    candidates.append(
                        (
                            block_id,
                            row.document_id,
                            row.document_revision_id,
                            page,
                            (x0, y0, x1, y1),
                        )
                    )

        kept: dict[tuple[uuid.UUID, uuid.UUID, int], list[float]] = {}
        for revision_id in {key[1] for key in unions}:
            pages = [key[2] for key in unions if key[1] == revision_id]
            answers = self._answer_lines(workspace_id, revision_id, pages)
            for key, union in unions.items():
                if key[1] == revision_id and not _reaches(union, answers.get(key[2], [])):
                    kept[key] = union

        figures: dict[tuple[Any, ...], Region] = {}
        for revision_id in {key[1] for key in kept}:
            inside = [
                c
                for c in candidates
                if c[2] == revision_id and _within(c[4], kept.get((c[1], c[2], c[3])))
            ]
            if not inside:
                continue
            images = self._image_blocks(workspace_id, revision_id, [c[0] for c in inside])
            for block_id, document_id, _, page, edges in inside:
                if block_id in images:
                    figures[(document_id, page, *edges)] = Region(
                        document_id, revision_id, page, *edges
                    )
        ordered = sorted(kept.items(), key=lambda kv: kv[0][2])
        return (
            [Region(k[0], k[1], k[2], *v) for k, v in ordered],
            sorted(figures.values(), key=lambda r: (r.page, r.y0, r.x0)),
        )

    def _answer_lines(
        self, workspace_id: uuid.UUID, revision_id: uuid.UUID, pages: list[int]
    ) -> dict[int, list[_Edges | None]]:
        """Where the revision prints inline answers on `pages`: the blocks holding such a line, by
        page. None = on the page, position unknown. A block can start on the page before."""
        rows = self._session.execute(
            text(
                "select text, provenance from public.content_blocks "
                "where workspace_id = :w and document_revision_id = :r "
                "and page between :first and :last and text ~* '정\\s*답|answer'"
            ),
            {"w": workspace_id, "r": revision_id, "first": min(pages) - 1, "last": max(pages)},
        )
        found: dict[int, list[_Edges | None]] = {}
        for row in rows:
            if not has_inline_answer(row.text):
                continue
            for location in row.provenance.get("locations") or []:
                box = _box(location)
                if box is not None:
                    found.setdefault(box[0], []).append(box[1:])
                elif isinstance(location, dict) and isinstance(location.get("page"), int):
                    found.setdefault(location["page"], []).append(None)
        return found

    def _image_blocks(
        self, workspace_id: uuid.UUID, revision_id: uuid.UUID, block_ids: list[str]
    ) -> set[str]:
        rows = self._session.execute(
            text(
                "select block_id from public.content_blocks "
                "where workspace_id = :w and document_revision_id = :r "
                "and block_id = any(:ids) and block_type = 'image'"
            ),
            {"w": workspace_id, "r": revision_id, "ids": block_ids},
        )
        return {row.block_id for row in rows}

    def mock_origin(self, workspace_id: uuid.UUID, mock_question_id: uuid.UUID) -> uuid.UUID | None:
        """The live, non-draft origin question of a live `보기 섞기` mock exam question."""
        row = self._session.execute(
            text(
                "select o.id from public.mock_exam_questions m "
                "join public.mock_exams e on e.id = m.mock_exam_id "
                "and e.workspace_id = m.workspace_id and e.deleted_at is null "
                "join public.questions o on o.workspace_id = m.workspace_id "
                "and o.id = m.source_question_id and o.deleted_at is null "
                "and o.publication_status <> 'DRAFT' "
                "where m.id = :m and m.workspace_id = :w and m.removed_at is null "
                "and m.variation_type = 'OPTION_SHUFFLE'"
            ),
            {"m": mock_question_id, "w": workspace_id},
        ).one_or_none()
        return row.id if row is not None else None

    def question_is_readable(self, workspace_id: uuid.UUID, question_id: uuid.UUID) -> bool:
        row = self._session.execute(
            text(
                "select 1 from public.questions where id = :q and workspace_id = :w "
                "and deleted_at is null and publication_status <> 'DRAFT'"
            ),
            {"q": question_id, "w": workspace_id},
        ).first()
        return row is not None
