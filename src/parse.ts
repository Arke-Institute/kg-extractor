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
  return (
    typeof op === 'object' &&
    op !== null &&
    (op as { op?: string }).op === 'create' &&
    typeof (op as { label?: string }).label === 'string' &&
    typeof (op as { entity_type?: string }).entity_type === 'string'
  );
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
  return (
    typeof op === 'object' &&
    op !== null &&
    (op as { op?: string }).op === 'add_relationship' &&
    typeof (op as { subject?: string }).subject === 'string' &&
    typeof (op as { predicate?: string }).predicate === 'string' &&
    typeof (op as { target?: string }).target === 'string'
  );
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
