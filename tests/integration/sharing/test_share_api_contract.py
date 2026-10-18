"""S0 RED security contract: owner share-link API and the guest share session.

docs/workspace-sharing.md §1-§5, docs/auth.md (share section), docs/questions.md (shared privacy
rules); request shapes and assumptions S1-S9 in tests/e2e/fixtures/sharing.ts. Each test starts
with a share-link call so a missing feature fails first with "<route> not implemented (404)".
"""

from __future__ import annotations

import base64
import uuid
from typing import Any

import pytest

# S0 RED, GREEN since S1b (share session exchange and shared read API).
pytestmark = pytest.mark.infra

RANDOM_ID = "00000000-0000-4000-8000-000000000000"


def test_ws_share_01_ac02_secret_is_shown_once_and_stored_only_as_digest(seed: Any) -> None:
    owner = seed.client("ac02-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"])

    secret = str(link["secret"])
    assert seed.secret_bytes(secret) >= seed.MIN_SECRET_BYTES, "secret must carry >= 32 bytes"
    assert link["allow_fork"] is False, "Fork is OFF by default"
    assert link["revoked_at"] is None
    share_url = str(link["share_url"])
    assert share_url.endswith(f"/share/{link['id']}#k={secret}"), "secret travels in the fragment"
    assert "?" not in share_url, "no secret or token in the query string"

    # Listing never returns the secret or its digest.
    listed = owner.call("GET", f"/workspaces/{ws['id']}/share-links")
    seed.assert_status(listed, 200, "list links")
    assert (secret in listed.text) is False, "listing must not echo the secret"
    items = listed.json()["items"]
    assert [i["id"] for i in items] == [link["id"]]
    assert not {"secret", "token", "token_digest", "share_url"} & set(items[0])

    # The DB holds a digest only: never the plaintext, nor its raw bytes.
    row, digest = seed.link_row(link["id"])
    assert (secret in row) is False, "plaintext secret stored in workspace_share_links"
    decoded = base64.urlsafe_b64decode(secret + "=" * (-len(secret) % 4))
    assert digest not in {secret.encode(), decoded}, "the raw secret is not a digest"
    assert len(digest) == 32, "SHA-256/HMAC-SHA-256 digest expected"

    # A link is not a membership: the owner stays the only member, also after a guest exchange.
    guest = seed.guest()
    guest.session(link["id"], secret)
    assert seed.memberships(ws["id"]) == [(owner.user.id, "owner")]


def test_ws_share_01_ac03_only_the_owner_manages_links(seed: Any) -> None:
    owner = seed.client("ac03-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"])
    stranger = seed.client("ac03-stranger")
    editor = seed.client("ac03-editor")
    viewer = seed.client("ac03-viewer")
    seed.membership(ws["id"], editor.user, "editor")
    seed.membership(ws["id"], viewer.user, "viewer")

    expires = "2099-01-31T00:00:00Z"
    routes: list[tuple[str, str, Any]] = [
        ("GET", f"/workspaces/{ws['id']}/share-links", None),
        ("POST", f"/workspaces/{ws['id']}/share-links", {}),
        ("PATCH", f"/workspaces/{ws['id']}/share-links/{link['id']}", {"allow_fork": True}),
        ("POST", f"/workspaces/{ws['id']}/share-links/{link['id']}/revoke", {}),
        ("POST", f"/workspaces/{ws['id']}/share-links/{link['id']}/rotate", {}),
    ]
    for method, path, body in routes:
        res = stranger.call(method, path, body)
        seed.assert_status(res, 404, f"stranger {method} {seed.route_of(path)}")
        for member in (editor, viewer):
            res = member.call(method, path, body)
            seed.problem(res, 403, seed.INSUFFICIENT_ROLE)

    # Nothing changed; the owner's own PATCH works and persists.
    assert [(i["id"], i["allow_fork"], i["revoked_at"]) for i in owner.links(ws["id"])] == [
        (link["id"], False, None)
    ]
    res = owner.patch_link(ws["id"], link["id"], allow_fork=True, expires_at=expires)
    seed.assert_status(res, 200, "owner PATCH")
    (item,) = owner.links(ws["id"])
    assert item["allow_fork"] is True
    assert str(item["expires_at"]).startswith("2099-01-31")
    # The policy is what a guest sees.
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    shared = guest.read(link["id"], cookie)
    seed.assert_status(shared, 200, "shared workspace")
    assert shared.json()["allow_fork"] is True


