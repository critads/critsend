import { describe, expect, it } from "vitest";
import { classifyDbError } from "../server/db-errors";

describe("classifyDbError", () => {
  it("unwraps a Drizzle query wrapper around a pool connection timeout", () => {
    const cause = new Error("timeout exceeded when trying to connect");
    const wrapper = new Error("Failed query: SELECT status FROM campaigns");
    wrapper.cause = cause;

    expect(classifyDbError(wrapper)).toMatchObject({
      kind: "timeout",
      transient: true,
      message: cause.message,
    });
  });

  it("unwraps a nested PostgreSQL connection SQLSTATE", () => {
    const cause = Object.assign(new Error("connection failure"), {
      code: "08006",
    });
    const middle = new Error("query failed", { cause });
    const outer = new Error("campaign lookup failed", { cause: middle });

    expect(classifyDbError(outer)).toMatchObject({
      kind: "connection",
      transient: true,
      code: "08006",
    });
  });

  it("keeps an unknown wrapper non-transient", () => {
    const wrapper = new Error("Failed query: malformed application query", {
      cause: new Error("column does not exist"),
    });

    expect(classifyDbError(wrapper)).toMatchObject({
      kind: "unknown",
      transient: false,
      message: wrapper.message,
    });
  });

  it("stops safely on a cyclic cause chain", () => {
    const error = new Error("cyclic");
    error.cause = error;

    expect(classifyDbError(error)).toMatchObject({
      kind: "unknown",
      transient: false,
    });
  });
});