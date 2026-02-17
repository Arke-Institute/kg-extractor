/**
 * Cross-chunk connectivity test
 *
 * Process 20 chunks and verify entities get connected across chunks
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  configureTestClient,
  createCollection,
  createEntity,
  invokeKlados,
  waitForKladosLog,
  getEntity,
  log,
} from '@arke-institute/klados-testing';

const ARKE_USER_KEY = process.env.ARKE_USER_KEY;
const ARKE_API_BASE = process.env.ARKE_API_BASE || 'https://arke-v1.arke.institute';
const KLADOS_ID = process.env.KLADOS_ID;

const NUM_CHUNKS = 20;
const CHUNK_SIZE = 8000;

// Load Moby Dick and create chunks
function loadMobyDickChunks(numChunks: number, chunkSize: number): string[] {
  const raw = readFileSync(join(__dirname, 'fixtures/moby-dick.txt'), 'utf-8');

  // Strip Gutenberg header/footer
  const startMarker = '*** START OF THE PROJECT GUTENBERG EBOOK';
  const endMarker = '*** END OF THE PROJECT GUTENBERG EBOOK';
  let start = raw.indexOf(startMarker);
  start = start !== -1 ? raw.indexOf('\n', start) + 1 : 0;
  let end = raw.indexOf(endMarker);
  end = end !== -1 ? end : raw.length;
  let clean = raw.slice(start, end);

  // Skip table of contents - find "CHAPTER 1." after the TOC
  const ch1First = clean.indexOf('CHAPTER 1.');
  const ch1Second = clean.indexOf('CHAPTER 1.', ch1First + 1);
  if (ch1Second !== -1) {
    clean = clean.slice(ch1Second);
  }

  // Chunk the text
  const chunks: string[] = [];
  let position = 0;

  while (position < clean.length && chunks.length < numChunks) {
    let end = Math.min(position + chunkSize, clean.length);

    // Try to break at paragraph boundary
    if (end < clean.length) {
      const searchStart = position + Math.floor(chunkSize * 0.8);
      const searchRegion = clean.slice(searchStart, end + 200);
      const breakMatch = searchRegion.match(/\n\n/);
      if (breakMatch && breakMatch.index !== undefined) {
        end = searchStart + breakMatch.index + 2;
      }
    }

    const chunk = clean.slice(position, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    position = end;
  }

  return chunks;
}

describe('cross-chunk connectivity', () => {
  let chunks: string[];

  beforeAll(() => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Skipping: ARKE_USER_KEY or KLADOS_ID not set');
      return;
    }
    configureTestClient({
      apiBase: ARKE_API_BASE,
      userKey: ARKE_USER_KEY,
      network: 'test',
    });

    chunks = loadMobyDickChunks(NUM_CHUNKS, CHUNK_SIZE);
    log(`Loaded ${chunks.length} chunks of ~${CHUNK_SIZE} chars`);
  });

  it('should connect entities across 20 chunks', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) return;

    // Create collection
    log('Creating collection...');
    const coll = await createCollection({
      label: `Cross-Chunk Test ${Date.now()}`,
      description: `${NUM_CHUNKS} chunks testing cross-chunk entity merging`,
      roles: { public: ['*:view', '*:invoke'] },
    });
    log(`Collection: ${coll.id}`);

    // Create chunk entities
    log(`Creating ${chunks.length} chunk entities...`);
    const chunkEntities = await Promise.all(
      chunks.map(async (chunk, i) => {
        const entity = await createEntity({
          type: 'text_chunk',
          collection: coll.id,
          properties: {
            label: `Moby Dick Chunk ${i + 1}`,
            text: chunk,
            chunk_index: i,
          },
        });
        return { id: entity.id, index: i };
      })
    );
    log(`Created ${chunkEntities.length} entities`);

    // Invoke klados on all chunks in parallel
    log(`Invoking kg-extractor on ${chunkEntities.length} chunks...`);
    const invokeStart = Date.now();

    const invokeResults = await Promise.all(
      chunkEntities.map(async (entity) => {
        try {
          const result = await invokeKlados({
            kladosId: KLADOS_ID!,
            targetCollection: coll.id,
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
    log(`Invoked ${successful.length}/${chunkEntities.length} in ${Date.now() - invokeStart}ms`);

    // Wait for all jobs
    log('Waiting for jobs to complete...');
    const waitStart = Date.now();

    const logResults = await Promise.all(
      successful.map(async ({ entity, result }) => {
        try {
          const kladosLog = await waitForKladosLog(result!.job_collection!, {
            timeout: 180000,
            pollInterval: 3000,
          });
          return { entity, log: kladosLog, error: null };
        } catch (error) {
          return { entity, log: null, error };
        }
      })
    );

    const completed = logResults.filter((r) => r.log?.properties.status === 'done');
    log(`Completed: ${completed.length}/${successful.length} in ${Date.now() - waitStart}ms`);

    // Collect all extracted entities
    log('\nCollecting extracted entities...');
    const allEntities = new Map<string, {
      id: string;
      label: string;
      type: string;
      sourceChunks: number[];
      relationshipCount: number;
      relationships: string[];
    }>();

    for (const chunkEntity of chunkEntities) {
      try {
        const chunk = await getEntity(chunkEntity.id);
        const extractedRels = chunk.relationships?.filter(
          (r: any) => r.predicate === 'extracted_entity'
        ) || [];

        for (const rel of extractedRels) {
          const r = rel as any;
          const entityId = r.peer;

          if (allEntities.has(entityId)) {
            // Entity already seen - add this chunk as a source
            allEntities.get(entityId)!.sourceChunks.push(chunkEntity.index);
          } else {
            // Fetch entity details
            try {
              const entity = await getEntity(entityId);
              const rels = entity.relationships?.filter(
                (rel: any) => rel.predicate !== 'collection' && rel.predicate !== 'extracted_from'
              ) || [];

              allEntities.set(entityId, {
                id: entityId,
                label: (entity.properties as any)?.label || r.peer_label,
                type: entity.type,
                sourceChunks: [chunkEntity.index],
                relationshipCount: rels.length,
                relationships: rels.map((rel: any) => `${rel.predicate} → ${rel.peer_label || rel.peer}`),
              });
            } catch {
              // Entity might not be accessible
            }
          }
        }
      } catch {
        // Chunk might not be accessible
      }
    }

    // Analyze cross-chunk connectivity
    log('\n========== RESULTS ==========');
    log(`Total unique entities: ${allEntities.size}`);

    // Find entities appearing in multiple chunks
    const multiChunkEntities = Array.from(allEntities.values())
      .filter((e) => e.sourceChunks.length > 1)
      .sort((a, b) => b.sourceChunks.length - a.sourceChunks.length);

    log(`\nEntities appearing in MULTIPLE chunks: ${multiChunkEntities.length}`);

    if (multiChunkEntities.length > 0) {
      log('\nTop cross-chunk entities:');
      for (const entity of multiChunkEntities.slice(0, 15)) {
        log(`  • ${entity.label} (${entity.type})`);
        log(`    Chunks: ${entity.sourceChunks.map(i => i + 1).join(', ')}`);
        log(`    Relationships: ${entity.relationshipCount}`);
        if (entity.relationships.length > 0) {
          for (const rel of entity.relationships.slice(0, 5)) {
            log(`      → ${rel}`);
          }
          if (entity.relationships.length > 5) {
            log(`      ... and ${entity.relationships.length - 5} more`);
          }
        }
        log('');
      }
    }

    // Count by type
    const byType = new Map<string, number>();
    for (const e of allEntities.values()) {
      byType.set(e.type, (byType.get(e.type) || 0) + 1);
    }
    log('\nEntities by type:');
    for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      log(`  ${type}: ${count}`);
    }

    // Most connected entities
    const mostConnected = Array.from(allEntities.values())
      .sort((a, b) => b.relationshipCount - a.relationshipCount)
      .slice(0, 10);

    log('\nMost connected entities:');
    for (const entity of mostConnected) {
      log(`  • ${entity.label} (${entity.type}): ${entity.relationshipCount} relationships`);
    }

    log('\n========== SUMMARY ==========');
    log(`Chunks processed: ${completed.length}/${NUM_CHUNKS}`);
    log(`Unique entities: ${allEntities.size}`);
    log(`Cross-chunk entities: ${multiChunkEntities.length}`);
    log(`Cross-chunk ratio: ${Math.round((multiChunkEntities.length / allEntities.size) * 100)}%`);

    log(`\n=== COLLECTION ID: ${coll.id} ===`);

    // Assertions
    expect(completed.length).toBeGreaterThan(NUM_CHUNKS * 0.8); // At least 80% completion
    expect(allEntities.size).toBeGreaterThan(0);
    // We expect SOME cross-chunk entities (key characters should appear multiple times)
    expect(multiChunkEntities.length).toBeGreaterThan(0);
  }, 900000); // 15 minute timeout
});
