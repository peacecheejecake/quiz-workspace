// Generated from contracts/openapi.json by scripts/generate.ts. Do not edit.
// Regenerate with `make contracts`.
/* eslint-disable */

export type paths = {
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
    patch?: never;
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
     *     positions); append the attempt; reveal answers and explanation. Once per session.
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
     *     Import and generation drafts share this route. A generation draft (M6.2) is re-validated
     *     against its run's source revision and passages on every request; `is_multi_answer: true`
     *     confirms a changed answer count and `question_type` a changed type (`acknowledged_codes`).
     */
    patch: operations['updateQuestionDraft'];
    trace?: never;
  };
  '/api/v1/question-generations/{generation_id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Question Generation */
    get: operations['getQuestionGeneration'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/question-generations/{generation_id}/drafts': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Question Generation Drafts
     * @description The run's drafts in generation order with diff original (the run's source revision),
     *     justification, cited passages and validations. Review them with PATCH /question-drafts/{id}.
     */
    get: operations['listQuestionGenerationDrafts'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/question-generations/{generation_id}/publish': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Publish Question Generation Drafts
     * @description Register exactly these approved drafts as CONFIRMED questions with lineage
     *     (QGEN-01-AC04). Same contract as the import publish: all or nothing; 404 for an id that is
     *     not a draft of this run, 409 `stale-draft` for a draft changed since review, 409
     *     `draft-not-approved` for a pending/rejected draft, 422 when a draft cannot be confirmed,
     *     409 `duplicate-question` when a draft duplicates a current question of the workspace or
     *     another draft of the request; already published drafts return their question (idempotent
     *     replay).
     */
    post: operations['publishQuestionGenerationDrafts'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
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
     *     Drafts a failed job persisted are listed too (they are kept for the retry).
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
     * @description Register exactly these approved drafts as CONFIRMED questions (QIMPORT-01-AC03).
     *
     *     Each item names the draft and the `version` that was reviewed. All or nothing: an id that
     *     is not a draft of this import is 404; a draft that changed since (another editor's edit,
     *     approval or rejection) is 409 `stale-draft`; a draft that is not approved (pending or
     *     rejected) is 409 `draft-not-approved`; a draft that cannot be confirmed is 422. Already
     *     published drafts return their question whatever version is sent (idempotent replay).
     */
    post: operations['publishQuestionImportDrafts'];
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
  '/api/v1/questions/{question_id}/attempts': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List My Attempts
     * @description The caller's own attempts on the question, newest first, each pinned to the revision it
     *     was graded on (its content: GET /questions/{id}/revisions/{revision_id}).
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
  '/api/v1/questions/{question_id}/generations': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Create Question Generation
     * @description Start generating variant drafts of a CONFIRMED question (QGEN-01-AC02..AC04). 409
     *     `question-not-confirmed` for a draft/archived question. ANALOGOUS_CONCEPT passages are the
     *     source's cited pages plus related passages from a search of the workspace's published
     *     documents; with neither, the job fails `source_passages_missing`.
     */
    post: operations['createQuestionGeneration'];
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
     * @description Toggle the caller's favorite / retry flags (independent of each other and of results).
     */
    patch: operations['updateMyQuestionState'];
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
     * @description Open the practice panel on a CONFIRMED question: pins its active revision, shuffles MCQ
     *     options, records the caller's view. No answers in the response.
     */
    post: operations['startPracticeSession'];
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
  '/api/v1/workspaces/{workspace_id}/documents': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Documents
     * @description The workspace's documents (not soft-deleted), newest first.
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
  '/api/v1/workspaces/{workspace_id}/question-generations': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List Question Generations
     * @description The workspace's generation runs, newest first (optionally of one source question).
     */
    get: operations['listQuestionGenerations'];
    put?: never;
    post?: never;
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
     * @description Start extracting draft questions from a question paper (QIMPORT-01-AC01). 409
     *     `document-not-ready` while the paper is still processing (or failed).
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
     * @description Every link of the workspace (revoked and expired included), newest first; no secrets.
     */
    get: operations['listShareLinks'];
    put?: never;
    /**
     * Create Share Link
     * @description Issue a read-only share link (WS-SHARE-01-AC02). Fork is off unless `allow_fork`.
     *
     *     The secret appears only in this response. A link is not a membership.
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
       * Last Error
       * @description Why the last processing attempt failed.
       */
      last_error: string | null;
      /** @description The newest revision (a draft while a parse or correction is pending). */
      latest_revision: components['schemas']['quiz_api__api__documents__RevisionSummary'] | null;
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
    /** DocumentList */
    DocumentList: {
      /** Items */
      items: components['schemas']['DocumentSummary'][];
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
       * Last Error
       * @description Why the last processing attempt failed.
       */
      last_error: string | null;
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
    /** GenerationCreate */
    GenerationCreate: {
      /**
       * Candidate Count
       * @description Candidates per variation.
       * @default 1
       */
      candidate_count?: number;
      /**
       * Difficulty
       * @description Optional target difficulty relative to the source.
       */
      difficulty?: ('easier' | 'same' | 'harder') | null;
      /**
       * Variation Types
       * @description Distinct variations. OPTION_SHUFFLE is refused (422): it is a practice order (POST /questions/{id}/practice-sessions), never a generation.
       */
      variation_types: (
        'OPTION_SHUFFLE' | 'PARAPHRASE' | 'INVERT_POLARITY' | 'ANALOGOUS_CONCEPT'
      )[];
    };
    /** GenerationDraftList */
    GenerationDraftList: {
      /**
       * Items
       * @description Generation drafts (`run_id` set).
       */
      items: components['schemas']['ImportDraft'][];
    };
    /** GenerationRun */
    GenerationRun: {
      /** Candidate Count */
      candidate_count: number;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /** Difficulty */
      difficulty: ('easier' | 'same' | 'harder') | null;
      /** Draft Count */
      draft_count: number;
      /**
       * Error Code
       * @description Why the job failed (stable code), e.g. `llm_output_invalid`, `no_valid_candidates`, `llm_unavailable`, `llm_not_configured`.
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
       * @description Poll `GET /jobs/{id}` (job `question.generate`).
       */
      job_id: string | null;
      /**
       * Llm Model
       * @description Set when the run succeeded.
       */
      llm_model: string | null;
      /**
       * Prompt Version
       * @description Set when the run succeeded.
       */
      prompt_version: string | null;
      /** Published Count */
      published_count: number;
      /**
       * Source Question Id
       * Format: uuid
       */
      source_question_id: string;
      /**
       * Source Question Revision Id
       * Format: uuid
       * @description The revision the variants are generated from (the diff original).
       */
      source_question_revision_id: string;
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
      /** Variation Types */
      variation_types: ('PARAPHRASE' | 'INVERT_POLARITY' | 'ANALOGOUS_CONCEPT')[];
      /**
       * Workspace Id
       * Format: uuid
       */
      workspace_id: string;
    };
    /** GenerationRunList */
    GenerationRunList: {
      /** Items */
      items: components['schemas']['GenerationRun'][];
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
       * @description A `question_paper` document of this workspace whose processing finished.
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
      /** Items */
      items: components['schemas']['ImportDraft'][];
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
    /** ImportPublishRequest */
    ImportPublishRequest: {
      /** Drafts */
      drafts: components['schemas']['ReviewedDraft'][];
    };
    /** ImportPublishResult */
    ImportPublishResult: {
      /**
       * Items
       * @description In request order.
       */
      items: components['schemas']['ImportPublishedDraft'][];
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
      /** Is Favorite */
      is_favorite?: boolean | null;
      /**
       * Needs Retry
       * @description Never cleared by a correct answer; only by the user.
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
    /** PracticeSessionCreate */
    PracticeSessionCreate: Record<string, never>;
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
      /** Document Id */
      document_id: string | null;
      /**
       * Document Revision Id
       * @description The document revision that was active when the source was saved.
       */
      document_revision_id: string | null;
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
    /** ReviewedDraft */
    ReviewedDraft: {
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
       * @description `book` or `question_paper`.
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
       * @description Also search question-paper documents (left out of book search by default).
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
     * @description A share link's metadata (never its secret or digest).
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
       * @description `question_paper` for question PDFs to import.
       * @default book
       * @enum {string}
       */
      document_type?: 'book' | 'question_paper';
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
  getQuestionGeneration: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        generation_id: string;
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
          'application/json': components['schemas']['GenerationRun'];
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
  listQuestionGenerationDrafts: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        generation_id: string;
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
          'application/json': components['schemas']['GenerationDraftList'];
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
  publishQuestionGenerationDrafts: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        generation_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ImportPublishRequest'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportPublishResult'];
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
  listQuestionImportDrafts: {
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
        'application/json': components['schemas']['ImportPublishRequest'];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportPublishResult'];
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
  createQuestionGeneration: {
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
    requestBody: {
      content: {
        'application/json': components['schemas']['GenerationCreate'];
      };
    };
    responses: {
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['GenerationRun'];
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
  listQuestionGenerations: {
    parameters: {
      query?: {
        limit?: number;
        source_question_id?: string | null;
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
          'application/json': components['schemas']['GenerationRunList'];
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
  listQuestionImports: {
    parameters: {
      query?: {
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
        /** @description Repeatable; keeps these statuses. */
        status?: ('unseen' | 'viewed' | 'incorrect' | 'correct' | 'retry')[] | null;
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