def test_ws_share_01_ac04_revoke_and_rotate_block_existing_sessions_immediately(
    seed: Any,
) -> None:
    owner = seed.client("ac04-owner")
    ws = owner.create_workspace()
    first = owner.create_link(ws["id"])
    guest = seed.guest()
    cookie_first = guest.session(first["id"], first["secret"])
    seed.assert_status(guest.read(first["id"], cookie_first), 200, "before rotate")
    never = guest.exchange(RANDOM_ID, first["secret"])

    rotated = owner.rotate(ws["id"], first["id"])
    seed.assert_status(rotated, 201, "rotate")
    second = rotated.json()
    assert second["id"] != first["id"]
    assert (second["secret"] == first["secret"]) is False
    # The old URL and its live session are dead on the very next request.
    old_read = guest.read(first["id"], cookie_first)
    seed.assert_status(old_read, 404, "old session after rotate")
    old_exchange = guest.exchange(first["id"], first["secret"])
    seed.assert_status(old_exchange, 404, "old secret after rotate")
    assert seed.stable(old_exchange) == seed.stable(never)

    cookie_second = guest.session(second["id"], second["secret"])
    seed.assert_status(guest.read(second["id"], cookie_second), 200, "rotated link works")
    seed.assert_status(owner.revoke(ws["id"], second["id"]), 200, "revoke")
    seed.assert_status(guest.read(second["id"], cookie_second), 404, "session after revoke")
    again = guest.exchange(second["id"], second["secret"])
    seed.assert_status(again, 404, "secret after revoke")
    assert seed.stable(again) == seed.stable(never)
    # Revoke is idempotent and reported in the listing.
    seed.assert_status(owner.revoke(ws["id"], second["id"]), 200, "second revoke")
    assert all(i["revoked_at"] for i in owner.links(ws["id"]))


def test_ws_share_01_ac05_archived_allows_only_revoke_and_policy_and_deleted_blocks_links(
    seed: Any,
) -> None:
    owner = seed.client("ac05-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"])
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    owner.ok("POST", f"/workspaces/{ws['id']}/archive")

    seed.problem(owner.call("POST", f"/workspaces/{ws['id']}/share-links", {}), 403, seed.ARCHIVED)
    seed.problem(owner.rotate(ws["id"], link["id"]), 403, seed.ARCHIVED)
    seed.assert_status(owner.patch_link(ws["id"], link["id"], allow_fork=True), 200, "PATCH")
    # Archived stays readable through the link until the owner revokes it.
    seed.assert_status(guest.read(link["id"], cookie), 200, "archived shared read")
    seed.assert_status(owner.revoke(ws["id"], link["id"]), 200, "revoke on archived")
    seed.assert_status(guest.read(link["id"], cookie), 404, "after revoke")

    deleted = owner.create_workspace()
    gone = owner.create_link(deleted["id"])
    gone_cookie = guest.session(gone["id"], gone["secret"])
    owner.ok("DELETE", f"/workspaces/{deleted['id']}", expected=(200, 202, 204))
    never = guest.exchange(RANDOM_ID, gone["secret"])
    exchange = guest.exchange(gone["id"], gone["secret"])
    seed.assert_status(exchange, 404, "exchange on deleted workspace")
    assert seed.stable(exchange) == seed.stable(never)
    seed.assert_status(guest.read(gone["id"], gone_cookie), 404, "session on deleted workspace")
    seed.assert_status(
        owner.call("GET", f"/workspaces/{deleted['id']}/share-links"), 404, "owner list deleted"
    )


