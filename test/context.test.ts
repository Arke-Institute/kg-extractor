/**
 * E2E Test: Context-Dependent Knowledge Extraction
 *
 * Tests that the same text is extracted differently based on entity context.
 * The kg-extractor now fetches entities with expand=relationships:preview,
 * giving the LLM context about what the text is part of.
 *
 * Test case: Same historical-sounding text about "Sarah Chen" in Vienna.
 * - Test A: Context says it's a biography chapter → extract as real historical figures
 * - Test B: Context says it's a novel chapter → extract as fictional characters
 *
 * Usage:
 *   ARKE_USER_KEY=uk_... KLADOS_ID=klados_... npm test -- context.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  configureTestClient,
  createCollection,
  createEntity,
  deleteEntity,
  invokeKlados,
  waitForKladosLog,
  assertLogCompleted,
  apiRequest,
  log,
} from '@arke-institute/klados-testing';

// =============================================================================
// Configuration
// =============================================================================

const ARKE_API_BASE = process.env.ARKE_API_BASE || 'https://arke-v1.arke.institute';
const ARKE_USER_KEY = process.env.ARKE_USER_KEY;
const NETWORK = (process.env.ARKE_NETWORK || 'test') as 'test' | 'main';
const KLADOS_ID = process.env.KLADOS_ID;

// =============================================================================
// Test Data
// =============================================================================

// The SAME text for both tests - ambiguous without context
const SHARED_TEXT = `Sarah Chen arrived in Vienna in the summer of 1923, where she quickly became part of the circle surrounding Dr. Wilhelm Reich. Her correspondence with Sigmund Freud during this period reveals a fascinating exchange about the nature of consciousness. Reich, who would later break with Freud over the concept of orgone energy, considered Chen his most promising student.

During her time in Vienna, Chen developed what she called "somatic integration therapy," a method that combined Reich's body-focused techniques with elements drawn from her study of traditional Chinese medicine. Her 1926 monograph, "The Embodied Mind," was initially dismissed by the psychoanalytic establishment but has recently been rediscovered by scholars interested in the mind-body connection.

Chen's relationship with both Reich and Freud was complicated by the political tensions of the era. She maintained correspondence with both men even after their famous split, serving as an informal mediator. Her letters, recently discovered in the Reich archives, provide new insight into this pivotal moment in the history of psychoanalysis.`;

// Text with ambiguous proper nouns - reads naturally in either context
const AMBIGUOUS_TEXT = `The Phoenix will rise in Q3 when Mercury aligns with Jupiter. The Tiger and Dragon forces have been preparing for the Saturn transition, working to ensure all elements converge before the celestial window closes.

Phoenix energy flows through the constellation of interconnected channels. Mercury governs swift communication, while Saturn oversees the deeper, longer cycles. Dragon brings foundational power, with Tiger providing dynamic forward momentum.

The alignment between Mercury and Jupiter phases is critical. When Saturn enters its next phase, Gemini must be fully activated. The Tiger and Dragon energies have been harmonizing weekly to coordinate the celestial protocols.

Sarah Chen, who guides the Phoenix work, explained: "This convergence of Mercury, Saturn, Jupiter, and Gemini hasn't occurred since the Apollo era. Q3 will be transformative."

The ancient symbols remind us: Phoenix rises from transformation, Tiger represents courage, Dragon embodies wisdom, and the planets guide our timing.`;

// =============================================================================
// Test Suite
// =============================================================================

describe('context-dependent-extraction', () => {
  let targetCollection: { id: string };
  let biographyDocId: string;
  let biographyChapterId: string;
  let novelDocId: string;
  let novelChapterId: string;

  beforeAll(() => {
    if (!ARKE_USER_KEY) {
      console.warn('Skipping tests: ARKE_USER_KEY not set');
      return;
    }
    if (!KLADOS_ID) {
      console.warn('Skipping tests: KLADOS_ID not set');
      return;
    }

    configureTestClient({
      apiBase: ARKE_API_BASE,
      userKey: ARKE_USER_KEY,
      network: NETWORK,
    });
  });

  // Create test fixtures
  beforeAll(async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) return;

    log('Creating test fixtures for context extraction test...');

    // Create target collection
    targetCollection = await createCollection({
      label: `Context Test ${Date.now()}`,
      description: 'Testing context-dependent extraction',
      roles: { public: ['*:view', '*:invoke'] },
    });
    log(`Created collection: ${targetCollection.id}`);

    // === TEST A: Non-fiction context (Biography) ===
    log('\n--- Setting up Test A: Non-fiction (Biography) ---');

    // Create parent document first
    const bioDoc = await createEntity({
      type: 'research_document',
      properties: {
        label: 'Forgotten Pioneers: Women in Early Psychoanalysis',
        description: 'An academic study examining the overlooked contributions of women to the development of psychoanalytic theory in the early 20th century. Based on archival research and primary sources from the Freud Museum and Reich Archives.',
        document_type: 'academic_monograph',
        publication_year: 2024,
        publisher: 'Cambridge University Press',
      },
      collection: targetCollection.id,
    });
    biographyDocId = bioDoc.id;
    log(`Created biography document: ${biographyDocId}`);

    // Create chapter that links to parent (using apiRequest to include relationships)
    const bioChapter = await apiRequest<{ id: string }>('POST', '/entities', {
      type: 'biography_chapter',
      collection: targetCollection.id,
      properties: {
        label: 'Chapter 3: Sarah Chen and the Vienna Circle',
        description: 'Biographical account of Sarah Chen\'s time in Vienna and her documented relationships with Reich and Freud, based on recently discovered correspondence.',
        text: SHARED_TEXT,
        chapter_number: 3,
      },
      relationships: [
        { predicate: 'part_of', peer: biographyDocId, direction: 'outgoing' },
      ],
    });
    biographyChapterId = bioChapter.id;
    log(`Created biography chapter: ${biographyChapterId}`);

    // === TEST B: Fiction context (Novel) ===
    log('\n--- Setting up Test B: Fiction (Novel) ---');

    // Create parent document
    const novelDoc = await createEntity({
      type: 'fiction_novel',
      properties: {
        label: 'The Vienna Sessions',
        description: 'A historical fiction novel exploring the world of early psychoanalysis through the eyes of a fictional Chinese-American woman who infiltrates Freud\'s inner circle. Winner of the 2023 PEN/Faulkner Award for Fiction.',
        genre: 'historical_fiction',
        publication_year: 2023,
        author: 'Margaret Liu',
      },
      collection: targetCollection.id,
    });
    novelDocId = novelDoc.id;
    log(`Created novel document: ${novelDocId}`);

    // Create chapter that links to parent (using apiRequest to include relationships)
    const novelChapter = await apiRequest<{ id: string }>('POST', '/entities', {
      type: 'novel_chapter',
      collection: targetCollection.id,
      properties: {
        label: 'Chapter 7: The Circle',
        description: 'The protagonist Sarah Chen navigates the complex politics of Vienna\'s psychoanalytic community in this pivotal chapter.',
        text: SHARED_TEXT,
        chapter_number: 7,
      },
      relationships: [
        { predicate: 'part_of', peer: novelDocId, direction: 'outgoing' },
      ],
    });
    novelChapterId = novelChapter.id;
    log(`Created novel chapter: ${novelChapterId}`);

    log('\n=== Test fixtures created ===');
  });

  // Cleanup
  afterAll(async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) return;

    log('Cleaning up test fixtures...');
    try {
      // Delete in reverse order (children first)
      if (biographyChapterId) await deleteEntity(biographyChapterId);
      if (biographyDocId) await deleteEntity(biographyDocId);
      if (novelChapterId) await deleteEntity(novelChapterId);
      if (novelDocId) await deleteEntity(novelDocId);
      if (targetCollection?.id) await deleteEntity(targetCollection.id);
      log('Cleanup complete');
    } catch (e) {
      log(`Cleanup error (non-fatal): ${e}`);
    }
  });

  // ==========================================================================
  // Tests
  // ==========================================================================

  it('should extract from biography chapter with non-fiction context', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    log('\n=== Test A: Extracting from BIOGRAPHY chapter ===');
    log('Context: research_document → biography_chapter');
    log('Expected: Entities extracted as real historical figures\n');

    // Verify the relationship exists by fetching with expand
    const chapter = await apiRequest<{ type: string; relationships: unknown[] }>(
      'GET',
      `/entities/${biographyChapterId}?expand=relationships:preview`
    );
    log(`Chapter type: ${chapter?.type}`);
    log(`Relationships: ${JSON.stringify(chapter?.relationships, null, 2)}`);

    // Invoke the extractor
    const result = await invokeKlados({
      kladosId: KLADOS_ID,
      targetEntity: biographyChapterId,
      targetCollection: targetCollection.id,
      confirm: true,
    });

    expect(result.status).toBe('started');
    log(`Job started: ${result.job_id}`);

    // Wait for completion
    const kladosLog = await waitForKladosLog(result.job_collection!, {
      timeout: 120000,
      pollInterval: 5000,
    });

    assertLogCompleted(kladosLog);
    log(`\nJob completed with status: ${kladosLog.properties.status}`);

    // Log all messages
    log('\n--- Extraction Log ---');
    for (const msg of kladosLog.properties.log_data.messages) {
      log(`  [${msg.level}] ${msg.message}`);
      if (msg.data) {
        log(`         ${JSON.stringify(msg.data)}`);
      }
    }

    log(`\n--- Results ---`);

    // Query the collection to see ALL extracted entities (exclude test fixtures)
    // Note: outputs are not stored in the log - they're used for workflow handoffs only
    // Note: Collection entities returns {id, type, label} at top level, not nested in properties
    const collectionEntities = await apiRequest<{ entities: Array<{ id: string; type: string; label: string }> }>(
      'GET',
      `/collections/${targetCollection.id}/entities?limit=100`
    );

    // Filter to just extracted entities (not our test fixtures)
    const fixtureTypes = new Set(['research_document', 'biography_chapter', 'fiction_novel', 'novel_chapter']);
    const extractedEntities = collectionEntities.entities.filter(e => !fixtureTypes.has(e.type));

    log(`\nExtracted entities: ${extractedEntities.length}`);
    for (const ent of extractedEntities) {
      log(`  - [${ent.type}] ${ent.label}`);
    }
  }, 180000);

  it('should extract from novel chapter with fiction context', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    log('\n=== Test B: Extracting from NOVEL chapter ===');
    log('Context: fiction_novel → novel_chapter');
    log('Expected: Entities extracted as fictional characters\n');

    // Verify the relationship exists
    const chapter = await apiRequest<{ type: string; relationships: unknown[] }>(
      'GET',
      `/entities/${novelChapterId}?expand=relationships:preview`
    );
    log(`Chapter type: ${chapter?.type}`);
    log(`Relationships: ${JSON.stringify(chapter?.relationships, null, 2)}`);

    // Invoke the extractor
    const result = await invokeKlados({
      kladosId: KLADOS_ID,
      targetEntity: novelChapterId,
      targetCollection: targetCollection.id,
      confirm: true,
    });

    expect(result.status).toBe('started');
    log(`Job started: ${result.job_id}`);

    // Wait for completion
    const kladosLog = await waitForKladosLog(result.job_collection!, {
      timeout: 120000,
      pollInterval: 5000,
    });

    assertLogCompleted(kladosLog);
    log(`\nJob completed with status: ${kladosLog.properties.status}`);

    // Log all messages
    log('\n--- Extraction Log ---');
    for (const msg of kladosLog.properties.log_data.messages) {
      log(`  [${msg.level}] ${msg.message}`);
      if (msg.data) {
        log(`         ${JSON.stringify(msg.data)}`);
      }
    }

    log(`\n--- Results ---`);

    // Query the collection to see ALL extracted entities
    const collectionEntities = await apiRequest<{ entities: Array<{ id: string; type: string; label: string }> }>(
      'GET',
      `/collections/${targetCollection.id}/entities?limit=100`
    );

    // Filter to just extracted entities (not our test fixtures)
    const fixtureTypes = new Set(['research_document', 'biography_chapter', 'fiction_novel', 'novel_chapter']);
    const extractedEntities = collectionEntities.entities.filter(e => !fixtureTypes.has(e.type));

    log(`\nExtracted entities: ${extractedEntities.length}`);
    for (const ent of extractedEntities) {
      log(`  - [${ent.type}] ${ent.label}`);
    }
  }, 180000);
});

// =============================================================================
// Test Suite 2: Corporate Memo vs Astrology Article
// =============================================================================

describe('ambiguous-proper-nouns', () => {
  let targetCollection: { id: string };
  let corporateMemoDocId: string;
  let corporateMemoChunkId: string;
  let astrologyArticleDocId: string;
  let astrologyArticleChunkId: string;

  beforeAll(() => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Skipping tests: missing environment variables');
      return;
    }

    configureTestClient({
      apiBase: ARKE_API_BASE,
      userKey: ARKE_USER_KEY,
      network: NETWORK,
    });
  });

  // Create test fixtures
  beforeAll(async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) return;

    log('Creating test fixtures for ambiguous proper nouns test...');

    // Create target collection
    targetCollection = await createCollection({
      label: `Ambiguous Test ${Date.now()}`,
      description: 'Testing context-dependent extraction with ambiguous proper nouns',
      roles: { public: ['*:view', '*:invoke'] },
    });
    log(`Created collection: ${targetCollection.id}`);

    // === TEST A: Corporate Internal Memo ===
    log('\n--- Setting up Test A: Corporate Memo ---');

    const corpDoc = await apiRequest<{ id: string }>('POST', '/entities', {
      type: 'internal_memo',
      collection: targetCollection.id,
      properties: {
        label: 'Q3 2024 Project Status Update',
        description: 'Internal company memo discussing project codenames, team assignments, and system integration milestones. Confidential - for internal distribution only.',
        document_type: 'internal_communication',
        department: 'Engineering',
        classification: 'confidential',
      },
    });
    corporateMemoDocId = corpDoc.id;
    log(`Created corporate memo document: ${corporateMemoDocId}`);

    const corpChunk = await apiRequest<{ id: string }>('POST', '/entities', {
      type: 'memo_section',
      collection: targetCollection.id,
      properties: {
        label: 'Project Phoenix Integration Status',
        description: 'Section detailing the integration status of Project Phoenix with related internal systems and team coordination.',
        text: AMBIGUOUS_TEXT,
        section_number: 2,
      },
      relationships: [
        { predicate: 'part_of', peer: corporateMemoDocId, direction: 'outgoing' },
      ],
    });
    corporateMemoChunkId = corpChunk.id;
    log(`Created corporate memo chunk: ${corporateMemoChunkId}`);

    // === TEST B: Astrology/Mythology Article ===
    log('\n--- Setting up Test B: Astrology Article ---');

    const astroDoc = await apiRequest<{ id: string }>('POST', '/entities', {
      type: 'astrology_publication',
      collection: targetCollection.id,
      properties: {
        label: 'Celestial Alignments and Mythological Symbolism Quarterly',
        description: 'A peer-reviewed journal exploring the intersection of astronomical phenomena, astrological interpretation, and mythological symbolism across cultures.',
        publication_type: 'academic_journal',
        field: 'astrology_and_mythology',
        issn: '1234-5678',
      },
    });
    astrologyArticleDocId = astroDoc.id;
    log(`Created astrology document: ${astrologyArticleDocId}`);

    const astroChunk = await apiRequest<{ id: string }>('POST', '/entities', {
      type: 'journal_article',
      collection: targetCollection.id,
      properties: {
        label: 'The Phoenix Rising: Planetary Alignments in Q3 2024',
        description: 'An analysis of the rare convergence of Mercury, Saturn, Jupiter, and Gemini during the Phoenix constellation period, with implications for Tiger and Dragon zodiac signs.',
        text: AMBIGUOUS_TEXT,
        article_type: 'research_article',
      },
      relationships: [
        { predicate: 'part_of', peer: astrologyArticleDocId, direction: 'outgoing' },
      ],
    });
    astrologyArticleChunkId = astroChunk.id;
    log(`Created astrology article chunk: ${astrologyArticleChunkId}`);

    log('\n=== Test fixtures created ===');
  });

  // Cleanup
  afterAll(async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) return;

    log('Cleaning up test fixtures...');
    try {
      if (corporateMemoChunkId) await deleteEntity(corporateMemoChunkId);
      if (corporateMemoDocId) await deleteEntity(corporateMemoDocId);
      if (astrologyArticleChunkId) await deleteEntity(astrologyArticleChunkId);
      if (astrologyArticleDocId) await deleteEntity(astrologyArticleDocId);
      if (targetCollection?.id) await deleteEntity(targetCollection.id);
      log('Cleanup complete');
    } catch (e) {
      log(`Cleanup error (non-fatal): ${e}`);
    }
  });

  it('should extract corporate codenames from internal memo context', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    log('\n=== Test A: Extracting from CORPORATE MEMO ===');
    log('Context: internal_memo → memo_section');
    log('Expected: Phoenix, Mercury, Saturn = projects/systems; Tiger, Dragon = teams\n');

    // Verify the relationship exists
    const chapter = await apiRequest<{ type: string; relationships: unknown[] }>(
      'GET',
      `/entities/${corporateMemoChunkId}?expand=relationships:preview`
    );
    log(`Chunk type: ${chapter?.type}`);
    log(`Relationships: ${JSON.stringify(chapter?.relationships, null, 2)}`);

    // Invoke the extractor
    const result = await invokeKlados({
      kladosId: KLADOS_ID,
      targetEntity: corporateMemoChunkId,
      targetCollection: targetCollection.id,
      confirm: true,
    });

    expect(result.status).toBe('started');
    log(`Job started: ${result.job_id}`);

    // Wait for completion
    const kladosLog = await waitForKladosLog(result.job_collection!, {
      timeout: 120000,
      pollInterval: 5000,
    });

    assertLogCompleted(kladosLog);
    log(`\nJob completed with status: ${kladosLog.properties.status}`);

    // Log messages
    log('\n--- Extraction Log ---');
    for (const msg of kladosLog.properties.log_data.messages) {
      log(`  [${msg.level}] ${msg.message}`);
    }

    log(`\n--- Results ---`);

    // Query extracted entities
    const collectionEntities = await apiRequest<{ entities: Array<{ id: string; type: string; label: string }> }>(
      'GET',
      `/collections/${targetCollection.id}/entities?limit=100`
    );

    const fixtureTypes = new Set(['internal_memo', 'memo_section', 'astrology_publication', 'journal_article']);
    const extractedEntities = collectionEntities.entities.filter(e => !fixtureTypes.has(e.type));

    log(`\nExtracted entities: ${extractedEntities.length}`);
    for (const ent of extractedEntities) {
      log(`  - [${ent.type}] ${ent.label}`);
    }
  }, 180000);

  it('should extract celestial/mythological entities from astrology context', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    log('\n=== Test B: Extracting from ASTROLOGY ARTICLE ===');
    log('Context: astrology_publication → journal_article');
    log('Expected: Phoenix, Mercury, Saturn, Jupiter = celestial bodies; Tiger, Dragon = zodiac signs\n');

    // Verify the relationship exists
    const chapter = await apiRequest<{ type: string; relationships: unknown[] }>(
      'GET',
      `/entities/${astrologyArticleChunkId}?expand=relationships:preview`
    );
    log(`Chunk type: ${chapter?.type}`);
    log(`Relationships: ${JSON.stringify(chapter?.relationships, null, 2)}`);

    // Invoke the extractor
    const result = await invokeKlados({
      kladosId: KLADOS_ID,
      targetEntity: astrologyArticleChunkId,
      targetCollection: targetCollection.id,
      confirm: true,
    });

    expect(result.status).toBe('started');
    log(`Job started: ${result.job_id}`);

    // Wait for completion
    const kladosLog = await waitForKladosLog(result.job_collection!, {
      timeout: 120000,
      pollInterval: 5000,
    });

    assertLogCompleted(kladosLog);
    log(`\nJob completed with status: ${kladosLog.properties.status}`);

    // Log messages
    log('\n--- Extraction Log ---');
    for (const msg of kladosLog.properties.log_data.messages) {
      log(`  [${msg.level}] ${msg.message}`);
    }

    log(`\n--- Results ---`);

    // Query extracted entities
    const collectionEntities = await apiRequest<{ entities: Array<{ id: string; type: string; label: string }> }>(
      'GET',
      `/collections/${targetCollection.id}/entities?limit=100`
    );

    const fixtureTypes = new Set(['internal_memo', 'memo_section', 'astrology_publication', 'journal_article']);
    const extractedEntities = collectionEntities.entities.filter(e => !fixtureTypes.has(e.type));

    log(`\nExtracted entities: ${extractedEntities.length}`);
    for (const ent of extractedEntities) {
      log(`  - [${ent.type}] ${ent.label}`);
    }
  }, 180000);
});
