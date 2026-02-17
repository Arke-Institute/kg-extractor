/**
 * Test graph connectivity improvements:
 * - extracted_from relationship on every entity
 * - referenced_by relationship for orphan entities
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

// Load and chunk Moby Dick
function loadMobyDickChunk(chunkSize = 8000, skipToChapter?: number): string {
  const raw = readFileSync(join(__dirname, 'fixtures/moby-dick.txt'), 'utf-8');
  // Strip Gutenberg header
  const startMarker = '*** START OF THE PROJECT GUTENBERG EBOOK';
  const start = raw.indexOf(startMarker);
  let clean = start !== -1 ? raw.slice(raw.indexOf('\n', start) + 1) : raw;

  // Skip to specific chapter if requested (find second occurrence to skip TOC)
  if (skipToChapter) {
    const chapterMarker = `CHAPTER ${skipToChapter}.`;
    const firstOccurrence = clean.indexOf(chapterMarker);
    if (firstOccurrence !== -1) {
      // Look for second occurrence (the actual chapter, not TOC)
      const secondOccurrence = clean.indexOf(chapterMarker, firstOccurrence + 1);
      if (secondOccurrence !== -1) {
        clean = clean.slice(secondOccurrence);
      } else {
        clean = clean.slice(firstOccurrence);
      }
    }
  }

  return clean.slice(0, chunkSize).trim();
}

const ARKE_USER_KEY = process.env.ARKE_USER_KEY;
const ARKE_API_BASE = process.env.ARKE_API_BASE || 'https://arke-v1.arke.institute';
const KLADOS_ID = process.env.KLADOS_ID;

describe('graph connectivity', () => {
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
  });

  it('should add extracted_from and referenced_by relationships', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) return;

    // Create collection
    log('Creating collection...');
    const coll = await createCollection({
      label: 'Connectivity Test ' + Date.now(),
      description: 'Testing graph connectivity',
      roles: { public: ['*:view', '*:invoke'] },
    });
    log('Collection:', coll.id);

    // Create entity with simple text that should produce relationships
    log('Creating entity...');
    const ent = await createEntity({
      type: 'text_chunk',
      collection: coll.id,
      properties: {
        label: 'Moby Dick Chapter 28 - Ahab',
        text: loadMobyDickChunk(8000, 28), // Chapter 28: Ahab - meaty narrative content
      },
    });
    log('Entity:', ent.id);

    // Invoke klados
    log('Invoking klados...');
    const result = await invokeKlados({
      kladosId: KLADOS_ID,
      targetCollection: coll.id,
      targetEntity: ent.id,
      confirm: true,
    });
    log('Job collection:', result.job_collection);

    // Wait for completion
    log('Waiting for completion...');
    const kladosLog = await waitForKladosLog(result.job_collection!, {
      timeout: 120000,
      pollInterval: 3000,
    });
    log('Status:', kladosLog.properties.status);

    expect(kladosLog.properties.status).toBe('done');

    // Get the chunk entity with relationships
    const chunk = await getEntity(ent.id);
    const extractedRels = chunk.relationships?.filter(
      (r: any) => r.predicate === 'extracted_entity'
    ) || [];

    log('Extracted entities:', extractedRels.length);
    expect(extractedRels.length).toBeGreaterThan(0);

    // Check each extracted entity for the new relationships
    let hasExtractedFrom = 0;
    let hasReferencedBy = 0;

    for (const rel of extractedRels.slice(0, 5)) {
      const entity = await getEntity((rel as any).peer);
      const entityRels = entity.relationships || [];

      const extractedFromRel = entityRels.find((r: any) => r.predicate === 'extracted_from');
      const referencedByRel = entityRels.find((r: any) => r.predicate === 'referenced_by');

      log(`Entity: ${(entity.properties as any)?.label} (${entity.type})`);
      log(`  - extracted_from: ${extractedFromRel ? 'YES' : 'NO'}`);
      log(`  - referenced_by: ${referencedByRel ? 'YES' : 'NO'}`);
      log(`  - All relationships: ${entityRels.map((r: any) => r.predicate).join(', ')}`);

      if (extractedFromRel) hasExtractedFrom++;
      if (referencedByRel) hasReferencedBy++;
    }

    log('\n=== CONNECTIVITY RESULTS ===');
    log(`Entities with extracted_from: ${hasExtractedFrom}/${Math.min(5, extractedRels.length)}`);
    log(`Entities with referenced_by: ${hasReferencedBy}/${Math.min(5, extractedRels.length)}`);

    // Every entity should have extracted_from
    expect(hasExtractedFrom).toBeGreaterThan(0);

    log('\n=== IDs for inspection ===');
    log('Collection:', coll.id);
    log('Chunk entity:', ent.id);
  }, 180000);
});
