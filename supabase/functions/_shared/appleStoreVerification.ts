import { Buffer } from "node:buffer";
import { Environment, SignedDataVerifier } from "npm:@apple/app-store-server-library@3.1.0";

const rootCertificate = await Deno.readFile(new URL("./apple-certs/AppleRootCA-G3.cer", import.meta.url));
const bundleId = Deno.env.get("APPLE_BUNDLE_ID") || "au.com.receiptbox.app";

function verifier(environment: Environment) {
  const appAppleId = environment === Environment.PRODUCTION
    ? Number(Deno.env.get("APPLE_APP_ID"))
    : undefined;
  if (environment === Environment.PRODUCTION && !Number.isSafeInteger(appAppleId)) {
    throw new Error("apple_app_id_not_configured");
  }
  return new SignedDataVerifier(
    [Buffer.from(rootCertificate)],
    true,
    environment,
    bundleId,
    appAppleId,
  );
}

function untrustedEnvironment(jws: string) {
  try {
    const payload = JSON.parse(Buffer.from(jws.split(".")[1], "base64url").toString("utf8"));
    const value = payload.environment || payload.data?.environment;
    if (value === "Production") return Environment.PRODUCTION;
    if (value === "Sandbox") return Environment.SANDBOX;
  } catch { /* Verification below remains authoritative. */ }
  throw new Error("invalid_apple_environment");
}

export async function verifyTransaction(jws: string) {
  if (!jws || jws.split(".").length !== 3) throw new Error("invalid_signed_transaction");
  return await verifier(untrustedEnvironment(jws)).verifyAndDecodeTransaction(jws);
}

export async function verifyNotification(jws: string) {
  if (!jws || jws.split(".").length !== 3) throw new Error("invalid_signed_notification");
  return await verifier(untrustedEnvironment(jws)).verifyAndDecodeNotification(jws);
}

export async function verifyRenewalInfo(jws: string) {
  if (!jws) return {};
  return await verifier(untrustedEnvironment(jws)).verifyAndDecodeRenewalInfo(jws);
}
