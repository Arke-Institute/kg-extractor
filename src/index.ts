/**
 * KG Extractor Worker - Knowledge Graph Entity Extraction
 *
 * This worker extracts entities and relationships from text using Gemini,
 * creates them in Arke, and passes newly-created entities to the next
 * workflow step.
 *
 * Two-phase processing:
 * 1. Sync: Gemini extraction + check-create entities (determines handoff)
 * 2. Async: Fire updates via /updates/additive (fire-and-forget)
 */

import { Hono } from 'hono';
import { KladosJob, type KladosRequest } from '@arke-institute/rhiza';
import { processJob } from './job';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

/**
 * Health check endpoint
 */
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    agent_id: c.env.AGENT_ID,
    version: c.env.AGENT_VERSION,
  });
});

/**
 * Arke verification endpoint
 * Required to verify ownership of this endpoint before activating the klados.
 */
app.get('/.well-known/arke-verification', (c) => {
  const token = c.env.VERIFICATION_TOKEN;
  const kladosId = c.env.ARKE_VERIFY_AGENT_ID || c.env.AGENT_ID;

  if (!token || !kladosId) {
    return c.json({ error: 'Verification not configured' }, 500);
  }

  return c.json({
    verification_token: token,
    klados_id: kladosId,
  });
});

/**
 * Debug endpoint to check environment (remove in production)
 */
app.get('/debug/env', (c) => {
  return c.json({
    agent_id: c.env.AGENT_ID || '(not set)',
    agent_version: c.env.AGENT_VERSION || '(not set)',
    arke_agent_key: c.env.ARKE_AGENT_KEY ? `${c.env.ARKE_AGENT_KEY.slice(0, 10)}...` : '(not set)',
    gemini_api_key: c.env.GEMINI_API_KEY ? `${c.env.GEMINI_API_KEY.slice(0, 10)}...` : '(not set)',
  });
});

/**
 * Main job processing endpoint
 * The API calls POST /process to invoke the klados
 */
app.post('/process', async (c) => {
  const rawReq = await c.req.json<KladosRequest>();
  const env = c.env;

  // Override api_base if it's the non-v1 URL (platform sends wrong URL)
  const req: KladosRequest = {
    ...rawReq,
    api_base: rawReq.api_base === 'https://api.arke.institute'
      ? 'https://arke-v1.arke.institute'
      : rawReq.api_base,
  };

  // Log incoming request for debugging
  console.log('[KG Extractor] Received request:', JSON.stringify({
    job_id: req.job_id,
    target_entity: req.target_entity,
    target_collection: req.target_collection,
    job_collection: req.job_collection,
    api_base: req.api_base,
    original_api_base: rawReq.api_base,
    network: req.network,
    has_rhiza: !!req.rhiza,
  }));

  // Validate required secrets
  if (!env.GEMINI_API_KEY) {
    console.error('[KG Extractor] GEMINI_API_KEY not configured');
    return c.json({ error: 'GEMINI_API_KEY not configured' }, 500);
  }
  if (!env.ARKE_AGENT_KEY) {
    console.error('[KG Extractor] ARKE_AGENT_KEY not configured');
    return c.json({ error: 'ARKE_AGENT_KEY not configured' }, 500);
  }

  console.log('[KG Extractor] Creating KladosJob with agentId:', env.AGENT_ID);

  // Accept the job immediately
  const job = KladosJob.accept(req, {
    agentId: env.AGENT_ID,
    agentVersion: env.AGENT_VERSION,
    authToken: env.ARKE_AGENT_KEY,
  });

  console.log('[KG Extractor] Job accepted, logId:', job.logId);

  // Process in background - KladosJob handles:
  // - Writing initial log entry
  // - Catching errors and updating log + batch slot
  // - Executing workflow handoffs
  // - Finalizing log on completion
  c.executionCtx.waitUntil(
    job.run(async () => {
      return await processJob(job, env);
    }).catch((err) => {
      // Log any errors that escape KladosJob
      console.error('[KG Extractor] Fatal error in job.run():', err);
    })
  );

  // Return acceptance immediately
  return c.json(job.acceptResponse);
});

export default app;
