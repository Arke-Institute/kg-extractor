#!/usr/bin/env npx tsx
/**
 * Inspect extracted entities from a collection
 */

import { readFileSync } from 'fs';
import { ArkeClient } from '@arke-institute/sdk';

// Load .env
const envContent = readFileSync('.env', 'utf-8');
for (const line of envContent.split('\n')) {
  if (line && !line.startsWith('#')) {
    const [key, ...valueParts] = line.split('=');
    process.env[key] = valueParts.join('=');
  }
}

const client = new ArkeClient({
  apiKey: process.env.ARKE_USER_KEY!,
  network: 'test',
});

async function main() {
  const collectionId = process.argv[2] || 'IIKHAEQY8J5KWXZ4F9XPPH3BCD';
  const chunkId = process.argv[3] || 'IIKHAEQZ8QB57Q9K1AZ20DBWRS';

  console.log('Fetching chunk entity...');
  const { data: chunk } = await client.api.GET('/entities/{id}', {
    params: { path: { id: chunkId } },
  });

  if (!chunk) {
    console.error('Chunk not found');
    return;
  }

  const extractedRels = chunk.relationships?.filter(
    (r: any) => r.predicate === 'extracted_entity'
  ) || [];

  console.log(`\n=== EXTRACTED ENTITIES (${extractedRels.length}) ===\n`);

  for (const rel of extractedRels) {
    const r = rel as any;
    console.log(`• ${r.peer_label} (${r.properties?.entity_type || 'unknown'})`);
  }

  // Now fetch a few entities to see their relationships
  console.log('\n=== ENTITY DETAILS (first 10) ===\n');

  for (const rel of extractedRels.slice(0, 10)) {
    const r = rel as any;
    const { data: entity } = await client.api.GET('/entities/{id}', {
      params: { path: { id: r.peer } },
    });

    if (!entity) continue;

    const props = entity.properties as any;
    const rels = entity.relationships || [];
    const outgoing = rels.filter((rel: any) =>
      rel.predicate !== 'collection' && rel.predicate !== 'extracted_from'
    );

    console.log(`━━━ ${props?.label || r.peer_label} (${entity.type}) ━━━`);

    // Show properties
    const propKeys = Object.keys(props || {}).filter(k => k !== 'label');
    if (propKeys.length > 0) {
      console.log('  Properties:');
      for (const key of propKeys) {
        const val = props[key];
        if (typeof val === 'string' && val.length > 60) {
          console.log(`    ${key}: "${val.slice(0, 60)}..."`);
        } else {
          console.log(`    ${key}: ${JSON.stringify(val)}`);
        }
      }
    }

    // Show relationships
    if (outgoing.length > 0) {
      console.log('  Relationships:');
      for (const rel of outgoing) {
        const or = rel as any;
        console.log(`    → ${or.predicate} → ${or.peer_label || or.peer}`);
      }
    }
    console.log('');
  }
}

main().catch(console.error);