def test_ws_view_01_ac05_unusable_links_share_one_generic_404(seed: Any) -> None:
    owner = seed.client("v-ac05-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"])
    guest = seed.guest()
    never = guest.exchange(RANDOM_ID, link["secret"])
    seed.assert_status(never, 404, "unknown share id")

    wrong = guest.exchange(link["id"], link["secret"][:-4] + "AAAA")
    seed.assert_status(wrong, 404, "wrong secret")
    assert seed.stable(wrong) == seed.stable(never)
    assert seed.share_cookie_of(wrong) is None
    assert (link["secret"] in wrong.text) is False

    # Expiry is re-checked on every request: an existing session dies with the link.
    cookie = guest.session(link["id"], link["secret"])
    seed.assert_status(guest.read(link["id"], cookie), 200, "valid session")
    seed.expire_now(link["id"])
    expired_read = guest.read(link["id"], cookie)
    seed.assert_status(expired_read, 404, "expired session")
    assert seed.stable(expired_read) == seed.stable(never)
    expired = guest.exchange(link["id"], link["secret"])
    seed.assert_status(expired, 404, "expired exchange")
    assert seed.stable(expired) == seed.stable(never)
    assert ws["name"] not in expired_read.text

    # No share cookie at all: 401, not a workspace.
    seed.assert_status(guest.send("GET", f"/shared/{link['id']}"), 401, "no share cookie")


def test_ws_view_01_ac04_share_session_is_scoped_and_never_a_login(seed: Any) -> None:
    owner = seed.client("v-ac04-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"])
    other_ws = owner.create_workspace()
    other_link = owner.create_link(other_ws["id"])
    other_q = owner.create_question(other_ws["id"], "다른 workspace 문제")
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])

    # The share cookie is no substitute for a JWT on the normal API.
    for method, path in [
        ("GET", "/me"),
        ("GET", "/me/workspaces"),
        ("GET", "/workspaces"),
        ("GET", f"/workspaces/{ws['id']}"),
        ("GET", f"/workspaces/{ws['id']}/questions"),
        ("GET", f"/workspaces/{ws['id']}/documents"),
        ("GET", f"/workspaces/{ws['id']}/share-links"),
    ]:
        for c in (None, cookie):
            res = guest.send(method, path, cookie=c)
            assert res.status_code == 401, f"{method} {seed.route_of(path)}: {res.status_code}"

    # Only its own workspace scope: other ids are 404 like missing ones.
    missing = guest.read(link["id"], cookie, f"/questions/{uuid.uuid4()}")
    seed.assert_status(missing, 404, "random question id")
    foreign_q = guest.read(link["id"], cookie, f"/questions/{other_q['id']}")
    seed.assert_status(foreign_q, 404, "question of another workspace")
    assert seed.stable(foreign_q) == seed.stable(missing)
    assert "다른 workspace 문제" not in foreign_q.text
    seed.assert_status(
        guest.read(link["id"], cookie, f"/documents/{uuid.uuid4()}"), 404, "random document id"
    )
    # A session for link A does not open link B (even of the same owner).
    seed.assert_status(guest.read(other_link["id"], cookie), 404, "session of another link")
    listed = guest.read(link["id"], cookie, "/questions")
    seed.assert_status(listed, 200, "own questions")
    assert other_q["id"] not in listed.text


