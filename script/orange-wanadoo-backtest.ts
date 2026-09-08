import { runOrangeWanadooBacktest } from "../server/services/orange-wanadoo-backtest";
import { pool } from "../server/db";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = ""] = arg.replace(/^--/, "").split("=", 2);
    return [key, value];
  }),
);
const asOf = new Date(args.get("as-of") || new Date().toISOString());
const lookbackDays = Number(args.get("lookback-days") || 30);

try {
  const output = await runOrangeWanadooBacktest(asOf, lookbackDays);
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
