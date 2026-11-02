"""ASK-01 server guarantees C01-C11 (docs/screens/ask-llm.md, questions.md §13,
architecture.md §4-§6).

Only the conversation's owner reaches it, members create, archived reads only, share sessions
nothing (C01); evidence is this workspace's live published books only — no question papers, no
`mixed` question part, references pinned without text, re-checked before the write (C02); a
`hint` context carries nothing that tells the answer, computed per message from the DB (C03);
unknown footnotes are dropped and renumbered, `[NO_ANSWER]` and uncited answers are marked
(C04); the SSE contract with resume, cancel and polling (C05); limits, idempotency and usage
(C06); no question, answer, passage or prompt in logs, job results or activities (C07);
retention, deletion, purge, fork and append-only (C08); the worker re-checks and runs once
(C09); mock exam question attachments (C10); the deterministic fake (C11).

Shapes are assumptions Q1-Q9 in tests/e2e/fixtures/ask.ts. Jobs run in this process
(conftest.py); the fake's requests are read from `JobWorker.ask_deps.llm.calls`.
"""

from __future__ import annotations

import dataclasses
import hashlib
import importlib
import json
import logging
import os
import random
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import pytest

pytestmark = [pytest.mark.infra, pytest.mark.red]

REPO_ROOT = Path(__file__).resolve().parents[3]
PDF_DIR = REPO_ROOT / "tests" / "fixtures" / "pdfs"
BOOK_KO = PDF_DIR / "book-ko.pdf"
PAPER = PDF_DIR / "questions-ko.pdf"
CH1, CH2 = "1장 물의 순환", "2장 정수 처리"
CH1_SNIPPET = "햇빛이 바다와 호수의 표면을 데우면"
PAPER_SNIPPET = "물이 액체에서 기체로 변하는 과정을 무엇이라 하는가?"
BOOK_PASSAGE = "가나다 원리"
PAPER_PASSAGE = "라마바 정답표"
MIXED_PASSAGE = "사아자 해설"
NOWHERE = "차카타파"
QUESTION = "가나다 원리를 설명해 줘"
EXPLANATION = "E2E-EXPLANATION-SECRET"
CORRECT = "E2E-CORRECT-OPTION"
RUBRIC = "E2E-RUBRIC-SECRET"
MODEL_ANSWER = "E2E-MODEL-ANSWER-SECRET"
ACCEPTED = "E2E-ACCEPTED-SECRET"
MOCK_EXPLANATION = "E2E-MOCK-EXPLANATION-SECRET"
MOCK_CORRECT = "E2E-MOCK-CORRECT-OPTION"
FAIL, SLOW, BADCITE, NOANSWER = (
    "E2E-ASK-FAIL",
    "E2E-ASK-SLOW",
    "E2E-ASK-BADCITE",
    "E2E-ASK-NOANSWER",
)
PROBE, UNCITED, HOLD = "E2E-ASK-LEAK-PROBE", "E2E-ASK-UNCITED", "E2E-ASK-HOLD"
ANSWER_FIELDS = (
    "correct_answer",
    "correct_option_ids",
    "is_correct",
    "explanation",
    "accepted_answers",
    "rubric",
    "question_sources",
    "evidence",
)
ANSWER_KEYS = {"correct_option_ids", "accepted_answers", "explanation", "rubric", "correct_answer"}
JOB_TYPE = "ask.answer"
TERMINAL = {"succeeded", "no_sources", "stopped", "failed"}
RANDOM_ID = "00000000-0000-4000-8000-000000000000"
P = "urn:quiz-workspace:problem:"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
API = "/api/v1"


# ---------------------------------------------------------------------------------------------
# Helpers (public API first; superuser reads only where no API exposes the guarantee)
# ---------------------------------------------------------------------------------------------


def upload(client: Any, workspace_id: str, pdf: Path, document_type: str) -> str:
    """upload-intent -> PUT -> complete-upload, then drains the parse job."""
    data = pdf.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    intent: dict[str, Any] = client.ok(
        "POST",
        f"/workspaces/{workspace_id}/documents/upload-intent",
        {
            "filename": pdf.name,
            "size_bytes": len(data),
            "content_type": "application/pdf",
            "sha256": sha256,
            "document_type": document_type,
        },
        (200, 201),
    )
    url = str(intent["upload_url"])
    assert urlsplit(url).hostname in LOOPBACK, "upload URL must stay on the local stack"
    put = httpx.put(
        url,
        content=data,
        headers={"content-type": "application/pdf", **intent.get("upload_headers", {})},
        timeout=30,
    )
    assert put.is_success, f"direct Storage upload failed: HTTP {put.status_code}"
    done: dict[str, Any] = client.ok(
        "POST",
        "/documents/complete-upload",
        {"upload_id": intent["upload_id"], "sha256": sha256},
        (202,),
    )
    client.wait_for_job(str(done["job_id"]))
    return str(done["document_id"])


def edit_block(client: Any, document_id: str, page: int, snippet: str, text: str) -> None:
    blocks = client.ok(
        "GET", f"/documents/{document_id}/blocks?revision=latest&page={page}&limit=200"
    )
    [block] = [b for b in blocks["items"] if snippet in b["text"]]
    client.ok(
        "PATCH",
        f"/documents/{document_id}/blocks/{block['block_id']}",
        {"text": text.replace("{text}", block["text"]), "base_version": block["version"]},
    )


def publish(client: Any, document_id: str) -> str:
    job_id = str(client.ok("POST", f"/documents/{document_id}/publish", {}, (202,))["job_id"])
    client.wait_for_job(job_id)
    return str(client.ok("GET", f"/documents/{document_id}")["active_revision_id"])


