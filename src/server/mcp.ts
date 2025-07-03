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

// Create MCP server
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
      limit: z.number().optional().default(5).describe("Maximum number of results to return"),
    },
  },
  async ({ query, limit = 5 }) => {
    try {
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

      // const rerankedResults = await rerankResults(query, results);

      // Use Jina AI's cloud reranking API
      const jinaApiKey = process.env.JINA_API_KEY;
      if (!jinaApiKey) {
        throw new Error("JINA_API_KEY environment variable is required");
      }

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
          top_n: results.length, // Return all results, we'll handle limiting elsewhere
          return_documents: false
        }),
      });

      if (!response.ok) {
        throw new Error(`Jina AI API error: ${response.status} ${response.statusText}`);
      }
      
            const jinaResponse: JinaRerankResponse = await response.json();
      
       // Map Jina AI results back to our results format
       const reranked = jinaResponse.results.map((jinaResult: JinaRerankResult) => ({
         ...results[jinaResult.index],
         rerankScore: jinaResult.relevance_score,
       })).sort((a: SearchResult & { rerankScore: number }, b: SearchResult & { rerankScore: number }) => b.rerankScore - a.rerankScore);
      

      console.log(reranked);

      return {
        content: [
          {
            type: "text",
            text: reranked.map((r: SearchResult & { rerankScore: number }) => 
              `### ${r.metadata.title} (${r.metadata.section})\n\n${r.content}\n\n[Source](${BASE_URL}/${r.metadata.path})`
            ).join("\n\n")      
          },
        ],
      };
    } catch (error) {
      console.error(JSON.stringify({ error: "Search error", details: error instanceof Error ? error.message : "Unknown error" }));
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

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(docs, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorSection = uri.pathname.split("/").pop() || "";
      console.error(JSON.stringify({ error: "Error fetching section", section: errorSection, details: error instanceof Error ? error.message : "Unknown error" }));
      throw new Error(`Failed to fetch section ${errorSection}: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
);

async function main() {

  const app = express();
  app.use(cors());
  const transports: { [sessionId: string]: SSEServerTransport } = {};

  app.get("/sse", async (_req: Request, res: Response) => {
    console.log("Received connection on /sse");
    const transport = new SSEServerTransport("/messages", res);

    transports[transport.sessionId] = transport;

    res.on("close", () => {
      console.log(`Connection closed for session ${transport.sessionId}`);
      delete transports[transport.sessionId];
    });

    await server.connect(transport);
  });

  app.post("/mcp", async (_req: Request, res: Response) => {
    console.log("Received connection on /mcp");
    const transport = new StreamableHTTPServerTransport(
      {
        enableJsonResponse: true,
        sessionIdGenerator: () => crypto.randomUUID(),
      },
    );
    await server.connect(transport);
  });


  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    console.log(`Received message for session ${sessionId}`);

    const transport = transports[sessionId];
    if (transport) {
      await transport.handlePostMessage(req, res);
    } else {
      res.status(400).send("No transport found for sessionId");
    }
  });
  const port = 3000;
  app.listen(port, () => {
    console.log(`MCP SSE server listening on port ${port}`);
    console.log(`MCP SSE server running at http://localhost:${port}/sse`);
  });

  return app;
}

main(); 