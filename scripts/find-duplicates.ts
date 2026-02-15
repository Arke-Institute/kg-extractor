#!/usr/bin/env npx tsx
/**
 * Find duplicate entities in a collection (same normalized label + type)
 */

import { readFileSync } from 'fs';
import { ArkeClient } from '@arke-institute/sdk';
import { normalizeLabel } from '../src/normalize';

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
  const collectionId = process.argv[2] || 'IIKHBTP1GX9XB4E7MYQMTATCDQ';

  console.log(`Fetching entities from collection ${collectionId}...`);

  // Paginate through all entities using offset-based pagination
  const allEntities: Array<{ id: string; type: string; label: string }> = [];
  let offset = 0;
  const limit = 100;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await client.api.GET('/collections/{id}/entities', {
      params: {
        path: { id: collectionId },
        query: { limit, offset }
      },
    });

    if (error || !data) {
      console.error('Failed to fetch entities:', error);
      return;
    }

    const entities = data.entities || [];
    for (const e of entities) {
      const entity = e as any;
      allEntities.push({
        id: entity.pi,
        type: entity.type,
        label: entity.label || '(no label)',
      });
    }

    const pagination = (data as any).pagination;
    hasMore = pagination?.has_more ?? false;
    offset += entities.length;
    console.log(`  Fetched ${allEntities.length} entities...`);
  }

  console.log(`\nTotal: ${allEntities.length} entities\n`);

  // Filter out text_chunk entities (they're the source, not extracted)
  const extracted = allEntities.filter(e => e.type !== 'text_chunk');
  console.log(`Extracted entities (excluding text_chunk): ${extracted.length}\n`);

  // Group by normalized label + type
  const groups = new Map<string, Array<{ id: string; label: string; type: string }>>();

  for (const entity of extracted) {
    const normalized = normalizeLabel(entity.label);
    const key = `${entity.type}:${normalized}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push({ id: entity.id, label: entity.label, type: entity.type });
  }

  // Find duplicates (same normalized label + type)
  const duplicates = Array.from(groups.entries())
    .filter(([_, items]) => items.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  if (duplicates.length === 0) {
    console.log('✓ No duplicates found (by label+type)!');
  } else {
    console.log(`⚠️  Found ${duplicates.length} groups with duplicates (same label+type):\n`);

    for (const [key, items] of duplicates.slice(0, 20)) {
      console.log(`${key} (${items.length} copies):`);
      for (const item of items) {
        console.log(`  - ${item.id}: "${item.label}"`);
      }
      console.log('');
    }
  }

  // Also check for "semantic duplicates" - same normalized label, different types
  const byLabel = new Map<string, Array<{ id: string; label: string; type: string }>>();
  for (const entity of extracted) {
    const normalized = normalizeLabel(entity.label);

    if (!byLabel.has(normalized)) {
      byLabel.set(normalized, []);
    }
    byLabel.get(normalized)!.push({ id: entity.id, label: entity.label, type: entity.type });
  }

  const semanticDuplicates = Array.from(byLabel.entries())
    .filter(([_, items]) => {
      const types = new Set(items.map(i => i.type));
      return types.size > 1; // Same label, different types
    })
    .sort((a, b) => b[1].length - a[1].length);

  if (semanticDuplicates.length > 0) {
    console.log(`\n⚠️  Found ${semanticDuplicates.length} "semantic duplicates" (same label, different types):\n`);

    for (const [label, items] of semanticDuplicates.slice(0, 15)) {
      const types = [...new Set(items.map(i => i.type))];
      console.log(`"${label}" appears as: ${types.join(', ')}`);
      for (const item of items) {
        console.log(`  - ${item.type}: ${item.id}`);
      }
      console.log('');
    }
  }
}

main().catch(console.error);
