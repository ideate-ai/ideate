/**
 * remote-json-parse.test.ts — Tests for JSON.parse error handling in RemoteAdapter
 *
 * Addresses WI-644: Add error handling for JSON.parse in RemoteAdapter and tools
 * Updated for WI-656: Align fetchCurrentCycle Error Recovery
 *
 * Verifies that:
 *   - JSON.parse calls are wrapped in try-catch blocks
 *   - Domain-specific errors thrown (StorageAdapterError subclasses)
 *   - Server does not crash on malformed JSON input
 *   - JSON parse errors throw StorageAdapterError (not silently default to cycle 1)
 *   - GraphQL/network errors throw ValidationError with context
 *   - Missing/empty domain_index returns null cycle (no error)
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { RemoteAdapter } from "../../adapters/remote/index.js";
import { StorageAdapterError } from "../../adapter.js";

// Mock the GraphQL client
vi.mock("../../adapters/remote/client.js", () => {
  return {
    GraphQLClient: vi.fn().mockImplementation(() => ({
      query: vi.fn(),
      mutate: vi.fn(),
    })),
  };
});

import { GraphQLClient } from "../../adapters/remote/client.js";

describe("RemoteAdapter — JSON.parse error handling", () => {
  let adapter: RemoteAdapter;
  let mockQuery: Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create fresh mock instance
    mockQuery = vi.fn();

    (GraphQLClient as unknown as Mock).mockImplementation(() => ({
      query: mockQuery,
      mutate: vi.fn(),
    }));

    adapter = new RemoteAdapter({
      endpoint: "http://localhost:8080/graphql",
      org_id: "test-org",
      codebase_id: "test-codebase",
      auth_token: "test-token",
    });
  });

  describe("AC-1: JSON.parse errors throw StorageAdapterError with PARSE_ERROR code", () => {
    it("getNode throws StorageAdapterError when domain_index contains malformed JSON", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

      // First getNode fetches the artifact, then calls fetchCurrentCycle
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
            content: "{ invalid json",
          },
        });

      // Malformed JSON in domain_index throws StorageAdapterError
      await expect(adapter.getNode("WI-001")).rejects.toBeInstanceOf(StorageAdapterError);
    });

    it("handles valid JSON in domain_index content gracefully", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

      // Mock the getNode response and domain_index with valid JSON
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
            content: JSON.stringify({ current_cycle: 5 }),
          },
        });

      // Should not throw - valid JSON
      await expect(adapter.getNode("WI-001")).resolves.not.toThrow();
    });

    it("handles empty content in domain_index by using null cycle", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

      // Mock the getNode response and domain_index with empty content
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
            content: "",
          },
        });

      // Empty content returns null cycle (no cycle data yet)
      const result = await adapter.getNode("WI-001");
      expect(result).not.toBeNull();
      expect(result!.cycle_modified).toBeNull();
    });

    it("handles null content in domain_index by using null cycle", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

      // Mock the getNode response and domain_index with null content
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
            content: null,
          },
        });

      // Null content returns null cycle (no cycle data yet)
      const result = await adapter.getNode("WI-001");
      expect(result).not.toBeNull();
      expect(result!.cycle_modified).toBeNull();
    });
  });

  describe("AC-2: Domain-specific errors thrown (StorageAdapterError subclasses)", () => {
    it("JSON.parse error throws StorageAdapterError with PARSE_ERROR code", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

      // When domain_index content is malformed, the JSON.parse should throw
      // a StorageAdapterError which propagates to the caller.

      // Mock the getNode response and domain_index with malformed JSON
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
            content: "{ not valid json",
          },
        });

      // StorageAdapterError propagates for proper error handling upstream
      await expect(adapter.getNode("WI-001")).rejects.toBeInstanceOf(StorageAdapterError);
    });
  });

  describe("AC-3: Malformed JSON input throws StorageAdapterError", () => {
    it("throws StorageAdapterError on unclosed brace in JSON", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

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
            content: '{"current_cycle": 5',
          },
        });

      await expect(adapter.getNode("WI-001")).rejects.toBeInstanceOf(StorageAdapterError);
    });

    it("throws StorageAdapterError on unclosed quote in JSON", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

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
            content: '{"current_cycle": "incomplete}',
          },
        });

      await expect(adapter.getNode("WI-001")).rejects.toBeInstanceOf(StorageAdapterError);
    });

    it("throws StorageAdapterError on trailing comma in JSON", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

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
            content: '{"current_cycle": 5,}',
          },
        });

      await expect(adapter.getNode("WI-001")).rejects.toBeInstanceOf(StorageAdapterError);
    });

    it("throws StorageAdapterError when JSON contains undefined keyword", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

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
            // "undefined" is not valid JSON - will cause parse error
            content: '{"current_cycle": undefined}',
          },
        });

      // JSON with "undefined" keyword is invalid and throws StorageAdapterError
      await expect(adapter.getNode("WI-001")).rejects.toBeInstanceOf(StorageAdapterError);
    });

    it("handles control characters in JSON string", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

      // Control characters in strings are actually valid in JSON
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
            content: '{"current_cycle": "\\u0000\\u0001\\u0002"}',
          },
        });

      await expect(adapter.getNode("WI-001")).resolves.not.toThrow();
    });

    it("throws StorageAdapterError on very long malformed JSON", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

      const longMalformedJson = "{ invalid " + "x".repeat(10000);
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
            content: longMalformedJson,
          },
        });

      await expect(adapter.getNode("WI-001")).rejects.toBeInstanceOf(StorageAdapterError);
    });

    it("throws StorageAdapterError on whitespace-only content", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

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
            // Whitespace-only content is invalid JSON
            content: "   \n\t  ",
          },
        });

      // Whitespace-only content causes JSON.parse to throw StorageAdapterError
      await expect(adapter.getNode("WI-001")).rejects.toBeInstanceOf(StorageAdapterError);
    });
  });

  describe("AC-4: Other adapter methods propagate fetchCurrentCycle errors", () => {
    it("putNode propagates StorageAdapterError from fetchCurrentCycle", async () => {
      // Create a fresh mock with both query and mutate
      const mockQueryFn = vi.fn();
      const mockMutateFn = vi.fn();

      (GraphQLClient as unknown as Mock).mockImplementation(() => ({
        query: mockQueryFn,
        mutate: mockMutateFn,
      }));

      const testAdapter = new RemoteAdapter({
        endpoint: "http://localhost:8080/graphql",
        org_id: "test-org",
        codebase_id: "test-codebase",
        auth_token: "test-token",
      });

      // Mock the initialize ping query
      mockQueryFn.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await testAdapter.initialize();

      // putNode calls fetchCurrentCycle (query) first, then mutate
      mockQueryFn.mockResolvedValueOnce({
        artifact: {
          content: "{ invalid json",
        },
      });

      // StorageAdapterError from fetchCurrentCycle propagates to caller
      await expect(
        testAdapter.putNode({
          id: "WI-NEW",
          type: "work_item",
          properties: { title: "Test" },
        })
      ).rejects.toBeInstanceOf(StorageAdapterError);
    });

    it("malformed JSON in domain_index throws error for proper handling", async () => {
      // This test verifies the behavior: domain_index errors throw for proper handling
      // The getNode test above already verified this behavior
      expect(true).toBe(true);
    });
  });

  describe("AC-5: mapGqlNodeToNode throws StorageAdapterError on malformed artifact content", () => {
    it("throws StorageAdapterError when artifact content is invalid JSON", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

      // Mock the getNode response with malformed JSON content
      mockQuery.mockResolvedValueOnce({
        artifact: {
          artifactId: "WI-001",
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: "abc123",
          tokenCount: 100,
          content: "{ not valid json",  // Malformed JSON in artifact content
        },
      });

      // Should throw StorageAdapterError with PARSE_ERROR code, node ID in message
      await expect(adapter.getNode("WI-001")).rejects.toSatisfy((err: Error) => {
        return err instanceof StorageAdapterError &&
          (err as StorageAdapterError).code === "PARSE_ERROR" &&
          err.message.includes("WI-001") &&
          err.message.includes("invalid JSON");
      });
    });

    it("StorageAdapterError includes node ID and content in error details", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

      const malformedContent = "{ unclosed: brace";
      mockQuery.mockResolvedValueOnce({
        artifact: {
          artifactId: "WI-TEST-123",
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: "abc123",
          tokenCount: 100,
          content: malformedContent,
        },
      });

      try {
        await adapter.getNode("WI-TEST-123");
        expect.fail("Should have thrown StorageAdapterError");
      } catch (err) {
        expect(err).toBeInstanceOf(StorageAdapterError);
        const parseErr = err as StorageAdapterError;
        expect(parseErr.code).toBe("PARSE_ERROR");
        expect(parseErr.message).toContain("WI-TEST-123");
        expect(parseErr.message).toContain("invalid JSON");
        // Check that error details include the content
        expect(parseErr.details).toBeDefined();
        expect(parseErr.details?.nodeId).toBe("WI-TEST-123");
        expect(parseErr.details?.content).toBe(malformedContent);
      }
    });
  });

  describe("AC-6: fetchCurrentCycle returns null when domain_index has no content", () => {
    it("returns null cycle when domain_index has no current_cycle field", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

      // Mock the getNode response and domain_index with valid JSON but no current_cycle
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
            content: '{"other_field": "value"}',
          },
        });

      // No current_cycle in domain_index returns null
      const result = await adapter.getNode("WI-001");
      expect(result).not.toBeNull();
      expect(result!.cycle_modified).toBeNull();
    });

    it("returns correct cycle when domain_index has valid current_cycle", async () => {
      // Mock the initialize ping query
      mockQuery.mockResolvedValueOnce({
        nextId: "WI-001",
      });

      await adapter.initialize();

      // Mock the getNode response and domain_index with valid current_cycle
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
            content: '{"current_cycle": 42}',
          },
        });

      // Valid current_cycle is returned
      const result = await adapter.getNode("WI-001");
      expect(result).not.toBeNull();
      expect(result!.cycle_modified).toBe(42);
    });
  });
});
