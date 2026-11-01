/**
 * Stub network surfaces so any accidental call fails the test suite.
 * Tripwire must never make network calls.
 *
 * Node built-in ESM exports are non-configurable, so we replace modules via
 * vi.mock rather than vi.spyOn.
 */
import { afterEach, beforeEach, vi } from "vitest";

const MSG = "Network calls are forbidden in agent-tripwire tests";

function forbid(..._args: unknown[]): never {
  throw new Error(MSG);
}

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    connect: forbid,
    createConnection: forbid,
  };
});

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    request: forbid,
    get: forbid,
  };
});

vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  return {
    ...actual,
    request: forbid,
    get: forbid,
  };
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error(MSG);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});
