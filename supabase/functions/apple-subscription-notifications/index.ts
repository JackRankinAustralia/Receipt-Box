import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.57.4";
import { verifyNotification, verifyRenewalInfo, verifyTransaction } from "../_shared/appleStoreVerification.ts";
import { storeSubscription, subscriptionRecord } from "../_shared/appleSubscription.mjs";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const body = await request.json();
    const notification = await verifyNotification(String(body?.signedPayload || ""));
    const signedTransaction = notification?.data?.signedTransactionInfo;
    if (!signedTransaction) return json({ received: true });
    const transaction = await verifyTransaction(signedTransaction);
    const renewal = notification?.data?.signedRenewalInfo
      ? await verifyRenewalInfo(notification.data.signedRenewalInfo)
      : {};
    const record = subscriptionRecord(transaction, renewal, notification.notificationType || null);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await storeSubscription(admin, record);
    return json({ received: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : "notification_verification_failed";
    console.warn("ReceiptGo Apple subscription notification rejected:", code);
    return json({ error: "Notification verification failed." }, 400);
  }
});