class AskSeed:
    """A workspace with book-ko (BOOK_PASSAGE in chapter 1), and on demand the question paper,
    the `mixed` document and the answer-marker questions."""

    def __init__(self, client: Any, workspace_id: str | None = None) -> None:
        self.client = client
        self.ws: str = workspace_id or client.create_workspace()["id"]
        self.book = upload(client, self.ws, BOOK_KO, "book")
        edit_block(
            client,
            self.book,
            2,
            CH1_SNIPPET,
            f"{BOOK_PASSAGE}는 증발한 수증기가 식으며 구름이 되는 순서를 정리한 합성 개념이다. "
            "{text}",
        )
        self.book_revision = publish(client, self.book)
        items = client.ok("GET", f"/documents/{self.book}/outline")["items"]
        by_title = {str(n["title"]).strip(): str(n["id"]) for n in items}
        self.ch1, self.ch2 = by_title[CH1], by_title[CH2]
        self._n = 0

    def paper(self) -> str:
        doc = upload(self.client, self.ws, PAPER, "question_paper")
        edit_block(self.client, doc, 1, PAPER_SNIPPET, "{text} " + f"({PAPER_PASSAGE})")
        publish(self.client, doc)
        return doc

    def mixed(self) -> str:
        doc = upload(self.client, self.ws, PAPER, "book")
        self.client.ok("PATCH", f"/documents/{doc}", {"kind": "mixed", "extract": False})
        edit_block(self.client, doc, 1, PAPER_SNIPPET, "{text} " + f"({MIXED_PASSAGE})")
        publish(self.client, doc)
        return doc

    def mcq(
        self,
        tag: str,
        correct: int = 1,
        texts: list[str] | None = None,
        status: str = "CONFIRMED",
        ws: str | None = None,
    ) -> dict[str, Any]:
        self._n += 1
        texts = texts or ["보기 가 증산", CORRECT, "보기 다 침전", "보기 라 강수"]
        options = [{"id": f"opt-{i + 1}", "text": t} for i, t in enumerate(texts)]
        out: dict[str, Any] = self.client.ok(
            "POST",
            f"/workspaces/{ws or self.ws}/questions",
            {
                "question_type": "MCQ",
                "stem": f"{tag} 물이 액체에서 기체로 변하는 과정은 무엇인가?",
                "options": options,
                "correct_option_ids": [options[correct]["id"]],
                "is_multi_answer": False,
                "explanation": f"{EXPLANATION} 증발은 액체가 기체로 바뀌는 과정이다.",
                "chapter_id": self.ch1 if ws is None else None,
                "question_number": self._n,
                "sources": []
                if ws
                else [{"document_id": self.book, "page_start": 2, "page_end": 2}],
                "publication_status": status,
            },
            (201,),
        )
        return out

    def written(self, tag: str, kind: str) -> dict[str, Any]:
        """SHORT_ANSWER (accepted answers) or ESSAY (rubric + model answer) with markers."""
        self._n += 1
        body: dict[str, Any] = {
            "question_type": kind,
            "stem": f"{tag} 수증기가 물방울로 바뀌는 과정을 쓰시오.",
            "explanation": f"{EXPLANATION} 응결이다. {MODEL_ANSWER}",
            "chapter_id": self.ch1,
            "question_number": self._n,
            "sources": [{"document_id": self.book, "page_start": 2, "page_end": 2}],
        }
        if kind == "SHORT_ANSWER":
            body["accepted_answers"] = [ACCEPTED, "응결"]
        else:
            body["rubric"] = f"{RUBRIC} 응결을 쓰면 정답"
        out: dict[str, Any] = self.client.ok(
            "POST", f"/workspaces/{self.ws}/questions", body, (201,)
        )
        return out


def conv(client: Any, ws: str, expected: int = 201, **body: Any) -> httpx.Response:
    res: httpx.Response = client.send("POST", f"/workspaces/{ws}/ask/conversations", body)
    assert not _missing(res), "POST /workspaces/{id}/ask/conversations not implemented (404)"
    assert res.status_code == expected, (
        f"expected {expected}, got {res.status_code}: {res.text[:300]}"
    )
    return res


def _missing(res: httpx.Response) -> bool:
    if res.status_code == 405:
        return True
    if res.status_code != 404:
        return False
    try:
        return not res.json().get("detail")
    except ValueError:
        return True


def new_conv(client: Any, ws: str, **body: Any) -> dict[str, Any]:
    out: dict[str, Any] = conv(client, ws, **body).json()
    return out


def post(
    client: Any, conversation_id: str, question: str, key: str | None = None, **extra: Any
) -> httpx.Response:
    headers = {"Idempotency-Key": key} if key else {}
    res: httpx.Response = client.send(
        "POST",
        f"/ask/conversations/{conversation_id}/messages",
        {"question": question, **extra},
        headers=headers,
    )
    assert not _missing(res), "POST /ask/conversations/{id}/messages not implemented (404)"
    return res


