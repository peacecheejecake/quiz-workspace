// Generated from contracts/openapi.json by scripts/generate.ts. Do not edit.
// Regenerate with `make contracts`.
/* eslint-disable */

export type paths = {
  '/api/v1/ai-explanations/{explanation_id}/stream': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Stream Question Explanation
     * @description The explanation's text as it is written (same gate as GET …/ai-explanation).
     */
    get: operations['streamQuestionAiExplanation'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/ask/conversations/{conversation_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Conversation */
    get: operations['getAskConversation'];
    put?: never;
    post?: never;
    /**
     * Delete Conversation
     * @description Deletes the conversation with its messages, sources and feedback (usage counts stay).
     */
    delete: operations['deleteAskConversation'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/ask/conversations/{conversation_id}/attachment': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /**
     * Detach Question
     * @description Later messages carry no question context; earlier answers stay.
     */
    delete: operations['detachAskQuestion'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/ask/conversations/{conversation_id}/messages': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Ask Question
     * @description Ask a question in the conversation; stream the answer from `stream_url`.
     */
    post: operations['askQuestion'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/ask/messages/{message_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Message
     * @description One message; while an answer streams, its text so far (the SSE fallback).
     */
    get: operations['getAskMessage'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/ask/messages/{message_id}/cancel': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Cancel Answer
     * @description Stops an unfinished answer, keeping the text streamed so far (idempotent).
     */
    post: operations['cancelAskAnswer'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/ask/messages/{message_id}/feedback': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /**
     * Set Feedback
     * @description "도움이 안 됨" with one reason code (no free text), for the caller's own answer.
     */
    put: operations['setAskFeedback'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/ask/messages/{message_id}/regenerate': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Regenerate Answer
     * @description A new answer version of the conversation's last question (evidence searched again).
     */
    post: operations['regenerateAskAnswer'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/ask/messages/{message_id}/retry': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Retry Answer
     * @description A new answer to the question of a failed or stopped answer (which stays).
     */
    post: operations['retryAskAnswer'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/ask/messages/{message_id}/stream': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Stream Answer
     * @description The answer's text as it is written (re-authorized on every poll).
     */
    get: operations['streamAskAnswer'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/chapters/{chapter_id}/my-highlights': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Chapter Highlights
     * @description The caller's highlights of the chapter: those of every note version of the chapter (version
     *     number included) and the explanation highlights of the questions now in it (live CONFIRMED;
     *     archived, deleted, draft and moved-away questions are left out).
     */
    get: operations['listChapterHighlights'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/chapters/{chapter_id}/note': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Chapter Note
     * @description The chapter's note (newest version or `version=k`), its versions, newest generation and
     *     whether it is stale. Read-only: never records a view.
     */
    get: operations['getChapterNote'];
    put?: never;
    /**
     * Create Chapter Note
     * @description Make (or remake) the chapter's note from its CONFIRMED questions and explanations: a new
     *     version; the previous ones are kept. The questions and explanations are sent to the LLM
     *     provider.
     */
    post: operations['createChapterNote'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/documents/{document_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Document */
    get: operations['getDocument'];
    put?: never;
    post?: never;
    /**
     * Delete Document
     * @description Soft delete (editor+). The document then answers 404 everywhere and leaves the library;
     *     the original stays in Storage until the retention cleanup (follow-up).
     */
    delete: operations['deleteDocument'];
    options?: never;
    head?: never;
    /**
     * Update Document Kind
     * @description Change a PDF's kind (`종류 변경`, DOC-01-AC08; editor+, archived workspaces read-only).
     *
     *     The chosen kind is pinned (`kind_source: user`): the parse job never reclassifies it. 409
     *     `document-not-ready` unless the document finished processing; 409 `document-in-use` when a
     *     book would become a question paper (it would leave search, generation sources and chapter
     *     matching) while questions or import drafts are registered under its chapters or cite it.
     *     Nothing is deleted: drafts, runs and questions stay whatever the kind. With `extract` (the
     *     default), a `question_paper` / `mixed` kind starts the question import when the document has
     *     none yet. Repeating the same change changes nothing.
     */
    patch: operations['updateDocumentKind'];
    trace?: never;
  };
  '/api/v1/documents/{document_id}/blocks': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Blocks
     * @description Canonical blocks of a revision in reading order (keyset-paged by ordinal).
     */
    get: operations['listDocumentBlocks'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/documents/{document_id}/blocks/{block_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Block */
    get: operations['getDocumentBlock'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /**
     * Correct Block
     * @description Correct one block's canonical text in the document's draft revision (DOC-02-AC02).
     */
    patch: operations['correctDocumentBlock'];
    trace?: never;
  };
  '/api/v1/documents/{document_id}/outline': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Outline
     * @description Chapter/section tree of a revision (DOC-02-AC01), roots and children in reading order.
     */
    get: operations['getDocumentOutline'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/documents/{document_id}/publish': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Publish Draft
     * @description Index and publish the correction draft (DOC-02-AC03): 202 with the job to follow.
     */
    post: operations['publishDocumentDraft'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/documents/{document_id}/revisions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Revisions
     * @description Every revision, newest first, with its newest parse/publish job.
     */
    get: operations['listDocumentRevisions'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/documents/{document_id}/revisions/{revision_id}/restore': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Restore Revision
     * @description Put a previous published revision's content into the draft (rollback); publish it to
     *     make it live. Restoring the active revision discards the draft's corrections.
     */
    post: operations['restoreDocumentRevision'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/documents/{document_id}/source-url': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Document Source Url
     * @description A short-lived signed URL of the original PDF for the viewer; ask again when it expires.
     */
    get: operations['getDocumentSourceUrl'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/documents/{document_id}/summary': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Document Summary
     * @description The summary panel's state (DOCSUM-01): any member, archived workspaces included.
     */
    get: operations['getDocumentSummary'];
    put?: never;
    /**
     * Create Document Summary
     * @description `요약 만들기` (DOCSUM-01-AC01/AC08): opt in and summarize the current published revision.
     *
     *     202 with the queued (or still running) run; 200 when the current revision already has a
     *     succeeded summary (only the opt-in changes, no run). Re-enables auto refresh after
     *     `자동 갱신 끄기`.
     */
    post: operations['createDocumentSummary'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/documents/{document_id}/summary/auto': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /**
     * Disable Document Summary Auto
     * @description `자동 갱신 끄기` (DOCSUM-01-AC08): later publishes start no run and send nothing to the
     *     LLM; stored summaries stay. Running runs are not cancelled. Idempotent (204).
     */
    delete: operations['disableDocumentSummaryAuto'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/documents/{document_id}/summary/retry': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Retry Document Summary
     * @description `다시 시도` (DOCSUM-01-AC03): a new run of the current revision after a failed one.
     */
    post: operations['retryDocumentSummary'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/documents/{document_id}/text': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Export Document Text
     * @description The document's canonical text as a Markdown or text file (DOC-03).
     */
    get: operations['exportDocumentText'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/documents/complete-upload': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Complete Upload
     * @description Verify the uploaded object and start parsing it (202 + job id, DOC-01-AC03/AC04).
     *
     *     Idempotent per upload: repeating it returns the same document and job. 409
     *     `upload-incomplete` = nothing stored yet (finish the upload, then retry); 409
     *     `upload-expired` = start over with a new intent; 422 `upload-mismatch` = the stored bytes
     *     differ from the declared size/SHA-256 (the object is discarded).
     */
    post: operations['completeDocumentUpload'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/jobs/{job_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Job
     * @description Current status of an async job (poll this, or stream `/jobs/{id}/events`).
     */
    get: operations['getJob'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/jobs/{job_id}/events': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Stream Job Events
     * @description Status transitions and progress of a job as Server-Sent Events.
     */
    get: operations['streamJobEvents'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/me': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Me
     * @description The authenticated user and their profile (created on first call).
     */
    get: operations['getMe'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/me/forks/{fork_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get My Fork
     * @description Status of one of the caller's forks (WS-FORK-01-AC04); anyone else's is 404.
     */
    get: operations['getMyFork'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/me/workspaces': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List My Workspaces
     * @description Workspaces the caller is a member of (soft-deleted ones excluded), newest first.
     */
    get: operations['listMyWorkspaces'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/mock-ai-explanations/{mock_explanation_id}/stream': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Stream Mock Explanation */
    get: operations['streamMockExamQuestionAiExplanation'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/mock-exam-questions/{mock_exam_question_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /**
     * Remove Mock Exam Question
     * @description 이 모의고사에서 빼기: the question leaves the list and later 풀기 (attempts stay).
     */
    delete: operations['removeMockExamQuestion'];
    options?: never;
    head?: never;
    /**
     * Update Mock Exam Question
     * @description Edit (a new revision; earlier attempts keep pointing at theirs). A stale
     *     `base_revision_id` is 409 `stale-revision`.
     */
    patch: operations['updateMockExamQuestion'];
    trace?: never;
  };
  '/api/v1/mock-exam-questions/{mock_exam_question_id}/ai-explanation': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Mock Explanation
     * @description The AI explanation of this mock exam question's revision (its own, never the source's).
     */
    get: operations['getMockExamQuestionAiExplanation'];
    put?: never;
    /** Create Mock Explanation */
    post: operations['createMockExamQuestionAiExplanation'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/mock-exam-questions/{mock_exam_question_id}/ai-explanation/regenerate': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Regenerate Mock Explanation */
    post: operations['regenerateMockExamQuestionAiExplanation'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/mock-exam-questions/{mock_exam_question_id}/practice-sessions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Start Mock Practice Session
     * @description Open a mock exam question: pins its active revision and optionally shuffles MCQ options.
     *     No answers in the response, nothing recorded outside the mock exam tables. With a run
     *     position the caller's mock run must hold this question; an open session is resumed, and a
     *     submitted one is 409 `already-submitted`.
     */
    post: operations['startMockPracticeSession'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/mock-exam-questions/{mock_exam_question_id}/related-sources': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Mock Exam Question Related Sources
     * @description Related passages of a mock exam question (its own list; evidence book blocks first).
     */
    get: operations['getMockExamQuestionRelatedSources'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/mock-exam-questions/{mock_exam_question_id}/source-region': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Mock Exam Question Source Region
     * @description The origin question's regions for a `보기 섞기` mock question (QSRC-01-C04).
     */
    get: operations['getMockExamQuestionSourceRegion'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/mock-exams/{mock_exam_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Mock Exam
     * @description Settings, current and newest generation (status, progress, counts).
     */
    get: operations['getMockExam'];
    put?: never;
    post?: never;
    /**
     * Delete Mock Exam
     * @description Soft delete: the mock exam leaves the list (attempts stay); a running generation is
     *     cancelled.
     */
    delete: operations['deleteMockExam'];
    options?: never;
    head?: never;
    /**
     * Rename Mock Exam
     * @description 이름 바꾸기 (1-100 characters; names may repeat in a workspace).
     */
    patch: operations['renameMockExam'];
    trace?: never;
  };
  '/api/v1/mock-exams/{mock_exam_id}/generations': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Create Mock Exam Generation
     * @description 다시 만들기 (empty body), 설정 바꾸기 (`config` / `range`: saved as a new revision) or
     *     다시 시도: a new generation; on success it replaces the shown questions (earlier ones and
     *     their attempts are kept).
     */
    post: operations['createMockExamGeneration'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/mock-exams/{mock_exam_id}/questions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Mock Exam Questions
     * @description The shown generation's questions by position (removed ones excluded). Viewers never get
     *     answers or explanations, also with `include=answers`.
     */
    get: operations['listMockExamQuestions'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/mock-practice-sessions/{mock_practice_session_id}/self-grade': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Self Grade Mock Practice Session
     * @description The user's own grade of a pending (essay / ungradable short answer) submission: appends a
     *     grade attempt referencing the pending one; the session becomes graded. Once.
     */
    post: operations['selfGradeMockPracticeSession'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/mock-practice-sessions/{mock_practice_session_id}/submit': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Submit Mock Practice Session
     * @description Grade the answer on the server against the session's revision (option ids, never
     *     positions); append the attempt; reveal answers and explanation. Once per session — for a run
     *     position once per position (409 `already-submitted`), and not after the run finished.
     */
    post: operations['submitMockPracticeSession'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/my-highlights': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Create Highlight
     * @description Highlight a range of a note version or of a question's current explanation. Overlapping
     *     highlights of the caller must be named in `replace_ids` (they are replaced by this one in the
     *     same transaction); allowed for every member, also in an archived workspace.
     */
    post: operations['createHighlight'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/my-highlights/{highlight_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /**
     * Delete Highlight
     * @description Remove one of the caller's highlights (idempotent; it can be restored for 10 minutes).
     */
    delete: operations['deleteHighlight'];
    options?: never;
    head?: never;
    /**
     * Update Highlight
     * @description Change the color of one of the caller's live highlights (`version` must match).
     */
    patch: operations['updateHighlight'];
    trace?: never;
  };
  '/api/v1/my-highlights/{highlight_id}/restore': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Restore Highlight
     * @description Undo the deletion of one of the caller's highlights within 10 minutes: the same id,
     *     target, anchor and color (`version` + 1). Merged-away highlights are not restorable.
     */
    post: operations['restoreHighlight'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/practice-runs/{run_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Practice Run
     * @description The run's counts, progress and summary (no items, no content).
     */
    get: operations['getPracticeRun'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/practice-runs/{run_id}/finish': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Finish Practice Run
     * @description End the run: unsubmitted positions count as skipped and no position can be submitted
     *     any more. Finishing a finished run returns it unchanged.
     */
    post: operations['finishPracticeRun'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/practice-runs/{run_id}/items/{position}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Practice Run Item
     * @description One position of the run: the question without answers, or — once submitted — the
     *     submitted answer, its result and the answers (`attempt`).
     */
    get: operations['getPracticeRunItem'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/practice-runs/{run_id}/items/{position}/retry-session': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Start Run Item Retry Session */
    post: operations['startRunItemRetrySession'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/practice-runs/{run_id}/results': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Practice Run Results
     * @description Positions offset+1 .. offset+limit with their result (no answers).
     */
    get: operations['listPracticeRunResults'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/practice-sessions/{session_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Practice Session
     * @description Resume one of the caller's sessions. `outcome` (with answers) only once submitted.
     */
    get: operations['getPracticeSession'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/practice-sessions/{session_id}/self-grade': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Self Grade Practice Session
     * @description The user's own grade of a pending (essay / ungradable short answer) submission. Appends
     *     a grade attempt referencing the pending one; the session becomes graded. Once.
     */
    post: operations['selfGradePracticeSession'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/practice-sessions/{session_id}/submit': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Submit Practice Session
     * @description Grade the answer on the server against the session's revision (option ids, never
     *     positions); append the attempt; reveal answers and explanation. Once per session — for a
     *     run position once per position (409 `already-submitted`), and not after the run finished.
     */
    post: operations['submitPracticeSession'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/question-drafts/{draft_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /**
     * Update Question Draft
     * @description Edit a draft (e.g. enter the answer the source did not give), approve or reject it.
     *     409 `stale-draft` when `base_version` is outdated, 409 `draft-published` once published.
     *
     *     Import drafts only: a generation draft of the retired 변형 출제 (QGEN-RM) answers 404.
     */
    patch: operations['updateQuestionDraft'];
    trace?: never;
  };
  '/api/v1/question-imports/{import_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Question Import */
    get: operations['getQuestionImport'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/question-imports/{import_id}/draft-summaries': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Question Import Draft Summaries
     * @description Every draft of the run in source order without its content (QIMP-PAGING): the review
     *     screen selects, counts and registers over all drafts from this and reads the content of the
     *     page on screen through `GET /drafts?offset&limit`. Same audience as the drafts: no stem,
     *     options, answers or explanation are listed here.
     */
    get: operations['listQuestionImportDraftSummaries'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/question-imports/{import_id}/drafts': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Question Import Drafts
     * @description The run's drafts in source order, with validations, provenance pages and answer flags.
     *     Drafts a failed job persisted are listed too (they are kept for the retry). Without
     *     `offset`/`limit` every draft is listed; with them one page (QIMP-PAGING), `total` counting
     *     all drafts of the run.
     */
    get: operations['listQuestionImportDrafts'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/question-imports/{import_id}/publish': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Publish Question Import Drafts
     * @description Register exactly these drafts as CONFIRMED questions (QIMPORT-01-AC03).
     *
     *     Each item names the draft and the `version` the reviewer saw. An id that is not a draft of
     *     this import is 404 (nothing changes). Already published drafts return their question whatever
     *     version is sent (idempotent replay).
     *
     *     Without `approve` (drafts approved beforehand through PATCH) it is all or nothing: a draft
     *     that changed since (another editor's edit, approval or rejection) is 409 `stale-draft`; a
     *     draft that is not approved is 409 `draft-not-approved`; a draft that cannot be confirmed is
     *     422.
     *
     *     With `approve` the request is the human selection itself ("선택한 문제 승인 및 등록"): each
     *     listed draft still at the sent version that can be confirmed is approved by the caller
     *     (`reviewed_by`/`reviewed_at`; a draft approved earlier keeps its approval) and registered,
     *     in one transaction. A draft that changed since or cannot be confirmed (e.g. an MCQ without
     *     an answer) is left untouched and listed in `refused`; it is never registered silently.
     */
    post: operations['publishQuestionImportDrafts'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/question-imports/{import_id}/registrations': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Register Question Import Drafts
     * @description Approve and register the whole selection on the server (QIMPORT-01-AC07, "선택한 문제 승인
     *     및 등록"): the request records every listed draft with the version on screen and starts a
     *     `question.import_register` job, which registers them in batches whether or not the page stays
     *     open. Same rules as `publish` with `approve: true`: the job's user (the caller) approves each
     *     draft still at the sent version that can be confirmed; drafts changed since (`stale-draft`) or
     *     not confirmable (`not-publishable`) are refused and left as they were; drafts registered
     *     already are skipped. Idempotent per draft (a re-delivered job never registers twice).
     *
     *     An id that is not a draft of this import is 404 (nothing recorded). 409
     *     `import-registration-running` while the previous registration of this import is still queued
     *     or running (follow `registration_job_id`). The job re-checks the workspace on every batch: an
     *     archived workspace or a lost editor role stops it (`workspace_unavailable`).
     */
    post: operations['registerQuestionImportDrafts'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/question-imports/{import_id}/registrations/{registration_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Question Import Registration
     * @description Progress of a registration of this import (`registration_id` = its `job_id`):
     *     processed/total and the refused drafts.
     */
    get: operations['getQuestionImportRegistration'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/question-imports/{import_id}/retry': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Retry Question Import
     * @description Run a failed (or cancelled) import again as a new job of the same run
     *     (QIMPORT-01-AC04). The new job keeps the drafts the failed one persisted and adds only the
     *     missing ones. 409 `import-not-retryable` unless the run failed or was cancelled.
     */
    post: operations['retryQuestionImport'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/questions/{question_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Question */
    get: operations['getQuestion'];
    put?: never;
    post?: never;
    /**
     * Delete Question
     * @description Soft delete (editor+). Revisions and attempts stay for history; the question then answers
     *     404 everywhere and leaves the bank and the overview.
     */
    delete: operations['deleteQuestion'];
    options?: never;
    head?: never;
    /**
     * Update Question
     * @description Edit (QBANK-01-AC03): a content change appends a revision and keeps option ids; a stale
     *     `base_revision_id` is 409 `stale-revision`.
     */
    patch: operations['updateQuestion'];
    trace?: never;
  };
  '/api/v1/questions/{question_id}/ai-explanation': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Question Explanation
     * @description The AI explanation of this question's revision for a submitted session or `view=detail`.
     */
    get: operations['getQuestionAiExplanation'];
    put?: never;
    /**
     * Create Question Explanation
     * @description Make the explanation (202), or return the cached one (200) / the one being made (202).
     */
    post: operations['createQuestionAiExplanation'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/questions/{question_id}/ai-explanation/regenerate': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Regenerate Question Explanation
     * @description A new version of the explanation (owner/editor; 3 per revision per day).
     */
    post: operations['regenerateQuestionAiExplanation'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/questions/{question_id}/attempts': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List My Attempts
     * @description The caller's own attempts on the question and on the duplicates merged into it
     *     (UX7-DEDUP), newest first, each pinned to the revision it was graded on (its content:
     *     GET /questions/{question_id}/revisions/{revision_id} of the item's `question_id`).
     */
    get: operations['listMyQuestionAttempts'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/questions/{question_id}/my-highlights': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Question Highlights
     * @description The caller's highlights of the question's explanation (same access as GET /questions/{id};
     *     the response holds the caller's quotes only, never the explanation).
     */
    get: operations['listQuestionHighlights'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/questions/{question_id}/my-state': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /**
     * Update My State
     * @description Toggle the caller's favorite / retry flags (independent of each other).
     *     The state answered is folded with the merged duplicates' (UX7-DEDUP): a flag set on any of
     *     them is set, and turning one off turns it off on all of them. RETRY-CORRECT: `needs_retry`
     *     can only be turned on while the last graded result is correct and the latest submission is not
     *     waiting for grading (409 `retry-requires-correct`, nothing written); turning it off is
     *     always allowed.
     */
    patch: operations['updateMyQuestionState'];
    trace?: never;
  };
  '/api/v1/questions/{question_id}/practice-recent': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Latest Question Practice */
    get: operations['getLatestQuestionPractice'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/questions/{question_id}/practice-reset': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Reset Question Practice
     * @description Reset personal study state; immutable attempts remain for audit.
     */
    post: operations['resetQuestionPractice'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/questions/{question_id}/practice-sessions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Start Practice Session
     * @description Open the practice panel on a CONFIRMED question: pins its active revision, optionally
     *     shuffles MCQ options, records the caller's view. No answers in the response. With a run position
     *     (QVIEW-B) the caller's run of this workspace must hold this question there; the position's
     *     open session is resumed (another view), a submitted one is 409 `already-submitted`.
     */
    post: operations['startPracticeSession'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/questions/{question_id}/preview': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Question Preview
     * @description A chapter-note footnote preview (CHNOTE-02-C01): stem and options of a live CONFIRMED
     *     question, no answer or explanation. Records no view.
     */
    get: operations['getQuestionPreview'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/questions/{question_id}/related-sources': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Question Related Sources
     * @description Related passages of a registered question after a submission or in its details.
     */
    get: operations['getQuestionRelatedSources'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/questions/{question_id}/revisions/{revision_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Question Revision
     * @description One immutable revision of the question (history; attempts point at these).
     */
    get: operations['getQuestionRevision'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/questions/{question_id}/source-region': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Question Source Region
     * @description Where the question sits in its import PDF (QSRC-01-C01); 404 when it has no region.
     */
    get: operations['getQuestionSourceRegion'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Shared Workspace
     * @description The shared workspace: name, fork policy and published documents (WS-VIEW-01-AC01/AC06).
     */
    get: operations['getSharedWorkspace'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}/chapter-notes': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Shared Chapter Notes
     * @description Chapters of published documents whose newest note is source-matched.
     */
    get: operations['listSharedChapterNotes'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}/chapters/{chapter_id}/note': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Shared Chapter Note
     * @description The chapter's newest note, read-only, when it is source-matched (else 404).
     */
    get: operations['getSharedChapterNote'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}/documents/{document_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Shared Document
     * @description The published revision of a document: outline and blocks (WS-VIEW-01-AC01/AC02).
     *
     *     Only the active published revision; drafts and older revisions are never reachable here.
     */
    get: operations['getSharedDocument'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}/documents/{document_id}/pdf': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Shared Document Pdf
     * @description The original PDF of a shared document, streamed through the API (WS-VIEW-01-AC02).
     *
     *     The private bucket is read server-side after the share check; no signed Storage URL is
     *     handed to the guest.
     */
    get: operations['getSharedDocumentPdf'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}/documents/{document_id}/summary': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Shared Document Summary
     * @description The AI summary of a shared document (DOCSUM-01-AC06, workspace-sharing.md §8): only a
     *     succeeded summary of the revision the guest reads now. An older revision's summary, a run in
     *     progress or failed, and anything of other workspaces answer the same 404 as a random id; no
     *     run, usage, cost or error data.
     */
    get: operations['getSharedDocumentSummary'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}/forks': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Start Fork
     * @description Fork the shared workspace into a new workspace of the caller (WS-FORK-01-AC02/AC04).
     *
     *     Needs the user's Bearer JWT and the share session cookie of this link, and the link must
     *     allow forking. Copies the published documents, questions, answers and explanations; never
     *     drafts, other people's progress, activity or share links. 202 with the fork; poll
     *     `GET /me/forks/{id}`.
     */
    post: operations['startWorkspaceFork'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}/questions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Shared Questions
     * @description CONFIRMED questions in bank order, answers and explanations included (WS-VIEW-01-AC01).
     *
     *     Reading records nothing (no view, favourite, retry or attempt state).
     */
    get: operations['listSharedQuestions'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}/questions/{question_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Shared Question
     * @description One CONFIRMED question of the shared workspace; anything else is the same 404.
     */
    get: operations['getSharedQuestion'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}/questions/{question_id}/ai-explanation': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Shared Question Explanation
     * @description The AI explanation of one published question, as members see it (read-only).
     */
    get: operations['getSharedQuestionAiExplanation'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}/questions/{question_id}/preview': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Shared Question Preview
     * @description The member preview's DTO for a question in the share's published scope (CHNOTE-02-C02);
     *     anything else is the same 404.
     */
    get: operations['getSharedQuestionPreview'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}/questions/{question_id}/related-sources': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Shared Question Related Sources
     * @description The stored list of a published question's active revision and the current corpus;
     *     guests never compute (404 until a member's read stored one).
     */
    get: operations['getSharedQuestionRelatedSources'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}/search': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Search Shared Workspace
     * @description Search the published documents of the shared workspace (WS-VIEW-01-AC02).
     *
     *     Same request and result items as the member search; `document_ids` must name shared
     *     (published) documents. The query is not echoed back.
     */
    post: operations['searchSharedWorkspace'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/shared/{share_id}/sessions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Create Shared Session
     * @description Exchange the link secret for a read-only share session cookie (WS-VIEW-01-AC01).
     *
     *     Needs an allowlisted `Origin` (the web app). Unknown link, wrong secret, revoked or expired
     *     link and deleted workspace all answer the same 404. The secret is never stored or logged.
     */
    post: operations['createSharedSession'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Workspaces
     * @description The caller's workspaces in one status; soft-deleted workspaces never appear.
     */
    get: operations['listWorkspaces'];
    put?: never;
    /**
     * Create Workspace
     * @description Create a workspace; the caller becomes its owner (WS-01-AC02).
     */
    post: operations['createWorkspace'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Workspace */
    get: operations['getWorkspace'];
    put?: never;
    post?: never;
    /**
     * Delete Workspace
     * @description Soft delete (owner, also from archived). The workspace then answers 404 everywhere.
     */
    delete: operations['deleteWorkspace'];
    options?: never;
    head?: never;
    /**
     * Update Workspace
     * @description Rename (owner). Renaming to the current name is a no-op without an activity event.
     */
    patch: operations['updateWorkspace'];
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/activities': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Activities
     * @description Change history of the workspace (documents, questions, imports, sharing), newest first.
     *     Personal study-state events are included for the caller's own changes only.
     */
    get: operations['listWorkspaceActivities'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/archive': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Archive Workspace
     * @description Make the workspace read-only (owner). Repeating it returns the archived workspace.
     *
     *     With `Idempotency-Key`, a retry replays the first response even if the workspace was
     *     restored in between (no second archive, no second event).
     */
    post: operations['archiveWorkspace'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/ask': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Ask State
     * @description Whether new AI questions can be asked here, and the limits the panel shows.
     */
    get: operations['getAskState'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/ask/conversations': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Conversations
     * @description The caller's own conversations of this workspace, most recent first (30 per page).
     */
    get: operations['listAskConversations'];
    put?: never;
    /**
     * Create Conversation
     * @description A new (personal) conversation, optionally with one attached question.
     */
    post: operations['createAskConversation'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/attempts': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List My Attempts
     * @description The caller's own practice attempts in the workspace, newest first. Other users' attempts
     *     are never listed; a `user_id` parameter is refused (422).
     */
    get: operations['listMyWorkspaceAttempts'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/chapter-notes': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Chapter Notes
     * @description Per Heatmap chapter (a chapter with a CONFIRMED question or a note), in outline order:
     *     the newest version, whether it is stale and whether a generation is queued/running.
     */
    get: operations['listChapterNotes'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/chapter-redistribution/preview': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Preview Redistribution
     * @description Recommend chapters again (CHAPTER-MAP on each question's first source block) and list the
     *     questions whose chapter would change. Read-only: computed on every request, nothing stored.
     */
    post: operations['previewChapterRedistribution'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/chapter-redistribution/questions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Redistribution Questions
     * @description The workspace's confirmed questions by chapter group (Heatmap order) with how each chapter
     *     was decided, and the book chapters they can move to. No answers.
     */
    get: operations['listChapterRedistributionQuestions'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/documents': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Documents
     * @description The workspace's documents (not soft-deleted), newest first, each with its queued or
     *     running parse job.
     */
    get: operations['listDocuments'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/documents/upload-intent': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Create Upload Intent
     * @description Reserve a document and return where to upload its PDF (DOC-01-AC03).
     *
     *     Rejects non-PDF names/types (415) and files over 50 MiB (413) before any URL is issued.
     *     Each call is a new intent; an intent that is never completed creates no document.
     */
    post: operations['createDocumentUploadIntent'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/jobs': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Jobs
     * @description Async jobs of the workspace (parse/reindex, import, generation), newest first, with what
     *     each works on and whether the caller can retry it.
     */
    get: operations['listWorkspaceJobs'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/mock-exams': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Mock Exams
     * @description The workspace's mock exams, newest first, with their generation state.
     */
    get: operations['listMockExams'];
    put?: never;
    /**
     * Create Mock Exam
     * @description Save a mock exam and start its first generation. With an AI variation type the range's
     *     questions, answers, explanations and related book text are sent to the LLM provider.
     */
    post: operations['createMockExam'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/my-highlights': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Chapterless Highlights
     * @description The caller's explanation highlights of the "챕터 없음" Heatmap group.
     */
    get: operations['listChapterlessHighlights'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/practice-runs': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Create Practice Run
     * @description Resolve the range on the server into a fixed, ordered run of at most 5,000 questions.
     *     The response carries counts only (read positions through /items/{position}).
     */
    post: operations['createPracticeRun'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/question-duplicates': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Question Duplicates
     * @description Groups of identical CONFIRMED questions (same normalised stem and options, any option
     *     order). A read: scanning again gives the same groups until questions change.
     */
    get: operations['listQuestionDuplicates'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/question-duplicates/merge': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Merge Question Duplicates
     * @description Keep one question per group, archive the others and merge their study history into it
     *     (the kept question's state, favorite and retry marks include theirs; attempts unchanged).
     *     Repeating a merge changes nothing. Unarchiving a duplicate later unmerges it.
     */
    post: operations['mergeQuestionDuplicates'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/question-imports': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Question Imports
     * @description The workspace's import runs, newest first.
     */
    get: operations['listQuestionImports'];
    put?: never;
    /**
     * Create Question Import
     * @description Start extracting draft questions from a PDF (QIMPORT-01-AC01): a question paper, a book
     *     with questions, or any ready document (UX6-UPLOAD-B). 409 `document-not-ready` while it is
     *     still processing (or failed).
     *
     *     The server already starts the import of a question paper when its processing succeeds
     *     (QIMPORT-01-AC06), so this usually attaches: if the paper's active revision already has a
     *     run (started by the server or by anyone), that run is returned and nothing new is created.
     *     It creates a run for papers that have none (e.g. processed before QIMP-AUTO).
     */
    post: operations['createQuestionImport'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/questions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Questions
     * @description The bank (any member, answers included): live questions in bank order (sort order,
     *     question number, registration order).
     */
    get: operations['listQuestions'];
    put?: never;
    /**
     * Create Question
     * @description Register a question with revision 1 (QBANK-01-AC02). CONFIRMED (default) requires
     *     complete content (an MCQ needs >= 2 options and a correct option); DRAFT may be incomplete.
     */
    post: operations['createQuestion'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/questions/chapter-assignments': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Assign Question Chapters
     * @description Move questions to chapters in one transaction (all or nothing). Each item carries the
     *     chapter the client showed; any difference refuses the whole request. Moving never creates a
     *     question revision and keeps attempts and study state.
     */
    post: operations['assignQuestionChapters'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/questions/overview': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Question Overview
     * @description The caller's question heatmap: CONFIRMED questions with their study status, grouped by
     *     chapter, plus the status counts. Read-only: never records a view.
     */
    get: operations['getQuestionOverview'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/restore': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Restore Workspace
     * @description Make an archived workspace writable again (owner). Repeating it is a no-op.
     *
     *     With `Idempotency-Key`, a retry replays the first response (see archive).
     */
    post: operations['restoreWorkspace'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/search': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Search Workspace
     * @description Search the published text of this workspace's documents (SEARCH-01).
     */
    post: operations['searchWorkspace'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/share-links': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Share Links
     * @description Every link of the workspace (revoked and expired included), newest first; no raw secrets.
     */
    get: operations['listShareLinks'];
    put?: never;
    /**
     * Create Share Link
     * @description Issue a read-only share link (WS-SHARE-01-AC02). Fork is off unless `allow_fork`.
     *
     *     The raw `secret` appears only in this response. A link is not a membership.
     */
    post: operations['createShareLink'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/share-links/{link_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /**
     * Update Share Link
     * @description Change `allow_fork` and/or `expires_at` (WS-SHARE-01-AC03; allowed on archived).
     *
     *     A revoked link is final (409 `share-link-inactive`); an expired one can get a new expiry.
     */
    patch: operations['updateShareLink'];
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/share-links/{link_id}/revoke': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Revoke Share Link
     * @description Revoke at once (WS-SHARE-01-AC04; allowed on archived). Repeating it is a no-op.
     */
    post: operations['revokeShareLink'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/workspaces/{workspace_id}/share-links/{link_id}/rotate': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Rotate Share Link
     * @description Revoke the link and issue a replacement (new id and secret, same policy) atomically.
     *
     *     Only an active link can be rotated (409 `share-link-inactive` for revoked or expired ones:
     *     extend the expiry first, or create a new link).
     */
    post: operations['rotateShareLink'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/health/live': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Live
     * @description Process is up. Never touches external dependencies.
     */
    get: operations['getLiveness'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/health/ready': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Ready
     * @description All required dependencies (DB, Redis, Qdrant) answer within the timeout.
     */
    get: operations['getReadiness'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
};
export type webhooks = Record<string, never>;
export type components = {
  schemas: {
    /** Activity */
    Activity: {
      /** @description null once the user was deleted. */
      actor: components['schemas']['ActivityActor'] | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Event Type
       * @description e.g. `document.block_corrected`, `question.updated`.
       */
      event_type: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** @description The revision a document correction/publish/restore touched or the question version a change produced; null for events without one. */
      revision: components['schemas']['ActivityRevision'] | null;
      /** Target Id */
      target_id: string | null;
      /**
       * Target Label
       * @description Document title, workspace name or a question label (`N번 문제`); never book or question text.
       */
      target_label: string | null;
      /**
       * Target Type
       * @description e.g. `document`, `question`, `workspace`.
       */
      target_type: string;
    };
    /** ActivityActor */
    ActivityActor: {
      /** Display Name */
      display_name: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
    };
    /** ActivityPage */
    ActivityPage: {
      /** Items */
      items: components['schemas']['Activity'][];
      /**
       * Next Cursor
       * @description Pass as `cursor` for older events.
       */
      next_cursor: string | null;
    };
    /** ActivityRevision */
    ActivityRevision: {
      /**
       * Id
       * @description Document revision id or question revision id.
       */
      id: string | null;
      /**
       * Number
       * @description Document `revision_number` or question `version` the event produced.
       */
      number: number | null;
    };
    /** AiExplanationHighlightTarget */
    AiExplanationHighlightTarget: {
      /**
       * Ai Explanation Id
       * Format: uuid
       */
      ai_explanation_id: string;
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: 'ai_explanation';
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
    };
    /** AiExplanationTargetIn */
    AiExplanationTargetIn: {
      /**
       * Ai Explanation Id
       * Format: uuid
       * @description AIEXPL-01 (not available yet: 404).
       */
      ai_explanation_id: string;
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: 'ai_explanation';
    };
    /** AskLimits */
    AskLimits: {
      /** Max Question Chars */
      max_question_chars: number;
      /** Max Regenerations */
      max_regenerations: number;
      /** Max Turns */
      max_turns: number;
    };
    /** AskScope */
    AskScope: {
      /** Chapter Ids */
      chapter_ids?: string[];
      /** Document Ids */
      document_ids?: string[];
    };
    /** AskState */
    AskState: {
      /**
       * Available
       * @description New questions can be asked here now.
       */
      available: boolean;
      limits: components['schemas']['AskLimits'];
      /**
       * Reason
       * @description Why not: the feature is off in this environment, or the workspace is archived (stored conversations stay readable either way).
       */
      reason: ('disabled' | 'archived') | null;
    };
    /** Attachment */
    Attachment: {
      /**
       * Available
       * @description False once the question, session or mock exam is gone (no context then).
       */
      available: boolean;
      /**
       * Disclosure
       * @description What the next message will use (from the DB).
       * @enum {string}
       */
      disclosure: 'hint' | 'full';
      /**
       * Kind
       * @enum {string}
       */
      kind: 'question' | 'mock_exam_question';
      /**
       * Label
       * @description `<n>장 <m>번 · <발문 앞 40자>` / `문제 k · …`.
       */
      label: string;
      /**
       * View
       * @enum {string}
       */
      view: 'practice' | 'detail' | 'manage';
    };
    /** AttachmentInput */
    AttachmentInput: {
      /**
       * Kind
       * @enum {string}
       */
      kind: 'question' | 'mock_exam_question';
      /** Mock Exam Question Id */
      mock_exam_question_id?: string | null;
      /** Mock Practice Session Id */
      mock_practice_session_id?: string | null;
      /** Practice Session Id */
      practice_session_id?: string | null;
      /** Question Id */
      question_id?: string | null;
      /** Selected Option Ids */
      selected_option_ids?: string[];
      /**
       * View
       * @enum {string}
       */
      view: 'practice' | 'detail' | 'manage';
    };
    /** Attempt */
    Attempt: {
      /**
       * Displayed Option Ids
       * @description The order the options were shown in.
       */
      displayed_option_ids: string[];
      /** Graded At */
      graded_at: string | null;
      /**
       * Grades Attempt Id
       * @description For a self/reviewer grade: the pending attempt it settles.
       */
      grades_attempt_id: string | null;
      /**
       * Grading Method
       * @description null while pending.
       */
      grading_method: ('auto' | 'self' | 'reviewer') | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Practice Session Id
       * Format: uuid
       */
      practice_session_id: string;
      /**
       * Question Id
       * Format: uuid
       * @description The question answered: this one, or a duplicate merged into it (UX7-DEDUP).
       */
      question_id: string;
      /**
       * Question Revision Id
       * Format: uuid
       * @description Graded against this revision.
       */
      question_revision_id: string;
      /**
       * Result
       * @enum {string}
       */
      result: 'correct' | 'incorrect' | 'pending';
      /** Revision Version */
      revision_version: number;
      submitted_answer: components['schemas']['SubmittedAnswer'];
      /**
       * Submitted At
       * Format: date-time
       */
      submitted_at: string;
    };
    /** AttemptList */
    AttemptList: {
      /** Items */
      items: components['schemas']['Attempt'][];
      /**
       * Next Cursor
       * @description Pass as `cursor` for older attempts.
       */
      next_cursor: string | null;
    };
    /** BlockCorrection */
    BlockCorrection: {
      /**
       * Base Version
       * @description The block `version` the correction started from; 409 `edit-conflict` when the block changed since.
       */
      base_version?: string | null;
      /**
       * Text
       * @description Corrected text. Tables: one row per line, cells separated by `|`.
       */
      text: string;
    };
    /** BlockDetail */
    BlockDetail: {
      block: components['schemas']['ContentBlock'];
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      revision: components['schemas']['RevisionInfo'];
    };
    /** BlockList */
    BlockList: {
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /** Items */
      items: components['schemas']['ContentBlock'][];
      /**
       * Next After
       * @description Pass as `after` for the next page; null on the last page.
       */
      next_after: number | null;
      revision: components['schemas']['RevisionInfo'] | null;
    };
    /** BlockLocation */
    BlockLocation: {
      /** @description PDF points, origin top-left. */
      bbox: components['schemas']['BoundingBox'] | null;
      /** Page */
      page: number;
    };
    /** BookChapterOption */
    BookChapterOption: {
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /** Document Title */
      document_title: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Level
       * @description 1 = chapter, 2+ = nested section.
       */
      level: number;
      /** Title */
      title: string;
    };
    /** BoundingBox */
    BoundingBox: {
      /** X0 */
      x0: number;
      /** X1 */
      x1: number;
      /** Y0 */
      y0: number;
      /** Y1 */
      y1: number;
    };
    /** ChapterAssignmentItem */
    ChapterAssignmentItem: {
      /**
       * Chapter Id
       * @description Target; null = "챕터 없음".
       */
      chapter_id: string | null;
      /**
       * Expected Chapter Id
       * @description The chapter the client showed (the current one); a different current chapter refuses the whole request (409 `chapter-changed`).
       */
      expected_chapter_id: string | null;
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
    };
    /** ChapterAssignmentRequest */
    ChapterAssignmentRequest: {
      /** Items */
      items: components['schemas']['ChapterAssignmentItem'][];
      /**
       * Source
       * @description manual (직접 옮기기 -> `manual`) | recommendation (applied -> `auto`).
       * @enum {string}
       */
      source: 'manual' | 'recommendation';
    };
    /** ChapterAssignmentResult */
    ChapterAssignmentResult: {
      /** Moved */
      moved: number;
      /**
       * Unchanged
       * @description Already in the target chapter (as expected).
       */
      unchanged: number;
    };
    /** ChapterNote */
    ChapterNote: {
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /** Footnotes */
      footnotes: components['schemas']['NoteFootnote'][];
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Input Fingerprint */
      input_fingerprint: string;
      /** Question Count */
      question_count: number;
      /** Question Refs */
      question_refs: components['schemas']['NoteQuestionRef'][];
      /** Sections */
      sections: components['schemas']['NoteSection'][];
      /** @description null for a copied (forked) note. */
      usage: components['schemas']['NoteUsage'] | null;
      /** Version */
      version: number;
    };
    /** ChapterNoteList */
    ChapterNoteList: {
      /** Available */
      available: boolean;
      /** Items */
      items: components['schemas']['ChapterNoteSummary'][];
    };
    /** ChapterNoteState */
    ChapterNoteState: {
      /**
       * Available
       * @description This environment can create notes.
       */
      available: boolean;
      /**
       * Chapter Id
       * Format: uuid
       */
      chapter_id: string;
      /** Chapter Title */
      chapter_title: string;
      /** Confirmed Question Count */
      confirmed_question_count: number;
      /** @description The chapter's newest generation. */
      generation: components['schemas']['NoteGeneration'] | null;
      /** @description The newest version, or `version=k`. */
      note: components['schemas']['ChapterNote'] | null;
      /**
       * Stale
       * @description The chapter's confirmed questions changed since the note.
       */
      stale: boolean;
      /**
       * Versions
       * @description Newest first.
       */
      versions: components['schemas']['NoteVersion'][];
    };
    /** ChapterNoteSummary */
    ChapterNoteSummary: {
      /**
       * Chapter Id
       * Format: uuid
       */
      chapter_id: string;
      /** Chapter Title */
      chapter_title: string;
      /** Generating */
      generating: boolean;
      /** Latest Version */
      latest_version: number | null;
      /** Stale */
      stale: boolean;
    };
    /** ChapterRef */
    ChapterRef: {
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Title */
      title: string;
    };
    /** ChapterSummary */
    ChapterSummary: {
      /** Key Points */
      key_points: components['schemas']['SummaryKeyPoint'][];
      /** Page From */
      page_from: number | null;
      /** Page To */
      page_to: number | null;
      /** Section Key */
      section_key: string;
      /**
       * Summary Md
       * @description Markdown subset (paragraphs, lists, emphasis); render HTML, links and images as text. Empty when the chapter has no body text.
       */
      summary_md: string;
      /** Title */
      title: string;
    };
    /**
     * CheckStatus
     * @enum {string}
     */
    CheckStatus: 'ok' | 'error' | 'timeout' | 'not_configured';
    /** CompleteUpload */
    CompleteUpload: {
      /**
       * Sha256
       * @description Hex SHA-256 of the uploaded bytes.
       */
      sha256: string;
      /**
       * Upload Id
       * Format: uuid
       */
      upload_id: string;
    };
    /** ContentBlock */
    ContentBlock: {
      /**
       * Block Id
       * @description Stable across revisions (search hits, question sources).
       */
      block_id: string;
      /** Caption Block Id */
      caption_block_id: string | null;
      /** Chapter Id */
      chapter_id: string | null;
      /**
       * Edited
       * @description Corrected by a user in this or an earlier revision.
       */
      edited: boolean;
      /** Heading Level */
      heading_level: number | null;
      /**
       * Locations
       * @description Where the block sits in the PDF.
       */
      locations: components['schemas']['BlockLocation'][];
      /**
       * Ordinal
       * @description Reading order within the revision.
       */
      ordinal: number;
      /**
       * Page
       * @description First PDF page of the block.
       */
      page: number;
      table: components['schemas']['TableCells'] | null;
      /** Text */
      text: string;
      /**
       * Type
       * @enum {string}
       */
      type: 'heading' | 'text' | 'table' | 'image' | 'formula';
      /**
       * Version
       * @description Send as `base_version` when correcting this block.
       */
      version: string;
    };
    /** Conversation */
    Conversation: {
      attachment: components['schemas']['Attachment'] | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Last Message At
       * Format: date-time
       */
      last_message_at: string;
      /** Messages */
      messages: components['schemas']['Message'][];
      scope: components['schemas']['AskScope'];
      /** Title */
      title: string | null;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /**
     * ConversationCreate
     * @description Extra fields (e.g. a `disclosure` value) are ignored.
     */
    ConversationCreate: {
      attachment?: components['schemas']['AttachmentInput'] | null;
      scope?: components['schemas']['AskScope'] | null;
    };
    /** ConversationPage */
    ConversationPage: {
      /** Items */
      items: components['schemas']['ConversationSummary'][];
      /** Next Cursor */
      next_cursor: string | null;
    };
    /** ConversationSummary */
    ConversationSummary: {
      attachment: components['schemas']['Attachment'] | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Last Message At
       * Format: date-time
       */
      last_message_at: string;
      /** Title */
      title: string | null;
    };
    /** DependencyStatus */
    DependencyStatus: {
      status: components['schemas']['CheckStatus'];
    };
    /** DocumentDetail */
    DocumentDetail: {
      active_revision: components['schemas']['quiz_api__api__documents__RevisionSummary'] | null;
      /**
       * Active Revision Id
       * @description The published revision search and the viewer use (null until ready).
       */
      active_revision_id: string | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Document Type
       * @description Body text or not: `book` (also for a `mixed` kind) or `question_paper`. Search, generation sources and chapter matching use books only.
       * @enum {string}
       */
      document_type: 'book' | 'question_paper';
      /** Filename */
      filename: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Kind
       * @description `book` (교재), `question_paper` (문제지) or `mixed` (교재+문제: a book that also prints questions). Null while an automatically classified upload is not classified yet (`분석 중`), or when it failed before that.
       */
      kind?: ('book' | 'question_paper' | 'mixed') | null;
      /**
       * Kind Source
       * @description `auto` = classified by the server; `user` = chosen by a person (at upload or with `PATCH /documents/{id}`), never reclassified.
       * @default user
       * @enum {string}
       */
      kind_source?: 'user' | 'auto';
      /**
       * Last Error
       * @description Why the last processing attempt failed.
       */
      last_error: string | null;
      /**
       * Latest Import Id
       * @description The newest question import run of the document, whatever its kind (the server starts one for a question paper or a confident `mixed` PDF once it is processed, QIMPORT-01-AC06); null when it has none.
       */
      latest_import_id?: string | null;
      /** @description The newest revision (a draft while a parse or correction is pending). */
      latest_revision: components['schemas']['quiz_api__api__documents__RevisionSummary'] | null;
      /** @description The queued or running parse job; null when there is none. */
      processing_job?: components['schemas']['DocumentProcessingJob'] | null;
      /**
       * Question Count
       * @description Live questions registered from this PDF's question imports.
       * @default 0
       */
      question_count?: number;
      /** Sha256 */
      sha256: string;
      /** Size Bytes */
      size_bytes: number;
      /**
       * Status
       * @description uploading | processing | ready | failed
       * @enum {string}
       */
      status: 'uploading' | 'processing' | 'ready' | 'failed';
      /** Title */
      title: string;
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /**
     * DocumentKindChange
     * @description `종류 변경` (DOC-01-AC08).
     */
    DocumentKindChange: {
      /**
       * Extract
       * @description For `question_paper` / `mixed`: start the question import when the document has none yet (an existing run, its drafts and questions are kept either way).
       * @default true
       */
      extract?: boolean;
      /**
       * Kind
       * @description `book` (교재), `question_paper` (문제지) or `mixed` (교재+문제).
       * @enum {string}
       */
      kind: 'book' | 'question_paper' | 'mixed';
    };
    /** DocumentList */
    DocumentList: {
      /** Items */
      items: components['schemas']['DocumentSummary'][];
    };
    /**
     * DocumentProcessingJob
     * @description The document's queued or running parse job, so a list shows progress without following
     *     the job (UX3-JOB, DOC-01-AC05).
     */
    DocumentProcessingJob: {
      /**
       * Created At
       * Format: date-time
       * @description When the job was queued.
       */
      created_at: string;
      /**
       * Id
       * Format: uuid
       * @description Poll `GET /jobs/{id}` or stream its events for more.
       */
      id: string;
      /**
       * Progress
       * @description 0-99 while running; null when unknown.
       */
      progress: number | null;
      /**
       * Stage
       * @description Current step while running: `preparing` (loading the parser's models), `downloading`, `parsing`, `structuring`, `loading`, `chunking`, `indexing`, `publishing`; null when not reported yet.
       */
      stage: string | null;
      /**
       * Started At
       * @description When a worker first started it.
       */
      started_at: string | null;
      /**
       * Status
       * @enum {string}
       */
      status: 'queued' | 'running';
    };
    /** DocumentSummary */
    DocumentSummary: {
      /**
       * Active Revision Id
       * @description The published revision search and the viewer use (null until ready).
       */
      active_revision_id: string | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Document Type
       * @description Body text or not: `book` (also for a `mixed` kind) or `question_paper`. Search, generation sources and chapter matching use books only.
       * @enum {string}
       */
      document_type: 'book' | 'question_paper';
      /** Filename */
      filename: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Kind
       * @description `book` (교재), `question_paper` (문제지) or `mixed` (교재+문제: a book that also prints questions). Null while an automatically classified upload is not classified yet (`분석 중`), or when it failed before that.
       */
      kind?: ('book' | 'question_paper' | 'mixed') | null;
      /**
       * Kind Source
       * @description `auto` = classified by the server; `user` = chosen by a person (at upload or with `PATCH /documents/{id}`), never reclassified.
       * @default user
       * @enum {string}
       */
      kind_source?: 'user' | 'auto';
      /**
       * Last Error
       * @description Why the last processing attempt failed.
       */
      last_error: string | null;
      /**
       * Latest Import Id
       * @description The newest question import run of the document, whatever its kind (the server starts one for a question paper or a confident `mixed` PDF once it is processed, QIMPORT-01-AC06); null when it has none.
       */
      latest_import_id?: string | null;
      /** @description The queued or running parse job; null when there is none. */
      processing_job?: components['schemas']['DocumentProcessingJob'] | null;
      /**
       * Question Count
       * @description Live questions registered from this PDF's question imports.
       * @default 0
       */
      question_count?: number;
      /** Sha256 */
      sha256: string;
      /** Size Bytes */
      size_bytes: number;
      /**
       * Status
       * @description uploading | processing | ready | failed
       * @enum {string}
       */
      status: 'uploading' | 'processing' | 'ready' | 'failed';
      /** Title */
      title: string;
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /** DraftBBox */
    DraftBBox: {
      /** X0 */
      x0: number;
      /** X1 */
      x1: number;
      /** Y0 */
      y0: number;
      /** Y1 */
      y1: number;
    };
    /** DraftChapterRef */
    DraftChapterRef: {
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /** Document Title */
      document_title: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Title */
      title: string;
    };
    /**
     * DraftDuplicate
     * @description Why an unregistered import draft looks like a duplicate (UX7-DEDUP, QIMPORT-01-AC10):
     *     the same question (docs/questions.md §10.1) as a CONFIRMED question of the workspace or as
     *     an earlier draft of the same import. A hint only: the draft can still be registered.
     */
    DraftDuplicate: {
      /**
       * Draft Id
       * @description `draft`: the earlier draft of this import.
       */
      draft_id: string | null;
      /**
       * Kind
       * @enum {string}
       */
      kind: 'question' | 'draft';
      /**
       * Number
       * @description `question`: its number (null if none); `draft`: its N번 (printed number, else position + 1).
       */
      number: number | null;
      /**
       * Question Id
       * @description `question`: the confirmed question.
       */
      question_id: string | null;
    };
    /** DraftEvidence */
    DraftEvidence: {
      /** Block Ids */
      block_ids?: string[];
      /** Document Id */
      document_id: string;
      /** Locations */
      locations: components['schemas']['DraftLocation'][];
      /**
       * Quote
       * @description Figure caption text, when any.
       */
      quote?: string | null;
      /** Revision Id */
      revision_id?: string | null;
    };
    /** DraftGenerator */
    DraftGenerator: {
      /** Model */
      model: string;
      /** Prompt Version */
      prompt_version: string;
    };
    /** DraftIssue */
    DraftIssue: {
      /** Code */
      code: string;
      /**
       * Severity
       * @description `error` blocks approval.
       * @enum {string}
       */
      severity: 'warning' | 'error';
    };
    /** DraftLocation */
    DraftLocation: {
      bbox?: components['schemas']['DraftBBox'] | null;
      /** Block Id */
      block_id?: string | null;
      /** Page */
      page: number;
    };
    /**
     * DraftPayload
     * @description book_core `QuestionDraft` (schema_version 1).
     */
    DraftPayload: {
      /**
       * Accepted Answers
       * @description null = the source has no answer.
       */
      accepted_answers: string[] | null;
      /**
       * Correct Option Ids
       * @description null = the source has no answer.
       */
      correct_option_ids: string[] | null;
      /**
       * Evidence
       * @description Import: page/area provenance in the question PDF. Generation: the cited book passages (document revision, blocks, pages, verbatim quote).
       */
      evidence: components['schemas']['DraftEvidence'][];
      /** Explanation */
      explanation?: string | null;
      generator?: components['schemas']['DraftGenerator'] | null;
      /**
       * Id
       * @description Producer id: extractor `{document_id}-q{NNN}` or generator `gen-{run id}-{variation}-{NN}` (not the draft row id).
       */
      id: string;
      /**
       * Justification
       * @description Generation: why the answer is correct, from the passages.
       */
      justification?: string | null;
      /** Options */
      options: components['schemas']['QuestionOption'][];
      /**
       * Origin
       * @enum {string}
       */
      origin: 'pdf_import' | 'generation';
      /**
       * Parent Question Id
       * @description Generation: the source question (lineage parent).
       */
      parent_question_id?: string | null;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /**
       * Review Status
       * @enum {string}
       */
      review_status: 'pending' | 'approved' | 'rejected';
      /** Schema Version */
      schema_version: number;
      /**
       * Source Question Revision Id
       * @description Generation: the source revision to diff against.
       */
      source_question_revision_id?: string | null;
      /** Stem */
      stem: string;
      /** Validations */
      validations: components['schemas']['DraftValidation'][];
      /**
       * Variation Type
       * @description Generation drafts only.
       */
      variation_type?: ('PARAPHRASE' | 'INVERT_POLARITY' | 'ANALOGOUS_CONCEPT') | null;
    };
    /** DraftPublishError */
    DraftPublishError: {
      /** Field */
      field: string | null;
      /** Message */
      message: string;
    };
    /** DraftValidation */
    DraftValidation: {
      /** Code */
      code: string;
      /** Field */
      field?: string | null;
      /** Message */
      message: string;
      /**
       * Severity
       * @description `error` blocks approval.
       * @enum {string}
       */
      severity: 'warning' | 'error';
    };
    /** DuplicateGroup */
    DuplicateGroup: {
      /**
       * Answers Differ
       * @description The questions' answers (correct option texts / accepted answers) differ.
       */
      answers_differ: boolean;
      /** Fingerprint */
      fingerprint: string;
      /**
       * Questions
       * @description Registration order, oldest first.
       */
      questions: components['schemas']['DuplicateQuestion'][];
      /**
       * Suggested Keep Question Id
       * Format: uuid
       * @description The question with the most graded attempts by the workspace's members (its merged duplicates' included), ties to the oldest. Counts are not returned.
       */
      suggested_keep_question_id: string;
    };
    /** DuplicateOption */
    DuplicateOption: {
      /** Id */
      id: string;
      /** Text */
      text: string;
    };
    /** DuplicateQuestion */
    DuplicateQuestion: {
      /** Chapter Id */
      chapter_id: string | null;
      /** Chapter Title */
      chapter_title: string | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Options
       * @description Authored order; no answer marks.
       */
      options: components['schemas']['DuplicateOption'][];
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /** Question Number */
      question_number: number | null;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /** Stem */
      stem: string;
    };
    /** DuplicateScan */
    DuplicateScan: {
      /**
       * Groups
       * @description Heatmap order of each group's first member.
       */
      groups: components['schemas']['DuplicateGroup'][];
      /**
       * Question Count
       * @description Confirmed questions scanned.
       */
      question_count: number;
    };
    /** Explanation */
    Explanation: {
      /** @description Succeeded only. */
      body: components['schemas']['ExplanationBody'] | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /** Error Code */
      error_code: string | null;
      /** Finished At */
      finished_at: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Job Id */
      job_id: string | null;
      /**
       * Question Revision Id
       * Format: uuid
       */
      question_revision_id: string;
      /**
       * Sources
       * @description The cited sources (succeeded only).
       */
      sources: components['schemas']['ExplanationSource'][];
      /**
       * Status
       * @enum {string}
       */
      status: 'queued' | 'running' | 'succeeded' | 'failed';
      /** Truncated */
      truncated: boolean;
      /** Version */
      version: number;
    };
    /** ExplanationBody */
    ExplanationBody: {
      /** Concepts Md */
      concepts_md: string;
      /**
       * Correct Option Ids
       * @description The server's answer (MCQ); [] otherwise.
       */
      correct_option_ids: string[];
      /**
       * Options
       * @description Every option exactly once, in stored order.
       */
      options: components['schemas']['OptionWhy'][];
      /**
       * Points Md
       * @description Short answer / essay: the rubric's core, common wrong answers.
       */
      points_md?: string | null;
      /** Summary Md */
      summary_md: string;
    };
    /** ExplanationHighlightTarget */
    ExplanationHighlightTarget: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: 'explanation';
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /**
       * Question Revision Id
       * Format: uuid
       * @description The revision it was made on.
       */
      question_revision_id: string;
    };
    /** ExplanationRequest */
    ExplanationRequest: {
      /**
       * Practice Session Id
       * @description The caller's submitted practice session of this question.
       */
      practice_session_id?: string | null;
      /**
       * View
       * @description `detail`: the 문제 상세 dialog (no submission needed).
       */
      view?: 'detail' | null;
    };
    /** ExplanationSource */
    ExplanationSource: {
      /**
       * Block Id
       * @description The first cited block (block_ids[0]).
       */
      block_id: string | null;
      /**
       * Block Ids
       * @description The cited blocks of the pinned revision.
       */
      block_ids: string[];
      /** Chapter Title */
      chapter_title: string | null;
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /** Document Title */
      document_title: string;
      /**
       * N
       * @description The footnote number `[n]` in the body.
       */
      n: number;
      /**
       * Outdated
       * @description The document was published again since.
       */
      outdated: boolean;
      /** Page */
      page: number;
      /**
       * Revision Id
       * Format: uuid
       * @description The pinned document revision the passage was cited from (kept after a republish: open the excerpt and the PDF at this revision).
       */
      revision_id: string;
    };
    /** ExplanationState */
    ExplanationState: {
      /**
       * Available
       * @description This environment can make AI explanations.
       */
      available: boolean;
      /**
       * Can Create
       * @description available, active workspace, none for this revision.
       */
      can_create: boolean;
      /**
       * Can Regenerate
       * @description An owner/editor of an active workspace, a success.
       */
      can_regenerate: boolean;
      /** @description The newest explanation of this revision that is not superseded (a current success over a later failed attempt), or null. */
      explanation: components['schemas']['Explanation'] | null;
    };
    /** ExplanationTargetIn */
    ExplanationTargetIn: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: 'explanation';
      /**
       * Question Id
       * Format: uuid
       * @description The question's current revision's explanation.
       */
      question_id: string;
      /**
       * Question Revision Id
       * @description The revision whose explanation the client showed (recommended): 409 `stale-revision` when it is no longer the current one, so the anchor is never applied to a different text.
       */
      question_revision_id?: string | null;
    };
    /** Feedback */
    Feedback: {
      /**
       * Message Id
       * Format: uuid
       */
      message_id: string;
      /**
       * Reason
       * @enum {string}
       */
      reason: 'source_mismatch' | 'made_up' | 'revealed_answer' | 'other';
    };
    /** FeedbackInput */
    FeedbackInput: {
      /**
       * Reason
       * @enum {string}
       */
      reason: 'source_mismatch' | 'made_up' | 'revealed_answer' | 'other';
    };
    /**
     * Fork
     * @description A fork request of the caller (never the source owner, manifest or link).
     */
    Fork: {
      /** Completed At */
      completed_at: string | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Error Code
       * @description Why a fork ended FAILED or CANCELLED, e.g. `share_unavailable` (the link was revoked, expired, set to no-fork or its workspace deleted while copying).
       */
      error_code: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Job Id
       * @description The `workspace.fork` job (202 Accepted).
       */
      job_id: string | null;
      /**
       * Name
       * @description Name of the new workspace.
       */
      name: string;
      /**
       * Progress
       * @description 0-100 (100 once COMPLETED).
       */
      progress: number;
      /**
       * Status
       * @description PENDING | COPYING | COMPLETED | FAILED | CANCELLED
       * @enum {string}
       */
      status: 'PENDING' | 'COPYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
      /**
       * Target Workspace Id
       * @description The new workspace, owned by the caller; null until COMPLETED.
       */
      target_workspace_id: string | null;
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
    };
    /** ForkCreate */
    ForkCreate: {
      /**
       * Name
       * @description Name of the new workspace.
       */
      name: string;
    };
    /** Highlight */
    Highlight: {
      /** @description Where it was made (in its note version/revision). */
      anchor: components['schemas']['HighlightAnchor'];
      /** @description Position in the current text; null when missing. */
      anchor_current: components['schemas']['HighlightAnchor'] | null;
      /**
       * Anchor Status
       * @description `exact`: same text; `relocated`: found again in the current revision; `missing`: the current explanation no longer contains the quote.
       * @enum {string}
       */
      anchor_status: 'exact' | 'relocated' | 'missing';
      /**
       * Color
       * @enum {string}
       */
      color: 'yellow' | 'blue' | 'pink';
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** @description Explanation highlights only. */
      question: components['schemas']['HighlightQuestion'] | null;
      /**
       * Quote
       * @description The highlighted text, cut by the server.
       */
      quote: string;
      /** Target */
      target:
        | components['schemas']['NoteHighlightTarget']
        | components['schemas']['ExplanationHighlightTarget']
        | components['schemas']['AiExplanationHighlightTarget'];
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
      /** Version */
      version: number;
    };
    /** HighlightAnchor */
    HighlightAnchor: {
      /**
       * Block
       * @description `s<i>.i<j>` (note item `sections[i].items[j]`) or `p<i>` (explanation paragraph, blank-line separated, 0-based).
       */
      block: string;
      /**
       * End
       * @description UTF-16 offset, exclusive.
       */
      end: number;
      /**
       * Start
       * @description UTF-16 offset in the block.
       */
      start: number;
    };
    /** HighlightCreate */
    HighlightCreate: {
      anchor: components['schemas']['HighlightAnchor'];
      /**
       * Color
       * @enum {string}
       */
      color: 'yellow' | 'blue' | 'pink';
      /**
       * Replace Ids
       * @description The caller's live highlights of the same target that overlap `anchor`: removed in the same transaction (merge). They cannot be restored.
       */
      replace_ids?: string[] | null;
      /** Target */
      target:
        | components['schemas']['NoteTargetIn']
        | components['schemas']['ExplanationTargetIn']
        | components['schemas']['AiExplanationTargetIn'];
    };
    /** HighlightList */
    HighlightList: {
      /**
       * Items
       * @description Display order: note highlights (newest version first, body order), then explanation highlights (Heatmap order, position in the explanation).
       */
      items: components['schemas']['Highlight'][];
    };
    /** HighlightQuestion */
    HighlightQuestion: {
      /**
       * Number Label
       * @description `<n>장 <번호>번` (the Heatmap's numbering).
       */
      number_label: string;
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /**
       * Stem Preview
       * @description First 40 characters of the current stem.
       */
      stem_preview: string;
    };
    /** HighlightUpdate */
    HighlightUpdate: {
      /**
       * Color
       * @enum {string}
       */
      color: 'yellow' | 'blue' | 'pink';
      /**
       * Version
       * @description The `version` the client read (optimistic lock).
       */
      version: number;
    };
    /** HitBoundingBox */
    HitBoundingBox: {
      /** X0 */
      x0: number;
      /** X1 */
      x1: number;
      /** Y0 */
      y0: number;
      /** Y1 */
      y1: number;
    };
    /** HitLocation */
    HitLocation: {
      /** @description PDF points, origin top-left. */
      bbox: components['schemas']['HitBoundingBox'] | null;
      /** Block Id */
      block_id: string | null;
      /** Page */
      page: number;
    };
    /** ImportCreate */
    ImportCreate: {
      /**
       * Document Id
       * Format: uuid
       * @description A document of this workspace whose processing finished: usually a `question_paper` or a `mixed` PDF, but any kind may be imported (UX6-UPLOAD-B).
       */
      document_id: string;
    };
    /**
     * ImportDraft
     * @description A question draft under review: an import draft or a generation draft (M6.2).
     */
    ImportDraft: {
      /**
       * Acknowledged Codes
       * @description Generation: blocking validations the reviewer confirmed (answer_count_changed via is_multi_answer, question_type_changed via question_type).
       */
      acknowledged_codes?: string[];
      /**
       * Answer Missing
       * @description No option answers, no accepted answers and (essay) no model answer.
       */
      answer_missing: boolean;
      /** @description Import drafts (CHAPTER-MAP): the book chapter the draft is registered under (the suggestion, or the reviewer's choice), in its book's current revision; null = none. */
      chapter?: components['schemas']['DraftChapterRef'] | null;
      /**
       * Chapter Choice
       * @description `auto`: the server's suggestion; `manual`: chosen in review.
       * @default auto
       * @enum {string}
       */
      chapter_choice?: 'auto' | 'manual';
      /**
       * Chapter Match
       * @description Why the suggestion is what it is (auto only): `matched` (exactly one book chapter with the question's chapter title), `no_match`, `ambiguous` (several), `no_source_chapter` (the question PDF has no chapter there).
       */
      chapter_match?: ('matched' | 'no_match' | 'ambiguous' | 'no_source_chapter') | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /** @description Import drafts not registered yet: the same question exists. */
      duplicate_of?: components['schemas']['DraftDuplicate'] | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Import Id
       * @description The import run (import drafts).
       */
      import_id: string | null;
      /** Is Multi Answer */
      is_multi_answer: boolean;
      /**
       * Pages
       * @description Source PDF pages (1-based) of the draft.
       */
      pages: number[];
      payload: components['schemas']['DraftPayload'];
      /**
       * Position
       * @description 0-based order in the source.
       */
      position: number;
      /**
       * Publish Errors
       * @description Why it cannot be confirmed yet.
       */
      publish_errors: components['schemas']['DraftPublishError'][];
      /**
       * Publishable
       * @description Can be approved / confirmed as it is.
       */
      publishable: boolean;
      /** Published Question Id */
      published_question_id: string | null;
      /**
       * Question Number
       * @description Number printed in the source.
       */
      question_number: number | null;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /**
       * Review Status
       * @enum {string}
       */
      review_status: 'pending' | 'approved' | 'rejected';
      /** Reviewed At */
      reviewed_at: string | null;
      /**
       * Rubric
       * @description Essay model answer / grading criteria (a model answer printed in the source lands here, never in accepted_answers).
       */
      rubric: string | null;
      /**
       * Run Id
       * @description The generation run (generation drafts).
       */
      run_id?: string | null;
      /**
       * Source Chapter Title
       * @description The question PDF chapter the suggestion was made from.
       */
      source_chapter_title?: string | null;
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
      /** Validations */
      validations: components['schemas']['DraftValidation'][];
      /**
       * Variation Type
       * @description Generation drafts only.
       */
      variation_type?: ('PARAPHRASE' | 'INVERT_POLARITY' | 'ANALOGOUS_CONCEPT') | null;
      /**
       * Version
       * @description Changes with every write. Send it as `base_version` when editing and as `version` when publishing (the version that was reviewed).
       */
      version: string;
    };
    /** ImportDraftList */
    ImportDraftList: {
      /**
       * Chapters
       * @description Import runs: the workspace's book chapters (current revisions), the choices for `chapter_id`. Empty with `include_chapters=false`.
       */
      chapters?: components['schemas']['BookChapterOption'][];
      /** Items */
      items: components['schemas']['ImportDraft'][];
      /**
       * Total
       * @description All drafts of the run (more than `items` when one page was read).
       */
      total: number;
    };
    /**
     * ImportDraftSummary
     * @description A draft without its content (QIMP-PAGING): no stem, options, answers or explanation —
     *     only what selecting, counting and registering it needs.
     */
    ImportDraftSummary: {
      /** Answer Missing */
      answer_missing: boolean;
      /**
       * Chapter Id
       * @description Import drafts: the book chapter the draft is registered under (as `ImportDraft.chapter.id`, sent back as `chapter_id` when registering); null = none.
       */
      chapter_id?: string | null;
      /** @description As `ImportDraft.duplicate_of` (UX7-DEDUP). */
      duplicate_of?: components['schemas']['DraftDuplicate'] | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Position
       * @description 0-based order in the source.
       */
      position: number;
      /**
       * Publishable
       * @description Can be approved / confirmed as it is.
       */
      publishable: boolean;
      /** Published Question Id */
      published_question_id: string | null;
      /** Question Number */
      question_number: number | null;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /**
       * Review Status
       * @enum {string}
       */
      review_status: 'pending' | 'approved' | 'rejected';
      /**
       * Validations
       * @description Validation codes, without messages.
       */
      validations: components['schemas']['DraftIssue'][];
      /**
       * Version
       * @description As `ImportDraft.version`.
       */
      version: string;
    };
    /** ImportDraftSummaryList */
    ImportDraftSummaryList: {
      /**
       * Chapters
       * @description As `ImportDraftList.chapters`.
       */
      chapters?: components['schemas']['BookChapterOption'][];
      /**
       * Items
       * @description Every draft of the run, source order.
       */
      items: components['schemas']['ImportDraftSummary'][];
    };
    /** ImportPublishBody */
    ImportPublishBody: {
      /**
       * Approve
       * @description Approve and register the listed drafts in one step (QIMPORT-01-AC03, "선택한 문제 승인 및 등록"): every listed draft at the sent `version` is approved by the caller and registered in the same transaction; drafts that changed since or cannot be confirmed are returned in `refused`, untouched, and the others are registered. Without it only drafts approved beforehand are registered, all or nothing.
       * @default false
       */
      approve?: boolean;
      /** Drafts */
      drafts: components['schemas']['ReviewedImportDraft'][];
    };
    /** ImportPublishedDraft */
    ImportPublishedDraft: {
      /**
       * Draft Id
       * Format: uuid
       */
      draft_id: string;
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
    };
    /** ImportPublishOutcome */
    ImportPublishOutcome: {
      /**
       * Items
       * @description In request order.
       */
      items: components['schemas']['ImportPublishedDraft'][];
      /**
       * Refused
       * @description `approve` requests only (else empty): listed drafts left as they were, in request order.
       */
      refused: components['schemas']['ImportRefusedDraft'][];
    };
    /** ImportRefusedDraft */
    ImportRefusedDraft: {
      /**
       * Draft Id
       * Format: uuid
       */
      draft_id: string;
      /**
       * Reason
       * @description `stale-draft`: changed since the sent version (review it again); `not-publishable`: cannot be confirmed as it is (see the draft's `publish_errors`).
       * @enum {string}
       */
      reason: 'stale-draft' | 'not-publishable';
    };
    /**
     * ImportRegistration
     * @description A submitted selection being approved and registered on the server (QIMP-JOB).
     */
    ImportRegistration: {
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Error Code
       * @description Why the job stopped, e.g. `workspace_unavailable` (archived workspace or lost editor role); drafts not processed by then stay unregistered.
       */
      error_code: string | null;
      /** Finished At */
      finished_at: string | null;
      /**
       * Import Id
       * Format: uuid
       */
      import_id: string;
      /**
       * Job Id
       * Format: uuid
       * @description The `question.import_register` job (`GET /jobs/{id}`).
       */
      job_id: string;
      /**
       * Processed
       * @description Drafts done (registered, already registered or refused).
       */
      processed: number;
      /**
       * Refused
       * @description Drafts left as they were, in submitted order.
       */
      refused: components['schemas']['ImportRegistrationRefusal'][];
      /**
       * Registered
       * @description Drafts this registration registered.
       */
      registered: number;
      /**
       * Skipped
       * @description Drafts that were registered already (nothing new).
       */
      skipped: number;
      /**
       * Status
       * @description queued | running | succeeded | failed | cancelled
       * @enum {string}
       */
      status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
      /**
       * Total
       * @description Distinct drafts submitted.
       */
      total: number;
    };
    /** ImportRegistrationRefusal */
    ImportRegistrationRefusal: {
      /**
       * Draft Id
       * Format: uuid
       */
      draft_id: string;
      /**
       * Position
       * @description 0-based order in the source.
       */
      position: number;
      /**
       * Question Number
       * @description Number printed in the source.
       */
      question_number: number | null;
      /**
       * Reason
       * @description `stale-draft`: changed since the sent version; `not-publishable`: cannot be confirmed as it is.
       * @enum {string}
       */
      reason: 'stale-draft' | 'not-publishable';
    };
    /** ImportRegistrationRequest */
    ImportRegistrationRequest: {
      /**
       * Drafts
       * @description The whole selection, each draft at the version on screen (the version the selection approves).
       */
      drafts: components['schemas']['ReviewedImportDraft'][];
    };
    /** ImportRun */
    ImportRun: {
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /** Document Title */
      document_title: string | null;
      /** Draft Count */
      draft_count: number;
      /**
       * Error Code
       * @description Why the last job failed (stable code).
       */
      error_code: string | null;
      /** Finished At */
      finished_at: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Job Id
       * @description The run's current job; poll `GET /jobs/{id}`.
       */
      job_id: string | null;
      /** Published Count */
      published_count: number;
      /**
       * Registration Job Id
       * @description The newest registration (QIMP-JOB) of this run, if any: read its progress at `GET /question-imports/{id}/registrations/{registration_id}`.
       */
      registration_job_id: string | null;
      /** Source Document Id */
      source_document_id: string | null;
      /**
       * Source Document Revision Id
       * @description The document revision the import reads (active when it started).
       */
      source_document_revision_id: string | null;
      /**
       * Status
       * @description queued | running | succeeded | failed | cancelled
       * @enum {string}
       */
      status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /** ImportRunList */
    ImportRunList: {
      /** Items */
      items: components['schemas']['ImportRun'][];
    };
    /** IssuedShareLink */
    IssuedShareLink: {
      /**
       * Allow Fork
       * @description Whether signed-in viewers may fork (default off).
       */
      allow_fork: boolean;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Expires At
       * @description Null: never expires.
       */
      expires_at: string | null;
      /**
       * Id
       * Format: uuid
       * @description The public share id (`/share/{id}`).
       */
      id: string;
      /** Revoked At */
      revoked_at: string | null;
      /**
       * Rotated From Id
       * @description The revoked link this one replaced (rotate).
       */
      rotated_from_id: string | null;
      /**
       * Secret
       * @description The link secret (unpadded base64url, 32 bytes). Returned only in this response; null when an Idempotency-Key retry replays an earlier issue.
       */
      secret: string | null;
      /**
       * Secret Already Issued
       * @description True on an Idempotency-Key replay: the secret was shown once already.
       */
      secret_already_issued: boolean;
      /**
       * Share Url
       * @description `<web origin>/share/{id}#k={secret}`; null exactly when `secret` is.
       */
      share_url: string | null;
      /**
       * Status
       * @description Derived from revoked_at / expires_at.
       * @enum {string}
       */
      status: 'active' | 'expired' | 'revoked';
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /** Job */
    Job: {
      /** Attempts */
      attempts: number;
      /** Cancel Requested */
      cancel_requested: boolean;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Error Code
       * @description Stable reason of a failed (or `cancelled`) job, e.g. `parse_failed`.
       */
      error_code: string | null;
      /** Finished At */
      finished_at: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Job Type
       * @description e.g. `document.parse`.
       */
      job_type: string;
      /** Max Attempts */
      max_attempts: number;
      /**
       * Progress
       * @description 0-100 while running (100 once succeeded); null when unknown.
       */
      progress: number | null;
      /**
       * Result
       * @description Counts and code only, for `mock_exam.generate`: {created_count, skipped_count, usage: {llm_calls, batches, input_tokens, output_tokens}, error_code}; for `ask.answer` (its creator only): {sources, dropped_citations, llm_calls, usage: {input_tokens, output_tokens, cache_read_tokens}, status, error_code}; null for other job types.
       */
      result?: {
        [key: string]: unknown;
      } | null;
      /**
       * Stage
       * @description Current step while running, e.g. `parsing`, `indexing`; null otherwise.
       */
      stage: string | null;
      /** Started At */
      started_at: string | null;
      /**
       * Status
       * @description queued | running | succeeded | failed | cancelled
       * @enum {string}
       */
      status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
    };
    /** LatestPractice */
    LatestPractice: {
      /**
       * Active Revision Id
       * Format: uuid
       */
      active_revision_id: string;
      /** Latest Attempt Id */
      latest_attempt_id: string | null;
      /** Previous Revision */
      previous_revision: boolean;
      /** Reset Epoch */
      reset_epoch: number;
      session: components['schemas']['PracticeSessionDetail'] | null;
      /** Submitted Answer */
      submitted_answer?: {
        [key: string]: unknown;
      } | null;
    };
    /** LivenessReport */
    LivenessReport: {
      /**
       * Status
       * @constant
       */
      status: 'ok';
    };
    /** Me */
    Me: {
      /**
       * Id
       * Format: uuid
       * @description The verified user id (token `sub`).
       */
      id: string;
      /** @description Created on the first authenticated `/me` call. */
      profile: components['schemas']['Profile'];
    };
    /** MergedGroup */
    MergedGroup: {
      /**
       * Already Merged Question Ids
       * @description Already archived and merged into this question (left as they were).
       */
      already_merged_question_ids: string[];
      /**
       * Archived Question Ids
       * @description Archived and merged now.
       */
      archived_question_ids: string[];
      /**
       * Keep Question Id
       * Format: uuid
       */
      keep_question_id: string;
    };
    /** MergeGroup */
    MergeGroup: {
      /** Duplicate Question Ids */
      duplicate_question_ids: string[];
      /**
       * Keep Question Id
       * Format: uuid
       */
      keep_question_id: string;
    };
    /** MergeRequest */
    MergeRequest: {
      /** Groups */
      groups: components['schemas']['MergeGroup'][];
    };
    /** MergeResult */
    MergeResult: {
      /** Groups */
      groups: components['schemas']['MergedGroup'][];
    };
    /** Message */
    Message: {
      /**
       * Conversation Id
       * Format: uuid
       */
      conversation_id: string;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /** Degraded */
      degraded: ('dense_unavailable' | 'attachment_only')[];
      /**
       * Disclosure
       * @enum {string}
       */
      disclosure: 'none' | 'hint' | 'full';
      /** Error Code */
      error_code: string | null;
      /** Feedback */
      feedback: ('source_mismatch' | 'made_up' | 'revealed_answer' | 'other') | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Question Message Id */
      question_message_id: string | null;
      /** Regenerated From Message Id */
      regenerated_from_message_id: string | null;
      /** Retry Of Message Id */
      retry_of_message_id: string | null;
      /**
       * Role
       * @enum {string}
       */
      role: 'user' | 'assistant';
      /**
       * Searched Sources
       * @description The passages searched for a `no_sources` answer ("검색한 구절").
       */
      searched_sources: components['schemas']['Source'][];
      /**
       * Sources
       * @description Cited passages of a finished answer.
       */
      sources: components['schemas']['Source'][];
      /**
       * Status
       * @enum {string}
       */
      status:
        'queued' | 'retrieving' | 'streaming' | 'succeeded' | 'no_sources' | 'stopped' | 'failed';
      /**
       * Text
       * @description Markdown: the finished, validated answer (footnotes `[1]`…), or the text streamed so far.
       */
      text: string;
      /** Truncated */
      truncated: boolean;
      /** Uncited */
      uncited: boolean;
    };
    /** MessageAccepted */
    MessageAccepted: {
      answer: components['schemas']['Message'];
      /**
       * Job Id
       * Format: uuid
       */
      job_id: string;
      /** Stream Url */
      stream_url: string;
      user_message: components['schemas']['Message'];
    };
    /** MessageCreate */
    MessageCreate: {
      /** Question */
      question: string;
      scope?: components['schemas']['AskScope'] | null;
      /** Selected Option Ids */
      selected_option_ids?: string[] | null;
    };
    /** MockExam */
    MockExam: {
      config: components['schemas']['MockExamConfig'];
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /** @description The generation whose questions are shown. */
      current_generation: components['schemas']['MockExamGeneration'] | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      latest_generation: components['schemas']['MockExamGeneration'] | null;
      /** Question Count Current */
      question_count_current: number;
      range: components['schemas']['QuestionRange'];
      /**
       * Status
       * @enum {string}
       */
      status: 'generating' | 'ready' | 'partial' | 'failed';
      /** Title */
      title: string;
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
      /** Version */
      version: number;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /** MockExamConfig */
    MockExamConfig: {
      /**
       * Difficulty
       * @description null = like the source.
       */
      difficulty?: ('easy' | 'medium' | 'hard') | null;
      /**
       * Question Count
       * @description Questions to make: 1..100 with an AI type; with 보기 섞기 only 1..range (null = the whole range).
       */
      question_count: number | null;
      /**
       * Variation Types
       * @description Distinct variation types (one or more).
       */
      variation_types: (
        'OPTION_SHUFFLE' | 'PARAPHRASE' | 'INVERT_POLARITY' | 'ANALOGOUS_CONCEPT'
      )[];
    };
    /** MockExamCreate */
    MockExamCreate: {
      config: components['schemas']['MockExamConfig'];
      range: components['schemas']['QuestionRange'];
      /** Seed */
      seed?: number | null;
      /** Title */
      title: string;
    };
    /** MockExamGeneration */
    MockExamGeneration: {
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /** Created Count */
      created_count: number;
      /**
       * Error Code
       * @description `llm_unavailable`, `llm_timeout`, `no_valid_questions`, `mock_exam_unavailable`, ...
       */
      error_code: string | null;
      /** Finished At */
      finished_at: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Job Id
       * @description Job `mock_exam.generate`.
       */
      job_id: string | null;
      /** @description While queued or running. */
      progress: components['schemas']['MockExamProgress'] | null;
      /** Requested Count */
      requested_count: number;
      /** Seed */
      seed: number;
      /** Skipped Count */
      skipped_count: number;
      /**
       * Status
       * @enum {string}
       */
      status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
      /** Version */
      version: number;
    };
    /** MockExamGenerationCreate */
    MockExamGenerationCreate: {
      /** @description 설정 바꾸기: new settings. */
      config?: components['schemas']['MockExamConfig'] | null;
      range?: components['schemas']['QuestionRange'] | null;
      /** Seed */
      seed?: number | null;
    };
    /** MockExamList */
    MockExamList: {
      /** Items */
      items: components['schemas']['MockExam'][];
      /**
       * Llm Available
       * @description This environment can use the AI variation types.
       */
      llm_available: boolean;
    };
    /** MockExamOption */
    MockExamOption: {
      /** Id */
      id: string;
      /** Text */
      text: string;
    };
    /** MockExamProgress */
    MockExamProgress: {
      /** Done */
      done: number;
      /** Total */
      total: number;
    };
    /** MockExamQuestion */
    MockExamQuestion: {
      /** Accepted Answers */
      accepted_answers?: string[] | null;
      /** Correct Option Ids */
      correct_option_ids?: string[] | null;
      /** Edited */
      edited: boolean;
      /** Explanation */
      explanation?: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Is Multi Answer */
      is_multi_answer: boolean;
      /** Options */
      options: components['schemas']['MockExamOption'][];
      /** Position */
      position: number;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      revision: components['schemas']['MockExamRevisionRef'];
      /** Rubric */
      rubric?: string | null;
      source: components['schemas']['MockExamSourceRef'];
      /** Stem */
      stem: string;
      /** Validation Issues */
      validation_issues?: components['schemas']['MockExamValidationNote'][] | null;
      /**
       * Variation Type
       * @enum {string}
       */
      variation_type: 'OPTION_SHUFFLE' | 'PARAPHRASE' | 'INVERT_POLARITY' | 'ANALOGOUS_CONCEPT';
    };
    /** MockExamQuestionUpdate */
    MockExamQuestionUpdate: {
      /** Accepted Answers */
      accepted_answers?: string[] | null;
      /**
       * Base Revision Id
       * Format: uuid
       */
      base_revision_id: string;
      /** Correct Option Ids */
      correct_option_ids?: string[] | null;
      /** Explanation */
      explanation?: string | null;
      /** Is Multi Answer */
      is_multi_answer?: boolean | null;
      /** Options */
      options?: components['schemas']['MockExamOption'][] | null;
      /** Rubric */
      rubric?: string | null;
      /** Stem */
      stem?: string | null;
    };
    /** MockExamRevisionRef */
    MockExamRevisionRef: {
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Version */
      version: number;
    };
    /**
     * MockExamSourceChapter
     * @description The source question's chapter (MOCK-01-C10): the range step groups by it.
     */
    MockExamSourceChapter: {
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Number
       * @description Leading chapter number of the outline path (as the Heatmap's), or null.
       */
      number: number | null;
      /**
       * Rank
       * @description The generation plan's `chapter_rank` (Heatmap order of the range's chapters): groups sort by it.
       */
      rank: number;
      /** Title */
      title: string;
    };
    /** MockExamSourceRef */
    MockExamSourceRef: {
      /** @description null: the source was deleted or has no chapter (the 'none' group, last). */
      chapter?: components['schemas']['MockExamSourceChapter'] | null;
      /**
       * Label
       * @description "<n>장 <m>번", "<m>번" or "원본 삭제됨".
       */
      label: string;
      /**
       * Question Id
       * @description null: the source was deleted.
       */
      question_id: string | null;
    };
    /** MockExamUpdate */
    MockExamUpdate: {
      /** Title */
      title: string;
    };
    /** MockExamValidationNote */
    MockExamValidationNote: {
      /** Code */
      code: string;
      /**
       * Severity
       * @enum {string}
       */
      severity: 'error' | 'warning';
    };
    /** MockExplanation */
    MockExplanation: {
      /** @description Succeeded only. */
      body: components['schemas']['ExplanationBody'] | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /** Error Code */
      error_code: string | null;
      /** Finished At */
      finished_at: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Job Id */
      job_id: string | null;
      /**
       * Mock Exam Question Revision Id
       * Format: uuid
       */
      mock_exam_question_revision_id: string;
      /**
       * Sources
       * @description The cited sources (succeeded only).
       */
      sources: components['schemas']['ExplanationSource'][];
      /**
       * Status
       * @enum {string}
       */
      status: 'queued' | 'running' | 'succeeded' | 'failed';
      /** Truncated */
      truncated: boolean;
      /** Version */
      version: number;
    };
    /** MockExplanationRequest */
    MockExplanationRequest: {
      /**
       * Mock Practice Session Id
       * @description The caller's submitted mock practice session of this question.
       */
      mock_practice_session_id?: string | null;
      /**
       * View
       * @description `manage`: 모의고사 문제 관리 (owner/editor, no submission).
       */
      view?: 'manage' | null;
    };
    /** MockExplanationState */
    MockExplanationState: {
      /**
       * Available
       * @description This environment can make AI explanations.
       */
      available: boolean;
      /**
       * Can Create
       * @description available, active workspace, none for this revision.
       */
      can_create: boolean;
      /**
       * Can Regenerate
       * @description An owner/editor of an active workspace, a success.
       */
      can_regenerate: boolean;
      explanation: components['schemas']['MockExplanation'] | null;
    };
    /**
     * MockPracticeSession
     * @description What a viewer needs to show a mock exam question. Never carries answers, explanations,
     *     rubrics or accepted answers (a new field here is a reviewed change).
     */
    MockPracticeSession: {
      /**
       * Displayed Option Ids
       * @description The displayed order (MCQ), as ids.
       */
      displayed_option_ids: string[];
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Is Multi Answer */
      is_multi_answer: boolean;
      /**
       * Mock Exam Id
       * Format: uuid
       */
      mock_exam_id: string;
      /**
       * Mock Exam Question Id
       * Format: uuid
       */
      mock_exam_question_id: string;
      /**
       * Opened At
       * Format: date-time
       */
      opened_at: string;
      /**
       * Options
       * @description MCQ options in displayed order.
       */
      options: components['schemas']['PracticeOption'][];
      /**
       * Practice Run Id
       * @description The practice run this session practises a position of.
       */
      practice_run_id?: string | null;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /**
       * Revision Id
       * Format: uuid
       * @description The mock exam question revision graded on.
       */
      revision_id: string;
      /**
       * Run Position
       * @description That run position (1-based).
       */
      run_position?: number | null;
      /**
       * State
       * @enum {string}
       */
      state: 'open' | 'pending_grade' | 'graded';
      /** Stem */
      stem: string;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /** MockQuestionSourceRegion */
    MockQuestionSourceRegion: {
      /**
       * Mock Exam Question Id
       * Format: uuid
       */
      mock_exam_question_id: string;
      /** Regions */
      regions: components['schemas']['SourceRegionItem'][];
    };
    /** MockRelatedSources */
    MockRelatedSources: {
      /** Degraded */
      degraded: 'dense_unavailable'[];
      /** Id */
      id: string | null;
      /** Items */
      items: components['schemas']['RelatedSource'][];
      /**
       * Mock Exam Question Revision Id
       * Format: uuid
       */
      mock_exam_question_revision_id: string;
      /** Stored */
      stored: boolean;
    };
    /**
     * MockSubmitResult
     * @description The graded (or pending) submission with the pinned revision's answers revealed.
     */
    MockSubmitResult: {
      /** Accepted Answers */
      accepted_answers: string[] | null;
      /**
       * Attempt Id
       * Format: uuid
       * @description The attempt that holds the current result.
       */
      attempt_id: string;
      /** Correct Option Ids */
      correct_option_ids: string[] | null;
      /** Explanation */
      explanation: string | null;
      /**
       * Mock Exam Question Id
       * Format: uuid
       */
      mock_exam_question_id: string;
      /**
       * Practice Session Id
       * Format: uuid
       */
      practice_session_id: string;
      /**
       * Result
       * @enum {string}
       */
      result: 'correct' | 'incorrect' | 'pending';
      /**
       * Revision Id
       * Format: uuid
       */
      revision_id: string;
      /** Rubric */
      rubric: string | null;
      /**
       * State
       * @enum {string}
       */
      state: 'open' | 'pending_grade' | 'graded';
    };
    /** MyState */
    MyState: {
      /** Is Favorite */
      is_favorite: boolean;
      /** Last Graded Result */
      last_graded_result: ('correct' | 'incorrect') | null;
      /** Needs Retry */
      needs_retry: boolean;
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /**
       * Status
       * @enum {string}
       */
      status: 'unseen' | 'viewed' | 'incorrect' | 'correct' | 'retry';
    };
    /**
     * MyStateUpdate
     * @description Omitted flags are kept; at least one is required.
     */
    MyStateUpdate: {
      /** Expected Reset Epoch */
      expected_reset_epoch?: number | null;
      /** Is Favorite */
      is_favorite?: boolean | null;
      /**
       * Needs Retry
       * @description Never cleared by a correct answer, only by the user or by a later incorrect grading. Turning it on needs a correct last graded result (409 `retry-requires-correct`).
       */
      needs_retry?: boolean | null;
    };
    /** MyWorkspace */
    MyWorkspace: {
      /** Archived At */
      archived_at: string | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Name */
      name: string;
      /**
       * Role
       * @description The caller's membership role.
       * @enum {string}
       */
      role: 'owner' | 'editor' | 'viewer';
      /**
       * Status
       * @description Archived workspaces are read-only.
       * @enum {string}
       */
      status: 'active' | 'archived';
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
    };
    /** MyWorkspaceList */
    MyWorkspaceList: {
      /** Items */
      items: components['schemas']['MyWorkspace'][];
    };
    /** NoteFootnote */
    NoteFootnote: {
      /** Label */
      label: string;
      /** Number */
      number: number;
      /**
       * Question Id
       * @description null: no longer a CONFIRMED question of the chapter (deleted or moved).
       */
      question_id: string | null;
      /**
       * Stem Preview
       * @description First 40 characters of the current stem.
       */
      stem_preview: string | null;
    };
    /** NoteGeneration */
    NoteGeneration: {
      /**
       * Error Code
       * @description Why it failed (stable code): `llm_unavailable`, `llm_timeout`, `note_citation_invalid`, `llm_invalid_output`, ...
       */
      error_code: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Job Id
       * @description Job `chapter_note.generate`.
       */
      job_id: string | null;
      /** @description Batches of a large chapter while running. */
      progress: components['schemas']['NoteProgress'] | null;
      /**
       * Status
       * @enum {string}
       */
      status: 'queued' | 'running' | 'succeeded' | 'failed';
    };
    /** NoteHighlightTarget */
    NoteHighlightTarget: {
      /**
       * Chapter Note Id
       * Format: uuid
       */
      chapter_note_id: string;
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: 'note';
      /** Note Version */
      note_version: number;
    };
    /** NoteItem */
    NoteItem: {
      /**
       * Footnotes
       * @description Footnote numbers (at least one).
       */
      footnotes: number[];
      /** Text */
      text: string;
    };
    /** NoteProgress */
    NoteProgress: {
      /** Batches Done */
      batches_done: number;
      /** Batches Total */
      batches_total: number;
    };
    /** NoteQuestionRef */
    NoteQuestionRef: {
      /**
       * Label
       * @description `<n>장 <번호>번` (the Heatmap's numbering).
       */
      label: string;
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /**
       * Question Revision Id
       * Format: uuid
       * @description The revision the note was made from.
       */
      question_revision_id: string;
      /**
       * Tag
       * @description Input tag (`Q1`..`Qn`).
       */
      tag: string;
    };
    /** NoteSection */
    NoteSection: {
      /** Heading */
      heading: string;
      /** Items */
      items: components['schemas']['NoteItem'][];
    };
    /** NoteTargetIn */
    NoteTargetIn: {
      /**
       * Chapter Note Id
       * Format: uuid
       * @description A succeeded chapter note version.
       */
      chapter_note_id: string;
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: 'note';
    };
    /** NoteUsage */
    NoteUsage: {
      /**
       * Batches
       * @default 0
       */
      batches?: number;
      /** Cost Usd */
      cost_usd?: number | null;
      /**
       * Dropped Items
       * @default 0
       */
      dropped_items?: number;
      /** Input Tokens */
      input_tokens?: number | null;
      /**
       * Items
       * @default 0
       */
      items?: number;
      /**
       * Llm Calls
       * @default 0
       */
      llm_calls?: number;
      /** Output Tokens */
      output_tokens?: number | null;
    };
    /** NoteVersion */
    NoteVersion: {
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Note Id
       * Format: uuid
       */
      note_id: string;
      /** Question Count */
      question_count: number;
      /** Version */
      version: number;
    };
    /** OptionWhy */
    OptionWhy: {
      /** Option Id */
      option_id: string;
      /** Why Md */
      why_md: string;
    };
    /** Outline */
    Outline: {
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /** Items */
      items: components['schemas']['OutlineItem'][];
      /** @description Null while nothing is published yet. */
      revision: components['schemas']['RevisionInfo'] | null;
    };
    /** OutlineItem */
    OutlineItem: {
      /**
       * Block Id
       * @description The heading block that opens the section.
       */
      block_id: string | null;
      /** Children */
      children: components['schemas']['OutlineItem'][];
      /**
       * Id
       * Format: uuid
       * @description Chapter id of this revision (the `chapter_ids` value search and questions use). Changes with every revision; `section_key` does not.
       */
      id: string;
      /** Level */
      level: number;
      /**
       * Page
       * @description 1-based PDF page of the heading.
       */
      page: number | null;
      /**
       * Section Key
       * @description Stable section id across revisions.
       */
      section_key: string;
      /** Title */
      title: string;
    };
    /** OverviewChapter */
    OverviewChapter: {
      /** Document Id */
      document_id: string | null;
      /**
       * Id
       * @description null = the questions without a chapter.
       */
      id: string | null;
      /**
       * Number
       * @description Chapter number for `3장 12번` labels, if known.
       */
      number: number | null;
      /**
       * Question Count
       * @description Items of this group in `items`.
       */
      question_count: number;
      /** Title */
      title: string;
    };
    /** OverviewCounts */
    OverviewCounts: {
      /** Correct */
      correct: number;
      /**
       * Favorite
       * @description Overlaps the status counts.
       */
      favorite: number;
      /** Incorrect */
      incorrect: number;
      /** Retry */
      retry: number;
      /** Total */
      total: number;
      /** Unseen */
      unseen: number;
      /** Viewed */
      viewed: number;
    };
    /** OverviewItem */
    OverviewItem: {
      /** Chapter Id */
      chapter_id: string | null;
      /** Is Favorite */
      is_favorite: boolean;
      /**
       * Is Pending Grading
       * @description Latest submission awaits grading (채점 대기).
       */
      is_pending_grading: boolean;
      /** Last Graded Result */
      last_graded_result: ('correct' | 'incorrect') | null;
      /** Needs Retry */
      needs_retry: boolean;
      /**
       * Preview
       * @description First 1-3 lines of the stem; never the answer.
       */
      preview: string;
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /** Question Number */
      question_number: number | null;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /**
       * Status
       * @enum {string}
       */
      status: 'unseen' | 'viewed' | 'incorrect' | 'correct' | 'retry';
    };
    /** PracticeOption */
    PracticeOption: {
      /**
       * Id
       * @description Stable option id; submit it, never a position.
       */
      id: string;
      /** Text */
      text: string;
    };
    /** PracticeResetResult */
    PracticeResetResult: {
      /** Epochs */
      epochs: {
        [key: string]: number;
      };
      /** Reset */
      reset: boolean;
    };
    /**
     * PracticeRun
     * @description Counts, progress and summary only: never the item list or question content.
     */
    PracticeRun: {
      /**
       * Answered
       * @description Positions submitted.
       */
      answered: number;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /** Finished At */
      finished_at: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Mock Exam Id */
      mock_exam_id: string | null;
      /** Random Order */
      random_order: boolean;
      /**
       * Reached
       * @description The furthest position opened (0: none yet).
       */
      reached: number;
      /** Seed */
      seed: number;
      /**
       * Source
       * @enum {string}
       */
      source: 'bank' | 'mock';
      summary: components['schemas']['RunSummary'];
      /**
       * Total
       * @description Positions 1..total.
       */
      total: number;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /**
     * PracticeRunCreate
     * @description `source=bank`: the workspace's questions. `source=mock` (with `mock_exam_id`): the
     *     questions the mock exam lists now. Unknown body fields are ignored (never a workspace or user
     *     override).
     */
    PracticeRunCreate: {
      /** Mock Exam Id */
      mock_exam_id?: string | null;
      /** Question Count */
      question_count?: number | null;
      /**
       * Random Order
       * @default false
       */
      random_order?: boolean;
      range: components['schemas']['QuestionRange'];
      /**
       * Seed
       * @description Shuffle seed; the server picks one if absent.
       */
      seed?: number | null;
      /**
       * Source
       * @enum {string}
       */
      source: 'bank' | 'mock';
    };
    /**
     * PracticeSession
     * @description What the practice panel needs to show a question. Never carries answers, explanations,
     *     rubrics or accepted answers (a new field here is a reviewed change).
     */
    PracticeSession: {
      /** Chapter Id */
      chapter_id: string | null;
      /**
       * Displayed Option Ids
       * @description The displayed order (MCQ), as ids.
       */
      displayed_option_ids: string[];
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Is Multi Answer */
      is_multi_answer: boolean;
      /**
       * Opened At
       * Format: date-time
       */
      opened_at: string;
      /**
       * Options
       * @description MCQ options in displayed order.
       */
      options: components['schemas']['PracticeOption'][];
      /**
       * Practice Run Id
       * @description The practice run this session practises a position of.
       */
      practice_run_id?: string | null;
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /** Question Number */
      question_number: number | null;
      /**
       * Question Revision Id
       * Format: uuid
       * @description The revision this session is graded on.
       */
      question_revision_id: string;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /**
       * Run Position
       * @description That run position (1-based).
       */
      run_position?: number | null;
      /**
       * State
       * @enum {string}
       */
      state: 'open' | 'pending_grade' | 'graded';
      /** Stem */
      stem: string;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /**
     * PracticeSessionCreate
     * @description Option order and reset precondition; a run requires both run id and position.
     *
     *     A run position must hold this question and has at most one session.
     */
    PracticeSessionCreate: {
      /** Expected Reset Epoch */
      expected_reset_epoch?: number | null;
      /** Practice Run Id */
      practice_run_id?: string | null;
      /** Run Position */
      run_position?: number | null;
      /**
       * Shuffle Options
       * @default false
       */
      shuffle_options?: boolean;
    };
    /** PracticeSessionDetail */
    PracticeSessionDetail: {
      /** Chapter Id */
      chapter_id: string | null;
      /**
       * Displayed Option Ids
       * @description The displayed order (MCQ), as ids.
       */
      displayed_option_ids: string[];
      /** Graded At */
      graded_at: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Is Multi Answer */
      is_multi_answer: boolean;
      /**
       * Opened At
       * Format: date-time
       */
      opened_at: string;
      /**
       * Options
       * @description MCQ options in displayed order.
       */
      options: components['schemas']['PracticeOption'][];
      /** @description null while the session is open (no answers before submission). */
      outcome: components['schemas']['SubmitResult'] | null;
      /**
       * Practice Run Id
       * @description The practice run this session practises a position of.
       */
      practice_run_id?: string | null;
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /** Question Number */
      question_number: number | null;
      /**
       * Question Revision Id
       * Format: uuid
       * @description The revision this session is graded on.
       */
      question_revision_id: string;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /**
       * Run Position
       * @description That run position (1-based).
       */
      run_position?: number | null;
      /**
       * State
       * @enum {string}
       */
      state: 'open' | 'pending_grade' | 'graded';
      /** Stem */
      stem: string;
      /** Submitted At */
      submitted_at: string | null;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /** PreviewOption */
    PreviewOption: {
      /** Id */
      id: string;
      /** Text */
      text: string;
    };
    /** Problem */
    Problem: {
      /**
       * Detail
       * @default null
       */
      detail?: string | null;
      /**
       * Errors
       * @description Field-level issues (422 only).
       * @default null
       */
      errors?: components['schemas']['ValidationIssue'][] | null;
      /**
       * Instance
       * @description Request path.
       * @default null
       */
      instance?: string | null;
      /**
       * Question Ids
       * @description 409 `chapter-changed` of a chapter assignment: the questions whose chapter is no longer the expected one.
       * @default null
       */
      question_ids?: string[] | null;
      /**
       * Request Id
       * @default null
       */
      request_id?: string | null;
      /** Status */
      status: number;
      /** Title */
      title: string;
      /**
       * Type
       * @description Problem type URI.
       * @default about:blank
       */
      type?: string;
    };
    /** Profile */
    Profile: {
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /** Display Name */
      display_name: string | null;
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
    };
    /** PublishAccepted */
    PublishAccepted: {
      /**
       * Job Id
       * Format: uuid
       * @description The indexing job; poll `GET /jobs/{id}` or its SSE.
       */
      job_id: string;
      /**
       * Revision Id
       * Format: uuid
       * @description The draft revision being published.
       */
      revision_id: string;
    };
    /** PublishRequest */
    PublishRequest: {
      /**
       * Revision Id
       * @description The draft the client reviewed; 409 `edit-conflict` if it is not the draft.
       */
      revision_id?: string | null;
    };
    /** Question */
    Question: {
      chapter: components['schemas']['ChapterRef'] | null;
      /**
       * Chapter Id
       * @description Document outline node (`chapters.id`).
       */
      chapter_id: string | null;
      /**
       * Chapter Source
       * @description How the chapter was decided: `manual` (a person chose it: registration, edit, a move) or `auto` (a CHAPTER-MAP suggestion: import registration, an applied recommendation).
       * @enum {string}
       */
      chapter_source: 'manual' | 'auto';
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Origin
       * @description manual | import | generation
       */
      origin: string;
      /**
       * Publication Status
       * @enum {string}
       */
      publication_status: 'DRAFT' | 'CONFIRMED' | 'ARCHIVED';
      /**
       * Question Number
       * @description Display number (`12번`), not unique.
       */
      question_number: number | null;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /** @description The active revision. */
      revision: components['schemas']['QuestionRevision'];
      /** Sources */
      sources: components['schemas']['QuestionSource'][];
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /** QuestionCreate */
    QuestionCreate: {
      /**
       * Accepted Answers
       * @description SHORT_ANSWER only.
       */
      accepted_answers?: string[] | null;
      /** Chapter Id */
      chapter_id?: string | null;
      /**
       * Correct Option Ids
       * @description MCQ only; required when CONFIRMED.
       */
      correct_option_ids?: string[] | null;
      /** Explanation */
      explanation?: string | null;
      /**
       * Is Multi Answer
       * @default false
       */
      is_multi_answer?: boolean;
      /**
       * Options
       * @description MCQ only.
       */
      options?: components['schemas']['QuestionOption'][];
      /**
       * Publication Status
       * @description DRAFT or CONFIRMED (ARCHIVED is not a creation state).
       * @default CONFIRMED
       * @enum {string}
       */
      publication_status?: 'DRAFT' | 'CONFIRMED' | 'ARCHIVED';
      /** Question Number */
      question_number?: number | null;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /** Rubric */
      rubric?: string | null;
      /** Sources */
      sources?: components['schemas']['QuestionSourceInput'][];
      /** Stem */
      stem: string;
    };
    /** QuestionDetail */
    QuestionDetail: {
      chapter: components['schemas']['ChapterRef'] | null;
      /**
       * Chapter Id
       * @description Document outline node (`chapters.id`).
       */
      chapter_id: string | null;
      /**
       * Chapter Source
       * @description How the chapter was decided: `manual` (a person chose it: registration, edit, a move) or `auto` (a CHAPTER-MAP suggestion: import registration, an applied recommendation).
       * @enum {string}
       */
      chapter_source: 'manual' | 'auto';
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** @description Set for a question registered from a generated draft (origin `generation`). */
      lineage?: components['schemas']['QuestionLineage'] | null;
      /**
       * Origin
       * @description manual | import | generation
       */
      origin: string;
      /**
       * Publication Status
       * @enum {string}
       */
      publication_status: 'DRAFT' | 'CONFIRMED' | 'ARCHIVED';
      /**
       * Question Number
       * @description Display number (`12번`), not unique.
       */
      question_number: number | null;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /** @description The active revision. */
      revision: components['schemas']['QuestionRevision'];
      /**
       * Revisions
       * @description Every revision, newest first.
       */
      revisions: components['schemas']['quiz_api__api__questions__RevisionSummary'][];
      /** Sources */
      sources: components['schemas']['QuestionSource'][];
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /**
     * QuestionDraftUpdate
     * @description Partial update: omitted fields are kept; `null` clears a nullable field (an answer set
     *     to null means unknown).
     */
    QuestionDraftUpdate: {
      /** Accepted Answers */
      accepted_answers?: string[] | null;
      /**
       * Base Version
       * @description `version` of the draft being edited.
       */
      base_version: string;
      /**
       * Chapter Id
       * @description Import drafts (CHAPTER-MAP): the book chapter to register the draft under (a chapter of a book's current revision here; `null` = no chapter). Sending it replaces the suggestion with this choice; it is not content and keeps an approval.
       */
      chapter_id?: string | null;
      /** Correct Option Ids */
      correct_option_ids?: string[] | null;
      /** Explanation */
      explanation?: string | null;
      /** Is Multi Answer */
      is_multi_answer?: boolean | null;
      /** Options */
      options?: components['schemas']['QuestionOption'][] | null;
      /** Question Number */
      question_number?: number | null;
      /** Question Type */
      question_type?: ('MCQ' | 'SHORT_ANSWER' | 'ESSAY') | null;
      /**
       * Review Status
       * @description approve (needs a publishable draft) / reject / back to pending. Any other change without `approved` returns an approved draft to pending (it must be re-approved).
       */
      review_status?: ('pending' | 'approved' | 'rejected') | null;
      /**
       * Rubric
       * @description Essay model answer / criteria.
       */
      rubric?: string | null;
      /** Stem */
      stem?: string | null;
    };
    /**
     * QuestionLineage
     * @description Where a generated variant comes from (questions.md §5).
     */
    QuestionLineage: {
      /** Generation Run Id */
      generation_run_id: string | null;
      /**
       * Parent Question Id
       * Format: uuid
       */
      parent_question_id: string;
      /**
       * Source Question Revision Id
       * Format: uuid
       * @description The parent's revision the variant was generated from.
       */
      source_question_revision_id: string;
      /**
       * Variation Type
       * @description PARAPHRASE | INVERT_POLARITY | ANALOGOUS_CONCEPT
       */
      variation_type: string;
    };
    /** QuestionList */
    QuestionList: {
      /** Items */
      items: components['schemas']['Question'][];
      /**
       * Next Cursor
       * @description Pass as `cursor` for the next page.
       */
      next_cursor: string | null;
    };
    /** QuestionOption */
    QuestionOption: {
      /**
       * Id
       * @description Opaque, client-chosen id (no whitespace, unique in the question). Grading and practice use it; keep it when editing the option.
       */
      id: string;
      /** Text */
      text: string;
    };
    /** QuestionOverview */
    QuestionOverview: {
      /** Chapters */
      chapters: components['schemas']['OverviewChapter'][];
      /** @description Over the chapter/type/q scope; status/favorite/retry filters ignored. */
      counts: components['schemas']['OverviewCounts'];
      /** Items */
      items: components['schemas']['OverviewItem'][];
    };
    /**
     * QuestionPreview
     * @description Stem and options only: no answer, explanation, rubric, source or per-user field.
     */
    QuestionPreview: {
      /** Chapter Title */
      chapter_title: string | null;
      /**
       * Number Label
       * @description "<n>장 <번호>번" like the Heatmap, or "<번호>번".
       */
      number_label: string;
      /**
       * Options
       * @description Original order; empty for text answers.
       */
      options: components['schemas']['PreviewOption'][];
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /**
       * Stem
       * @description The active revision's stem, unaltered.
       */
      stem: string;
    };
    /**
     * QuestionRange
     * @description Whole groups (`all`, `chapter_ids`) plus single questions, minus exclusions, narrowed by
     *     `filters`. Id lists are capped at 5,000 entries each.
     */
    QuestionRange: {
      /**
       * All
       * @description Every question of the Heatmap.
       * @default false
       */
      all?: boolean;
      /** Chapter Ids */
      chapter_ids?: (string | 'none')[];
      /** Excluded Question Ids */
      excluded_question_ids?: string[];
      filters?: components['schemas']['RangeFilters'];
      /** Question Ids */
      question_ids?: string[];
    };
    /** QuestionRevision */
    QuestionRevision: {
      /**
       * Accepted Answers
       * @description null = not auto-gradable.
       */
      accepted_answers: string[] | null;
      /**
       * Correct Option Ids
       * @description null = answer unknown.
       */
      correct_option_ids: string[] | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /** Explanation */
      explanation: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Is Multi Answer */
      is_multi_answer: boolean;
      /** Options */
      options: components['schemas']['QuestionOption'][];
      /** Rubric */
      rubric: string | null;
      /** Stem */
      stem: string;
      /** Version */
      version: number;
    };
    /** QuestionSource */
    QuestionSource: {
      /**
       * Block Ids
       * @description Canonical text blocks of the source in that document (block ids are stable across revisions); empty when the source names pages only.
       */
      block_ids?: string[];
      /** Document Id */
      document_id: string | null;
      /**
       * Document Revision Id
       * @description The document revision that was active when the source was saved.
       */
      document_revision_id: string | null;
      /**
       * Imported
       * @description The question's printed place in a question PDF (a question import), not a passage the question cites.
       * @default false
       */
      imported?: boolean;
      /** Page End */
      page_end: number | null;
      /** Page Start */
      page_start: number | null;
    };
    /** QuestionSourceInput */
    QuestionSourceInput: {
      /**
       * Document Id
       * Format: uuid
       * @description A live document of this workspace.
       */
      document_id: string;
      /**
       * Page End
       * @description Defaults to `page_start`.
       */
      page_end?: number | null;
      /** Page Start */
      page_start?: number | null;
    };
    /** QuestionSourceRegion */
    QuestionSourceRegion: {
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /** Regions */
      regions: components['schemas']['SourceRegionItem'][];
    };
    /**
     * QuestionUpdate
     * @description Partial update: omitted fields are kept, `null` clears a nullable field.
     */
    QuestionUpdate: {
      /** Accepted Answers */
      accepted_answers?: string[] | null;
      /**
       * Base Revision Id
       * Format: uuid
       * @description The active revision the edit is based on.
       */
      base_revision_id: string;
      /** Chapter Id */
      chapter_id?: string | null;
      /** Correct Option Ids */
      correct_option_ids?: string[] | null;
      /** Explanation */
      explanation?: string | null;
      /** Is Multi Answer */
      is_multi_answer?: boolean | null;
      /** Options */
      options?: components['schemas']['QuestionOption'][] | null;
      /** Publication Status */
      publication_status?: ('DRAFT' | 'CONFIRMED' | 'ARCHIVED') | null;
      /** Question Number */
      question_number?: number | null;
      /**
       * Question Type
       * @description Must equal the current type (changing it is refused).
       */
      question_type?: ('MCQ' | 'SHORT_ANSWER' | 'ESSAY') | null;
      /** Rubric */
      rubric?: string | null;
      /** Sources */
      sources?: components['schemas']['QuestionSourceInput'][] | null;
      /** Stem */
      stem?: string | null;
    };
    /** RevisionSummary */
    quiz_api__api__documents__RevisionSummary: {
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Published At */
      published_at: string | null;
      /** Revision Number */
      revision_number: number;
      /**
       * Status
       * @enum {string}
       */
      status: 'draft' | 'published';
    };
    /** RevisionSummary */
    quiz_api__api__questions__RevisionSummary: {
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Version */
      version: number;
    };
    /**
     * RangeFilters
     * @description The overview's state/type filters (GET /workspaces/{id}/questions/overview).
     */
    RangeFilters: {
      /** Favorite */
      favorite?: boolean | null;
      /**
       * Retry
       * @description The `needs_retry` flag.
       */
      retry?: boolean | null;
      /**
       * Status
       * @description Keep these dot statuses; empty selects none, omitted selects all.
       */
      status?: ('unseen' | 'viewed' | 'incorrect' | 'correct' | 'retry')[] | null;
      /** Type */
      type?: ('MCQ' | 'SHORT_ANSWER' | 'ESSAY') | null;
    };
    /** ReadinessReport */
    ReadinessReport: {
      /** Checks */
      checks: {
        [key: string]: components['schemas']['DependencyStatus'];
      };
      /**
       * Status
       * @enum {string}
       */
      status: 'ok' | 'unavailable';
    };
    /** RedistributionChapter */
    RedistributionChapter: {
      /** Document Id */
      document_id?: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Title */
      title: string;
    };
    /** RedistributionGroup */
    RedistributionGroup: {
      /** Document Id */
      document_id: string | null;
      /**
       * Id
       * @description null = "챕터 없음" (always last).
       */
      id: string | null;
      /**
       * Number
       * @description Chapter number for labels, if known.
       */
      number: number | null;
      /** Question Count */
      question_count: number;
      /** Title */
      title: string;
    };
    /** RedistributionList */
    RedistributionList: {
      /**
       * Chapters
       * @description Groups of `items`, Heatmap order.
       */
      chapters: components['schemas']['RedistributionGroup'][];
      /**
       * Items
       * @description Heatmap order.
       */
      items: components['schemas']['RedistributionQuestion'][];
      /**
       * Targets
       * @description Chapters a question may move to (live books' current revisions; "챕터 없음" = `chapter_id: null` is always allowed).
       */
      targets: components['schemas']['RedistributionTargetDocument'][];
    };
    /** RedistributionPreview */
    RedistributionPreview: {
      /**
       * Items
       * @description Only questions whose chapter would change.
       */
      items: components['schemas']['RedistributionPreviewItem'][];
      /**
       * No Recommendation
       * @description Questions without a recommendation, by reason (non-zero only).
       */
      no_recommendation: {
        [key: string]: number;
      };
      /**
       * Skipped Manual
       * @description `manual` questions not computed (include_manual).
       */
      skipped_manual: number;
      /**
       * Unchanged
       * @description Recommended chapter = current chapter.
       */
      unchanged: number;
    };
    /** RedistributionPreviewItem */
    RedistributionPreviewItem: {
      /** @description null = "챕터 없음". */
      current_chapter: components['schemas']['RedistributionChapter'] | null;
      /** Number Label */
      number_label: string;
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /**
       * Reason
       * @description source_in_book (출처 교재의 장) | matched (문제지 장 제목과 일치) | paper_chapter (일치하는 교재 장이 없어 문제지 자신의 최상위 장).
       * @enum {string}
       */
      reason: 'source_in_book' | 'matched' | 'paper_chapter';
      recommended_chapter: components['schemas']['RedistributionChapter'];
      /** Stem Preview */
      stem_preview: string;
    };
    /** RedistributionPreviewRequest */
    RedistributionPreviewRequest: {
      /**
       * All
       * @description Every confirmed question (nothing selected).
       * @default false
       */
      all?: boolean;
      /**
       * Include Manual
       * @description Also recommend for chapters a person chose (`manual`).
       * @default false
       */
      include_manual?: boolean;
      /**
       * Question Ids
       * @description The selected questions (ids that are not confirmed questions here are ignored).
       */
      question_ids?: string[] | null;
    };
    /** RedistributionQuestion */
    RedistributionQuestion: {
      /** Chapter Id */
      chapter_id: string | null;
      /**
       * Chapter Source
       * @description `manual` rows show 직접 정함.
       * @enum {string}
       */
      chapter_source: 'manual' | 'auto';
      /**
       * Label
       * @description Display label, e.g. "1장 3번" (chapter number, number).
       */
      label: string;
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /** Question Number */
      question_number: number | null;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /**
       * Stem Preview
       * @description The stem's first 40 characters.
       */
      stem_preview: string;
    };
    /** RedistributionTargetChapter */
    RedistributionTargetChapter: {
      /**
       * Depth
       * @description Outline level (1 = top level).
       */
      depth: number;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Title */
      title: string;
    };
    /** RedistributionTargetDocument */
    RedistributionTargetDocument: {
      /**
       * Chapters
       * @description Outline order.
       */
      chapters: components['schemas']['RedistributionTargetChapter'][];
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /** Document Title */
      document_title: string;
    };
    /** RegionBox */
    RegionBox: {
      /** X0 */
      x0: number;
      /** X1 */
      x1: number;
      /** Y0 */
      y0: number;
      /** Y1 */
      y1: number;
    };
    /** RelatedSource */
    RelatedSource: {
      /**
       * Block Id
       * @description The passage's first block (DOC-02 / excerpt panel).
       */
      block_id: string;
      /**
       * Block Ids
       * @description The passage's blocks in reading order (the first is `block_id`); the excerpt panel shows all of them.
       */
      block_ids: string[];
      /**
       * Chapter Id
       * @description Top-level chapter of the passage.
       */
      chapter_id: string | null;
      /** Chapter Title */
      chapter_title: string | null;
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /** Document Title */
      document_title: string;
      /**
       * Excerpt
       * @description At most 300 characters, whole paragraphs where possible.
       */
      excerpt: string;
      /**
       * From Question Source
       * @description One of the question's own sources (문제 출처).
       */
      from_question_source: boolean;
      /**
       * Highlights
       * @description Query-term ranges in `excerpt` (<mark>).
       */
      highlights: components['schemas']['TextSpan'][];
      /** Page End */
      page_end: number;
      /** Page Start */
      page_start: number;
      /**
       * Rank
       * @description 1-based position in the list.
       */
      rank: number;
      /**
       * Revision Id
       * Format: uuid
       * @description The document revision the passage is from.
       */
      revision_id: string;
      /**
       * Score
       * @description Relevance (or fusion) score of a search hit; null for sources.
       */
      score?: number | null;
      /**
       * Stale
       * @description The revision is no longer the document's published one.
       */
      stale: boolean;
    };
    /** RelatedSources */
    RelatedSources: {
      /**
       * Degraded
       * @description `dense_unavailable`: keyword (BM25) results only, not stored.
       */
      degraded: 'dense_unavailable'[];
      /**
       * Id
       * @description The stored list (the same for every reader of the key); null when the list was computed but not stored (archived workspace, degraded search).
       */
      id: string | null;
      /** Items */
      items: components['schemas']['RelatedSource'][];
      /**
       * Question Revision Id
       * Format: uuid
       */
      question_revision_id: string;
      /** Stored */
      stored: boolean;
    };
    /** RestoredDraft */
    RestoredDraft: {
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /** @description The draft now holding the restored content. */
      revision: components['schemas']['RevisionInfo'];
    };
    /**
     * ResumableUpload
     * @description TUS (resumable) alternative to the single PUT, for large files and flaky networks.
     */
    ResumableUpload: {
      /**
       * Endpoint
       * @description TUS creation endpoint.
       */
      endpoint: string;
      /**
       * Headers
       * @description Send on every TUS request (carries the token).
       */
      headers: {
        [key: string]: string;
      };
      /**
       * Metadata
       * @description TUS `Upload-Metadata` entries.
       */
      metadata: {
        [key: string]: string;
      };
    };
    /** RetrySession */
    RetrySession: {
      /** Chapter Id */
      chapter_id: string | null;
      /** Displayed Option Ids */
      displayed_option_ids: string[];
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Is Multi Answer */
      is_multi_answer: boolean;
      /**
       * Opened At
       * Format: date-time
       */
      opened_at: string;
      /** Options */
      options: components['schemas']['RunOption'][];
      /** Practice Run Id */
      practice_run_id?: string | null;
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /** Question Number */
      question_number: number | null;
      /**
       * Question Revision Id
       * Format: uuid
       */
      question_revision_id: string;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /** Run Position */
      run_position?: number | null;
      /**
       * State
       * @enum {string}
       */
      state: 'open' | 'pending_grade' | 'graded';
      /** Stem */
      stem: string;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /** RetrySessionCreate */
    RetrySessionCreate: {
      /** Expected Reset Epoch */
      expected_reset_epoch?: number | null;
    };
    /** ReviewedImportDraft */
    ReviewedImportDraft: {
      /**
       * Chapter Id
       * @description CHAPTER-MAP: the chapter shown for the draft (`null` = 챕터 없음). When sent, the request is refused with 409 `chapter-changed` if the draft's chapter is no longer that one (e.g. a book was added and the suggestion changed): reload and review again. Omitted = not checked.
       */
      chapter_id?: string | null;
      /**
       * Draft Id
       * Format: uuid
       */
      draft_id: string;
      /**
       * Version
       * @description The `version` of the draft that was approved.
       */
      version: string;
    };
    /** RevisionHistory */
    RevisionHistory: {
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /** Items */
      items: components['schemas']['RevisionHistoryItem'][];
    };
    /** RevisionHistoryItem */
    RevisionHistoryItem: {
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Is Active
       * @description The published revision search and the viewer use.
       */
      is_active: boolean;
      /** @description The newest parse/publish job of this revision. */
      job: components['schemas']['RevisionJob'] | null;
      /** Parent Revision Id */
      parent_revision_id: string | null;
      /** Published At */
      published_at: string | null;
      /** Revision Number */
      revision_number: number;
      /**
       * Status
       * @enum {string}
       */
      status: 'draft' | 'published';
    };
    /** RevisionInfo */
    RevisionInfo: {
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Is Active
       * @description The published revision search and the viewer use.
       */
      is_active: boolean;
      /** Parent Revision Id */
      parent_revision_id: string | null;
      /** Published At */
      published_at: string | null;
      /** Revision Number */
      revision_number: number;
      /**
       * Status
       * @enum {string}
       */
      status: 'draft' | 'published';
    };
    /** RevisionJob */
    RevisionJob: {
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Status
       * @description queued | running | succeeded | failed | cancelled
       */
      status: string;
    };
    /**
     * RunAttempt
     * @description The submitted position's result with its answers (present only after submission).
     */
    RunAttempt: {
      /** Accepted Answers */
      accepted_answers: string[] | null;
      /**
       * Attempt Id
       * Format: uuid
       */
      attempt_id: string;
      /** Correct Option Ids */
      correct_option_ids: string[] | null;
      /** Explanation */
      explanation: string | null;
      /**
       * Result
       * @enum {string}
       */
      result: 'correct' | 'incorrect' | 'pending';
      /** Rubric */
      rubric: string | null;
      submitted_answer: components['schemas']['RunSubmittedAnswer'];
    };
    /**
     * RunItem
     * @description One position. `available=false` (deleted or archived since the run started): no content.
     *     Before submission no answer field exists anywhere outside `attempt` (null).
     */
    RunItem: {
      attempt: components['schemas']['RunAttempt'] | null;
      /** Available */
      available: boolean;
      /** Chapter Id */
      chapter_id: string | null;
      /**
       * Chapter Number
       * @description For `3장 12번` labels, if known.
       */
      chapter_number: number | null;
      /** Chapter Title */
      chapter_title: string | null;
      /** Is Multi Answer */
      is_multi_answer: boolean | null;
      /**
       * Options
       * @description MCQ options; in the session's displayed order once a session is open.
       */
      options: components['schemas']['RunOption'][];
      /** Position */
      position: number;
      /**
       * Practice Session Id
       * @description This position's session, if any.
       */
      practice_session_id: string | null;
      /** Question Id */
      question_id: string | null;
      /** Question Number */
      question_number: number | null;
      /** Question Type */
      question_type: ('MCQ' | 'SHORT_ANSWER' | 'ESSAY') | null;
      /** Reset Epoch */
      reset_epoch?: number | null;
      /** Session State */
      session_state: ('open' | 'pending_grade' | 'graded') | null;
      /** Stem */
      stem: string | null;
      /** Total */
      total: number;
    };
    /** RunOption */
    RunOption: {
      /**
       * Id
       * @description Stable option id; submit it, never a position.
       */
      id: string;
      /** Text */
      text: string;
    };
    /** RunResultItem */
    RunResultItem: {
      /** Available */
      available: boolean;
      /** Chapter Id */
      chapter_id: string | null;
      /** Chapter Number */
      chapter_number: number | null;
      /** Chapter Title */
      chapter_title: string | null;
      /** Position */
      position: number;
      /**
       * Preview
       * @description First lines of the stem; never the answer.
       */
      preview: string | null;
      /** Question Id */
      question_id: string | null;
      /** Question Number */
      question_number: number | null;
      /** Question Type */
      question_type: ('MCQ' | 'SHORT_ANSWER' | 'ESSAY') | null;
      /**
       * Result
       * @description null: not reached yet (open run).
       */
      result: ('correct' | 'incorrect' | 'pending' | 'skipped' | 'reset') | null;
    };
    /** RunResults */
    RunResults: {
      /** Items */
      items: components['schemas']['RunResultItem'][];
      /** Limit */
      limit: number;
      /** Offset */
      offset: number;
      /** Total */
      total: number;
    };
    /** RunSubmittedAnswer */
    RunSubmittedAnswer: {
      /** Answer Text */
      answer_text?: string | null;
      /** Selected Option Ids */
      selected_option_ids?: string[] | null;
    };
    /** RunSummary */
    RunSummary: {
      /** Correct */
      correct: number;
      /** Incorrect */
      incorrect: number;
      /** Pending */
      pending: number;
      /** Skipped */
      skipped: number;
    };
    /** SearchItem */
    SearchItem: {
      /** @description Box of `block_id` on `page`. */
      bbox: components['schemas']['HitBoundingBox'] | null;
      /**
       * Block Id
       * @description Where to jump: the first matched block.
       */
      block_id: string;
      /**
       * Block Ids
       * @description Blocks the hit itself covers.
       */
      block_ids: string[];
      /**
       * Breadcrumb
       * @description Document title, then the section path.
       */
      breadcrumb: string[];
      /**
       * Chapter Id
       * @description Top-level outline node (chapter) of the hit, in this revision.
       */
      chapter_id: string | null;
      /** Chunk Id */
      chunk_id: string;
      /**
       * Context Block Ids
       * @description Every block shown in `text`.
       */
      context_block_ids: string[];
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /** Document Title */
      document_title: string;
      /**
       * Document Type
       * @description `book` (question papers are never searched, so never `question_paper`).
       */
      document_type: string;
      /**
       * Highlights
       * @description The matched passage inside `text`.
       */
      highlights: components['schemas']['TextRange'][];
      /** Language */
      language: string | null;
      /**
       * Locations
       * @description Every page/box of `context_block_ids`.
       */
      locations: components['schemas']['HitLocation'][];
      /**
       * Page
       * @description 1-based PDF page of `block_id`.
       */
      page: number;
      /** Rank */
      rank: number;
      /**
       * Revision Id
       * Format: uuid
       * @description The published revision the hit comes from.
       */
      revision_id: string;
      /** Score */
      score: number;
      /**
       * Score Type
       * @enum {string}
       */
      score_type: 'bm25' | 'cosine' | 'rrf' | 'rerank';
      /**
       * Section Id
       * @description Outline node of the hit's own section (the chapter or a sub-section).
       */
      section_id: string | null;
      /**
       * Term Highlights
       * @description Query terms inside `text`.
       */
      term_highlights: components['schemas']['TextRange'][];
      /**
       * Text
       * @description Excerpt: the matched paragraphs plus context, canonical text.
       */
      text: string;
      /** Truncated End */
      truncated_end: boolean;
      /** Truncated Start */
      truncated_start: boolean;
    };
    /** SearchRequest */
    SearchRequest: {
      /**
       * Chapter Ids
       * @description Only these outline nodes (chapter or section) and their sub-sections.
       */
      chapter_ids?: string[] | null;
      /**
       * Document Ids
       * @description Only these documents.
       */
      document_ids?: string[] | null;
      /**
       * Include Question Papers
       * @deprecated
       * @description Ignored: question papers are never searched (UX7-SEARCH-2). Accepted so older clients keep working.
       * @default false
       */
      include_question_papers?: boolean;
      /**
       * Languages
       * @description Only passages in these languages, e.g. `en`.
       */
      languages?: string[] | null;
      /**
       * Limit
       * @default 10
       */
      limit?: number;
      /**
       * Mode
       * @description `keyword` (BM25), `semantic` (dense) or `hybrid` (both fused with RRF).
       * @default hybrid
       * @enum {string}
       */
      mode?: 'keyword' | 'semantic' | 'hybrid';
      /**
       * Query
       * @description Free text in any language. Longer than 1000 characters is truncated (with a warning); blank is 422.
       */
      query: string;
    };
    /** SearchResponse */
    SearchResponse: {
      /**
       * Degraded
       * @description Degradations of this answer (SEARCH-01-AC06). `dense_unavailable`: the query could not be embedded, so `semantic`/`hybrid` returned keyword (BM25) results only.
       */
      degraded?: 'dense_unavailable'[];
      /** Items */
      items: components['schemas']['SearchItem'][];
      /**
       * Mode
       * @enum {string}
       */
      mode: 'keyword' | 'semantic' | 'hybrid';
      /**
       * Query
       * @description The query as searched (normalised, maybe truncated).
       */
      query: string;
      /**
       * Query Language
       * @description Script hint: `ko`, `en`, `mixed` or null.
       */
      query_language: string | null;
      /**
       * Truncated
       * @description The query was cut to the maximum length.
       */
      truncated: boolean;
      /** Warnings */
      warnings: string[];
    };
    /** SelfGradeBody */
    SelfGradeBody: {
      /**
       * Result
       * @enum {string}
       */
      result: 'correct' | 'incorrect';
    };
    /** SelfGradeResult */
    SelfGradeResult: {
      /**
       * Attempt Id
       * Format: uuid
       */
      attempt_id: string;
      /**
       * Grades Attempt Id
       * Format: uuid
       * @description The pending attempt this grade settles.
       */
      grades_attempt_id: string;
      /**
       * Practice Session Id
       * Format: uuid
       */
      practice_session_id: string;
      /**
       * Result
       * @enum {string}
       */
      result: 'correct' | 'incorrect';
    };
    /** SessionExchange */
    SessionExchange: {
      /**
       * Secret
       * @description The `k` value of the share URL fragment (`#k=…`), sent once.
       */
      secret: string;
    };
    /** SharedChapterNote */
    SharedChapterNote: {
      /**
       * Chapter Id
       * Format: uuid
       */
      chapter_id: string;
      /** Chapter Title */
      chapter_title: string;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Footnotes
       * @description `question_id` links a published question (the shared question panel).
       */
      footnotes: components['schemas']['NoteFootnote'][];
      /** Question Count */
      question_count: number;
      /** Sections */
      sections: components['schemas']['NoteSection'][];
      /**
       * Stale
       * @description Questions were added to the chapter since the note.
       */
      stale: boolean;
    };
    /** SharedChapterNoteList */
    SharedChapterNoteList: {
      /**
       * Items
       * @description Chapters whose newest note can be shown, in outline order.
       */
      items: components['schemas']['SharedChapterNoteSummary'][];
    };
    /** SharedChapterNoteSummary */
    SharedChapterNoteSummary: {
      /**
       * Chapter Id
       * Format: uuid
       */
      chapter_id: string;
      /** Chapter Title */
      chapter_title: string;
    };
    /** SharedDocument */
    SharedDocument: {
      /**
       * Blocks
       * @description Blocks in reading order (one page).
       */
      blocks: components['schemas']['ContentBlock'][];
      /** Document Type */
      document_type: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Next After
       * @description Pass as `after` for the next page of blocks.
       */
      next_after: number | null;
      /**
       * Outline
       * @description Chapter/section tree of the revision.
       */
      outline: components['schemas']['OutlineItem'][];
      /**
       * Revision Id
       * Format: uuid
       */
      revision_id: string;
      /** Title */
      title: string;
    };
    /** SharedDocumentSummary */
    SharedDocumentSummary: {
      /**
       * Document Type
       * @description `book` or `question_paper`.
       */
      document_type: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Revision Id
       * Format: uuid
       * @description The published revision shown to guests.
       */
      revision_id: string;
      /** Title */
      title: string;
    };
    /** SharedExplanation */
    SharedExplanation: {
      body: components['schemas']['ExplanationBody'];
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /** Sources */
      sources: components['schemas']['ExplanationSource'][];
    };
    /**
     * SharedQuestion
     * @description A published question with its answer and explanation; no per-user or owner fields.
     */
    SharedQuestion: {
      chapter: components['schemas']['ChapterRef'] | null;
      /** Chapter Id */
      chapter_id: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Question Number */
      question_number: number | null;
      /**
       * Question Type
       * @enum {string}
       */
      question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
      /** @description The active (published) revision. */
      revision: components['schemas']['QuestionRevision'];
      /**
       * Sources
       * @description Sources in shared documents only.
       */
      sources: components['schemas']['QuestionSource'][];
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
    };
    /** SharedQuestionList */
    SharedQuestionList: {
      /** Items */
      items: components['schemas']['SharedQuestion'][];
      /** Next Cursor */
      next_cursor: string | null;
    };
    /** SharedRelatedSource */
    SharedRelatedSource: {
      /**
       * Block Id
       * @description The passage's first block (DOC-02 / excerpt panel).
       */
      block_id: string;
      /**
       * Block Ids
       * @description The passage's blocks in reading order (the first is `block_id`); the excerpt panel shows all of them.
       */
      block_ids: string[];
      /**
       * Chapter Id
       * @description Top-level chapter of the passage.
       */
      chapter_id: string | null;
      /** Chapter Title */
      chapter_title: string | null;
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /** Document Title */
      document_title: string;
      /**
       * Excerpt
       * @description At most 300 characters, whole paragraphs where possible.
       */
      excerpt: string;
      /**
       * From Question Source
       * @description One of the question's own sources (문제 출처).
       */
      from_question_source: boolean;
      /**
       * Highlights
       * @description Query-term ranges in `excerpt` (<mark>).
       */
      highlights: components['schemas']['TextSpan'][];
      /** Page End */
      page_end: number;
      /** Page Start */
      page_start: number;
      /**
       * Rank
       * @description 1-based position in the list.
       */
      rank: number;
    };
    /** SharedRelatedSources */
    SharedRelatedSources: {
      /** Items */
      items: components['schemas']['SharedRelatedSource'][];
    };
    /** SharedSearchResponse */
    SharedSearchResponse: {
      /**
       * Degraded
       * @description As in `SearchResponse`: `dense_unavailable` = keyword (BM25) results only.
       */
      degraded?: 'dense_unavailable'[];
      /** Items */
      items: components['schemas']['SearchItem'][];
      /**
       * Mode
       * @enum {string}
       */
      mode: 'keyword' | 'semantic' | 'hybrid';
      /**
       * Query Language
       * @description Script hint: `ko`, `en`, `mixed` or null.
       */
      query_language: string | null;
      /**
       * Truncated
       * @description The query was cut to the maximum length.
       */
      truncated: boolean;
      /** Warnings */
      warnings: string[];
    };
    /**
     * SharedSummary
     * @description What a share-link guest sees: the current published revision's summary only.
     */
    SharedSummary: {
      /** Chapters */
      chapters: components['schemas']['ChapterSummary'][];
      document: components['schemas']['SummaryUnit'];
      /** Published At */
      published_at: string | null;
      /**
       * Revision Id
       * Format: uuid
       */
      revision_id: string;
    };
    /** SharedWorkspace */
    SharedWorkspace: {
      /**
       * Allow Fork
       * @description Signed-in guests may fork (WS-VIEW-01-AC06).
       */
      allow_fork: boolean;
      /**
       * Documents
       * @description Documents with a published revision, oldest first.
       */
      documents: components['schemas']['SharedDocumentSummary'][];
      /**
       * Expires At
       * @description When the link expires; null: never.
       */
      expires_at: string | null;
      workspace: components['schemas']['SharedWorkspaceInfo'];
    };
    /** SharedWorkspaceInfo */
    SharedWorkspaceInfo: {
      /**
       * Archived
       * @description Archived workspaces stay readable through the link.
       */
      archived: boolean;
      /** Name */
      name: string;
    };
    /**
     * ShareLink
     * @description A share link's metadata (never its raw `secret` or `token_digest`).
     */
    ShareLink: {
      /**
       * Allow Fork
       * @description Whether signed-in viewers may fork (default off).
       */
      allow_fork: boolean;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Expires At
       * @description Null: never expires.
       */
      expires_at: string | null;
      /**
       * Id
       * Format: uuid
       * @description The public share id (`/share/{id}`).
       */
      id: string;
      /** Revoked At */
      revoked_at: string | null;
      /**
       * Rotated From Id
       * @description The revoked link this one replaced (rotate).
       */
      rotated_from_id: string | null;
      /**
       * Share Url
       * @description `<web origin>/share/{id}#k={secret}` for non-revoked links whose secret can be reconstructed by the server; null when revoked or unavailable.
       */
      share_url?: string | null;
      /**
       * Status
       * @description Derived from revoked_at / expires_at.
       * @enum {string}
       */
      status: 'active' | 'expired' | 'revoked';
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /** ShareLinkCreate */
    ShareLinkCreate: {
      /**
       * Allow Fork
       * @default false
       */
      allow_fork?: boolean;
      /**
       * Expires At
       * @description Future instant with a UTC offset; null or absent: no expiry.
       */
      expires_at?: string | null;
    };
    /** ShareLinkList */
    ShareLinkList: {
      /** Items */
      items: components['schemas']['ShareLink'][];
    };
    /**
     * ShareLinkUpdate
     * @description Only the fields present change; `expires_at: null` removes the expiry.
     */
    ShareLinkUpdate: {
      /** Allow Fork */
      allow_fork?: boolean | null;
      /** Expires At */
      expires_at?: string | null;
    };
    /** SignedReadUrl */
    SignedReadUrl: {
      /**
       * Expires At
       * Format: date-time
       */
      expires_at: string;
      /**
       * Url
       * @description Short-lived signed URL of the original PDF. Do not store it.
       */
      url: string;
    };
    /** Source */
    Source: {
      /** Block Ids */
      block_ids: string[];
      /** Chapter Id */
      chapter_id: string | null;
      /** Chapter Title */
      chapter_title: string | null;
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /** Document Title */
      document_title: string;
      /** Document Type */
      document_type: string;
      /**
       * Number
       * @description The footnote number `[n]` in the answer text.
       */
      number: number;
      /**
       * Outdated
       * @description The revision is no longer the published one.
       */
      outdated: boolean;
      /** Page From */
      page_from: number;
      /** Page To */
      page_to: number;
      /**
       * Revision Id
       * Format: uuid
       * @description The published revision the passage was read in.
       */
      revision_id: string;
    };
    /** SourceRegionItem */
    SourceRegionItem: {
      bbox: components['schemas']['RegionBox'];
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /** Document Revision Id */
      document_revision_id: string | null;
      /** Page */
      page: number;
    };
    /**
     * SubmitBody
     * @description `selected_option_ids` for an MCQ (one id unless multi-answer), `answer_text` otherwise.
     */
    SubmitBody: {
      /** Answer Text */
      answer_text?: string | null;
      /** Selected Option Ids */
      selected_option_ids?: string[] | null;
    };
    /**
     * SubmitResult
     * @description The graded (or pending) submission with the pinned revision's answers revealed.
     */
    SubmitResult: {
      /** Accepted Answers */
      accepted_answers: string[] | null;
      /**
       * Attempt Id
       * Format: uuid
       * @description The attempt that holds the current result.
       */
      attempt_id: string;
      /** Correct Option Ids */
      correct_option_ids: string[] | null;
      /** Explanation */
      explanation: string | null;
      /**
       * Practice Session Id
       * Format: uuid
       */
      practice_session_id: string;
      /**
       * Question Revision Id
       * Format: uuid
       */
      question_revision_id: string;
      /**
       * Result
       * @enum {string}
       */
      result: 'correct' | 'incorrect' | 'pending';
      /** Rubric */
      rubric: string | null;
      /**
       * State
       * @enum {string}
       */
      state: 'open' | 'pending_grade' | 'graded';
    };
    /** SubmittedAnswer */
    SubmittedAnswer: {
      /** Answer Text */
      answer_text?: string | null;
      /** Selected Option Ids */
      selected_option_ids?: string[] | null;
    };
    /** Summary */
    Summary: {
      /**
       * Chapters
       * @description Top-level chapters in outline order.
       */
      chapters: components['schemas']['ChapterSummary'][];
      document: components['schemas']['SummaryUnit'];
      /** Published At */
      published_at: string | null;
      /**
       * Revision Id
       * Format: uuid
       */
      revision_id: string;
      /**
       * Run Id
       * Format: uuid
       */
      run_id: string;
      usage: components['schemas']['SummaryUsage'] | null;
    };
    /** SummaryKeyPoint */
    SummaryKeyPoint: {
      /** @description Pages the point is based on (inside the chapter's range), or null. */
      pages: components['schemas']['SummaryPages'] | null;
      /** Text */
      text: string;
    };
    /** SummaryPages */
    SummaryPages: {
      /** From */
      from: number;
      /** To */
      to: number;
    };
    /** SummaryProgress */
    SummaryProgress: {
      /** Chapters Done */
      chapters_done: number;
      /** Chapters Total */
      chapters_total: number;
    };
    /** SummaryRun */
    SummaryRun: {
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Error Code
       * @description llm_unavailable | llm_timeout | llm_invalid_output | summary_too_large | document_unavailable (failed runs only).
       */
      error_code: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Job Id */
      job_id: string | null;
      progress: components['schemas']['SummaryProgress'] | null;
      /**
       * Revision Id
       * Format: uuid
       */
      revision_id: string;
      /**
       * Status
       * @enum {string}
       */
      status: 'queued' | 'running' | 'succeeded' | 'failed' | 'superseded';
      /**
       * Trigger
       * @enum {string}
       */
      trigger: 'manual' | 'publish' | 'retry';
      usage: components['schemas']['SummaryUsage'] | null;
    };
    /** SummaryState */
    SummaryState: {
      /**
       * Available
       * @description This environment can create summaries.
       */
      available: boolean;
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /**
       * Enabled
       * @description Opted in: every publish re-summarizes (auto refresh).
       */
      enabled: boolean;
      /** Published Revision Id */
      published_revision_id: string | null;
      /** @description The newest run of the current revision. */
      run: components['schemas']['SummaryRun'] | null;
      /**
       * Stale
       * @description `summary` is not of the current published revision.
       */
      stale: boolean;
      /** @description The newest succeeded summary (any revision). */
      summary: components['schemas']['Summary'] | null;
    };
    /** SummaryUnit */
    SummaryUnit: {
      /** Key Points */
      key_points: components['schemas']['SummaryKeyPoint'][];
      /**
       * Summary Md
       * @description Markdown subset (paragraphs, lists, emphasis); render HTML, links and images as text. Empty when the chapter has no body text.
       */
      summary_md: string;
      /** Title */
      title: string;
    };
    /** SummaryUsage */
    SummaryUsage: {
      /** Cost Usd */
      cost_usd?: number | null;
      /**
       * Generated Units
       * @default 0
       */
      generated_units?: number;
      /** Input Tokens */
      input_tokens?: number | null;
      /** Output Tokens */
      output_tokens?: number | null;
      /**
       * Reused Units
       * @default 0
       */
      reused_units?: number;
    };
    /** TableCells */
    TableCells: {
      /** Header Rows */
      header_rows: number;
      /** Rows */
      rows: string[][];
    };
    /** TextRange */
    TextRange: {
      /**
       * End
       * @description Offset in `text` (characters), exclusive.
       */
      end: number;
      /**
       * Start
       * @description Offset in `text` (characters), inclusive.
       */
      start: number;
    };
    /** TextSpan */
    TextSpan: {
      /** End */
      end: number;
      /** Start */
      start: number;
    };
    /** UploadCompleted */
    UploadCompleted: {
      /**
       * Document Id
       * Format: uuid
       */
      document_id: string;
      /**
       * Job Id
       * Format: uuid
       * @description The parse job; poll `GET /jobs/{id}`.
       */
      job_id: string;
    };
    /** UploadIntent */
    UploadIntent: {
      /**
       * Expires At
       * Format: date-time
       * @description Complete the upload before this time.
       */
      expires_at: string;
      /**
       * Max Size Bytes
       * @default 52428800
       */
      max_size_bytes?: number;
      resumable: components['schemas']['ResumableUpload'];
      /**
       * Upload Headers
       * @description Headers to send with the PUT.
       */
      upload_headers: {
        [key: string]: string;
      };
      /**
       * Upload Id
       * Format: uuid
       */
      upload_id: string;
      /**
       * Upload Method
       * @default PUT
       * @constant
       */
      upload_method?: 'PUT';
      /**
       * Upload Url
       * @description Short-lived signed URL: `PUT` the raw PDF bytes here.
       */
      upload_url: string;
    };
    /** UploadIntentCreate */
    UploadIntentCreate: {
      /**
       * Content Type
       * @description Must be `application/pdf`.
       */
      content_type: string;
      /**
       * Document Type
       * @description `auto`: the server tells body text and question papers apart (UX6-UPLOAD-B; the document starts as a `book`). `book` / `question_paper`: a kind chosen by the uploader (never reclassified).
       * @default book
       * @enum {string}
       */
      document_type?: 'book' | 'question_paper' | 'auto';
      /**
       * Filename
       * @description Original file name; must end in `.pdf`.
       */
      filename: string;
      /**
       * Sha256
       * @description Hex SHA-256 of the file; re-verified on completion.
       */
      sha256: string;
      /**
       * Size Bytes
       * @description Exact size in bytes (at most 52428800).
       */
      size_bytes: number;
      /**
       * Title
       * @description Defaults to the file name stem.
       */
      title?: string | null;
    };
    /** ValidationIssue */
    ValidationIssue: {
      /** Loc */
      loc: (string | number)[];
      /** Msg */
      msg: string;
      /** Type */
      type: string;
    };
    /** Workspace */
    Workspace: {
      /** Archived At */
      archived_at: string | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Name */
      name: string;
      /**
       * Role
       * @description The caller's membership role.
       * @enum {string}
       */
      role: 'owner' | 'editor' | 'viewer';
      /**
       * Status
       * @description Archived workspaces are read-only.
       * @enum {string}
       */
      status: 'active' | 'archived';
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
    };
    /** WorkspaceAttempt */
    WorkspaceAttempt: {
      /**
       * Displayed Option Ids
       * @description The order the options were shown in.
       */
      displayed_option_ids: string[];
      /** Graded At */
      graded_at: string | null;
      /**
       * Grades Attempt Id
       * @description For a self/reviewer grade: the pending attempt it settles.
       */
      grades_attempt_id: string | null;
      /**
       * Grading Method
       * @description null while pending.
       */
      grading_method: ('auto' | 'self' | 'reviewer') | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Merged Into Question Id
       * @description The question was archived as a duplicate of this one (UX7-DEDUP): its history shows there, so links open it.
       */
      merged_into_question_id?: string | null;
      /**
       * Practice Session Id
       * Format: uuid
       */
      practice_session_id: string;
      /**
       * Question Id
       * Format: uuid
       */
      question_id: string;
      /** Question Number */
      question_number: number | null;
      /**
       * Question Revision Id
       * Format: uuid
       * @description Graded against this revision.
       */
      question_revision_id: string;
      /** Question Type */
      question_type: string;
      /**
       * Result
       * @enum {string}
       */
      result: 'correct' | 'incorrect' | 'pending';
      /** Revision Version */
      revision_version: number;
      submitted_answer: components['schemas']['SubmittedAnswer'];
      /**
       * Submitted At
       * Format: date-time
       */
      submitted_at: string;
    };
    /** WorkspaceAttemptPage */
    WorkspaceAttemptPage: {
      /** Items */
      items: components['schemas']['WorkspaceAttempt'][];
      /**
       * Next Cursor
       * @description Pass as `cursor` for older attempts.
       */
      next_cursor: string | null;
    };
    /** WorkspaceCreate */
    WorkspaceCreate: {
      /** Name */
      name: string;
    };
    /** WorkspaceJob */
    WorkspaceJob: {
      /** Attempts */
      attempts: number;
      /** Cancel Requested */
      cancel_requested: boolean;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Error Code
       * @description Stable reason of a failed (or `cancelled`) job, e.g. `parse_failed`.
       */
      error_code: string | null;
      /** Finished At */
      finished_at: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Job Type
       * @description e.g. `document.parse`.
       */
      job_type: string;
      /** Max Attempts */
      max_attempts: number;
      /**
       * Progress
       * @description 0-100 while running (100 once succeeded); null when unknown.
       */
      progress: number | null;
      /**
       * Retryable
       * @description The caller can start this job again: `document` → POST /documents/{target_id}/publish, `question_import` → POST /question-imports/{target_id}/retry. The retry is a new job.
       */
      retryable: boolean;
      /**
       * Stage
       * @description Current step while running, e.g. `parsing`, `indexing`; null otherwise.
       */
      stage: string | null;
      /** Started At */
      started_at: string | null;
      /**
       * Status
       * @description queued | running | succeeded | failed | cancelled
       * @enum {string}
       */
      status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
      /** Target Id */
      target_id: string | null;
      /**
       * Target Label
       * @description Document or question paper title.
       */
      target_label: string | null;
      /**
       * Target Revision Id
       * @description Document jobs: the revision the job parsed/indexed. A retry sends it as `revision_id` to POST /documents/{target_id}/publish, so a draft that changed since (published, replaced) is refused with 409 `edit-conflict` instead of being published.
       */
      target_revision_id?: string | null;
      /**
       * Target Type
       * @description What the job works on.
       */
      target_type: ('document' | 'question_import' | 'question_generation') | null;
      /**
       * Updated At
       * Format: date-time
       */
      updated_at: string;
    };
    /** WorkspaceJobPage */
    WorkspaceJobPage: {
      /** Items */
      items: components['schemas']['WorkspaceJob'][];
      /**
       * Next Cursor
       * @description Pass as `cursor` for older jobs.
       */
      next_cursor: string | null;
    };
    /** WorkspaceList */
    WorkspaceList: {
      /** Items */
      items: components['schemas']['Workspace'][];
    };
    /** WorkspaceUpdate */
    WorkspaceUpdate: {
      /** Name */
      name: string;
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
  streamQuestionAiExplanation: {
    parameters: {
      query?: {
        practice_session_id?: string | null;
        view?: 'detail' | null;
      };
      header?: never;
      path: {
        explanation_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Server-Sent Events: `delta {seq, text}` (seq counts deltas from 0, again from 0 after a `reset`; the SSE `id` is the event number: send `Last-Event-ID` to resume), `reset` (drop the text received so far), then one `done {explanation}` or `error {code}`. A finished explanation is a single `done`/`error`. Send the Bearer token in the Authorization header, never in the URL. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'text/event-stream': string;
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getAskConversation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversation_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Conversation'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  deleteAskConversation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversation_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  detachAskQuestion: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversation_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Conversation'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  askQuestion: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        conversation_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['MessageCreate'];
      };
    };
    responses: {
      /** @description Accepted: the answer is being made. */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MessageAccepted'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Too Many Requests */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getAskMessage: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        message_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Message'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  cancelAskAnswer: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        message_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Message'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  setAskFeedback: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        message_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['FeedbackInput'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Feedback'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  regenerateAskAnswer: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        message_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Accepted: the answer is being made. */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MessageAccepted'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Too Many Requests */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  retryAskAnswer: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        message_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Accepted: the answer is being made. */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MessageAccepted'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Too Many Requests */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  streamAskAnswer: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        message_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Server-Sent Events: `delta {seq, text}` (the SSE `id` is `seq`; send `Last-Event-ID` to resume after it), `reset` (drop the text received so far), then one `done {message}` or `error {code}`. A finished answer is a single `done`/`error` from the database. Send the Bearer token in the Authorization header (fetch streaming, not EventSource); never in the URL. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'text/event-stream': string;
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listChapterHighlights: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        chapter_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['HighlightList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getChapterNote: {
    parameters: {
      query?: {
        /** @description An older version. */
        version?: number | null;
      };
      header?: never;
      path: {
        chapter_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ChapterNoteState'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createChapterNote: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        chapter_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ChapterNoteState'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getDocument: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['DocumentDetail'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  deleteDocument: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  updateDocumentKind: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['DocumentKindChange'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['DocumentDetail'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listDocumentBlocks: {
    parameters: {
      query?: {
        /** @description `next_after` of the previous page. */
        after?: number | null;
        /** @description Only blocks of this chapter (an outline id) and its sub-sections. */
        chapter?: string | null;
        limit?: number;
        /** @description Only blocks starting on this page. */
        page?: number | null;
        /** @description `active` (published, default), `latest` (the draft if any) or a revision id. */
        revision?: string;
      };
      header?: never;
      path: {
        document_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['BlockList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getDocumentBlock: {
    parameters: {
      query?: {
        /** @description `active` (published, default), `latest` (the draft if any) or a revision id. */
        revision?: string;
      };
      header?: never;
      path: {
        /** @description Canonical block id (stable across revisions), e.g. from search hits. */
        block_id: string;
        document_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['BlockDetail'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  correctDocumentBlock: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description Canonical block id (stable across revisions), e.g. from search hits. */
        block_id: string;
        document_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['BlockCorrection'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['BlockDetail'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getDocumentOutline: {
    parameters: {
      query?: {
        /** @description `active` (published, default), `latest` (the draft if any) or a revision id. */
        revision?: string;
      };
      header?: never;
      path: {
        document_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Outline'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  publishDocumentDraft: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        document_id: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        'application/json': components['schemas']['PublishRequest'] | null;
      };
    };
    responses: {
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PublishAccepted'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listDocumentRevisions: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RevisionHistory'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  restoreDocumentRevision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document_id: string;
        revision_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RestoredDraft'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getDocumentSourceUrl: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SignedReadUrl'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getDocumentSummary: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SummaryState'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createDocumentSummary: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        document_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description OK */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SummaryState'];
        };
      };
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SummaryState'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  disableDocumentSummaryAuto: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  retryDocumentSummary: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SummaryState'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  exportDocumentText: {
    parameters: {
      query?: {
        /** @description `md` (Markdown) or `txt` (plain text); `markdown` / `plain` alike. */
        format?: 'md' | 'txt' | 'markdown' | 'plain';
        /** @description `published` (default), the unpublished correction `draft` (owners and editors) or a revision id of this document (the revision a screen shows; a draft id needs owner or editor). */
        revision?: string;
      };
      header?: never;
      path: {
        document_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The document text as a file (attachment). */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'text/markdown': string;
          'text/plain': string;
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  completeDocumentUpload: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['CompleteUpload'];
      };
    };
    responses: {
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['UploadCompleted'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unsupported Media Type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getJob: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        job_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Job'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  streamJobEvents: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        job_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Server-Sent Events: `event: job` with a `Job` JSON body on connect and on every change, `: keep-alive` comments, `event: gone` if access ends. The stream ends after a terminal status or after a few minutes (reconnect). Send the Bearer token in the Authorization header (use fetch streaming, not EventSource). */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'text/event-stream': string;
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getMe: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Me'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getMyFork: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        fork_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Fork'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listMyWorkspaces: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MyWorkspaceList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  streamMockExamQuestionAiExplanation: {
    parameters: {
      query?: {
        mock_practice_session_id?: string | null;
        view?: 'manage' | null;
      };
      header?: never;
      path: {
        mock_explanation_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Server-Sent Events: `delta {seq, text}` (seq counts deltas from 0, again from 0 after a `reset`; the SSE `id` is the event number: send `Last-Event-ID` to resume), `reset` (drop the text received so far), then one `done {explanation}` or `error {code}`. A finished explanation is a single `done`/`error`. Send the Bearer token in the Authorization header, never in the URL. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'text/event-stream': string;
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  removeMockExamQuestion: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        mock_exam_question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  updateMockExamQuestion: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        mock_exam_question_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['MockExamQuestionUpdate'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MockExamQuestion'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getMockExamQuestionAiExplanation: {
    parameters: {
      query?: {
        mock_practice_session_id?: string | null;
        view?: 'manage' | null;
      };
      header?: never;
      path: {
        mock_exam_question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MockExplanationState'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createMockExamQuestionAiExplanation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        mock_exam_question_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['MockExplanationRequest'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MockExplanationState'];
        };
      };
      /** @description Accepted: the explanation is being made (stream it). */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Too Many Requests */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  regenerateMockExamQuestionAiExplanation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        mock_exam_question_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['MockExplanationRequest'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MockExplanationState'];
        };
      };
      /** @description Accepted: the explanation is being made (stream it). */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Too Many Requests */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  startMockPracticeSession: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        mock_exam_question_id: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        'application/json': components['schemas']['PracticeSessionCreate'] | null;
      };
    };
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MockPracticeSession'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getMockExamQuestionRelatedSources: {
    parameters: {
      query?: {
        /** @description The caller's own submitted mock practice session of this question. */
        mock_practice_session_id?: string | null;
        /** @description `manage`: 모의고사 문제 관리 (edit rights, active workspace). */
        view?: 'manage' | null;
      };
      header?: never;
      path: {
        mock_exam_question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MockRelatedSources'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getMockExamQuestionSourceRegion: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        mock_exam_question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MockQuestionSourceRegion'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getMockExam: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        mock_exam_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MockExam'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  deleteMockExam: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        mock_exam_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  renameMockExam: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        mock_exam_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['MockExamUpdate'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MockExam'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createMockExamGeneration: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        mock_exam_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['MockExamGenerationCreate'];
      };
    };
    responses: {
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MockExam'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Too Many Requests */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listMockExamQuestions: {
    parameters: {
      query?: {
        /** @description `answers`: answers, explanations and checks (editors only). */
        include?: 'answers' | null;
      };
      header?: never;
      path: {
        mock_exam_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': unknown;
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  selfGradeMockPracticeSession: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        mock_practice_session_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SelfGradeBody'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SelfGradeResult'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  submitMockPracticeSession: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        mock_practice_session_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SubmitBody'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MockSubmitResult'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createHighlight: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['HighlightCreate'];
      };
    };
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Highlight'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  deleteHighlight: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        highlight_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  updateHighlight: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        highlight_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['HighlightUpdate'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Highlight'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  restoreHighlight: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        highlight_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Highlight'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getPracticeRun: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        run_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PracticeRun'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  finishPracticeRun: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        run_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PracticeRun'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getPracticeRunItem: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description 1-based; past the end is 404. */
        position: number;
        run_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RunItem'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  startRunItemRetrySession: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        position: number;
        run_id: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        'application/json': components['schemas']['RetrySessionCreate'] | null;
      };
    };
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RetrySession'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listPracticeRunResults: {
    parameters: {
      query?: {
        limit?: number;
        offset?: number;
      };
      header?: never;
      path: {
        run_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RunResults'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getPracticeSession: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        session_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PracticeSessionDetail'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  selfGradePracticeSession: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        session_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SelfGradeBody'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SelfGradeResult'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  submitPracticeSession: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        session_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SubmitBody'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SubmitResult'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  updateQuestionDraft: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        draft_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['QuestionDraftUpdate'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportDraft'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getQuestionImport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        import_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportRun'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listQuestionImportDraftSummaries: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        import_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportDraftSummaryList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listQuestionImportDrafts: {
    parameters: {
      query?: {
        /** @description List the workspace's book chapters (`chapters`). */
        include_chapters?: boolean;
        /** @description One page of at most this many drafts. */
        limit?: number | null;
        /** @description Skip this many drafts (source order). */
        offset?: number;
      };
      header?: never;
      path: {
        import_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportDraftList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  publishQuestionImportDrafts: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        import_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ImportPublishBody'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportPublishOutcome'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  registerQuestionImportDrafts: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        import_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ImportRegistrationRequest'];
      };
    };
    responses: {
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportRegistration'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getQuestionImportRegistration: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        import_id: string;
        registration_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportRegistration'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  retryQuestionImport: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        import_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportRun'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getQuestion: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['QuestionDetail'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  deleteQuestion: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  updateQuestion: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['QuestionUpdate'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Question'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getQuestionAiExplanation: {
    parameters: {
      query?: {
        practice_session_id?: string | null;
        view?: 'detail' | null;
      };
      header?: never;
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ExplanationState'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createQuestionAiExplanation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ExplanationRequest'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ExplanationState'];
        };
      };
      /** @description Accepted: the explanation is being made (stream it). */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Too Many Requests */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  regenerateQuestionAiExplanation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ExplanationRequest'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ExplanationState'];
        };
      };
      /** @description Accepted: the explanation is being made (stream it). */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Too Many Requests */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listMyQuestionAttempts: {
    parameters: {
      query?: {
        cursor?: string | null;
        limit?: number;
      };
      header?: never;
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['AttemptList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listQuestionHighlights: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['HighlightList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  updateMyQuestionState: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['MyStateUpdate'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MyState'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getLatestQuestionPractice: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['LatestPractice'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  resetQuestionPractice: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PracticeResetResult'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  startPracticeSession: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        'application/json': components['schemas']['PracticeSessionCreate'] | null;
      };
    };
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PracticeSession'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getQuestionPreview: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['QuestionPreview'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getQuestionRelatedSources: {
    parameters: {
      query?: {
        /** @description The caller's own submitted practice session of this question. */
        practice_session_id?: string | null;
        /** @description `detail`: the 문제 상세 dialog. */
        view?: 'detail' | null;
      };
      header?: never;
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RelatedSources'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getQuestionRevision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
        revision_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['QuestionRevision'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getQuestionSourceRegion: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['QuestionSourceRegion'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getSharedWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SharedWorkspace'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listSharedChapterNotes: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SharedChapterNoteList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getSharedChapterNote: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        chapter_id: string;
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SharedChapterNote'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getSharedDocument: {
    parameters: {
      query?: {
        /** @description `next_after` of the previous page. */
        after?: number | null;
        limit?: number;
        /** @description Only blocks starting on this page. */
        page?: number | null;
      };
      header?: never;
      path: {
        document_id: string;
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SharedDocument'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getSharedDocumentPdf: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document_id: string;
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The original PDF. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/pdf': unknown;
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getSharedDocumentSummary: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document_id: string;
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SharedSummary'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  startWorkspaceFork: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ForkCreate'];
      };
    };
    responses: {
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Fork'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Too Many Requests */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listSharedQuestions: {
    parameters: {
      query?: {
        chapter_id?: string | null;
        cursor?: string | null;
        /** @description Questions with a source in this document. */
        document_id?: string | null;
        limit?: number;
        question_type?: ('MCQ' | 'SHORT_ANSWER' | 'ESSAY') | null;
      };
      header?: never;
      path: {
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SharedQuestionList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getSharedQuestion: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SharedQuestion'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getSharedQuestionAiExplanation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SharedExplanation'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getSharedQuestionPreview: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['QuestionPreview'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getSharedQuestionRelatedSources: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        question_id: string;
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SharedRelatedSources'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  searchSharedWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SearchRequest'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SharedSearchResponse'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Too Many Requests */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createSharedSession: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description The share link id (`/share/{id}`). */
        share_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SessionExchange'];
      };
    };
    responses: {
      /** @description Successful Response */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Too Many Requests */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listWorkspaces: {
    parameters: {
      query?: {
        /** @description Which tab: active (default) or archived. */
        status?: 'active' | 'archived';
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['WorkspaceList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createWorkspace: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['WorkspaceCreate'];
      };
    };
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Workspace'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Workspace'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  deleteWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  updateWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['WorkspaceUpdate'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Workspace'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listWorkspaceActivities: {
    parameters: {
      query?: {
        cursor?: string | null;
        limit?: number;
      };
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ActivityPage'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  archiveWorkspace: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Workspace'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getAskState: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['AskState'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listAskConversations: {
    parameters: {
      query?: {
        cursor?: string | null;
      };
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ConversationPage'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createAskConversation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ConversationCreate'];
      };
    };
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Conversation'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listMyWorkspaceAttempts: {
    parameters: {
      query?: {
        cursor?: string | null;
        limit?: number;
      };
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['WorkspaceAttemptPage'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listChapterNotes: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ChapterNoteList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  previewChapterRedistribution: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['RedistributionPreviewRequest'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RedistributionPreview'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listChapterRedistributionQuestions: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['RedistributionList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listDocuments: {
    parameters: {
      query?: {
        /** @description Only this document type. */
        document_type?: ('book' | 'question_paper') | null;
      };
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['DocumentList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createDocumentUploadIntent: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['UploadIntentCreate'];
      };
    };
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['UploadIntent'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Content Too Large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unsupported Media Type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listWorkspaceJobs: {
    parameters: {
      query?: {
        cursor?: string | null;
        limit?: number;
      };
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['WorkspaceJobPage'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listMockExams: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MockExamList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createMockExam: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['MockExamCreate'];
      };
    };
    responses: {
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MockExam'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Too Many Requests */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listChapterlessHighlights: {
    parameters: {
      query: {
        /** @description Only `none`: the "챕터 없음" group (no workspace-wide list). */
        chapter: 'none';
      };
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['HighlightList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createPracticeRun: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['PracticeRunCreate'];
      };
    };
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PracticeRun'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listQuestionDuplicates: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['DuplicateScan'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  mergeQuestionDuplicates: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['MergeRequest'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['MergeResult'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listQuestionImports: {
    parameters: {
      query?: {
        /** @description Only the runs of this question paper (e.g. the server-started one). */
        document_id?: string | null;
        limit?: number;
      };
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportRunList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createQuestionImport: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ImportCreate'];
      };
    };
    responses: {
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportRun'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listQuestions: {
    parameters: {
      query?: {
        chapter_id?: string | null;
        cursor?: string | null;
        /** @description Questions with a source in this document. */
        document_id?: string | null;
        limit?: number;
        /** @description Repeatable; default CONFIRMED only. */
        publication_status?: ('DRAFT' | 'CONFIRMED' | 'ARCHIVED')[] | null;
        /** @description Case-insensitive stem search. */
        q?: string | null;
        question_type?: ('MCQ' | 'SHORT_ANSWER' | 'ESSAY') | null;
      };
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['QuestionList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createQuestion: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['QuestionCreate'];
      };
    };
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Question'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  assignQuestionChapters: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ChapterAssignmentRequest'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ChapterAssignmentResult'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getQuestionOverview: {
    parameters: {
      query?: {
        /** @description A chapter id, or `none` for questions without one. */
        chapter?: string | null;
        /** @description Keep (non-)favorites only. */
        favorite?: boolean | null;
        /** @description Case-insensitive stem search. */
        q?: string | null;
        /** @description Keep questions (not) marked for retry. */
        retry?: boolean | null;
        /** @description Repeatable statuses; none selects no questions, omitted selects all. */
        status?: (('unseen' | 'viewed' | 'incorrect' | 'correct' | 'retry') | 'none')[] | null;
        type?: ('MCQ' | 'SHORT_ANSWER' | 'ESSAY') | null;
      };
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['QuestionOverview'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  restoreWorkspace: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Workspace'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  searchWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['SearchRequest'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SearchResponse'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Too Many Requests */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  listShareLinks: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ShareLinkList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  createShareLink: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ShareLinkCreate'];
      };
    };
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['IssuedShareLink'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  updateShareLink: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        link_id: string;
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ShareLinkUpdate'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ShareLink'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  revokeShareLink: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        link_id: string;
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ShareLink'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  rotateShareLink: {
    parameters: {
      query?: never;
      header?: {
        /** @description Optional client-generated key (1-200 visible ASCII characters, e.g. a UUID). Retrying with the same key and body within 24 hours returns the original response (marked `Idempotent-Replayed: true`); the same key with a different body is 409. */
        'Idempotency-Key'?: string | null;
      };
      path: {
        link_id: string;
        workspace_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['IssuedShareLink'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Unprocessable Content */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
      /** @description Service Unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': components['schemas']['Problem'];
        };
      };
    };
  };
  getLiveness: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['LivenessReport'];
        };
      };
    };
  };
  getReadiness: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ReadinessReport'];
        };
      };
      /** @description A dependency is not ready. */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ReadinessReport'];
        };
      };
    };
  };
}
