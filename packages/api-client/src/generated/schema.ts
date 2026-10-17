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
    /** DependencyStatus */
    DependencyStatus: {
      status: components['schemas']['CheckStatus'];
    };
    /** DocumentDetail */
    DocumentDetail: {
      active_revision: components['schemas']['RevisionSummary'] | null;
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
      latest_revision: components['schemas']['RevisionSummary'] | null;
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
    /** RevisionSummary */
    RevisionSummary: {
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
    /** WorkspaceCreate */
    WorkspaceCreate: {
      /** Name */
      name: string;
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
