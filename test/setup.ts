/**
 * Stub network surfaces so any accidental call fails the test suite.
 * Tripwire must never make network calls.
 *
 * Node built-in ESM exports are non-configurable, so we replace modules via
 * vi.mock rather than vi.spyOn.
 *
 * Also mock node-notifier globally — Windows CI has no notification center
 * for tests, and desktop popups must not leak into the suite.
 */
import { afterEach, beforeEach, vi } from "vitest";

const MSG = "Network calls are forbidden in agent-tripwire tests";

vi.mock("node-notifier", () => ({
  default: {
    notify: vi.fn(
      (
        _opts: unknown,
        cb?: (err: Error | null, response: string) => void,
      ) => {
        cb?.(null, "ok");
      },
    ),
  },
}));

function forbid(..._args: unknown[]): never {
  throw new Error(MSG);
}

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    connect: forbid,
    createConnection: forbid,
    Socket: class ForbiddenSocket {
      constructor() {
        throw new Error(MSG);
      }
    },
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

vi.mock("node:tls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:tls")>();
  return {
    ...actual,
    connect: forbid,
  };
});

vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    lookup: forbid,
    resolve: forbid,
    reverse: forbid,
  };
});

vi.mock("node:dgram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dgram")>();
  return {
    ...actual,
    createSocket: forbid,
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
