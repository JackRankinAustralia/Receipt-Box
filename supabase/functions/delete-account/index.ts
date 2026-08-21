import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.57.4";
import { deleteAccountResources } from "./workflow.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function storedReceiptPaths(admin: ReturnType<typeof createClient>, userId: string) {
  const paths: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const { data: folders, error } = await admin.storage.from("receipts").list(userId, { limit: 100, offset });
    if (error) throw new Error(`Receipt folder cleanup failed: ${error.message}`);
    for (const folder of folders || []) {
      if (folder.id) paths.push(`${userId}/${folder.name}`);
      else {
        const { data: files, error: fileError } = await admin.storage.from("receipts").list(`${userId}/${folder.name}`, { limit: 1000 });
        if (fileError) throw new Error(`Receipt file cleanup failed: ${fileError.message}`);
        paths.push(...(files || []).filter((file) => file.id).map((file) => `${userId}/${folder.name}/${file.name}`));
      }
    }
    if (!folders || folders.length < 100) break;
  }
  return paths;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  const token = request.headers.get("Authorization");
  if (!token) return new Response(JSON.stringify({ error: "Authentication required." }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const authenticated = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: token } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error: userError } = await authenticated.auth.getUser();
  if (userError || !user) return new Response(JSON.stringify({ error: "Your session is no longer valid." }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  const body = await request.json().catch(() => ({}));
  if (body.confirm !== true) return new Response(JSON.stringify({ error: "Explicit deletion confirmation is required." }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    await deleteAccountResources({
      listPaths: async () => {
        const { data: receipts, error } = await admin.from("receipts").select("file_path").eq("user_id", user.id);
        if (error) throw error;
        return [...new Set([...(receipts || []).map((row) => row.file_path).filter(Boolean), ...await storedReceiptPaths(admin, user.id)])];
      },
      removePaths: async (paths) => {
        const { error } = await admin.storage.from("receipts").remove(paths);
        if (error) throw new Error(`Receipt file cleanup failed: ${error.message}`);
      },
      cleanupData: async () => {
        const { error } = await admin.rpc("delete_account_data", { target_user_id: user.id });
        if (error) throw new Error(`Account data cleanup failed: ${error.message}`);
      },
      deleteAuth: async () => {
        const { error } = await admin.auth.admin.deleteUser(user.id);
        if (error) throw new Error(`Account deletion failed: ${error.message}`);
      },
    });
    return new Response(JSON.stringify({ deleted: true }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Account cleanup did not complete." }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
