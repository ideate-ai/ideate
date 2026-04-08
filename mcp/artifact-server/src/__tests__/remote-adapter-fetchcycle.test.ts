/**
 * remote-adapter-fetchcycle.test.ts — Tests for RemoteAdapter.fetchCurrentCycle
 * error recovery behaviour (WI-656).
 *
 * Kept in a separate file so the module-level vi.mock for GraphQLClient does not
 * interfere with tests in remote-adapter.test.ts that rely on the real client
 * throwing network errors (Vitest hoists vi.mock to the top of the module at
 * import time, making it impossible to un-mock within the same file).
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

import { RemoteAdapter } from "../adapters/remote/index.js";
import { StorageAdapterError, ValidationError } from "../adapter.js";

// Mock the GraphQL client — safe here because every test in this file wants it mocked.
vi.mock("../adapters/remote/client.js", () => {
  return {
    GraphQLClient: vi.fn().mockImplementation(() => ({
      query: vi.fn(),
      mutate: vi.fn(),
    })),
  };
});

import { GraphQLClient } from "../adapters/remote/client.js";

// -----------------------------------------------------------------------------
// WI-656: fetchCurrentCycle Error Recovery Tests
// -----------------------------------------------------------------------------
// These tests verify that RemoteAdapter.fetchCurrentCycle() throws explicit
// errors with context instead of silently falling back to cycle 1.
// Decision: REMOVE silent fallback - errors should be explicit per P-58/P-002.
// -----------------------------------------------------------------------------

describe("RemoteAdapter — fetchCurrentCycle error recovery (WI-656)", () => {
  let mockQuery: Mock;
  let mockMutate: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery = vi.fn();
    mockMutate = vi.fn();

    (GraphQLClient as unknown as Mock).mockImplementation(() => ({
      query: mockQuery,
      mutate: mockMutate,
    }));
  });

  it("throws a plain Error (not ValidationError) with context on GraphQL/network errors (WI-698)", async () => {
    const adapter = new RemoteAdapter({
      endpoint: "http://localhost:8080/graphql",
      org_id: "test-org",
      codebase_id: "test-codebase",
      auth_token: "test-token",
    });

    // Mock initialize ping query
    mockQuery.mockResolvedValueOnce({ nextId: "WI-001" });
    await adapter.initialize();

    // Mock getNode response followed by GraphQL error when fetching domain_index
    mockQuery
      .mockResolvedValueOnce({
        artifact: {
          artifactId: "WI-001",
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: "abc123",
          tokenCount: 100,
          content: '{"title": "Test"}',
        },
      })
      .mockRejectedValueOnce(new Error("Network timeout"));

    // Should throw a plain Error (not ValidationError) with context about the failure
    await expect(adapter.getNode("WI-001")).rejects.toSatisfy((err: Error) => {
      return (
        !(err instanceof ValidationError) &&
        err.message.includes("Failed to fetch current cycle") &&
        err.message.includes("Network timeout")
      );
    });
  });

  it("throws StorageAdapterError on JSON parse errors", async () => {
    const adapter = new RemoteAdapter({
      endpoint: "http://localhost:8080/graphql",
      org_id: "test-org",
      codebase_id: "test-codebase",
      auth_token: "test-token",
    });

    // Mock initialize ping query
    mockQuery.mockResolvedValueOnce({ nextId: "WI-001" });
    await adapter.initialize();

    // Mock getNode response followed by domain_index with malformed JSON
    mockQuery
      .mockResolvedValueOnce({
        artifact: {
          artifactId: "WI-001",
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: "abc123",
          tokenCount: 100,
          content: '{"title": "Test"}',
        },
      })
      .mockResolvedValueOnce({
        artifact: {
          content: "{ invalid json", // Malformed JSON
        },
      });

    // Should throw StorageAdapterError with PARSE_ERROR code
    await expect(adapter.getNode("WI-001")).rejects.toSatisfy((err: Error) => {
      return (
        err instanceof StorageAdapterError &&
        err.code === "PARSE_ERROR" &&
        err.message.includes("Failed to parse domain_index content as JSON")
      );
    });
  });

  it("error message includes context about what operation failed (WI-698: plain Error, not ValidationError)", async () => {
    const adapter = new RemoteAdapter({
      endpoint: "http://localhost:8080/graphql",
      org_id: "test-org",
      codebase_id: "test-codebase",
      auth_token: "test-token",
    });

    // Mock initialize ping query
    mockQuery.mockResolvedValueOnce({ nextId: "WI-001" });
    await adapter.initialize();

    // Mock getNode response followed by GraphQL error
    mockQuery
      .mockResolvedValueOnce({
        artifact: {
          artifactId: "WI-001",
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: "abc123",
          tokenCount: 100,
          content: '{"title": "Test"}',
        },
      })
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    try {
      await adapter.getNode("WI-001");
      expect.fail("Should have thrown an Error");
    } catch (err) {
      // WI-698: network failures should throw a plain Error, not ValidationError
      expect(err).not.toBeInstanceOf(ValidationError);
      expect(err).toBeInstanceOf(Error);
      const plainErr = err as Error;
      // Error message includes context about what failed
      expect(plainErr.message).toContain("Failed to fetch current cycle");
      expect(plainErr.message).toContain("ECONNREFUSED");
    }
  });

  it("does NOT silently fallback to cycle 1 on any error (WI-698: plain Error for network failures)", async () => {
    const adapter = new RemoteAdapter({
      endpoint: "http://localhost:8080/graphql",
      org_id: "test-org",
      codebase_id: "test-codebase",
      auth_token: "test-token",
    });

    // Mock initialize ping query
    mockQuery.mockResolvedValueOnce({ nextId: "WI-001" });
    await adapter.initialize();

    // Mock getNode response followed by GraphQL error
    mockQuery
      .mockResolvedValueOnce({
        artifact: {
          artifactId: "WI-001",
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: "abc123",
          tokenCount: 100,
          content: '{"title": "Test"}',
        },
      })
      .mockRejectedValueOnce(new Error("Server error"));

    // Should throw error with proper error type, NOT return a node with cycle_modified = 1
    let caughtError: Error | null = null;
    try {
      await adapter.getNode("WI-001");
    } catch (err) {
      caughtError = err as Error;
    }

    // Verify we got an error (not a silent fallback to cycle 1)
    expect(caughtError).not.toBeNull();
    // WI-698: network/infrastructure errors throw a plain Error (not ValidationError)
    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError!.message).toContain("Failed to fetch current cycle");
  });

  it("propagates StorageAdapterError for PARSE_ERROR (not wrapped)", async () => {
    const adapter = new RemoteAdapter({
      endpoint: "http://localhost:8080/graphql",
      org_id: "test-org",
      codebase_id: "test-codebase",
      auth_token: "test-token",
    });

    // Mock initialize ping query
    mockQuery.mockResolvedValueOnce({ nextId: "WI-001" });
    await adapter.initialize();

    // Mock getNode followed by domain_index with unclosed brace JSON
    mockQuery
      .mockResolvedValueOnce({
        artifact: {
          artifactId: "WI-001",
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: "abc123",
          tokenCount: 100,
          content: '{"title": "Test"}',
        },
      })
      .mockResolvedValueOnce({
        artifact: {
          content: '{"current_cycle": 5', // Unclosed brace
        },
      });

    // Should throw StorageAdapterError directly (not wrapped in ValidationError)
    await expect(adapter.getNode("WI-001")).rejects.toBeInstanceOf(StorageAdapterError);
  });

  it("returns null (not error) when domain_index artifact is missing or empty", async () => {
    const adapter = new RemoteAdapter({
      endpoint: "http://localhost:8080/graphql",
      org_id: "test-org",
      codebase_id: "test-codebase",
      auth_token: "test-token",
    });

    // Mock initialize ping query
    mockQuery.mockResolvedValueOnce({ nextId: "WI-001" });
    await adapter.initialize();

    // Mock getNode followed by missing domain_index (artifact: null)
    mockQuery
      .mockResolvedValueOnce({
        artifact: {
          artifactId: "WI-001",
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: "abc123",
          tokenCount: 100,
          content: '{"title": "Test"}',
        },
      })
      .mockResolvedValueOnce({
        artifact: null, // Missing domain_index
      });

    // Should NOT throw - missing domain_index returns null cycle
    const result = await adapter.getNode("WI-001");
    expect(result).not.toBeNull();
    expect(result!.cycle_modified).toBeNull();
  });

  it("returns null (not error) when domain_index content is empty string", async () => {
    const adapter = new RemoteAdapter({
      endpoint: "http://localhost:8080/graphql",
      org_id: "test-org",
      codebase_id: "test-codebase",
      auth_token: "test-token",
    });

    // Mock initialize ping query
    mockQuery.mockResolvedValueOnce({ nextId: "WI-001" });
    await adapter.initialize();

    // Mock getNode followed by empty content
    mockQuery
      .mockResolvedValueOnce({
        artifact: {
          artifactId: "WI-001",
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: "abc123",
          tokenCount: 100,
          content: '{"title": "Test"}',
        },
      })
      .mockResolvedValueOnce({
        artifact: {
          content: "", // Empty content
        },
      });

    // Should NOT throw - empty content returns null cycle
    const result = await adapter.getNode("WI-001");
    expect(result).not.toBeNull();
    expect(result!.cycle_modified).toBeNull();
  });
});
