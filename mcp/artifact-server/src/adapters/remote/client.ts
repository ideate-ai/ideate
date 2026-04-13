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
import { log } from "../../logger.js";

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

/**
 * Token provider function type for auth token rotation.
 * Called when a request fails with 401 Unauthorized.
 * Should return the new token or null if rotation failed.
 */
export type TokenProvider = () => Promise<string | null>;

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

    case "TRANSACTION_FAILED":
      return new StorageAdapterError(
        error.message,
        "TRANSACTION_FAILED",
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
  private tokenProvider?: TokenProvider;

  constructor(
    endpoint: string,
    headers?: Record<string, string>,
    tokenProvider?: TokenProvider
  ) {
    this.endpoint = endpoint;
    this.headers = {
      "Content-Type": "application/json",
      ...headers,
    };
    this.tokenProvider = tokenProvider;
  }

  /**
   * Update the authorization header with a new token.
   * Called after successful token rotation.
   */
  setAuthToken(token: string): void {
    this.headers["Authorization"] = `Bearer ${token}`;
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

  // Retry configuration
  private readonly MAX_RETRIES = 3;
  private readonly INITIAL_RETRY_DELAY_MS = 1000;
  private readonly MAX_RETRY_DELAY_MS = 8000;

  /**
   * Determine if an error is retryable (transient).
   * Network errors, timeouts, and 5xx HTTP status codes are retryable.
   * 4xx client errors are not retryable.
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof ConnectionError) {
      // Network errors and connection failures are retryable
      return true;
    }
    if (error instanceof StorageAdapterError) {
      const code = error.code;
      // Retry on server errors and transient conditions
      if (code === "INTERNAL_SERVER_ERROR" || code === "SERVICE_UNAVAILABLE" || code === "TIMEOUT") {
        return true;
      }
    }
    return false;
  }

  /**
   * Calculate delay for exponential backoff with jitter.
   * Delays: 1s, 2s, 4s, capped at 8s.
   */
  private getRetryDelay(attempt: number): number {
    const exponentialDelay = this.INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, this.MAX_RETRY_DELAY_MS);
    // Add jitter: ±25% to avoid thundering herd
    const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
    return Math.floor(cappedDelay + jitter);
  }

  /**
   * Internal: execute a GraphQL operation (query or mutation) with retry logic.
   */
  private async execute<T>(
    document: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const result = await this.executeOnce<T>(document, variables);
        // Log successful retry if this wasn't the first attempt
        if (attempt > 1) {
          log.info("graphql", `Request succeeded on attempt ${attempt}/${this.MAX_RETRIES}`);
        }
        return result;
      } catch (err) {
        lastError = err;

        // Don't retry non-transient errors
        if (!this.isRetryableError(err)) {
          throw err;
        }

        // Don't retry if this was the last attempt
        if (attempt >= this.MAX_RETRIES) {
          log.error("graphql", `Request failed after ${this.MAX_RETRIES} attempts`);
          throw err;
        }

        // Calculate and apply backoff delay
        const delay = this.getRetryDelay(attempt);
        log.warn("graphql", `Attempt ${attempt}/${this.MAX_RETRIES} failed, retrying in ${delay}ms...`);
        await this.sleep(delay);
      }
    }

    // This should never be reached due to the throw above, but TypeScript needs it
    throw lastError;
  }

  /**
   * Sleep for a given number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Internal: execute a single GraphQL operation (query or mutation) without retry.
   */
  private async executeOnce<T>(
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
        `Failed to connect to GraphQL endpoint: ${this.endpoint} - ${err instanceof Error ? err.message : "Unknown error"}`,
        err instanceof Error ? err : undefined
      );
    }

    // Handle 401 Unauthorized - attempt token rotation if tokenProvider is configured
    if (response.status === 401 && this.tokenProvider) {
      const newToken = await this.tokenProvider();
      if (newToken) {
        this.setAuthToken(newToken);
        // Retry the request with the new token
        return this.executeOnceWithAuth<T>(document, variables);
      } else {
        throw new ConnectionError(
          `Authentication failed: GraphQL endpoint ${this.endpoint} returned 401 Unauthorized - token rotation failed`
        );
      }
    }

    // Handle 401 without tokenProvider - authentication failure
    if (response.status === 401) {
      throw new ConnectionError(
        `Authentication failed: GraphQL endpoint ${this.endpoint} returned 401 Unauthorized`
      );
    }

    if (!response.ok) {
      // 5xx errors are retryable, 4xx errors are not
      if (response.status >= 500 && response.status < 600) {
        throw new ConnectionError(
          `GraphQL endpoint ${this.endpoint} returned HTTP ${response.status}: ${response.statusText}`
        );
      } else {
        // 4xx errors are client errors, not retryable
        throw new StorageAdapterError(
          `GraphQL endpoint returned HTTP ${response.status}: ${response.statusText}`,
          `HTTP_${response.status}`
        );
      }
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

  /**
   * Internal: execute a request with the current auth token.
   * Used for retry after token rotation.
   */
  private async executeOnceWithAuth<T>(
    document: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        query: document,
        variables: variables ?? {},
      }),
    });

    if (!response.ok) {
      throw new StorageAdapterError(
        `GraphQL endpoint returned HTTP ${response.status}: ${response.statusText}`,
        `HTTP_${response.status}`
      );
    }

    const body = (await response.json()) as GraphQLResponse<T>;

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
