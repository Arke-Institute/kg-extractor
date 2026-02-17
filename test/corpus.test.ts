/**
 * Corpus test - Run kg-extractor-v2 on multiple chunks in parallel
 *
 * This tests the Durable Object-based kg-extractor which should NOT timeout
 * like the v1 waitUntil() based version.
 *
 * Usage:
 *   ARKE_USER_KEY=uk_... KLADOS_ID=... CHUNKS=10 npm test
 *
 * Environment:
 *   CHUNKS - Number of chunks to process (default: 5)
 *   CHUNK_SIZE - Characters per chunk (default: 8000 ~= 2000 tokens)
 */

import { readFileSync } from 'fs';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  configureTestClient,
  createCollection,
  createEntity,
  invokeKlados,
  waitForKladosLog,
  getEntity,
  log,
} from '@arke-institute/klados-testing';

// =============================================================================
// Configuration
// =============================================================================

const ARKE_USER_KEY = process.env.ARKE_USER_KEY;
const ARKE_API_BASE = process.env.ARKE_API_BASE || 'https://arke-v1.arke.institute';
const NETWORK = 'test' as const;
const KLADOS_ID = process.env.KLADOS_ID;

// Corpus settings - larger chunks for better context (~2000 tokens)
const MOBY_DICK_PATH = '/Users/chim/Downloads/test-collection/texts/moby-dick.txt';
const NUM_CHUNKS = parseInt(process.env.CHUNKS || '5', 10);
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '8000', 10);

// =============================================================================
// Chunking Utilities
// =============================================================================

/**
 * Strip Project Gutenberg header and footer
 */
function stripGutenberg(text: string): string {
  const startMarker = '*** START OF THE PROJECT GUTENBERG EBOOK';
  const endMarker = '*** END OF THE PROJECT GUTENBERG EBOOK';

  let start = text.indexOf(startMarker);
  if (start !== -1) {
    start = text.indexOf('\n', start) + 1;
  } else {
    start = 0;
  }

  let end = text.indexOf(endMarker);
  if (end === -1) {
    end = text.length;
  }

  return text.slice(start, end).trim();
}

/**
 * Chunk text into pieces by character count, trying to break at paragraph boundaries
 */
function chunkText(text: string, chunkSize: number, numChunks: number): string[] {
  const chunks: string[] = [];
  let position = 0;

  while (position < text.length && chunks.length < numChunks) {
    // Get a chunk of approximately chunkSize
    let end = Math.min(position + chunkSize, text.length);

    // Try to find a paragraph break near the end
    if (end < text.length) {
      // Look for paragraph break within last 20% of chunk
      const searchStart = position + Math.floor(chunkSize * 0.8);
      const searchRegion = text.slice(searchStart, end + 200);
      const breakMatch = searchRegion.match(/\n\n/);

      if (breakMatch && breakMatch.index !== undefined) {
        end = searchStart + breakMatch.index + 2; // Include the newlines
      }
    }

    const chunk = text.slice(position, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    position = end;
  }

  return chunks;
}

// =============================================================================
// Relationship Traversal
// =============================================================================

/**
 * Traverse extracted entities starting from chunks using BFS.
 * Follows 'extracted_entity' relationships to find all entities.
 * No indexing wait needed - outgoing relationships are on the entity.
 */
async function traverseExtractedEntities(
  chunkIds: string[]
): Promise<Map<string, { id: string; type: string; label: string }>> {
  const entities = new Map<string, { id: string; type: string; label: string }>();
  const visited = new Set<string>();
  const queue: string[] = [...chunkIds];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    try {
      const entity = await getEntity(currentId);

      // Skip chunk entities themselves in the result
      if (entity.type !== 'text_chunk') {
        entities.set(currentId, {
          id: entity.id,
          type: entity.type,
          label: (entity.properties?.label as string) || 'unknown',
        });
      }

      // Find outgoing 'extracted_entity' relationships
      const extractedRels =
        entity.relationships?.filter(
          (r: { predicate: string }) => r.predicate === 'extracted_entity'
        ) ?? [];

      // Add children to queue
      for (const rel of extractedRels) {
        if (!visited.has(rel.peer)) {
          queue.push(rel.peer);
        }
      }
    } catch (err) {
      log(`Failed to fetch entity ${currentId}: ${err}`);
    }
  }

  return entities;
}

// =============================================================================
// Test Suite
// =============================================================================

