import express, { Request, Response } from 'express';
import { randomUUID } from "node:crypto";
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { CallToolResult, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryEventStore } from '../shared/inMemoryEventStore.js';
import { QdrantClient } from "@qdrant/js-client-rest";
import { OpenAI } from "openai";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { URL } from 'url';
import dotenv from "dotenv";

dotenv.config();

const BASE_URL = "https://github.com/jito-foundation/jito-omnidocs/blob/master";

// Define types for Qdrant payload
interface DocMetadata {
  path: string;
  section: string;
  title: string;
  lastUpdated: string;
}

interface SearchResult {
  content: string;
  score: number;
  metadata: DocMetadata;
}

interface DocPayload {
  content: string;
  metadata: DocMetadata;
}

interface QdrantSearchResult {
  id: string | number;
  version: number;
  score: number;
  payload?: DocPayload;
  vector?: number[];
}

interface QdrantPoint {
  id: string | number;
  payload?: Record<string, unknown> | { [key: string]: unknown; } | null;
  vector?: number[] | Record<string, unknown> | number[][] | null;
  shard_key?: string | number;
}

interface JinaRerankResult {
  index: number;
  relevance_score: number;
}

interface JinaRerankResponse {
  model: string;
  usage: {
    total_tokens: number;
  };
  results: JinaRerankResult[];
}

// Initialize clients
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL || "http://localhost:6333",
  apiKey: process.env.QDRANT_API_KEY,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * This example server demonstrates backwards compatibility with both:
 * 1. The deprecated HTTP+SSE transport (protocol version 2024-11-05)
 * 2. The Streamable HTTP transport (protocol version 2025-03-26)
 * 
 * It maintains a single MCP server instance but exposes two transport options:
 * - /mcp: The new Streamable HTTP endpoint (supports GET/POST/DELETE)
 * - /sse: The deprecated SSE endpoint for older clients (GET to establish stream)
 * - /messages: The deprecated POST endpoint for older clients (POST to send messages)
 */

