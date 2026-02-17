/**
 * Parse LLM output into structured operations
 */

import type {
  Operation,
  CreateOp,
  AddPropertyOp,
  AddRelationshipOp,
  ParsedOperations,
} from './types';

/**
 * Type guard for CreateOp
 */
function isCreateOp(op: unknown): op is CreateOp {
  if (
    typeof op !== 'object' ||
    op === null ||
    (op as { op?: string }).op !== 'create' ||
    typeof (op as { label?: string }).label !== 'string' ||
    typeof (op as { entity_type?: string }).entity_type !== 'string'
  ) {
    return false;
  }

  const candidate = op as { description?: unknown; properties?: unknown };

  // Description is required
  if (typeof candidate.description !== 'string') {
    console.warn('[parse] CreateOp missing required description:', (op as { label?: string }).label);
    return false;
  }

  // Properties should be an object if present
  if (candidate.properties !== undefined && typeof candidate.properties !== 'object') {
    console.warn('[parse] CreateOp has invalid properties type:', (op as { label?: string }).label);
    return false;
  }

  // Warn if fewer than 2 properties
  if (candidate.properties) {
    const propCount = Object.keys(candidate.properties as object).length;
    if (propCount < 2) {
      console.warn('[parse] CreateOp has fewer than 2 properties:', (op as { label?: string }).label, `(${propCount})`);
    }
  } else {
    console.warn('[parse] CreateOp has no properties:', (op as { label?: string }).label);
  }

  return true;
}

/**
 * Type guard for AddPropertyOp
 */
function isAddPropertyOp(op: unknown): op is AddPropertyOp {
  return (
    typeof op === 'object' &&
    op !== null &&
    (op as { op?: string }).op === 'add_property' &&
    typeof (op as { entity?: string }).entity === 'string' &&
    typeof (op as { key?: string }).key === 'string' &&
    typeof (op as { value?: string }).value === 'string'
  );
}

/**
 * Type guard for AddRelationshipOp
 */
function isAddRelationshipOp(op: unknown): op is AddRelationshipOp {
  if (
    typeof op !== 'object' ||
    op === null ||
    (op as { op?: string }).op !== 'add_relationship' ||
    typeof (op as { subject?: string }).subject !== 'string' ||
    typeof (op as { predicate?: string }).predicate !== 'string' ||
    typeof (op as { target?: string }).target !== 'string'
  ) {
    return false;
  }

  const candidate = op as { description?: unknown; quote_start?: unknown; quote_end?: unknown };

  // Description is required
  if (typeof candidate.description !== 'string') {
    const rel = op as { subject?: string; predicate?: string; target?: string };
    console.warn('[parse] AddRelationshipOp missing required description:', `${rel.subject} -[${rel.predicate}]-> ${rel.target}`);
    return false;
  }

  // Quote markers should be strings if present
  if (candidate.quote_start !== undefined && typeof candidate.quote_start !== 'string') {
    console.warn('[parse] AddRelationshipOp has invalid quote_start type');
    return false;
  }
  if (candidate.quote_end !== undefined && typeof candidate.quote_end !== 'string') {
    console.warn('[parse] AddRelationshipOp has invalid quote_end type');
    return false;
  }

  return true;
}

/**
 * Parse raw LLM JSON output into typed operations
 *
 * Handles both array format and object with operations key.
 * Validates each operation and filters out invalid ones.
 */
export function parseOperations(content: string): ParsedOperations {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to parse JSON: ${e instanceof Error ? e.message : e}`);
  }

  // Handle both array format and object with operations key
  let operations: unknown[];
  if (Array.isArray(parsed)) {
    operations = parsed;
  } else if (
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as { operations?: unknown[] }).operations)
  ) {
    operations = (parsed as { operations: unknown[] }).operations;
  } else {
    throw new Error('Expected array or object with operations key');
  }

  // Categorize and validate operations
  const creates: CreateOp[] = [];
  const properties: AddPropertyOp[] = [];
  const relationships: AddRelationshipOp[] = [];

  for (const op of operations) {
    if (isCreateOp(op)) {
      creates.push(op);
    } else if (isAddPropertyOp(op)) {
      properties.push(op);
    } else if (isAddRelationshipOp(op)) {
      relationships.push(op);
    } else {
      // Log but don't fail on invalid operations
      console.warn('[parse] Skipping invalid operation:', op);
    }
  }

  return { creates, properties, relationships };
}

/**
 * Collect all entity labels referenced in operations
 * (both in creates and in property/relationship references)
 */
export function collectReferencedLabels(operations: ParsedOperations): Set<string> {
  const labels = new Set<string>();

  // Labels from creates
  for (const create of operations.creates) {
    labels.add(create.label);
  }

  // Labels from properties
  for (const prop of operations.properties) {
    labels.add(prop.entity);
  }

  // Labels from relationships
  for (const rel of operations.relationships) {
    labels.add(rel.subject);
    labels.add(rel.target);
  }

  return labels;
}
