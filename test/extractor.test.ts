/**
 * E2E Test for KG Extractor Worker
 *
 * This test invokes the kg-extractor worker against the Arke API and verifies:
 * 1. The worker accepts and processes jobs correctly
 * 2. Entities are extracted and created in the target collection
 * 3. Updates (properties and relationships) are applied
 * 4. Log entries are properly recorded
 *
 * Prerequisites:
 * 1. Deploy your worker: npm run deploy
 * 2. Register the klados: npm run register
 * 3. Set environment variables (see below)
 *
 * Environment variables:
 *   ARKE_USER_KEY   - Your Arke user API key (uk_...)
 *   KLADOS_ID       - The klados entity ID from registration
 *   ARKE_API_BASE   - API base URL (default: https://arke-v1.arke.institute)
 *   ARKE_NETWORK    - Network to use (default: test)
 *
 * Usage:
 *   ARKE_USER_KEY=uk_... KLADOS_ID=klados_... npm test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  configureTestClient,
  createCollection,
  createEntity,
  getEntity,
  deleteEntity,
  invokeKlados,
  waitForKladosLog,
  assertLogCompleted,
  assertLogHasMessages,
  sleep,
  log,
  getCollectionEntities,
} from '@arke-institute/klados-testing';

// =============================================================================
// Configuration
// =============================================================================

const ARKE_API_BASE = process.env.ARKE_API_BASE || 'https://arke-v1.arke.institute';
const ARKE_USER_KEY = process.env.ARKE_USER_KEY;
const NETWORK = (process.env.ARKE_NETWORK || 'test') as 'test' | 'main';
const KLADOS_ID = process.env.KLADOS_ID;

// Load test fixture (use short sample for faster testing within Cloudflare limits)
const FIXTURE_PATH = join(__dirname, 'fixtures', 'short-sample.txt');

// =============================================================================
// Test Suite
// =============================================================================

describe('kg-extractor', () => {
  // Test fixtures
  let targetCollection: { id: string };
  let testEntity: { id: string };
  let jobCollectionId: string;
  let fixtureText: string;

  // Skip tests if environment not configured
  beforeAll(() => {
    if (!ARKE_USER_KEY) {
      console.warn('Skipping tests: ARKE_USER_KEY not set');
      return;
    }
    if (!KLADOS_ID) {
      console.warn('Skipping tests: KLADOS_ID not set');
      return;
    }

    // Configure the test client
    configureTestClient({
      apiBase: ARKE_API_BASE,
      userKey: ARKE_USER_KEY,
      network: NETWORK,
    });

    // Load fixture text
    fixtureText = readFileSync(FIXTURE_PATH, 'utf-8');
    log(`Loaded fixture: ${fixtureText.length} characters`);
  });

  // Create test fixtures
  beforeAll(async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) return;

    log('Creating test fixtures...');

    // Create target collection - where entities will be created
    targetCollection = await createCollection({
      label: `KG Extractor Test ${Date.now()}`,
      description: 'Target collection for kg-extractor test',
    });
    log(`Created target collection: ${targetCollection.id}`);

    // Create test entity with text content
    testEntity = await createEntity({
      type: 'text_chunk',
      properties: {
        label: 'Moby Dick - Chapter 36: The Quarter-Deck',
        content: fixtureText,
        source: 'moby-dick',
        chapter: 36,
      },
      collectionId: targetCollection.id,
    });
    log(`Created test entity: ${testEntity.id}`);
  });

  // Cleanup test fixtures (disabled for debugging - uncomment to re-enable)
  // afterAll(async () => {
  //   if (!ARKE_USER_KEY || !KLADOS_ID) return;
  //
  //   log('Cleaning up test fixtures...');
  //
  //   try {
  //     // Note: We don't delete individual extracted entities - they're in the collection
  //     if (testEntity?.id) await deleteEntity(testEntity.id);
  //     if (targetCollection?.id) await deleteEntity(targetCollection.id);
  //     log('Cleanup complete');
  //   } catch (e) {
  //     log(`Cleanup error (non-fatal): ${e}`);
  //   }
  // });

  // ==========================================================================
  // Tests
  // ==========================================================================

  it('should extract entities from text', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    // Invoke the klados
    log('Invoking kg-extractor klados...');
    const result = await invokeKlados({
      kladosId: KLADOS_ID,
      targetEntity: testEntity.id,
      targetCollection: targetCollection.id,
      confirm: true,
    });

    expect(result.status).toBe('started');
    expect(result.job_id).toBeDefined();
    expect(result.job_collection).toBeDefined();

    jobCollectionId = result.job_collection!;
    log(`Job started: ${result.job_id}`);
    log(`Job collection: ${jobCollectionId}`);

    // Wait for the klados log to complete
    log('Waiting for extraction to complete...');
    const kladosLog = await waitForKladosLog(jobCollectionId, {
      timeout: 120000, // 2 minutes (Gemini can be slow)
      pollInterval: 3000,
    });

    // Verify log completed successfully
    assertLogCompleted(kladosLog);
    log(`Log status: ${kladosLog.properties.status}`);

    // Check log messages
    assertLogHasMessages(kladosLog, [
      { textContains: 'Starting extraction' },
      { textContains: 'Fetched target' },
      { textContains: 'Calling Gemini' },
      { textContains: 'Gemini response received' },
      { textContains: 'Parsed operations' },
      { textContains: 'Extraction complete' },
    ]);
    log('Log messages verified');

    // Show all messages
    log('Log messages:');
    for (const msg of kladosLog.properties.log_data.messages) {
      log(`  [${msg.level}] ${msg.message}`);
      if (msg.details) {
        log(`    ${JSON.stringify(msg.details)}`);
      }
    }

    // Wait for indexing before checking entities
    // Collection indexing can take longer than expected
    log('Waiting for entities to be indexed (15s)...');
    await sleep(15000);

    // Verify entities were created in target collection
    log('Checking extracted entities...');
    log(`Target collection ID: ${targetCollection.id}`);
    log(`Test entity ID: ${testEntity.id}`);
    const entitiesResult = await getCollectionEntities(targetCollection.id);
    log(`Raw getCollectionEntities result: ${JSON.stringify(entitiesResult)}`);

    // getCollectionEntities returns { entities: [...] } with pi, type, label
    const entities = entitiesResult.entities || [];
    log(`Entities array length: ${entities.length}`);

    // Should have created at least some entities (Ahab, Moby Dick, Starbuck, etc.)
    // Plus the original test entity
    const extractedEntities = entities.filter((e) => e.pi !== testEntity.id);
    log(`Found ${extractedEntities.length} extracted entities`);

    // Log entity types and labels
    const entitySummary = new Map<string, number>();
    for (const entity of extractedEntities) {
      const type = entity.type || 'unknown';
      entitySummary.set(type, (entitySummary.get(type) || 0) + 1);
      log(`  ${entity.type}: ${entity.label || entity.pi}`);
    }

    log('Entity type summary:');
    for (const [type, count] of entitySummary) {
      log(`  ${type}: ${count}`);
    }

    // Should have created at least some key entities from the text
    expect(extractedEntities.length).toBeGreaterThan(0);

    // Look for expected entities (these are prominent in the text)
    const labels = extractedEntities.map((e) => (e.label || '').toLowerCase());

    // Check for some key characters that should definitely be extracted
    const expectedEntities = ['ahab', 'moby dick', 'starbuck', 'stubb', 'flask'];
    const foundExpected = expectedEntities.filter((expected) =>
      labels.some((label) => label.includes(expected))
    );

    log(`Found ${foundExpected.length}/${expectedEntities.length} expected entities: ${foundExpected.join(', ')}`);
    expect(foundExpected.length).toBeGreaterThanOrEqual(3); // At least 3 main characters
  });

  it('should handle preview mode (confirm=false)', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    const preview = await invokeKlados({
      kladosId: KLADOS_ID,
      targetEntity: testEntity.id,
      targetCollection: targetCollection.id,
      confirm: false,
    });

    expect(preview.status).toBe('pending_confirmation');
    log(`Preview result: ${preview.status}`);
  });

  it('should handle entity with no text content', async () => {
    if (!ARKE_USER_KEY || !KLADOS_ID) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    // Create entity without text content
    const emptyEntity = await createEntity({
      type: 'test_entity',
      properties: {
        label: 'Empty Test Entity',
        // No content field
      },
      collectionId: targetCollection.id,
    });

    try {
      // Invoke the klados
      log('Invoking with empty entity...');
      const result = await invokeKlados({
        kladosId: KLADOS_ID,
        targetEntity: emptyEntity.id,
        targetCollection: targetCollection.id,
        confirm: true,
      });

      // Wait for log
      const kladosLog = await waitForKladosLog(result.job_collection!, {
        timeout: 30000,
        pollInterval: 2000,
      });

      // Should have error status
      expect(kladosLog.properties.status).toBe('error');
      log(`Log status: ${kladosLog.properties.status}`);

      // Check for appropriate error message
      const errorEntry = kladosLog.properties.log_data.entry;
      expect(errorEntry.error).toBeDefined();
      log(`Error: ${errorEntry.error?.message}`);
    } finally {
      // Cleanup disabled for debugging
      // await deleteEntity(emptyEntity.id);
    }
  });
});
