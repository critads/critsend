/**
 * One-shot smoke test for the Hetzner S3 backend.
 *
 * Run with:
 *   STORAGE_BACKEND=hetzner \
 *   HETZNER_S3_ENDPOINT=https://nbg1.your-objectstorage.com \
 *   HETZNER_S3_REGION=nbg1 \
 *   HETZNER_S3_BUCKET=critsender \
 *   HETZNER_S3_ACCESS_KEY=... \
 *   HETZNER_S3_SECRET_KEY=... \
 *   npx tsx scripts/test-hetzner-s3.ts
 *
 * Exercises the full contract: upload → exists → stream → delete → exists.
 * Cleans up after itself. Safe to run against a production bucket — uses a
 * random key under imports/_smoketest_/.
 */
import { HetznerS3Service } from "../server/storage-backends/hetzner-s3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

async function main() {
  console.log("=== Hetzner S3 backend smoke test ===");
  console.log(`endpoint = ${process.env.HETZNER_S3_ENDPOINT}`);
  console.log(`region   = ${process.env.HETZNER_S3_REGION}`);
  console.log(`bucket   = ${process.env.HETZNER_S3_BUCKET}`);
  console.log(`access   = ${process.env.HETZNER_S3_ACCESS_KEY?.slice(0, 6)}…`);

  const svc = new HetznerS3Service();

  // 1. Write a small fake CSV locally
  const id = `_smoketest_/${randomUUID()}`;
  const localPath = path.join(os.tmpdir(), `${randomUUID()}.csv`);
  const csv = "email;name;refs;tags\nfoo@bar.com;Foo;abc;tag1\nbaz@bar.com;Baz;def;tag2\n";
  fs.writeFileSync(localPath, csv);
  const sizeBefore = fs.statSync(localPath).size;
  console.log(`\n[1] Wrote ${sizeBefore} bytes to ${localPath}`);

  // 2. Upload
  console.log(`[2] Uploading…`);
  const storagePath = await svc.uploadLocalFile(localPath, `${id}.csv`);
  console.log(`    → storagePath = ${storagePath}`);
  if (!storagePath.startsWith("/objects/imports/")) {
    throw new Error(`Expected /objects/imports/ prefix, got: ${storagePath}`);
  }

  // 3. Exists?
  console.log(`[3] objectExists(${storagePath})…`);
  const exists = await svc.objectExists(storagePath);
  console.log(`    → ${exists}`);
  if (!exists) throw new Error("Upload succeeded but objectExists returned false!");

  // 4. Stream back
  console.log(`[4] getObjectStream… reading bytes back`);
  const stream = await svc.getObjectStream(storagePath);
  const chunks: Buffer[] = [];
  for await (const c of stream as any) chunks.push(Buffer.from(c));
  const downloaded = Buffer.concat(chunks).toString("utf-8");
  console.log(`    → ${downloaded.length} bytes received`);
  console.log(`    → first 80 chars: ${downloaded.slice(0, 80).replace(/\n/g, "\\n")}`);
  if (downloaded !== csv) {
    throw new Error(`Round-trip mismatch!\nExpected: ${JSON.stringify(csv)}\nGot:      ${JSON.stringify(downloaded)}`);
  }

  // 5. Negative test — non-existent key
  const fakePath = "/objects/imports/_smoketest_/does-not-exist.csv";
  console.log(`[5] objectExists(${fakePath}) (should be false)…`);
  const fakeExists = await svc.objectExists(fakePath);
  console.log(`    → ${fakeExists}`);
  if (fakeExists) throw new Error("objectExists returned true for a non-existent key!");

  // 6. Delete
  console.log(`[6] deleteStorageObject(${storagePath})…`);
  const deleted = await svc.deleteStorageObject(storagePath);
  console.log(`    → ${deleted}`);
  if (!deleted) throw new Error("Delete reported false!");

  // 7. Exists after delete?
  console.log(`[7] objectExists after delete (should be false)…`);
  const stillThere = await svc.objectExists(storagePath);
  console.log(`    → ${stillThere}`);
  if (stillThere) throw new Error("Object still exists after delete!");

  // Cleanup local temp
  try { fs.unlinkSync(localPath); } catch {}

  console.log("\n✅ ALL CHECKS PASSED — Hetzner S3 backend is operational.");
}

main().catch((err) => {
  console.error("\n❌ TEST FAILED:", err);
  process.exit(1);
});
