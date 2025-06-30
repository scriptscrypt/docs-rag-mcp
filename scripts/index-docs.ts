import { QdrantClient } from '@qdrant/js-client-rest';
import { OpenAI } from 'openai';
import { marked } from 'marked';
import { glob } from 'glob';
import { readFileSync } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { syncDocs } from './sync-docs';

// Initialize clients
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const COLLECTION_NAME = 'jito_docs';
const CHUNK_SIZE = 1000; // characters
const CHUNK_OVERLAP = 200;
const DOCS_DIR = path.join(process.cwd(), 'docs');

interface DocChunk {
  id: string;
  content: string;
  metadata: {
    path: string;
    section: string;
    title: string;
    lastUpdated: string;
    url: string; // GitHub URL to the document
  };
  embedding: number[];
}

async function createCollection() {
  try {
    await qdrant.getCollection(COLLECTION_NAME);
  } catch {
    await qdrant.createCollection(COLLECTION_NAME, {
      vectors: {
        size: 1536, // OpenAI embedding size
        distance: 'Cosine',
      },
    });
  }
}

function extractTextFromMarkdown(markdown: string): string {
  const tokens = marked.lexer(markdown);
  return tokens.map(token => {
    if (token.type === 'paragraph') return token.text;
    if (token.type === 'heading') return token.text;
    if (token.type === 'list') {
      return token.items
        .map((item: any) => item.text)
        .join('\n');
    }
    return '';
  }).join('\n');
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let currentChunk = '';

  const sentences = text.split(/(?<=[.!?])\s+/);

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > CHUNK_SIZE) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += ' ' + sentence;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    input: text,
    model: 'text-embedding-3-small'
  });

  return response.data[0].embedding;
}

function getGitHubUrl(filePath: string): string {
  const relativePath = path.relative(DOCS_DIR, filePath);
  return `https://github.com/jito-foundation/jito-omnidocs/blob/master/${relativePath}`;
}

async function processFile(filePath: string) {
  console.log(`Processing ${filePath}...`);
  
  const fileContent = readFileSync(filePath, 'utf-8');
  const { data: frontmatter, content } = matter(fileContent);
  
  const section = path.relative(DOCS_DIR, path.dirname(filePath)).split('/')[0];
  const plainText = extractTextFromMarkdown(content);
  const chunks = chunkText(plainText);

  const points: DocChunk[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = await generateEmbedding(chunk);

    points.push({
      id: `${filePath}-${i}`,
      content: chunk,
      metadata: {
        path: path.relative(DOCS_DIR, filePath),
        section,
        title: frontmatter.title || '',
        lastUpdated: new Date().toISOString(),
        url: getGitHubUrl(filePath),
      },
      embedding,
    });
  }

  // Upsert points to Qdrant
  await qdrant.upsert(COLLECTION_NAME, {
    points: points.map(point => ({
      id: point.id,
      vector: point.embedding,
      payload: {
        content: point.content,
        metadata: point.metadata,
      },
    })),
  });

  console.log(`Indexed ${points.length} chunks from ${filePath}`);
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('file', {
      type: 'string',
      description: 'Process a specific file',
    })
    .option('section', {
      type: 'string',
      description: 'Process a specific section',
    })
    .option('sync', {
      type: 'boolean',
      description: 'Sync documentation before indexing',
      default: true,
    })
    .argv;

  if (argv.sync) {
    await syncDocs();
  }

  await createCollection();

  if (argv.file) {
    const filePath = path.join(DOCS_DIR, argv.file);
    await processFile(filePath);
  } else if (argv.section) {
    const files = await glob(`${DOCS_DIR}/${argv.section}/**/*.{md,mdx}`);
    for (const file of files) {
      await processFile(file);
    }
  } else {
    const files = await glob(`${DOCS_DIR}/**/*.{md,mdx}`);
    for (const file of files) {
      await processFile(file);
    }
  }
}

main().catch(console.error); 