def test_ws_view_01_ac03_share_sessions_cannot_write_or_record_progress(seed: Any) -> None:
    owner = seed.client("v-ac03-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"])
    q = owner.create_question(ws["id"], "공유 쓰기 금지 문제")
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    sid = link["id"]

    # The normal write API rejects a share session as unauthenticated.
    for method, path, body in [
        ("POST", "/workspaces", {"name": "guest"}),
        ("PATCH", f"/workspaces/{ws['id']}", {"name": "guest"}),
        ("DELETE", f"/workspaces/{ws['id']}", None),
        ("POST", f"/workspaces/{ws['id']}/archive", None),
        ("POST", f"/workspaces/{ws['id']}/share-links", {}),
        ("POST", f"/workspaces/{ws['id']}/questions", {"question_type": "ESSAY", "stem": "x"}),
        ("PATCH", f"/questions/{q['id']}", {"stem": "x"}),
        ("POST", f"/workspaces/{ws['id']}/documents/upload-intent", {"filename": "a.pdf"}),
    ]:
        res = guest.send(method, path, body, cookie=cookie, origin=seed.web_origin())
        assert res.status_code == 401, f"{method} {seed.route_of(path)}: {res.status_code}"

    # The shared namespace has no write routes (no attempt, favourite, retry, edit, delete).
    for method, path in [
        ("POST", f"/shared/{sid}/questions/{q['id']}/attempts"),
        ("PUT", f"/shared/{sid}/questions/{q['id']}/favorite"),
        ("POST", f"/shared/{sid}/questions/{q['id']}/retry"),
        ("PATCH", f"/shared/{sid}/questions/{q['id']}"),
        ("DELETE", f"/shared/{sid}/questions/{q['id']}"),
        ("POST", f"/shared/{sid}/questions"),
        ("PATCH", f"/shared/{sid}"),
        ("DELETE", f"/shared/{sid}"),
    ]:
        res = guest.send(method, path, {}, cookie=cookie, origin=seed.web_origin())
        assert res.status_code in {401, 403, 404, 405}, f"{method} {seed.route_of(path)}"

    # Reading a question records nothing for anyone.
    seed.assert_status(guest.read(sid, cookie, f"/questions/{q['id']}"), 200, "read question")
    assert seed.private_counts(ws["id"])["question_user_states"] == 0
    assert seed.private_counts(ws["id"])["question_attempts"] == 0


def test_ws_view_01_ac04_shared_questions_carry_answers_but_no_personal_data(seed: Any) -> None:
    owner = seed.client("v-ac04q-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"])
    q = owner.create_question(ws["id"], "공유 개인정보 문제", answer=2)
    seed.study_state(owner.user.id, ws["id"], q["id"])
    seed.graded_attempt(ws["id"], q["id"], q["revision"]["id"], owner.user.id)
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])

    listed = guest.read(link["id"], cookie, "/questions")
    seed.assert_status(listed, 200, "shared questions")
    one = guest.read(link["id"], cookie, f"/questions/{q['id']}")
    seed.assert_status(one, 200, "shared question")
    for res in (listed, one):
        assert owner.user.id not in res.text
        assert owner.user.email not in res.text
    (item,) = listed.json()["items"]
    detail = one.json()
    for body in (item, detail):
        leaked = set(seed.PERSONAL_KEYS) & set(body)
        assert not leaked, f"personal keys in shared question: {sorted(leaked)}"
    # Published content in full: options, answer and explanation.
    assert detail["revision"]["stem"] == "공유 개인정보 문제"
    assert detail["revision"]["correct_option_ids"] == ["opt-3"]
    assert detail["revision"]["explanation"] == "해설: 공유 개인정보 문제"