describe('kg-extractor-v2 corpus test (DO-based)', () => {
  let targetCollection: { id: string };
  let chunks: string[];
  let chunkEntities: Array<{ id: string; label: string }>;

  // Skip if not configured
  beforeAll(() => {
    if (!ARKE_USER_KEY) {
      console.warn('Skipping tests: ARKE_USER_KEY not set');
      return;
    }
    if (!KLADOS_ID) {
      console.warn('Skipping tests: KLADOS_ID not set');
      return;
    }

    // Configure client
    configureTestClient({
      apiBase: ARKE_API_BASE,
      userKey: ARKE_USER_KEY,
      network: NETWORK,
    });

    // Load and chunk the text
    log(`Loading Moby Dick from ${MOBY_DICK_PATH}`);
    const rawText = readFileSync(MOBY_DICK_PATH, 'utf-8');
    const cleanText = stripGutenberg(rawText);
    log(`Clean text: ${cleanText.length} characters`);

    chunks = chunkText(cleanText, CHUNK_SIZE, NUM_CHUNKS);
    log(`Created ${chunks.length} chunks of ~${CHUNK_SIZE} chars each`);

    for (let i = 0; i < Math.min(3, chunks.length); i++) {
      log(`  Chunk ${i + 1}: ${chunks[i].length} chars, starts with: "${chunks[i].slice(0, 50)}..."`);
    }
  });

  it(`should process ${NUM_CHUNKS} chunks in parallel WITHOUT timeout (DO-based)`, async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    // =========================================================================
    // Step 1: Create collection with invoke permission for klados
    // =========================================================================
    log('Creating target collection...');
    targetCollection = await createCollection({
      label: `KG Extractor v2 Corpus Test ${Date.now()}`,
      description: `${chunks.length} chunks of ~${CHUNK_SIZE} chars (DO-based, no timeout)`,
      roles: { public: ['*:view', '*:invoke'] },
    });
    log(`Created collection: ${targetCollection.id}`);

    // =========================================================================
    // Step 2: Create all chunk entities in parallel
    // =========================================================================
    log(`Creating ${chunks.length} chunk entities...`);
    const createStart = Date.now();

    chunkEntities = await Promise.all(
      chunks.map(async (chunk, i) => {
        const entity = await createEntity({
          type: 'text_chunk',
          collection: targetCollection.id,
          properties: {
            label: `Moby Dick Chunk ${i + 1}`,
            text: chunk,
            chunk_index: i,
            chunk_size: chunk.length,
          },
        });
        return { id: entity.id, label: `Chunk ${i + 1}` };
      })
    );

    log(`Created ${chunkEntities.length} entities in ${Date.now() - createStart}ms`);

    // =========================================================================
    // Step 3: Invoke kg-extractor-v2 on ALL chunks in parallel
    // =========================================================================
    log(`Invoking kg-extractor-v2 on ${chunkEntities.length} chunks IN PARALLEL...`);
    const invokeStart = Date.now();

    const invokeResults = await Promise.all(
      chunkEntities.map(async (entity) => {
        try {
          const result = await invokeKlados({
            kladosId: KLADOS_ID!,
            targetCollection: targetCollection.id,
            targetEntity: entity.id,
            confirm: true,
          });
          return { entity, result, error: null };
        } catch (error) {
          return { entity, result: null, error };
        }
      })
    );

    const successful = invokeResults.filter((r) => r.result?.status === 'started');
    const failed = invokeResults.filter((r) => r.result?.status !== 'started');

    log(`Invoked ${successful.length}/${chunkEntities.length} successfully in ${Date.now() - invokeStart}ms`);
    if (failed.length > 0) {
      log(`Failed invocations: ${failed.length}`);
      for (const f of failed.slice(0, 3)) {
        log(`  ${f.entity.label}: ${f.result?.status || f.error}`);
        if (f.result?.error) log(`    Error: ${f.result.error}`);
        if (f.result?.message) log(`    Message: ${f.result.message}`);
      }
    }

    expect(successful.length).toBeGreaterThan(0);

    // =========================================================================
    // Step 4: Wait for all jobs to complete (longer timeout for DO)
    // =========================================================================
    log('Waiting for all jobs to complete (DO - no 30s limit)...');
    const waitStart = Date.now();

    const logResults = await Promise.all(
      successful.map(async ({ entity, result }) => {
        try {
          // waitForKladosLog takes jobCollectionId and options (not job_id)
          const kladosLog = await waitForKladosLog(result!.job_collection!, {
            timeout: 180000, // 3 min per job - DO can take longer
            pollInterval: 3000,
          });
          return { entity, log: kladosLog, error: null };
        } catch (error) {
          return { entity, log: null, error };
        }
      })
    );

    const completed = logResults.filter((r) => r.log?.properties.status === 'done');
    const errored = logResults.filter((r) => r.log?.properties.status === 'error');
    const timedOut = logResults.filter((r) => r.error);

    log(`Completed: ${completed.length}, Errored: ${errored.length}, Timed out: ${timedOut.length}`);
    log(`Total wait time: ${Date.now() - waitStart}ms`);

    if (errored.length > 0) {
      log('Errors:');
      for (const e of errored.slice(0, 5)) {
        const err = e.log?.properties.log_data.entry.error;
        log(`  ${e.entity.label}: ${err?.code} - ${err?.message}`);
      }
    }

    if (timedOut.length > 0) {
      log('Timed out (should be 0 with DO):');
      for (const t of timedOut.slice(0, 3)) {
        log(`  ${t.entity.label}: ${t.error}`);
      }
    }

    // =========================================================================
    // Step 5: Analyze extracted entities via relationship traversal
    // =========================================================================
    log('Traversing extracted entities from chunks (no indexing wait needed)...');

    // Get chunk entity IDs from our created entities
    const chunkIds = chunkEntities.map((e) => e.id);
    const extractedEntitiesMap = await traverseExtractedEntities(chunkIds);

    // Convert to array for analysis
    const extractedEntities = Array.from(extractedEntitiesMap.values());

    log(`\n========== RESULTS ==========`);
    log(`Chunks processed: ${completed.length}/${chunks.length}`);
    log(`Extracted entities (via traversal): ${extractedEntities.length}`);

    // Count by type
    const byType = new Map<string, number>();
    for (const e of extractedEntities) {
      byType.set(e.type, (byType.get(e.type) || 0) + 1);
    }
    log(`\nEntities by type:`);
    for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      log(`  ${type}: ${count}`);
    }

    // Check for duplicates (same label, same type)
    const labelTypeCounts = new Map<string, number>();
    for (const e of extractedEntities) {
      const key = `${e.type}:${e.label.toLowerCase()}`;
      labelTypeCounts.set(key, (labelTypeCounts.get(key) || 0) + 1);
    }

    const duplicates = [...labelTypeCounts.entries()].filter(([, count]) => count > 1);
    log(`\nDuplicate detection:`);
    log(`  Unique entity labels: ${labelTypeCounts.size}`);
    log(`  Duplicates found: ${duplicates.length}`);

    if (duplicates.length > 0) {
      log(`\n  ⚠️  DUPLICATES (should be 0):`);
      for (const [key, count] of duplicates.slice(0, 10)) {
        log(`    ${key}: ${count} copies`);
      }
    } else {
      log(`  ✓ No duplicates - deduplication working correctly`);
    }

    // Check key characters
    const keyCharacters = ['ahab', 'ishmael', 'queequeg', 'starbuck', 'stubb', 'flask', 'moby dick', 'pequod'];
    log(`\nKey character check:`);
    for (const char of keyCharacters) {
      const found = extractedEntities.filter((e) => e.label.toLowerCase().includes(char));
      log(`  ${char}: ${found.length > 0 ? `✓ found (${found.map((e) => e.type).join(', ')})` : '✗ not found'}`);
    }

    // Check a few extracted entities in detail
    log(`\nSample extracted entities (first 5):`);
    for (const entity of extractedEntities.slice(0, 5)) {
      log(`  ${entity.label} (${entity.type})`);
    }

    // Summary
    log(`\n========== SUMMARY ==========`);
    log(`Chunks processed: ${completed.length}/${chunks.length}`);
    log(`Unique entities extracted: ${labelTypeCounts.size}`);
    log(`Duplicates: ${duplicates.length}`);
    log(`Success rate: ${Math.round((completed.length / chunks.length) * 100)}%`);

    // KEY ASSERTION: With DO, we should get 100% completion (not 40% like v1)
    log(`\n========== KEY METRIC ==========`);
    log(`v1 (waitUntil) got ~40% completion due to 30s timeout`);
    log(`v2 (DO) should get 100% completion`);
    log(`Actual: ${Math.round((completed.length / chunks.length) * 100)}%`);

    // Assertions
    expect(completed.length).toBe(chunks.length); // 100% completion expected
    expect(duplicates.length).toBe(0); // No duplicates expected
  }, 600000); // 10 minute timeout for the whole test
});
