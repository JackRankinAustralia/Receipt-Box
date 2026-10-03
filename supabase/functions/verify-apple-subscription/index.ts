import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.57.4";
import { verifyTransaction } from "../_shared/appleStoreVerification.ts";
import { assertTransactionOwner, safeSubscriptionResponse, storeSubscription, subscriptionRecord } from "../_shared/appleSubscription.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "Content-Type": "application/json" },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const authorization = request.headers.get("Authorization");
  if (!authorization) return json({ error: "Authentication required." }, 401);

  const authenticated = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error: userError } = await authenticated.auth.getUser();
  if (userError || !user) return json({ error: "Your session is no longer valid." }, 401);

  try {
    const body = await request.json();
    const transaction = await verifyTransaction(String(body?.signedTransaction || ""));
    const record = assertTransactionOwner(subscriptionRecord(transaction), user.id);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await storeSubscription(admin, record);
    return json({ subscription: safeSubscriptionResponse(record) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "verification_failed";
    const status = code === "transaction_account_mismatch" ? 403 : 400;
    console.warn("ReceiptGo Apple subscription verification failed:", code);
    return json({ error: "This App Store purchase could not be verified.", code }, status);
  }
});