def test_ws_view_01_ac04_only_confirmed_questions_are_shared(seed: Any) -> None:
    owner = seed.client("v-ac04u-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"])
    confirmed = owner.create_question(ws["id"], "S0 발행된 공유 문제")
    hidden = seed.unpublished_questions(owner, ws["id"])
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])

    listed = guest.read(link["id"], cookie, "/questions")
    seed.assert_status(listed, 200, "shared questions")
    assert [q["id"] for q in listed.json()["items"]] == [confirmed["id"]]
    missing = guest.read(link["id"], cookie, f"/questions/{uuid.uuid4()}")
    seed.assert_status(missing, 404, "random question id")
    for kind, stem in seed.UNPUBLISHED_STEMS.items():
        assert stem not in listed.text, f"{kind} question listed"
        found = guest.send(
            "POST",
            f"/shared/{link['id']}/search",
            {"query": stem, "mode": "keyword"},
            cookie=cookie,
        )
        seed.assert_status(found, 200, "shared search")
        assert stem not in found.text, f"{kind} question searchable"
        direct = guest.read(link["id"], cookie, f"/questions/{hidden[kind]}")
        seed.assert_status(direct, 404, f"{kind} question by id")
        assert seed.stable(direct) == seed.stable(missing), f"{kind}: not the generic 404"
        assert stem not in direct.text


def test_ws_view_01_ac01_exchange_sets_a_short_lived_httponly_cookie_and_privacy_headers(
    seed: Any,
) -> None:
    owner = seed.client("v-ac01-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"])
    guest = seed.guest()

    res = guest.exchange(link["id"], link["secret"])
    seed.assert_status(res, {200, 201, 204}, "exchange")
    seed.assert_privacy_headers(res, "exchange")
    assert (link["secret"] in res.text) is False
    cookie = seed.share_cookie_of(res)
    assert cookie is not None, f"no {seed.SHARE_COOKIE} cookie"
    assert (link["secret"] in cookie.value) is False, "the cookie must not carry the secret"
    assert cookie.attributes["httponly"], "HttpOnly"
    assert cookie.attributes["secure"], "Secure"
    assert cookie.attributes["samesite"] == "lax", "SameSite=Lax"
    max_age = cookie.attributes["max-age"]
    assert max_age.isdigit(), "short-lived: explicit Max-Age"
    assert 0 < int(max_age) <= seed.MAX_SHARE_SESSION_SECONDS

    shared = guest.read(link["id"], cookie.header)
    seed.assert_status(shared, 200, "shared workspace")
    seed.assert_privacy_headers(shared, "GET /shared/{id}")
    body = shared.json()
    assert body["workspace"]["name"] == ws["name"]
    assert body["allow_fork"] is False
    assert owner.user.email not in shared.text
    assert owner.user.id not in shared.text
    questions = guest.read(link["id"], cookie.header, "/questions")
    seed.assert_privacy_headers(questions, "GET /shared/{id}/questions")


def test_ws_view_01_ac04_unpublished_revisions_never_reach_the_share(seed: Any) -> None:
    owner = seed.client("v-ac04d-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"])
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    _, _, done = owner.upload_book(ws["id"])
    doc = str(done["document_id"])
    owner.wait_for_job(str(done["job_id"]))
    hits = owner.ok("POST", f"/workspaces/{ws['id']}/search", {"query": "강수", "mode": "keyword"})
    block_id = hits["items"][0]["block_id"]
    draft = "S0 미발행 초안 문장"
    owner.ok("PATCH", f"/documents/{doc}/blocks/{block_id}", {"text": draft}, (200, 201))

    shared_doc = guest.read(link["id"], cookie, f"/documents/{doc}")
    seed.assert_status(shared_doc, 200, "shared document")
    seed.assert_privacy_headers(shared_doc, "shared document")
    assert draft not in shared_doc.text, "draft revision leaked to the share"
    assert any("강수" in b["text"] for b in shared_doc.json()["blocks"])
    found = guest.send(
        "POST", f"/shared/{link['id']}/search", {"query": draft, "mode": "keyword"}, cookie=cookie
    )
    seed.assert_status(found, 200, "shared search")
    assert found.json()["items"] == [], "draft text is searchable through the share"
    pdf = guest.read(link["id"], cookie, f"/documents/{doc}/pdf")
    seed.assert_status(pdf, {200, 302, 303, 307}, "shared pdf")
    seed.assert_privacy_headers(pdf, "shared pdf")
    if pdf.status_code == 200:
        assert pdf.headers["content-type"].startswith("application/pdf")


