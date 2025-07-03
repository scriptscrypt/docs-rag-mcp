import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QdrantClient } from "@qdrant/js-client-rest";
import { OpenAI } from "openai";
import { z } from "zod";
import dotenv from "dotenv";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { URL } from 'url';
import express, { Request, Response } from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

dotenv.config();

const BASE_URL = "https://github.com/jito-foundation/jito-omnidocs/blob/master";
const port = process.env.PORT || 3000;

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

// Create a function to set up a new server instance
function createServer() {
  const server = new McpServer({
    name: "jito-docs-search",
    version: "1.0.0",
  });

  // Register search tool
  server.registerTool(
    "search",
    {
      title: "Jito Documentation Search",
      description: "Search through Jito's documentation using semantic search",
      inputSchema: {
        query: z.string().describe("The search query"),
        limit: z.number().optional().default(10).describe("Maximum number of results to return"),
      },
    },
    async ({ query, limit = 5 }) => {
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
    "doc-section",
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

  return server;
}

async function main() {
  const app = express();
  
  // Add JSON parsing middleware
  app.use(express.json());
  app.use(cors({
    origin: true,
    exposedHeaders: ['mcp-session-id'],
    allowedHeaders: ['Content-Type', 'mcp-session-id'],
    credentials: true,
  }));

  // Storage for different transport types
  const sseTransports: { [sessionId: string]: SSEServerTransport } = {};
  const httpTransports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  // Health check endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
  });

  // Streamable HTTP endpoint (modern MCP transport)
  app.post("/mcp", async (req: Request, res: Response) => {
    console.log("Received POST request on /mcp");
    
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && httpTransports[sessionId]) {
        // Reuse existing transport for this session
        transport = httpTransports[sessionId];
        console.log(`Reusing transport for session ${sessionId}`);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request - create new transport
        console.log("Creating new transport for initialization");
        
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            console.log(`Session initialized: ${newSessionId}`);
            httpTransports[newSessionId] = transport;
          },
        });

        // Clean up transport when closed
        transport.onclose = () => {
          if (transport.sessionId) {
            console.log(`Cleaning up transport for session ${transport.sessionId}`);
            delete httpTransports[transport.sessionId];
          }
        };

        // Create a new server instance and connect
        const server = createServer();
        await server.connect(transport);
        console.log("Server connected to new transport");
      } else {
        // Invalid request
        console.log("Invalid request - no session ID or not an initialize request");
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

      // Handle the request
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

  // Handle GET requests for server-to-client notifications via SSE
  app.get("/mcp", async (req: Request, res: Response) => {
    console.log("Received GET request on /mcp for SSE");
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    
    if (!sessionId || !httpTransports[sessionId]) {
      console.log(`Invalid or missing session ID: ${sessionId}`);
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    
    try {
      const transport = httpTransports[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling GET MCP request:', error);
      if (!res.headersSent) {
        res.status(500).send('Internal server error');
      }
    }
  });

  // Handle DELETE requests for session termination
  app.delete("/mcp", async (req: Request, res: Response) => {
    console.log("Received DELETE request on /mcp for session termination");
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    
    if (!sessionId || !httpTransports[sessionId]) {
      console.log(`Invalid or missing session ID for deletion: ${sessionId}`);
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    
    try {
      const transport = httpTransports[sessionId];
      await transport.handleRequest(req, res);
      
      // Clean up the transport
      delete httpTransports[sessionId];
      console.log(`Session ${sessionId} terminated and cleaned up`);
    } catch (error) {
      console.error('Error handling DELETE MCP request:', error);
      if (!res.headersSent) {
        res.status(500).send('Internal server error');
      }
    }
  });

  // Legacy SSE endpoint (for backwards compatibility)
  app.get("/sse", async (_req: Request, res: Response) => {
    console.log("Received connection on legacy /sse endpoint");
    
    try {
      const transport = new SSEServerTransport("/messages", res);
      sseTransports[transport.sessionId] = transport;

      res.on("close", () => {
        console.log(`SSE connection closed for session ${transport.sessionId}`);
        delete sseTransports[transport.sessionId];
      });

      const server = createServer();
      await server.connect(transport);
      console.log(`SSE server connected with session ID: ${transport.sessionId}`);
    } catch (error) {
      console.error('Error setting up SSE transport:', error);
      if (!res.headersSent) {
        res.status(500).send('Internal server error');
      }
    }
  });

  // Legacy message endpoint for SSE transport
  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    console.log(`Received message for SSE session ${sessionId}`);

    const transport = sseTransports[sessionId];
    if (transport) {
      try {
        await transport.handlePostMessage(req, res);
      } catch (error) {
        console.error('Error handling SSE message:', error);
        if (!res.headersSent) {
          res.status(500).send('Internal server error');
        }
      }
    } else {
      console.log(`No transport found for SSE session ID: ${sessionId}`);
      res.status(400).send("No transport found for sessionId");
    }
  });

  // Error handling middleware
  app.use((error: Error, _req: Request, res: Response, _next: Function) => {
    console.error('Unhandled error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: error.message,
      });
    }
  });

  // Start the server
  app.listen(port, () => {
    console.log(`MCP server listening on port ${port}`);
    console.log(`Health check: http://localhost:${port}/health`);
    console.log(`Streamable HTTP: http://localhost:${port}/mcp`);
    console.log(`Legacy SSE: http://localhost:${port}/sse`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  return app;
}

// Start the server
main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});