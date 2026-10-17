// Generated from contracts/openapi.json by scripts/generate.ts. Do not edit.
// Regenerate with `make contracts`.
/* eslint-disable */

export type paths = {
  '/api/v1/me': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Me
     * @description The authenticated user and their profile.
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
    /** DependencyStatus */
    DependencyStatus: {
      status: components['schemas']['CheckStatus'];
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
      /** @description `null` until the profile is initialised. */
      profile: components['schemas']['Profile'] | null;
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
    /** ValidationIssue */
    ValidationIssue: {
      /** Loc */
      loc: (string | number)[];
      /** Msg */
      msg: string;
      /** Type */
      type: string;
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