def message(client: Any, message_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok("GET", f"/ask/messages/{message_id}")
    return out


def finish(client: Any, sent: httpx.Response, worker: Any = None) -> dict[str, Any]:
    """Drains the answer's `ask.answer` job and returns the finished answer."""
    assert sent.status_code == 202, f"expected 202, got {sent.status_code}: {sent.text[:300]}"
    body = sent.json()
    (worker or client.worker).drain(str(body["job_id"]))
    answer = message(client, str(body["answer"]["id"]))
    assert answer["status"] in TERMINAL, answer["status"]
    return answer


def ask(client: Any, conversation_id: str, question: str, worker: Any = None) -> dict[str, Any]:
    return finish(client, post(client, conversation_id, question), worker)


def ask_new(client: Any, ws: str, question: str = QUESTION, **body: Any) -> dict[str, Any]:
    return ask(client, new_conv(client, ws, **body)["id"], question)


def serialized(request: Any) -> str:
    """The fake's recorded provider request as one string (dataclass, pydantic or plain)."""
    if dataclasses.is_dataclass(request) and not isinstance(request, type):
        value: Any = dataclasses.asdict(request)
    elif hasattr(request, "model_dump"):
        value = request.model_dump()
    else:
        value = request
    return json.dumps(value, ensure_ascii=False, default=str)


def last_request(fake_llm: Any, worker: Any) -> str:
    calls = fake_llm(worker).calls
    assert calls, "the fake answerer was not called"
    return serialized(calls[-1][1])


def keys_in(value: Any) -> set[str]:
    if isinstance(value, list):
        return set().union(*(keys_in(v) for v in value)) if value else set()
    if isinstance(value, dict):
        return set(value) | set().union(*(keys_in(v) for v in value.values()))
    return set()


def sse(
    client: Any,
    message_id: str,
    last_event_id: str | None = None,
    cookie: str | None = None,
    jwt: bool = True,
) -> tuple[int, list[tuple[str, str | None, str]]]:
    """Reads the SSE stream to its end; returns the status and (event, id, data) triples."""
    headers = {"Accept": "text/event-stream"}
    if jwt:
        headers["Authorization"] = f"Bearer {client.user.token}"
    if last_event_id:
        headers["Last-Event-ID"] = last_event_id
    if cookie:
        headers["Cookie"] = cookie
    with client._http.stream(
        "GET", f"{API}/ask/messages/{message_id}/stream", headers=headers
    ) as res:
        if res.status_code != 200:
            return res.status_code, []
        text = "".join(res.iter_text())
    events = []
    for chunk in text.replace("\r\n", "\n").split("\n\n"):
        event, ident, data = "message", None, []
        for line in chunk.split("\n"):
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("id:"):
                ident = line[3:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())
        if data or event != "message":
            events.append((event, ident, "\n".join(data)))
    return 200, events


def via(app: Any, client: Any, method: str, path: str, body: Any = None) -> httpx.Response:
    """`client`'s user calling another in-process app (off_app / limits_app)."""
    res: httpx.Response = app.request(
        method, f"{API}{path}", json=body, headers={"Authorization": f"Bearer {client.user.token}"}
    )
    return res


def problem_type(res: httpx.Response) -> str:
    try:
        return str(res.json().get("type", ""))
    except ValueError:
        return ""


def fresh_session(client: Any, question_id: str) -> dict[str, Any]:
    out: dict[str, Any] = client.ok(
        "POST", f"/questions/{question_id}/practice-sessions", {}, (201,)
    )
    return out


def practice_attachment(
    q: dict[str, Any], session: dict[str, Any], selected: list[str]
) -> dict[str, Any]:
    return {
        "kind": "question",
        "view": "practice",
        "question_id": q["id"],
        "practice_session_id": session["id"],
        "selected_option_ids": selected,
    }


# ---------------------------------------------------------------------------------------------
# C01 authorization matrix
# ---------------------------------------------------------------------------------------------


def test_ask_01_c01_members_create_only_the_owner_reaches_a_conversation_and_shares_reach_nothing(
    seed: Any,
) -> None:
    owner, editor, viewer, outsider = (seed.client(n) for n in ("owner", "editor", "viewer", "out"))
    s = AskSeed(owner)
    seed.membership(s.ws, editor.user, "editor")
    seed.membership(s.ws, viewer.user, "viewer")

    for member in (owner, editor, viewer):
        state = member.send("GET", f"/workspaces/{s.ws}/ask")
        assert not _missing(state), "GET /workspaces/{id}/ask not implemented (404)"
        assert state.status_code == 200
        assert state.json()["available"] is True
        assert member.send("GET", f"/workspaces/{s.ws}/ask/conversations").status_code == 200
    unknown = outsider.send("GET", f"/workspaces/{s.ws}/ask")
    missing = outsider.send("GET", f"/workspaces/{RANDOM_ID}/ask")
    assert unknown.status_code == missing.status_code == 404
    assert seed.stable(unknown) == seed.stable(missing)
    conv(outsider, s.ws, expected=404)

    mine = new_conv(viewer, s.ws)
    answer = ask(viewer, mine["id"], QUESTION)
    paths = [
        ("GET", f"/ask/conversations/{mine['id']}", None),
        ("POST", f"/ask/conversations/{mine['id']}/messages", {"question": QUESTION}),
        ("GET", f"/ask/messages/{answer['id']}", None),
        ("GET", f"/ask/messages/{answer['id']}/stream", None),
        ("POST", f"/ask/messages/{answer['id']}/cancel", {}),
        ("POST", f"/ask/messages/{answer['id']}/retry", {}),
        ("POST", f"/ask/messages/{answer['id']}/regenerate", {}),
        ("PUT", f"/ask/messages/{answer['id']}/feedback", {"reason": "other"}),
        ("DELETE", f"/ask/conversations/{mine['id']}/attachment", None),
        ("DELETE", f"/ask/conversations/{mine['id']}", None),
    ]
    for other in (owner, editor, outsider):  # the workspace Owner too
        for method, path, body in paths:
            res = other.send(method, path, body)
            assert res.status_code == 404, f"{other.user.email[:12]} {method} {seed.route_of(path)}"
    listed = owner.ok("GET", f"/workspaces/{s.ws}/ask/conversations")["items"]
    assert mine["id"] not in [c["id"] for c in listed]

    # A share session reaches no ask API (401), with or without ids.
    link = owner.create_link(s.ws)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    for method, path, body in [("GET", f"/workspaces/{s.ws}/ask", None), *paths]:
        res = guest.send(method, path, body, cookie=cookie)
        assert res.status_code == 401, f"share session {method} {seed.route_of(path)}"

    # Archived: read, delete and stop yes; create, ask and retry no. Deleted: 404.
    keep = new_conv(owner, s.ws)
    ask(owner, keep["id"], QUESTION)
    owner.ok("POST", f"/workspaces/{s.ws}/archive", None)
    assert owner.send("GET", f"/ask/conversations/{keep['id']}").status_code == 200
    seed.problem(conv(owner, s.ws, expected=403), 403, seed.ARCHIVED)
    seed.problem(post(owner, keep["id"], QUESTION), 403, seed.ARCHIVED)
    last = owner.ok("GET", f"/ask/conversations/{keep['id']}")["messages"][-1]
    seed.problem(owner.send("POST", f"/ask/messages/{last['id']}/retry", {}), 403, seed.ARCHIVED)
    assert owner.send("POST", f"/ask/messages/{last['id']}/cancel", {}).status_code == 200
    assert owner.send("DELETE", f"/ask/conversations/{keep['id']}").status_code == 204
    owner.ok("POST", f"/workspaces/{s.ws}/restore", None)
    gone = new_conv(owner, s.ws)
    owner.ok("DELETE", f"/workspaces/{s.ws}", None, (200, 202, 204))
    assert owner.send("GET", f"/ask/conversations/{gone['id']}").status_code == 404
    assert post(owner, gone["id"], QUESTION).status_code == 404


def test_ask_01_c01_attachments_are_checked_against_this_workspace_and_the_callers_session(
    seed: Any,
) -> None:
    owner, viewer, other = seed.client("owner"), seed.client("viewer"), seed.client("other")
    s = AskSeed(owner)
    seed.membership(s.ws, viewer.user, "viewer")
    q = s.mcq("c01-att")
    draft = s.mcq("c01-draft", status="DRAFT")
    foreign_ws = other.create_workspace()["id"]
    foreign_q = AskSeed(other, foreign_ws).mcq("c01-foreign")

    # detail = GET /questions/{id} rights: confirmed and draft questions of this workspace.
    for question in (q, draft):
        made = new_conv(
            viewer,
            s.ws,
            attachment={"kind": "question", "view": "detail", "question_id": question["id"]},
        )
        assert made["attachment"]["disclosure"] == "full"
        assert made["attachment"]["available"] is True
    conv(
        viewer,
        s.ws,
        expected=404,
        attachment={"kind": "question", "view": "detail", "question_id": foreign_q["id"]},
    )
    conv(
        viewer,
        s.ws,
        expected=404,
        attachment={"kind": "question", "view": "detail", "question_id": RANDOM_ID},
    )
    # practice = the caller's own session of that question.
    owner_session = fresh_session(owner, q["id"])
    conv(viewer, s.ws, expected=404, attachment=practice_attachment(q, owner_session, []))
    mine = fresh_session(viewer, q["id"])
    other_q = s.mcq("c01-other")
    conv(viewer, s.ws, expected=404, attachment=practice_attachment(other_q, mine, []))
    made = new_conv(viewer, s.ws, attachment=practice_attachment(q, mine, ["opt-1"]))
    assert made["attachment"]["disclosure"] == "hint"
    assert not keys_in(made) & ANSWER_KEYS


# ---------------------------------------------------------------------------------------------
# C02 retrieval scope
# ---------------------------------------------------------------------------------------------


def test_ask_01_c02_evidence_is_live_published_books_only_pinned_without_text(
    seed: Any, db: Any
) -> None:
    owner = seed.client("owner")
    s = AskSeed(owner)
    paper, mixed = s.paper(), s.mixed()

    found = ask_new(owner, s.ws)
    assert found["status"] == "succeeded"
    assert found["sources"]
    assert found["sources"][0]["document_id"] == s.book
    assert found["sources"][0]["revision_id"] == s.book_revision
    for word in (PAPER_PASSAGE, MIXED_PASSAGE, NOWHERE):
        answer = ask_new(owner, s.ws, f"{word}을 설명해 줘")
        cited = {x["document_id"] for x in answer["sources"] + answer.get("searched_sources", [])}
        assert paper not in cited, word
        if word != NOWHERE:
            # the mixed document may be evidence elsewhere, never through its question part
            assert answer["status"] == "no_sources", (word, answer["status"])
        else:
            assert answer["status"] == "no_sources"
    # A scope naming the paper or another workspace's ids only narrows: no hits, not a 404.
    other = seed.client("other")
    foreign = AskSeed(other)
    scoped = ask_new(
        owner,
        s.ws,
        PAPER_PASSAGE,
        scope={"document_ids": [paper, foreign.book], "chapter_ids": [foreign.ch1]},
    )
    assert scoped["status"] == "no_sources"
    assert scoped["sources"] == []
    chapter2 = ask_new(owner, s.ws, QUESTION, scope={"document_ids": [], "chapter_ids": [s.ch2]})
    assert chapter2["status"] == "no_sources"
    assert mixed  # seeded

    # Pinned references: ids, pages, chunk ids and scores; no copied passage text.
    columns = {
        r[0]
        for r in db(
            "select column_name from information_schema.columns "
            "where table_schema = 'public' and table_name = 'ask_message_sources'"
        )
    }
    for needed in ("message_id", "document_id", "revision_id", "block_ids", "chunk_id", "score"):
        assert any(needed in c for c in columns), f"ask_message_sources.{needed}"
    assert not columns & {"text", "excerpt", "quote", "body", "content"}
    rows = db(
        "select row_to_json(s)::text from public.ask_message_sources s where message_id = %s",
        (found["id"],),
    )
    assert rows
    assert all(BOOK_PASSAGE not in r[0] for r in rows)


def test_ask_01_c02_a_publish_while_answering_ends_in_sources_unavailable(
    seed: Any, ask_env: Any
) -> None:
    owner = seed.client("owner")
    s = AskSeed(owner)
    c = new_conv(owner, s.ws)
    token = uuid.uuid4().hex[:12]
    sent = post(owner, c["id"], f"{HOLD}-{token} {QUESTION}")
    assert sent.status_code == 202
    job_id = str(sent.json()["job_id"])
    runner = threading.Thread(target=owner.worker.drain, args=(job_id,), daemon=True)
    runner.start()
    held = ask_env["hold"] / f"{token}.held"
    deadline = time.monotonic() + 60
    while not held.exists() and time.monotonic() < deadline:
        time.sleep(0.1)
    assert held.exists(), "the fake did not reach the hold barrier"
    edit_block(owner, s.book, 4, "염소와 같은 소독제", "{text} 새 발행본")
    publish(owner, s.book)
    (ask_env["hold"] / f"{token}.release").write_text("")
    runner.join(120)
    answer = message(owner, str(sent.json()["answer"]["id"]))
    assert (answer["status"], answer["error_code"]) == ("failed", "sources_unavailable")


# ---------------------------------------------------------------------------------------------
# C03 no answer before submission
# ---------------------------------------------------------------------------------------------


def test_ask_01_c03_the_hint_dto_has_no_answer_identifying_field() -> None:
    core_ask = importlib.import_module("book_core.ask")  # ASK-B

    hint = core_ask.HintQuestionContext
    fields = (
        {f.name for f in dataclasses.fields(hint)}
        if dataclasses.is_dataclass(hint)
        else set(getattr(hint, "model_fields", {}))
    )
    assert fields, "HintQuestionContext declares its fields"
    assert not fields & set(ANSWER_FIELDS), fields & set(ANSWER_FIELDS)
    option = core_ask.HintOption
    option_fields = (
        {f.name for f in dataclasses.fields(option)}
        if dataclasses.is_dataclass(option)
        else set(getattr(option, "model_fields", {}))
    )
    assert option_fields <= {"number", "label", "text", "option_id", "selected"}, option_fields


def test_ask_01_c03_hint_requests_never_carry_answer_content_for_random_questions_and_choices(
    seed: Any, fake: Any
) -> None:
    owner, viewer = seed.client("owner"), seed.client("viewer")
    s = AskSeed(owner)
    seed.membership(s.ws, viewer.user, "viewer")
    rng = random.Random(20261102)  # noqa: S311 - a seeded test order, not a secret
    for case in range(6):
        texts = [f"c03-{case} 보기 {x}" for x in "가나다라"]
        correct = rng.randrange(4)
        texts[correct] = f"{CORRECT}-{case}"
        q = s.mcq(f"c03-{case}", correct=correct, texts=texts)
        session = fresh_session(viewer, q["id"])
        shown = [o["id"] for o in session["options"]]
        # Sometimes the user's current choice is the correct option itself.
        chosen = q["revision"]["correct_option_ids"] if case % 2 == 0 else [rng.choice(shown)]
        c = new_conv(
            viewer, s.ws, attachment=practice_attachment(q, session, chosen), disclosure="full"
        )
        answer = ask(viewer, c["id"], f"{PROBE} 설명")
        assert answer["disclosure"] == "hint"
        request = last_request(fake, viewer.worker)
        assert EXPLANATION not in request, case
        for field in ANSWER_FIELDS:
            assert f'"{field}"' not in request, (case, field)
        assert f"{CORRECT}-{case}" in request  # the correct option's text is an ordinary option
        # display order = the session's order, no mark next to the correct one
        positions = [
            request.find(next(o["text"] for o in session["options"] if o["id"] == i)) for i in shown
        ]
        assert positions == sorted(positions), case
    for kind in ("SHORT_ANSWER", "ESSAY"):
        q = s.written(f"c03-{kind}", kind)
        session = fresh_session(viewer, q["id"])
        c = new_conv(viewer, s.ws, attachment=practice_attachment(q, session, []))
        ask(viewer, c["id"], f"{PROBE} 설명")
        request = last_request(fake, viewer.worker)
        for secret in (EXPLANATION, RUBRIC, MODEL_ANSWER, ACCEPTED):
            assert secret not in request, (kind, secret)


def test_ask_01_c03_disclosure_is_computed_per_message_and_never_returned(
    seed: Any, fake: Any, db: Any
) -> None:
    owner, viewer = seed.client("owner"), seed.client("viewer")
    s = AskSeed(owner)
    seed.membership(s.ws, viewer.user, "viewer")
    q = s.mcq("c03-flip")
    session = fresh_session(viewer, q["id"])
    practice_keys = set(session)
    c = new_conv(viewer, s.ws, attachment=practice_attachment(q, session, ["opt-1"]))
    sent = post(viewer, c["id"], f"{PROBE} 설명")
    hint = finish(viewer, sent)
    assert hint["disclosure"] == "hint"
    status, events = sse(viewer, hint["id"])
    assert status == 200
    for text in (sent.text, json.dumps(hint, ensure_ascii=False), *(e[2] for e in events)):
        assert EXPLANATION not in text
    assert not keys_in(sent.json()) & ANSWER_KEYS
    submitted = viewer.ok(
        "POST", f"/practice-sessions/{session['id']}/submit", {"selected_option_ids": ["opt-1"]}
    )
    full = ask(viewer, c["id"], f"{PROBE} 다시")
    assert full["disclosure"] == "full"
    request = last_request(fake, viewer.worker)
    assert EXPLANATION in request
    assert CORRECT in request
    # The responses never echo the context the server put in the request.
    convo = viewer.ok("GET", f"/ask/conversations/{c['id']}")
    assert "context" not in keys_in(convo)
    assert "prompt" not in keys_in(convo)
    rows = db(
        "select disclosure from public.ask_messages where conversation_id = %s "
        "and role = 'assistant' order by created_at",
        (c["id"],),
    )
    assert [r[0] for r in rows] == ["hint", "full"]
    # The practice API is unchanged by the feature.
    assert set(fresh_session(viewer, q["id"])) == practice_keys
    assert not {k for k in submitted if "ask" in k or "disclosure" in k}


# ---------------------------------------------------------------------------------------------
# C04 citations
# ---------------------------------------------------------------------------------------------


def test_ask_01_c04_unknown_tags_are_dropped_renumbered_and_counted(seed: Any, db: Any) -> None:
    owner = seed.client("owner")
    s = AskSeed(owner)
    bad = ask_new(owner, s.ws, f"{BADCITE} {QUESTION}")
    assert "S9" not in bad["text"]
    assert "[9]" not in bad["text"]
    assert [x["number"] for x in bad["sources"]] == [1]
    [[dropped, cited]] = db(
        "select m.dropped_citations, (select count(*) from public.ask_message_sources s "
        "where s.message_id = m.id and s.cited) from public.ask_messages m where m.id = %s",
        (bad["id"],),
    )
    assert (dropped, cited) == (1, 1)
    none = ask_new(owner, s.ws, f"{NOANSWER} {QUESTION}")
    assert none["status"] == "no_sources"
    assert "[NO_ANSWER]" not in none["text"]
    assert none["searched_sources"]
    uncited = ask_new(owner, s.ws, f"{UNCITED} {QUESTION}")
    assert uncited["status"] == "succeeded"
    assert uncited["uncited"] is True


# ---------------------------------------------------------------------------------------------
# C05 streaming
# ---------------------------------------------------------------------------------------------


def test_ask_01_c05_sse_resumes_without_gaps_and_finished_messages_answer_from_postgres(
    seed: Any,
) -> None:
    import redis

    owner = seed.client("owner")
    s = AskSeed(owner)
    c = new_conv(owner, s.ws)
    sent = post(owner, c["id"], f"{SLOW} {QUESTION}")
    assert sent.status_code == 202
    answer_id = str(sent.json()["answer"]["id"])
    assert "token" not in str(sent.json()["stream_url"]).lower()
    runner = threading.Thread(
        target=owner.worker.drain, args=(str(sent.json()["job_id"]),), daemon=True
    )
    runner.start()
    # Polling while streaming returns the text so far.
    deadline = time.monotonic() + 60
    partial = message(owner, answer_id)
    while not partial["text"] and time.monotonic() < deadline:
        time.sleep(0.2)
        partial = message(owner, answer_id)
    assert partial["status"] == "streaming"
    assert partial["text"]
    url = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")
    ttl = redis.Redis.from_url(url).ttl(f"ask:msg:{answer_id}")
    assert 0 < ttl <= 600
    runner.join(120)
    status, events = sse(owner, answer_id)
    assert status == 200
    assert [e[0] for e in events] == ["done"], "finished: one done from Postgres"

    # A second slow answer: read part of it, resume with Last-Event-ID, no gap and no duplicate.
    sent = post(owner, c["id"], f"{SLOW} 다시 {QUESTION}")
    answer_id = str(sent.json()["answer"]["id"])
    runner = threading.Thread(
        target=owner.worker.drain, args=(str(sent.json()["job_id"]),), daemon=True
    )
    runner.start()
    seqs: list[int] = []
    headers = {"Authorization": f"Bearer {owner.user.token}", "Accept": "text/event-stream"}
    with owner._http.stream(
        "GET", f"{API}/ask/messages/{answer_id}/stream", headers=headers
    ) as res:
        for line in res.iter_lines():
            if line.startswith("data:") and '"seq"' in line:
                seqs.append(int(json.loads(line[5:])["seq"]))
            if len(seqs) >= 3:
                break
    status, rest = sse(owner, answer_id, last_event_id=str(seqs[-1]))
    seqs += [int(json.loads(e[2])["seq"]) for e in rest if e[0] == "delta"]
    assert seqs == list(range(seqs[0], seqs[0] + len(seqs))), "contiguous, no duplicate"
    assert rest[-1][0] == "done"
    runner.join(120)


def test_ask_01_c05_cancel_is_idempotent_and_a_deleted_conversation_ends_the_stream(
    seed: Any, ask_env: Any
) -> None:
    owner = seed.client("owner")
    s = AskSeed(owner)
    c = new_conv(owner, s.ws)
    sent = post(owner, c["id"], f"{SLOW} {QUESTION}")
    answer_id = str(sent.json()["answer"]["id"])
    first = owner.send("POST", f"/ask/messages/{answer_id}/cancel", {})
    second = owner.send("POST", f"/ask/messages/{answer_id}/cancel", {})
    assert first.status_code == second.status_code == 200
    assert first.json()["status"] == second.json()["status"] == "stopped"
    owner.worker.drain(str(sent.json()["job_id"]))
    assert message(owner, answer_id)["status"] == "stopped"

    token = uuid.uuid4().hex[:12]
    held = post(owner, c["id"], f"{HOLD}-{token} {QUESTION}")
    held_id = str(held.json()["answer"]["id"])
    runner = threading.Thread(
        target=owner.worker.drain, args=(str(held.json()["job_id"]),), daemon=True
    )
    runner.start()
    result: dict[str, Any] = {}
    reader = threading.Thread(
        target=lambda: result.update(zip(("status", "events"), sse(owner, held_id), strict=False)),
        daemon=True,
    )
    reader.start()
    time.sleep(1)
    assert owner.send("DELETE", f"/ask/conversations/{c['id']}").status_code == 204
    reader.join(30)
    (ask_env["hold"] / f"{token}.release").write_text("")
    runner.join(60)
    events = result.get("events") or []
    assert events
    assert events[-1][0] == "error"
    assert json.loads(events[-1][2])["code"] == "not_found"


# ---------------------------------------------------------------------------------------------
# C06 limits and usage
# ---------------------------------------------------------------------------------------------


def test_ask_01_c06_limits_idempotency_and_usage(seed: Any, limits_app: Any, db: Any) -> None:
    owner = seed.client("owner")
    s = AskSeed(owner)
    c = via(limits_app, owner, "POST", f"/workspaces/{s.ws}/ask/conversations", {})
    assert not _missing(c), "POST /workspaces/{id}/ask/conversations not implemented (404)"
    cid = c.json()["id"]
    long = via(
        limits_app, owner, "POST", f"/ask/conversations/{cid}/messages", {"question": "가" * 51}
    )
    assert (long.status_code, problem_type(long)) == (422, P + "question-too-long")

    key = str(uuid.uuid4())
    sent = limits_app.request(
        "POST",
        f"{API}/ask/conversations/{cid}/messages",
        json={"question": QUESTION},
        headers={"Authorization": f"Bearer {owner.user.token}", "Idempotency-Key": key},
    )
    assert sent.status_code == 202
    running = via(
        limits_app, owner, "POST", f"/ask/conversations/{cid}/messages", {"question": "두 번째"}
    )
    assert (running.status_code, problem_type(running)) == (409, P + "ask-answer-running")
    again = limits_app.request(
        "POST",
        f"{API}/ask/conversations/{cid}/messages",
        json={"question": QUESTION},
        headers={"Authorization": f"Bearer {owner.user.token}", "Idempotency-Key": key},
    )
    assert again.status_code == 202
    assert again.json()["answer"]["id"] == sent.json()["answer"]["id"]
    finish(owner, sent)
    second = finish(
        owner,
        via(
            limits_app, owner, "POST", f"/ask/conversations/{cid}/messages", {"question": "두 번째"}
        ),
    )
    turn = via(
        limits_app, owner, "POST", f"/ask/conversations/{cid}/messages", {"question": "세 번째"}
    )
    assert (turn.status_code, problem_type(turn)) == (409, P + "ask-turn-limit")
    # Regenerate: last answer only, versions ≤ 2, counted like a question (3 per minute).
    first_answer = sent.json()["answer"]["id"]
    not_last = via(limits_app, owner, "POST", f"/ask/messages/{first_answer}/regenerate", {})
    assert (not_last.status_code, problem_type(not_last)) == (409, P + "ask-not-last-answer")
    regenerated = finish(
        owner, via(limits_app, owner, "POST", f"/ask/messages/{second['id']}/regenerate", {})
    )
    assert regenerated["regenerated_from_message_id"] == second["id"]
    limited = via(limits_app, owner, "POST", f"/ask/messages/{regenerated['id']}/regenerate", {})
    assert limited.status_code in {409, 429}
    other = via(limits_app, owner, "POST", f"/workspaces/{s.ws}/ask/conversations", {}).json()["id"]
    rate = via(
        limits_app, owner, "POST", f"/ask/conversations/{other}/messages", {"question": QUESTION}
    )
    assert rate.status_code == 429
    assert int(rate.headers["Retry-After"]) > 0

    # Usage: one row per LLM-called answer, no content.
    rows = db(
        "select feature, model, input_tokens, output_tokens, status, row_to_json(u)::text "
        "from public.llm_feature_usage u where user_id = %s and workspace_id = %s",
        (owner.user.id, s.ws),
    )
    assert len(rows) == 3
    assert {r[0] for r in rows} == {"ask"}
    assert all(r[2] > 0 and QUESTION not in r[5] for r in rows)


def test_ask_01_c06_requests_respect_top_k_context_and_output_caps(
    seed: Any, limits_app: Any, fake: Any, worker_with: Any, ask_env: Any
) -> None:
    owner = seed.client("owner")
    s = AskSeed(owner)
    worker = worker_with(ASK_MAX_OUTPUT_TOKENS="300", ASK_LLM_EFFORT="low")
    cid = new_conv(owner, s.ws)["id"]
    sent = via(
        limits_app, owner, "POST", f"/ask/conversations/{cid}/messages", {"question": "물의 순환"}
    )
    answer = finish(owner, sent, worker)
    [record] = [
        json.loads(line)
        for line in (ask_env["log"] / f"ask-{answer['id']}.jsonl").read_text().splitlines()
    ]
    assert len(record["source_tags"]) <= 2
    assert record["context_chars"] <= 600
    assert (record["max_output_tokens"], record["effort"]) == (300, "low")
    assert fake(worker).calls


def test_ask_01_c06_daily_and_monthly_limits(seed: Any, app_with: Any) -> None:
    owner, daily = seed.client("owner"), seed.client("daily")
    s = AskSeed(owner)
    seed.membership(s.ws, daily.user, "editor")
    # Daily limit 2 per user (Asia/Seoul day, counted in the DB, whichever app took them).
    for _ in range(2):
        ask_new(daily, s.ws)
    daily_app = app_with(ASK_DAILY_LIMIT_PER_USER="2")
    cid = new_conv(daily, s.ws)["id"]
    refused = via(
        daily_app, daily, "POST", f"/ask/conversations/{cid}/messages", {"question": QUESTION}
    )
    assert (refused.status_code, problem_type(refused)) == (429, P + "ask-daily-limit")
    assert (
        via(
            daily_app,
            owner,
            "POST",
            f"/ask/conversations/{new_conv(owner, s.ws)['id']}/messages",
            {"question": QUESTION},
        ).status_code
        == 202
    ), "another user is not limited by the first one's day"
    # Monthly token cap 1 over the whole environment: the answers above already exceed it.
    budget_app = app_with(ASK_MONTHLY_TOKEN_CAP="1")  # noqa: S106 - a token budget, not a secret
    cid = new_conv(owner, s.ws)["id"]
    capped = via(
        budget_app, owner, "POST", f"/ask/conversations/{cid}/messages", {"question": QUESTION}
    )
    assert (capped.status_code, problem_type(capped)) == (409, P + "ask-budget-exceeded")
    # 0 = off: the module's app (default cap 0) still answers.
    assert ask_new(owner, s.ws)["status"] == "succeeded"


# ---------------------------------------------------------------------------------------------
# C07 no leaks
# ---------------------------------------------------------------------------------------------


def test_ask_01_c07_no_question_answer_passage_or_prompt_in_logs_job_results_or_activities(
    seed: Any, caplog: pytest.LogCaptureFixture
) -> None:
    owner, viewer = seed.client("owner"), seed.client("viewer")
    s = AskSeed(owner)
    seed.membership(s.ws, viewer.user, "viewer")
    q = s.mcq("c07")
    question = f"c07 고유 질문 {uuid.uuid4().hex[:6]} {QUESTION}"
    with caplog.at_level(logging.DEBUG):
        c = new_conv(
            owner, s.ws, attachment={"kind": "question", "view": "detail", "question_id": q["id"]}
        )
        sent = post(owner, c["id"], question)
        answer = finish(owner, sent)
        failed = ask(owner, c["id"], f"{FAIL} {QUESTION}")
    logs = "\n".join(
        r.getMessage()
        + " "
        + json.dumps(getattr(r, "__dict__", {}), default=str, ensure_ascii=False)
        for r in caplog.records
    )
    for secret in (
        question,
        BOOK_PASSAGE,
        EXPLANATION,
        CORRECT,
        answer["text"][:30],
        owner.user.token,
    ):
        assert secret not in logs
    assert failed["error_code"] == "llm_unavailable"
    assert failed["text"] in ("", None)
    job = owner.ok("GET", f"/jobs/{sent.json()['job_id']}")
    assert keys_in(job.get("result") or {}) <= {
        "sources",
        "dropped_citations",
        "usage",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "error_code",
        "status",
        "llm_calls",
        "cost_usd",
    }
    assert question not in json.dumps(job, ensure_ascii=False)
    assert viewer.send("GET", f"/jobs/{sent.json()['job_id']}").status_code == 404
    jobs = owner.ok("GET", f"/workspaces/{s.ws}/jobs?limit=100")["items"]
    assert JOB_TYPE not in {j["job_type"] for j in jobs}
    activities = owner.ok("GET", f"/workspaces/{s.ws}/activities?limit=100")["items"]
    assert not [a for a in activities if "ask" in a["event_type"]]


# ---------------------------------------------------------------------------------------------
# C08 retention and privacy
# ---------------------------------------------------------------------------------------------


def test_ask_01_c08_delete_purge_fork_and_append_only(seed: Any, db: Any, job_worker: Any) -> None:
    import psycopg

    owner = seed.client("owner")
    s = AskSeed(owner)
    c = new_conv(owner, s.ws)
    answer = ask(owner, c["id"], QUESTION)
    owner.ok("PUT", f"/ask/messages/{answer['id']}/feedback", {"reason": "made_up"})
    with pytest.raises(psycopg.Error):  # finished messages are append-only
        db("update public.ask_messages set text = 'changed' where id = %s", (answer["id"],))
    assert owner.send("DELETE", f"/ask/conversations/{c['id']}").status_code == 204
    for table in ("ask_messages", "ask_message_feedback"):
        column = "id" if table == "ask_messages" else "message_id"
        assert (
            db(f"select count(*) from public.{table} where {column} = %s", (answer["id"],))[0][0]  # noqa: S608
            == 0
        )
    assert (
        db(
            "select count(*) from public.ask_message_sources where message_id = %s", (answer["id"],)
        )[0][0]
        == 0
    )
    [[kept]] = db(
        "select count(*) from public.llm_feature_usage where user_id = %s and message_id is null",
        (owner.user.id,),
    )
    assert kept >= 1

    old, recent = new_conv(owner, s.ws), new_conv(owner, s.ws)
    ask(owner, old["id"], QUESTION)
    ask(owner, recent["id"], QUESTION)
    db(
        "update public.ask_conversations set last_message_at = now() - interval '91 days' "
        "where id = %s",
        (old["id"],),
    )
    db(
        "insert into public.llm_feature_usage (feature, user_id, workspace_id, model, "
        "input_tokens, output_tokens, status, created_at) "
        "values ('ask', %s, %s, 'fake', 1, 1, 'succeeded', "
        "now() - interval '14 months')",
        (owner.user.id, s.ws),
    )
    job_worker.ask_deps.purge(now=datetime.now(UTC))
    job_worker.ask_deps.purge(now=datetime.now(UTC))  # idempotent
    assert owner.send("GET", f"/ask/conversations/{old['id']}").status_code == 404
    assert owner.send("GET", f"/ask/conversations/{recent['id']}").status_code == 200
    assert (
        db(
            "select count(*) from public.llm_feature_usage where user_id = %s "
            "and created_at < now() - interval '13 months'",
            (owner.user.id,),
        )[0][0]
        == 0
    )

    # A fork copies no conversation or usage; deleting the workspace removes its conversations.
    recipient = seed.client("recipient")
    link = owner.create_link(s.ws, allow_fork=True)
    cookie = seed.guest().session(link["id"], link["secret"])
    fork = recipient.fork(link["id"], cookie, "c08 fork")
    assert fork.status_code == 202
    done = recipient.wait_fork(fork.json()["id"], "COMPLETED")
    target = done["target_workspace_id"]
    assert (
        db("select count(*) from public.ask_conversations where workspace_id = %s", (target,))[0][0]
        == 0
    )
    owner.ok("DELETE", f"/workspaces/{s.ws}", None, (200, 202, 204))
    assert (
        db("select count(*) from public.ask_conversations where workspace_id = %s", (s.ws,))[0][0]
        == 0
    )


# ---------------------------------------------------------------------------------------------
# C09 worker re-checks and idempotency
# ---------------------------------------------------------------------------------------------


def test_ask_01_c09_the_worker_rechecks_runs_once_and_retries_only_before_the_first_delta(
    seed: Any, fake: Any, worker_with: Any, db: Any
) -> None:
    owner, editor = seed.client("owner"), seed.client("editor")
    s = AskSeed(owner)
    seed.membership(s.ws, editor.user, "editor")
    c = new_conv(owner, s.ws)
    sent = post(owner, c["id"], QUESTION)
    job_id = str(sent.json()["job_id"])
    before = len(fake(owner.worker).calls)
    owner.worker.drain(job_id)
    owner.worker.run_once(job_id)  # a redelivery of a finished job calls nothing
    assert len(fake(owner.worker).calls) == before + 1

    stopped = post(owner, c["id"], "중지될 질문")
    owner.send("POST", f"/ask/messages/{stopped.json()['answer']['id']}/cancel", {})
    n = len(fake(owner.worker).calls)
    owner.worker.drain(str(stopped.json()["job_id"]))
    assert len(fake(owner.worker).calls) == n

    ec = new_conv(editor, s.ws)
    gone = post(editor, ec["id"], QUESTION)
    db(
        "delete from public.workspace_memberships where workspace_id = %s and user_id = %s",
        (s.ws, editor.user.id),
    )
    owner.worker.drain(str(gone.json()["job_id"]))
    [[status, code]] = db(
        "select status, error_code from public.ask_messages where id = %s",
        (gone.json()["answer"]["id"],),
    )
    assert (status, code) == ("failed", "workspace_unavailable")

    retrying = worker_with(LLM_MAX_RETRIES="2")
    fail = post(owner, c["id"], f"{FAIL} {QUESTION}")
    before = len(fake(retrying).calls)
    retrying.drain(str(fail.json()["job_id"]))
    assert len(fake(retrying).calls) - before == 3, "first try + LLM_MAX_RETRIES before any delta"
    [[usage_rows]] = db(
        "select count(*) from public.llm_feature_usage where message_id = %s",
        (fail.json()["answer"]["id"],),
    )
    assert usage_rows >= 1
    [[queue]] = db("select queue from public.jobs where id = %s", (job_id,))
    assert queue == "interactive"


# ---------------------------------------------------------------------------------------------
# C10 mock exam question attachments
# ---------------------------------------------------------------------------------------------


def _mock_exam(
    owner: Any, s: AskSeed, other_source_doc: str | None = None
) -> tuple[str, list[dict[str, Any]]]:
    ids = []
    for k in (1, 2):
        texts = [f"보기 가 {k}", f"보기 나 {k}", MOCK_CORRECT, f"보기 라 {k}"]
        options = [{"id": f"opt-{i + 1}", "text": t} for i, t in enumerate(texts)]
        sources = [{"document_id": s.book, "page_start": 2, "page_end": 2}]
        if other_source_doc:
            sources.append({"document_id": other_source_doc, "page_start": 1, "page_end": 1})
        q = owner.ok(
            "POST",
            f"/workspaces/{s.ws}/questions",
            {
                "question_type": "MCQ",
                "stem": f"c10-{k} 수증기가 물방울로 바뀌는 과정은?",
                "options": options,
                "correct_option_ids": ["opt-3"],
                "is_multi_answer": False,
                "explanation": f"{MOCK_EXPLANATION} 응결",
                "chapter_id": s.ch1,
                "question_number": 20 + k,
                "sources": sources,
            },
            (201,),
        )
        ids.append(q["id"])
    exam = owner.ok(
        "POST",
        f"/workspaces/{s.ws}/mock-exams",
        {
            "title": "c10 모의",
            "config": {"variation_types": ["OPTION_SHUFFLE"], "question_count": 2},
            "range": {"question_ids": ids},
        },
        (202,),
    )
    owner.wait_for_job(str(exam["latest_generation"]["job_id"]))
    questions = owner.ok("GET", f"/mock-exams/{exam['id']}/questions?include=answers")["items"]
    return str(exam["id"]), questions


def test_ask_01_c10_mock_exam_attachments_hint_full_manage_and_removal(
    seed: Any, fake: Any
) -> None:
    owner, viewer, other = seed.client("owner"), seed.client("viewer"), seed.client("other")
    s = AskSeed(owner)
    seed.membership(s.ws, viewer.user, "viewer")
    paper = s.paper()
    exam_id, questions = _mock_exam(owner, s, other_source_doc=paper)
    mq = questions[0]
    session = viewer.ok("POST", f"/mock-exam-questions/{mq['id']}/practice-sessions", {}, (201,))
    attachment = {
        "kind": "mock_exam_question",
        "view": "practice",
        "mock_exam_question_id": mq["id"],
        "mock_practice_session_id": session["id"],
        "selected_option_ids": [session["options"][0]["id"]],
    }
    c = new_conv(viewer, s.ws, attachment=attachment)
    assert c["attachment"]["disclosure"] == "hint"
    hint = ask(viewer, c["id"], f"{PROBE} 설명")
    assert hint["disclosure"] == "hint"
    request = last_request(fake, viewer.worker)
    assert MOCK_EXPLANATION not in request
    assert MOCK_CORRECT in request
    assert BOOK_PASSAGE not in request.split('"sources"')[0] or '"evidence"' not in request
    for field in ANSWER_FIELDS:
        assert f'"{field}"' not in request, field

    # Someone else's session: 404; manage needs edit rights (viewer 403).
    other_session = owner.ok(
        "POST", f"/mock-exam-questions/{mq['id']}/practice-sessions", {}, (201,)
    )
    conv(
        viewer,
        s.ws,
        expected=404,
        attachment={**attachment, "mock_practice_session_id": other_session["id"]},
    )
    seed.problem(
        conv(
            viewer,
            s.ws,
            expected=403,
            attachment={
                "kind": "mock_exam_question",
                "view": "manage",
                "mock_exam_question_id": mq["id"],
            },
        ),
        403,
        seed.INSUFFICIENT_ROLE,
    )
    assert other  # a foreign user cannot see the workspace at all (C01)

    # After the attempt: full, with the session's revision and only published book evidence.
    viewer.ok(
        "POST",
        f"/mock-practice-sessions/{session['id']}/submit",
        {"selected_option_ids": [session["options"][0]["id"]]},
    )
    full = ask(viewer, c["id"], f"{PROBE} 다시")
    assert full["disclosure"] == "full"
    request = last_request(fake, viewer.worker)
    assert MOCK_EXPLANATION in request
    assert BOOK_PASSAGE in request
    assert PAPER_PASSAGE not in request, "question-paper evidence is left out"
    managed = new_conv(
        owner,
        s.ws,
        attachment={
            "kind": "mock_exam_question",
            "view": "manage",
            "mock_exam_question_id": mq["id"],
        },
    )
    assert managed["attachment"]["disclosure"] == "full"

    # Removed from the mock exam / mock exam deleted: 404 to attach; old chats lose the context.
    owner.ok("DELETE", f"/mock-exam-questions/{questions[1]['id']}", None, (204,))
    second = owner.ok("POST", f"/mock-exam-questions/{mq['id']}/practice-sessions", {}, (201,))
    conv(
        owner,
        s.ws,
        expected=404,
        attachment={
            "kind": "mock_exam_question",
            "view": "manage",
            "mock_exam_question_id": questions[1]["id"],
        },
    )
    owner.ok("DELETE", f"/mock-exams/{exam_id}", None, (204,))
    conv(
        owner,
        s.ws,
        expected=404,
        attachment={**attachment, "mock_practice_session_id": second["id"]},
    )
    after = viewer.ok("GET", f"/ask/conversations/{c['id']}")
    assert after["attachment"]["available"] is False
    bare = ask(viewer, c["id"], f"{PROBE} 마지막")
    assert "attachment: none" in bare["text"]


# ---------------------------------------------------------------------------------------------
# C11 deterministic fake
# ---------------------------------------------------------------------------------------------


def test_ask_01_c11_the_fake_streams_top_sources_deterministically_and_records_its_calls(
    seed: Any, ask_env: Any, off_app: Any
) -> None:
    owner = seed.client("owner")
    s = AskSeed(owner)
    first = ask_new(owner, s.ws)
    second = ask_new(owner, s.ws)
    assert first["text"] == second["text"], "same question, same evidence, same answer"
    assert "[1]" in first["text"]
    assert BOOK_PASSAGE in first["text"]
    status, _events = sse(owner, first["id"])
    assert status == 200
    [record] = [
        json.loads(x)
        for x in (ask_env["log"] / f"ask-{first['id']}.jsonl").read_text().splitlines()
    ]
    assert record["deltas_sent"] >= 3
    assert record["history_turns"] == 0
    text = json.dumps(record, ensure_ascii=False)
    assert BOOK_PASSAGE not in text, "the record holds no content"
    assert QUESTION not in text, "the record holds no content"
    nothing = ask_new(owner, s.ws, NOWHERE)
    assert not (ask_env["log"] / f"ask-{nothing['id']}.jsonl").exists()
    # Off: the state says unavailable, a question is refused, nothing is recorded.
    state = via(off_app, owner, "GET", f"/workspaces/{s.ws}/ask")
    assert state.status_code == 200
    assert state.json()["available"] is False
    cid = new_conv(owner, s.ws)["id"]
    refused = via(
        off_app, owner, "POST", f"/ask/conversations/{cid}/messages", {"question": QUESTION}
    )
    assert (refused.status_code, problem_type(refused)) == (409, P + "ask-disabled")
