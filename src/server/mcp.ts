import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QdrantClient } from "@qdrant/js-client-rest";
import { OpenAI } from "openai";
import { z } from "zod";
import dotenv from "dotenv";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { URL } from 'url';

dotenv.config();

// Define types for Qdrant payload
interface DocMetadata {
  path: string;
  section: string;
  title: string;
  lastUpdated: string;
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
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

// Start the server
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(JSON.stringify({ status: "Server started", message: "Jito Docs MCP server is running" }));
  } catch (error) {
    console.error(JSON.stringify({ error: "Server startup error", details: error instanceof Error ? error.message : "Unknown error" }));
    process.exit(1);
  }
}

main(); 