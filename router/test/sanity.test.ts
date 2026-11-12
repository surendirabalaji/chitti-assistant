import { describe, it, expect } from "vitest";

describe("sanity", () => {
  it("runs basic truthy assertion", () => {
    expect(true).toBe(true);
  });

  it("adds numbers correctly", () => {
    expect(1 + 2).toBe(3);
  });

});