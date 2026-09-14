import { insertBrandSchema, type InsertBrand } from "@shared/schema";

export const MAX_BRAND_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_BRAND_CSV_ROWS = 10_000;

export class BrandCsvError extends Error {
  readonly line?: number;

  constructor(message: string, line?: number) {
    super(line ? `CSV error on line ${line}: ${message}` : `CSV error: ${message}`);
    this.name = "BrandCsvError";
    this.line = line;
  }
}

interface CsvRecord {
  fields: string[];
  line: number;
}

function firstRecordEnd(input: string): number {
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') {
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (char === "\n" || char === "\r")) {
      return i;
    }
  }
  return input.length;
}

function detectDelimiter(input: string): "," | ";" {
  const header = input.slice(0, firstRecordEnd(input));
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i += 1) {
    const char = header[i];
    if (char === '"') {
      if (quoted && header[i + 1] === '"') {
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted) {
      if (char === ",") commas += 1;
      if (char === ";") semicolons += 1;
    }
  }
  if (semicolons > commas) return ";";
  return ",";
}

function* parseRecords(input: string, delimiter: "," | ";"): Generator<CsvRecord> {
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let quoteClosed = false;
  let line = 1;
  let recordLine = 1;

  const finishRecord = (): CsvRecord => {
    fields.push(field);
    field = "";
    fieldStarted = false;
    quoteClosed = false;
    const record = { fields, line: recordLine };
    fields = [];
    return record;
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else {
        field += char;
        if (char === "\n") line += 1;
      }
      continue;
    }

    if (char === '"') {
      if (fieldStarted && field.trim().length > 0) {
        throw new BrandCsvError("unexpected quote", line);
      }
      quoted = true;
      fieldStarted = true;
    } else if (char === delimiter) {
      fields.push(field);
      field = "";
      fieldStarted = false;
      quoteClosed = false;
    } else if (char === "\r" || char === "\n") {
      // Treat CRLF as one record terminator.  A CR inside a quoted value was
      // handled above and is intentionally preserved.
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      yield finishRecord();
      line += 1;
      recordLine = line;
    } else if (quoteClosed) {
      if (!/\s/.test(char)) {
        throw new BrandCsvError("unexpected characters after closing quote", line);
      }
      field += char;
    } else {
      field += char;
      fieldStarted = true;
    }
  }

  if (quoted) {
    throw new BrandCsvError("unterminated quoted field", recordLine);
  }

  // A trailing newline has already completed the final record.
  if (field.length > 0 || fields.length > 0 || fieldStarted) {
    yield finishRecord();
  }
}

function isBlankRecord(record: CsvRecord): boolean {
  return record.fields.every((field) => field.trim() === "");
}

function decodeUtf8(input: Buffer | string): string {
  if (typeof input === "string") return input;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new BrandCsvError("file must be valid UTF-8");
  }
}

/**
 * Parse and validate a complete Brands CSV before any database operation is
 * started.  Keeping this function side-effect free is what makes malformed
 * imports atomic from the API's perspective.
 */
export function parseBrandCsv(input: Buffer | string): InsertBrand[] {
  const byteLength = Buffer.byteLength(input);
  if (byteLength > MAX_BRAND_CSV_BYTES) {
    throw new BrandCsvError(`file exceeds the ${MAX_BRAND_CSV_BYTES} byte limit`);
  }
  const text = decodeUtf8(input).replace(/^\uFEFF/, "");
  if (!text.trim()) {
    throw new BrandCsvError("file is empty");
  }

  const delimiter = detectDelimiter(text);
  const rows: InsertBrand[] = [];
  let header: CsvRecord | undefined;
  for (const record of parseRecords(text, delimiter)) {
    // Blank physical records are ignored, but are discarded immediately
    // rather than retained in an intermediate array.  This matters for a
    // small (5 MiB) file containing millions of blank lines.
    if (isBlankRecord(record)) continue;

    if (!header) {
      header = record;
      if (header.fields.length !== 2) {
        throw new BrandCsvError(
          "header must contain exactly two columns: brand (or name) and ref",
          header.line,
        );
      }

      const firstHeader = header.fields[0].trim().toLowerCase();
      const secondHeader = header.fields[1].trim().toLowerCase();
      if (!["brand", "name"].includes(firstHeader) || secondHeader !== "ref") {
        throw new BrandCsvError(
          'header must be "brand,ref" (or "name,ref")',
          header.line,
        );
      }
      continue;
    }

    // Enforce the row bound as records are scanned.  At most 10,000
    // validated rows are retained, never all rows in the upload.
    if (rows.length >= MAX_BRAND_CSV_ROWS) {
      throw new BrandCsvError(
        `maximum ${MAX_BRAND_CSV_ROWS} data rows exceeded`,
        record.line,
      );
    }

    if (record.fields.length !== 2) {
      throw new BrandCsvError("each row must contain exactly two columns", record.line);
    }

    const parsed = insertBrandSchema.safeParse({
      name: record.fields[0],
      ref: record.fields[1],
    });
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "row"} ${issue.message}`)
        .join("; ");
      throw new BrandCsvError(details, record.line);
    }
    rows.push(parsed.data);
  }

  if (!header) {
    throw new BrandCsvError("file is empty");
  }
  return rows;
}