// adapters/remote/client.ts -- Lightweight GraphQL client using built-in fetch
//
// No external dependencies. Uses Node 22 built-in fetch.
// Handles request construction, error extraction, and auth header injection.

import {
  StorageAdapterError,
  ConnectionError,
  NotFoundError,
  ImmutableFieldError,
  TypeMismatchError,
  CycleDetectedError,
  ScopeCollisionError,
} from "../../adapter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: GraphQLError[];
}

export interface GraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
  extensions?: {
    code?: string;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map a GraphQL error (from extensions.code) to the appropriate
 * StorageAdapterError subtype.
 */
function mapGraphQLError(error: GraphQLError): StorageAdapterError {
  const code = error.extensions?.code;
  const details = (error.extensions ?? {}) as Record<string, unknown>;

  switch (code) {
    case "NOT_FOUND":
      return new NotFoundError(
        (details.id as string) ?? "unknown"
      );

    case "IMMUTABLE_FIELD":
      return new ImmutableFieldError(
        (details.field as string) ?? "unknown"
      );

    case "TYPE_MISMATCH":
      return new TypeMismatchError(
        (details.id as string) ?? "unknown",
        (details.expected as string) ?? "unknown",
        (details.actual as string) ?? "unknown"
      );

    case "CYCLE_DETECTED":
      return new CycleDetectedError(
        (details.cycles as string[][]) ?? []
      );

    case "SCOPE_COLLISION":
      return new ScopeCollisionError(
        (details.collisions as Array<{
          item_a: string;
          item_b: string;
          paths: string[];
        }>) ?? []
      );

    case "CONNECTION_ERROR":
      return new ConnectionError(error.message);

    case "MISSING_CYCLE":
      return new StorageAdapterError(
        error.message,
        "MISSING_CYCLE",
        details
      );

    default:
      return new StorageAdapterError(
        error.message,
        code ?? "UNKNOWN_ERROR",
        details
      );
  }
}

// ---------------------------------------------------------------------------
// GraphQL Client
// ---------------------------------------------------------------------------

export class GraphQLClient {
  private endpoint: string;
  private headers: Record<string, string>;

  constructor(endpoint: string, headers?: Record<string, string>) {
    this.endpoint = endpoint;
    this.headers = {
      "Content-Type": "application/json",
      ...headers,
    };
  }

  /**
   * Execute a GraphQL query.
   * Throws StorageAdapterError subtypes when the response contains errors.
   */
  async query<T>(
    document: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    return this.execute<T>(document, variables);
  }

  /**
   * Execute a GraphQL mutation.
   * Throws StorageAdapterError subtypes when the response contains errors.
   */
  async mutate<T>(
    document: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    return this.execute<T>(document, variables);
  }

  /**
   * Internal: execute a GraphQL operation (query or mutation).
   */
  private async execute<T>(
    document: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    let response: Response;

    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          query: document,
          variables: variables ?? {},
        }),
      });
    } catch (err) {
      throw new ConnectionError(
        `Failed to connect to GraphQL endpoint: ${this.endpoint}`,
        err instanceof Error ? err : undefined
      );
    }

    if (!response.ok) {
      throw new ConnectionError(
        `GraphQL endpoint returned HTTP ${response.status}: ${response.statusText}`
      );
    }

    let body: GraphQLResponse<T>;
    try {
      body = (await response.json()) as GraphQLResponse<T>;
    } catch {
      throw new StorageAdapterError(
        "Failed to parse GraphQL response as JSON",
        "PARSE_ERROR"
      );
    }

    // If the response contains errors, throw the first one mapped to the
    // appropriate StorageAdapterError subtype.
    if (body.errors && body.errors.length > 0) {
      throw mapGraphQLError(body.errors[0]);
    }

    if (!body.data) {
      throw new StorageAdapterError(
        "GraphQL response contained no data",
        "EMPTY_RESPONSE"
      );
    }

    return body.data;
  }
}