const getServer = () => {
  const server = new McpServer({
    name: 'jito-docs-search-server',
    version: '1.0.0',
  }, { capabilities: { logging: {} } });

  // Register Jito search tool
  server.registerTool(
    'search',
    {
      title: 'Jito Documentation Search',
      description: 'Search through Jito\'s documentation using semantic search',
      inputSchema: {
        query: z.string().describe("The search query"),
        limit: z.number().optional().default(10).describe("Maximum number of results to return"),
      },
    },
    async ({ query, limit = 5 }): Promise<CallToolResult> => {
      try {
        console.log(`Searching for: "${query}" with limit: ${limit}`);
        
        // Generate embedding for search query
        const embedding = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: query,
        });

        // Search in Qdrant
        const searchResults = await qdrant.search("jito_docs", {
          vector: embedding.data[0].embedding,
          limit: limit,
          with_payload: true,
          with_vector: false,
        }) as QdrantSearchResult[];

        // Format results
        const results = searchResults.map((result) => ({
          content: result.payload?.content || "",
          score: result.score,
          metadata: result.payload?.metadata || {
            path: "",
            section: "",
            title: "",
            lastUpdated: "",
          }
        }));

        // Use Jina AI's cloud reranking API if available
        let reranked = results;
        const jinaApiKey = process.env.JINA_API_KEY;
        
        if (jinaApiKey && results.length > 1) {
          try {
            const response = await fetch("https://api.jina.ai/v1/rerank", {
              method: "POST",
              headers: { 
                "Content-Type": "application/json",
                "Authorization": `Bearer ${jinaApiKey}`
              },
              body: JSON.stringify({
                model: "jina-reranker-v1-turbo-en",
                query,
                documents: results.map((r: SearchResult) => r.content),
                top_n: results.length,
                return_documents: false
              }),
            });

            if (response.ok) {
              const jinaResponse: JinaRerankResponse = await response.json();
              
              // Map Jina AI results back to our results format
              reranked = jinaResponse.results.map((jinaResult: JinaRerankResult) => ({
                ...results[jinaResult.index],
                rerankScore: jinaResult.relevance_score,
              })).sort((a: SearchResult & { rerankScore: number }, b: SearchResult & { rerankScore: number }) => b.rerankScore - a.rerankScore);
              
              console.log("Reranking successful");
            } else {
              console.warn(`Jina AI reranking failed: ${response.status} ${response.statusText}`);
            }
          } catch (rerankError) {
            console.warn("Reranking failed, using original results:", rerankError instanceof Error ? rerankError.message : "Unknown error");
          }
        }

        console.log(`Found ${reranked.length} results`);

        return {
          content: [
            {
              type: "text",
              text: reranked.map((r: SearchResult & { rerankScore?: number }) => 
                `### ${r.metadata.title} (${r.metadata.section})\n\n${r.content}\n\n[Source](${BASE_URL}/${r.metadata.path})`
              ).join("\n\n---\n\n")
            },
          ],
        };
      } catch (error) {
        console.error("Search error:", error);
        return {
          content: [
            {
              type: "text",
              text: `Error performing search: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register resource for getting specific documentation sections
  server.registerResource(
    "jito-docs-section",
    new ResourceTemplate("docs://{section}", { list: undefined }),
    {
      title: "Jito Documentation Section",
      description: "Access specific sections of Jito documentation",
      mimeType: "text/markdown",
    },
    async (uri: URL) => {
      try {
        const pathSection = uri.pathname.split("/").pop() || "";
        console.log(`Fetching documentation section: ${pathSection}`);

        // Get documents from the section
        const results = await qdrant.scroll("jito_docs", {
          filter: {
            must: [
              {
                key: "metadata.section",
                match: { value: pathSection },
              },
            ],
          },
          with_payload: true,
          limit: 10,
        });

        const docs = ((results.points || []) as QdrantSearchResult[]).map((point) => ({
          content: point.payload?.content || "",
          metadata: point.payload?.metadata || {
            path: "",
            section: "",
            title: "",
            lastUpdated: "",
          },
        }));

        console.log(`Found ${docs.length} documents in section ${pathSection}`);

        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(docs, null, 2),
              mimeType: "application/json",
            },
          ],
        };
      } catch (error) {
        const errorSection = uri.pathname.split("/").pop() || "";
        console.error("Error fetching section:", errorSection, error);
        throw new Error(`Failed to fetch section ${errorSection}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }
  );

  // Register a simple tool that sends notifications over time
  server.tool(
    'start-notification-stream',
    {
      title: 'Start Notification Stream',
      description: 'Starts sending periodic notifications for testing resumability',
      inputSchema: {
        interval: z.number().describe('Interval in milliseconds between notifications').default(100),
        count: z.number().describe('Number of notifications to send (0 for 100)').default(50),
      },
    },
    async ({ interval, count }, { sendNotification }): Promise<CallToolResult> => {
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      let counter = 0;

      while (count === 0 || counter < count) {
        counter++;
        try {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: `Periodic notification #${counter} at ${new Date().toISOString()}`
            }
          });
        }
        catch (error) {
          console.error("Error sending notification:", error);
        }
        // Wait for the specified interval
        await sleep(interval);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Started sending periodic notifications every ${interval}ms`,
          }
        ],
      };
    }
  );
  return server;
};

// Create Express application
const app = express();
app.use(express.json());

// Store transports by session ID
const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};

//=============================================================================
// STREAMABLE HTTP TRANSPORT (PROTOCOL VERSION 2025-03-26)
//=============================================================================

// Handle all MCP Streamable HTTP requests (GET, POST, DELETE) on a single endpoint
app.all('/mcp', async (req: Request, res: Response) => {
  console.log(`Received ${req.method} request to /mcp`);

  try {
    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Check if the transport is of the correct type
      const existingTransport = transports[sessionId];
      if (existingTransport instanceof StreamableHTTPServerTransport) {
        // Reuse existing transport
        transport = existingTransport;
      } else {
        // Transport exists but is not a StreamableHTTPServerTransport (could be SSEServerTransport)
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: Session exists but uses a different transport protocol',
          },
          id: null,
        });
        return;
      }
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      const eventStore = new InMemoryEventStore();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore, // Enable resumability
        onsessioninitialized: (sessionId) => {
          // Store the transport by session ID when session is initialized
          console.log(`StreamableHTTP session initialized with ID: ${sessionId}`);
          transports[sessionId] = transport;
        }
      });

      // Set up onclose handler to clean up transport when closed
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`Transport closed for session ${sid}, removing from transports map`);
          delete transports[sid];
        }
      };

      // Connect the transport to the MCP server
      const server = getServer();
      await server.connect(transport);
    } else {
      // Invalid request - no session ID or not initialization request
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
      return;
    }

    // Handle the request with the transport
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

//=============================================================================
// DEPRECATED HTTP+SSE TRANSPORT (PROTOCOL VERSION 2024-11-05)
//=============================================================================

app.get('/sse', async (req: Request, res: Response) => {
  console.log('Received GET request to /sse (deprecated SSE transport)');
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on("close", () => {
    delete transports[transport.sessionId];
  });
  const server = getServer();
  await server.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  let transport: SSEServerTransport;
  const existingTransport = transports[sessionId];
  if (existingTransport instanceof SSEServerTransport) {
    // Reuse existing transport
    transport = existingTransport;
  } else {
    // Transport exists but is not a SSEServerTransport (could be StreamableHTTPServerTransport)
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: Session exists but uses a different transport protocol',
      },
      id: null,
    });
    return;
  }
  if (transport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).send('No transport found for sessionId');
  }
});


// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backwards compatible MCP server listening on port ${PORT}`);
  console.log(`
==============================================
SUPPORTED TRANSPORT OPTIONS:

1. Streamable Http(Protocol version: 2025-03-26)
   Endpoint: /mcp
   Methods: GET, POST, DELETE
   Usage: 
     - Initialize with POST to /mcp
     - Establish SSE stream with GET to /mcp
     - Send requests with POST to /mcp
     - Terminate session with DELETE to /mcp

2. Http + SSE (Protocol version: 2024-11-05)
   Endpoints: /sse (GET) and /messages (POST)
   Usage:
     - Establish SSE stream with GET to /sse
     - Send requests with POST to /messages?sessionId=<id>
==============================================
`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');

  // Close all active transports to properly clean up resources
  for (const sessionId in transports) {
    try {
      console.log(`Closing transport for session ${sessionId}`);
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing transport for session ${sessionId}:`, error);
    }
  }
  console.log('Server shutdown complete');
  process.exit(0);
});