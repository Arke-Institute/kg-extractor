#!/usr/bin/env npx tsx
/**
 * Prompt Lab - Local iteration on extraction prompts
 *
 * Usage:
 *   npx tsx scripts/prompt-lab.ts [variant]
 *
 * Variants: detailed, balanced, broad, custom
 *
 * This lets you quickly test different prompt strategies against
 * the same text chunk without deploying.
 */

import { readFileSync } from 'fs';

// Load API key from .env
const envContent = readFileSync('.env', 'utf-8');
for (const line of envContent.split('\n')) {
  if (line && !line.startsWith('#')) {
    const [key, ...valueParts] = line.split('=');
    process.env[key] = valueParts.join('=');
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not found in .env');
  process.exit(1);
}

// =============================================================================
// Prompt Variants
// =============================================================================

const PROMPT_VARIANTS = {
  detailed: `You are an entity extractor for knowledge graphs. Extract entities and relationships from the text you're given.

IMPORTANT: You are processing ONE CHUNK of a larger work. Only extract what is actually present in this chunk.

ENTITY CATEGORIES:
- People/characters (e.g., captain, narrator, sailor)
- Places/locations (e.g., city, inn, harbor, ocean)
- Things/objects (e.g., ship, weapon, tool)
- Concepts/ideas (e.g., theme, belief, symbol)
- Organizations/groups (e.g., crew, guild, company)
- Events (e.g., voyage, battle, meeting)

OUTPUT FORMAT: JSON with "operations" array containing:
- {"op": "create", "label": "Name", "entity_type": "type"}
- {"op": "add_property", "entity": "Name", "key": "k", "value": "v"}
- {"op": "add_relationship", "subject": "A", "predicate": "verb", "target": "B", "source_text": "quote"}

GUIDELINES:
- Extract all significant entities mentioned
- Include specific details and minor characters
- Be thorough in capturing relationships`,

  balanced: `You are an entity extractor for knowledge graphs. Extract the MOST SIGNIFICANT entities and relationships from the text.

IMPORTANT: You are processing ONE CHUNK of a larger document. Focus on entities likely to be referenced in other parts of the document.

EXTRACT:
- Named entities (people, organizations, places, products)
- Key concepts or terms (especially if defined or explained in the text)
- Significant objects, systems, or artifacts
- Events or actions with consequences
- Document structure (chapters, sections, articles, clauses)

SIGNALS OF SIGNIFICANCE:
- Has a proper name or specific identifier
- Is defined, explained, or described in detail
- Is the subject or object of multiple statements
- Would appear in a summary of this text

SKIP:
- Generic references ("the user", "this section", "the system")
- Incidental mentions or passing references
- Common descriptive terms not central to the content
- Temporal markers ("recently", "in 2020") unless the date itself is significant

OUTPUT FORMAT: JSON with "operations" array.

OPERATION TYPES:

1. CREATE - Declare an entity
   {"op": "create", "label": "SEC", "entity_type": "government_agency"}

2. ADD_PROPERTY - Add a property
   {"op": "add_property", "entity": "SEC", "key": "full_name", "value": "Securities and Exchange Commission"}

3. ADD_RELATIONSHIP - Link entities with provenance
   {
     "op": "add_relationship",
     "subject": "SEC",
     "predicate": "regulates",
     "target": "securities markets",
     "source_text": "The SEC oversees securities markets",
     "confidence": 1.0
   }

GUIDELINES:
- Create an entity BEFORE referencing it
- Use consistent labels for the same entity
- Include brief source_text quotes for relationships
- Confidence: 1.0 for explicit statements, 0.7-0.8 for inferred
- Use descriptive entity_type (e.g., "government_agency" not just "organization")

TARGET: ~10-20 entities per chunk. Quality over quantity.`,

  broad: `You are an entity extractor for knowledge graphs. Extract ONLY the major, recurring entities from the text.

IMPORTANT: You are processing ONE CHUNK of a larger work. Only extract entities that would appear in a summary or character list.

EXTRACT ONLY:
- Main characters (protagonists, antagonists, key supporting characters)
- Major locations central to the narrative
- Core themes or symbols
- Significant events that drive the plot

DO NOT EXTRACT:
- Minor characters mentioned once
- Generic objects or locations
- Details specific to this passage only
- Anything not likely to be referenced elsewhere

OUTPUT: JSON with "operations" array.
TARGET: ~5-10 entities maximum. If in doubt, leave it out.`,

  thematic: `You are an entity extractor focused on THEMES and CONCEPTS in literature.

IMPORTANT: You are processing ONE CHUNK of a larger work. Extract the underlying themes, symbols, and conceptual relationships.

EXTRACT:
- Major characters AS they relate to themes
- Symbolic objects or locations
- Abstract concepts (obsession, fate, nature vs man)
- Thematic relationships (character embodies theme, object symbolizes concept)

RELATIONSHIP TYPES to focus on:
- symbolizes, represents, embodies
- struggles_with, confronts
- contrasts_with, parallels

OUTPUT: JSON with "operations" array.
TARGET: Focus on 5-15 thematically significant entities.`,
};

type VariantName = keyof typeof PROMPT_VARIANTS;

// =============================================================================
// Sample Text (Moby Dick opening)
// =============================================================================

const SAMPLE_TEXT = `MOBY-DICK;

or, THE WHALE.

By Herman Melville


CHAPTER 1. Loomings.

Call me Ishmael. Some years ago—never mind how long precisely—having
little or no money in my purse, and nothing particular to interest me
on shore, I thought I would sail about a little and see the watery part
of the world. It is a way I have of driving off the spleen and
regulating the circulation. Whenever I find myself growing grim about
the mouth; whenever it is a damp, drizzly November in my soul; whenever
I find myself involuntarily pausing before coffin warehouses, and
bringing up the rear of every funeral I meet; and especially whenever
my hypos get such an upper hand of me, that it requires a strong moral
principle to prevent me from deliberately stepping into the street, and
methodically knocking people's hats off—then, I account it high time to
get to sea as soon as I can. This is my substitute for pistol and ball.
With a philosophical flourish Cato throws himself upon his sword; I
quietly take to the ship. There is nothing surprising in this. If they
but knew it, almost all men in their degree, some time or other,
cherish very nearly the same feelings towards the ocean with me.`;

// =============================================================================
// Gemini API Call
// =============================================================================

async function callGemini(systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096,
        },
      }),
    }
  );

  const data = await response.json();

  if (data.error) {
    throw new Error(`Gemini error: ${data.error.message}`);
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const variant = (process.argv[2] || 'balanced') as VariantName;

  if (!PROMPT_VARIANTS[variant]) {
    console.log('Available variants:', Object.keys(PROMPT_VARIANTS).join(', '));
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`PROMPT VARIANT: ${variant.toUpperCase()}`);
  console.log(`${'='.repeat(60)}\n`);

  const systemPrompt = PROMPT_VARIANTS[variant];
  const userPrompt = `Extract entities and relationships from the following text.

Text:
${SAMPLE_TEXT}

Output only the JSON object with operations array.`;

  console.log('Calling Gemini...\n');

  const startTime = Date.now();
  const response = await callGemini(systemPrompt, userPrompt);
  const elapsed = Date.now() - startTime;

  // Parse and display results
  try {
    // Extract JSON from response (may have markdown wrapper)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('Raw response:', response);
      return;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const ops = parsed.operations || [];

    const creates = ops.filter((o: any) => o.op === 'create');
    const relationships = ops.filter((o: any) => o.op === 'add_relationship');
    const properties = ops.filter((o: any) => o.op === 'add_property');

    console.log(`RESULTS (${elapsed}ms):`);
    console.log(`${'─'.repeat(40)}`);
    console.log(`Entities: ${creates.length}`);
    console.log(`Relationships: ${relationships.length}`);
    console.log(`Properties: ${properties.length}`);
    console.log();

    console.log('ENTITIES:');
    for (const c of creates) {
      console.log(`  • ${c.label} (${c.entity_type})`);
    }

    if (relationships.length > 0) {
      console.log('\nRELATIONSHIPS:');
      for (const r of relationships) {
        console.log(`  • ${r.subject} → ${r.predicate} → ${r.target}`);
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Entity count by variant expectation:`);
    console.log(`  detailed: 20-50 entities`);
    console.log(`  balanced: 10-20 entities`);
    console.log(`  broad: 5-10 entities`);
    console.log(`  thematic: 5-15 entities (concept-focused)`);
    console.log(`\nActual: ${creates.length} entities`);

  } catch (e) {
    console.log('Failed to parse response:');
    console.log(response.slice(0, 1000));
  }
}

main().catch(console.error);