def test_ws_view_01_ac04_shared_search_accepts_only_published_chapter_ids(seed: Any) -> None:
    """Chapter filters of drafts, other workspaces and random ids are one 404 (no oracle)."""
    owner = seed.client("v-ac04c-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"])
    other_ws = owner.create_workspace()
    guest = seed.guest()
    cookie = guest.session(link["id"], link["secret"])
    docs = {}
    for w in (ws["id"], other_ws["id"]):
        _, _, done = owner.upload_book(w)
        owner.wait_for_job(str(done["job_id"]))
        docs[w] = str(done["document_id"])
    doc = docs[ws["id"]]

    def chapter_ids(document_id: str, revision: str) -> list[str]:
        outline = owner.ok("GET", f"/documents/{document_id}/outline?revision={revision}")
        out: list[str] = []
        stack = list(outline["items"])
        while stack:
            node = stack.pop()
            out.append(str(node["id"]))
            stack.extend(node["children"])
        return out

    published = chapter_ids(doc, "active")
    assert published, "fixture book has an outline"
    # A correction draft copies the outline under new (unpublished) chapter ids.
    blocks = owner.ok("GET", f"/documents/{doc}/blocks?limit=5")["items"]
    block = next(b for b in blocks if b["text"].strip())
    owner.ok(
        "PATCH",
        f"/documents/{doc}/blocks/{block['block_id']}",
        {"text": block["text"] + " S1b", "base_version": block["version"]},
        (200, 201),
    )
    drafts = [c for c in chapter_ids(doc, "latest") if c not in published]
    assert drafts, "the draft revision has its own chapter ids"
    foreign = chapter_ids(docs[other_ws["id"]], "active")

    def search(ids: list[str]) -> Any:
        return guest.send(
            "POST",
            f"/shared/{link['id']}/search",
            {"query": "강수", "mode": "keyword", "chapter_ids": ids},
            cookie=cookie,
        )

    ok = search(published[:1])
    seed.assert_status(ok, 200, "published chapter filter")
    missing = search([str(uuid.uuid4())])
    seed.assert_status(missing, 404, "random chapter id")
    for kind, ids in (("draft", drafts[:1]), ("foreign", foreign[:1])):
        res = search(ids)
        seed.assert_status(res, 404, f"{kind} chapter id")
        assert seed.stable(res) == seed.stable(missing), f"{kind}: not the generic 404"


def test_session_exchange_rejects_missing_or_foreign_origin(seed: Any) -> None:
    owner = seed.client("csrf-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"])
    guest = seed.guest()
    for origin in (None, seed.FOREIGN_ORIGIN, "null"):
        res = guest.exchange(link["id"], link["secret"], origin=origin)
        seed.assert_status(res, 403, f"exchange with origin {origin!r}")
        assert seed.share_cookie_of(res) is None
    guest.session(link["id"], link["secret"])


def test_session_exchange_is_rate_limited(seed: Any) -> None:
    """Assumed limit S7: <= 20 exchanges/min per client and share id; a burst of 30 hits 429."""
    owner = seed.client("rate-owner")
    ws = owner.create_workspace()
    link = owner.create_link(ws["id"])
    guest = seed.guest()
    statuses: list[int] = []
    limited = None
    for _ in range(seed.EXCHANGE_BURST):
        res = guest.exchange(link["id"], "A" * 43)
        statuses.append(res.status_code)
        if res.status_code == 429:
            limited = res
            break
    assert limited is not None, f"no 429 in {len(statuses)} attempts: {sorted(set(statuses))}"
    assert set(statuses[:-1]) <= {404}, "wrong secrets are 404 until the limit"
    assert limited.headers.get("retry-after"), "429 carries Retry-After"
