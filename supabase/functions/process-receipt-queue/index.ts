import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.57.4";
import { processReceiptQueueBatch } from "./workflow.mjs";
import { callGeminiForReceipt, extractMeaningfulReceiptFields } from "./geminiReceiptScan.mjs";
import { normaliseAustralianReceiptDate } from "./receiptDates.mjs";
import { isAuthorisedWorkerRequest, extractBearerToken } from "./workerAuth.mjs";
import { resolveMaxReceipts } from "./maxReceipts.mjs";

// This function is invoked by Supabase Cron (Stage 3D-C) or manually by an
// operator holding the dedicated worker secret. It is NEVER intended to be
// callable by an ordinary authenticated browser user, so authentication here
// checks a DEDICATED invocation secret (RECEIPT_QUEUE_WORKER_SECRET), not a
// Supabase user session (contrast with delete-account/index.ts) and NOT the
// Supabase service-role key. The service-role key stays entirely internal to
// this function, used only to build the privileged Supabase client for
// RPC/Storage calls; it is never accepted as (or compared against) the
// externally supplied invocation credential. Cron-invoked Edge Functions can
// be configured with a static Authorization header, so the same dedicated
// worker secret works unchanged for both manual invocation now and scheduled
// Cron invocation later.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_RECEIPTS_PER_INVOCATION = 3;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  const workerSecret = Deno.env.get("RECEIPT_QUEUE_WORKER_SECRET");
  const token = extractBearerToken(request.headers.get("Authorization"));
  if (!isAuthorisedWorkerRequest(token, workerSecret)) {
    return new Response(JSON.stringify({ error: "Not authorised." }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // Optional maxReceipts request body field, used only for controlled manual
  // testing (e.g. {"maxReceipts":1}). Omitted/empty body => unchanged current behaviour.
  const rawBody = await request.text();
  let requestedMaxReceipts: unknown;
  if (rawBody.trim().length > 0) {
    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: "Request body must be valid JSON." }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
    requestedMaxReceipts = parsedBody?.maxReceipts;
  }
  const maxReceiptsResult = resolveMaxReceipts(requestedMaxReceipts, MAX_RECEIPTS_PER_INVOCATION);
  if (!maxReceiptsResult.ok) {
    return new Response(JSON.stringify({ error: maxReceiptsResult.error }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiApiKey) {
    return new Response(JSON.stringify({ error: "Server is not configured for receipt scanning." }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Never logs image data or credentials; only short, operator-useful status text.
  const log = (message: string) => console.log(message);

  try {
    const summary = await processReceiptQueueBatch({
      maxReceipts: maxReceiptsResult.value,
      generateSessionId: () => crypto.randomUUID(),
      log,
      claimNext: async (sessionId: string) => {
        const { data, error } = await admin.rpc("claim_next_queued_receipt_service", { worker_scan_session_id: sessionId });
        if (error) throw new Error(`Claim failed: ${error.message}`);
        const row = Array.isArray(data) ? data[0] : data;
        return row?.claimed ? row : { claimed: false };
      },
      beginEntitlement: async (receiptId: string) => {
        const { data, error } = await admin.rpc("begin_receipt_ocr_service", { receipt_id: receiptId });
        if (error) throw new Error(`Entitlement check failed: ${error.message}`);
        const row = Array.isArray(data) ? data[0] : data;
        return { allowed: Boolean(row?.allowed) };
      },
      downloadReceiptFile: async (filePath: string) => {
        const { data, error } = await admin.storage.from("receipts").download(filePath);
        if (error || !data) throw new Error(error?.message || "Receipt file could not be downloaded.");
        const buffer = new Uint8Array(await data.arrayBuffer());
        let binary = "";
        for (let i = 0; i < buffer.length; i++) binary += String.fromCharCode(buffer[i]);
        return btoa(binary);
      },
      callGemini: async ({ base64Image, mimeType }: { base64Image: string; mimeType: string }) =>
        callGeminiForReceipt({ apiKey: geminiApiKey, base64Image, mimeType, log }),
      extractMeaningfulFields: (fields: unknown) => extractMeaningfulReceiptFields(fields, normaliseAustralianReceiptDate),
      completeOcr: async (
        receiptId: string,
        scanSessionId: string,
        outcome: { success: boolean; supplier?: string | null; receiptDate?: string | null; total?: number | null; gst?: number | null; errorSummary?: string | null; retryable?: boolean }
      ) => {
        const { data, error } = await admin.rpc("complete_receipt_ocr_service", {
          receipt_id: receiptId,
          scan_session_id: scanSessionId,
          success: outcome.success,
          supplier: outcome.supplier ?? null,
          receipt_date: outcome.receiptDate ?? null,
          total: outcome.total ?? null,
          gst: outcome.gst ?? null,
          error_summary: outcome.errorSummary ?? null,
          retryable: outcome.retryable ?? true,
        });
        if (error) throw new Error(`Completion failed: ${error.message}`);
        const row = Array.isArray(data) ? data[0] : data;
        return { workflow_status: row?.workflow_status };
      },
    });

    return new Response(JSON.stringify(summary), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (error) {
    log(`process-receipt-queue batch error: ${error instanceof Error ? error.message : "unknown error"}`);
    return new Response(JSON.stringify({ error: "Receipt queue processing did not complete." }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
