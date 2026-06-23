import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  request,
  setAuthToken,
  getAuthToken,
  setRefreshToken,
  getRefreshToken,
  clearRefreshToken,
  ApiError,
  http as httpApi,
} from "./client";

// We stub `fetch` per-test rather than using msw: msw's Response body streams
// conflict with happy-dom's FetchResponse.text() consumer ("ReadableStream
// is locked"). A fresh `new Response(...)` returned from a vi.fn avoids that.
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setAuthToken(null);
  clearRefreshToken();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth token accessors", () => {
  it("round-trips a token", () => {
    setAuthToken("abc");
    expect(getAuthToken()).toBe("abc");
  });

  it("clears with null", () => {
    setAuthToken("xyz");
    setAuthToken(null);
    expect(getAuthToken()).toBeNull();
  });
});

describe("request", () => {
  it("parses a JSON success response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, n: 42 }), { status: 200 }),
    );
    const res = await request<{ ok: boolean; n: number }>("/api/x");
    expect(res).toEqual({ ok: true, n: 42 });
  });

  it("sends JSON Content-Type and stringifies a body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await request("/api/x", { method: "POST", body: { a: 1 } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("throws ApiError with status + body on an error envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "bad input" }), { status: 400 }),
    );
    try {
      await request("/api/fail", { method: "POST", body: {} });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toBe("bad input");
    }
  });

  it("falls back to statusText when the error body has no `error` field", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500, statusText: "Internal" }));
    try {
      await request("/api/x");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(500);
    }
  });

  it("returns undefined for HTTP 204", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await request("/api/n", { method: "DELETE" })).toBeUndefined();
  });

  it("throws ApiError with status 0 when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));
    const err = (await request("/api/net").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
  });

  it("returns the raw Response when rawResponse is set", async () => {
    fetchMock.mockResolvedValueOnce(new Response("rawbody", { status: 200 }));
    const res = await request<Response>("/api/blob", { rawResponse: true });
    expect(res).toBeInstanceOf(Response);
    expect(await res.text()).toBe("rawbody");
  });

  it("passes rawBody through untouched", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await request("/api/raw", { method: "PUT", rawBody: "literal-body" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe("literal-body");
    // rawBody must NOT trigger the JSON Content-Type header.
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("injects Authorization header when token is set", async () => {
    setAuthToken("TKN");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await request("/api/authed");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer TKN");
  });

  it("omits Authorization header when token is null", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await request("/api/noauth");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("forwards the AbortSignal to fetch", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const ctrl = new AbortController();
    await request("/api/x", { signal: ctrl.signal });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBe(ctrl.signal);
  });
});

describe("http method helpers", () => {
  it("maps get/post/put/delete to the right methods", async () => {
    // mockImplementation creates a fresh Response per call — a Response body
    // can only be consumed once, so a shared mockResolvedValue would throw
    // "Body has already been used" on the second call.
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    await httpApi.get("/api/m");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    await httpApi.post("/api/m", {});
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
    await httpApi.put("/api/m", {});
    expect(fetchMock.mock.calls[2][1].method).toBe("PUT");
    await httpApi.delete("/api/m");
    expect(fetchMock.mock.calls[3][1].method).toBe("DELETE");
  });
});

describe("refresh-token storage", () => {
  it("persists to localStorage and reads back", () => {
    setRefreshToken("rt-1");
    expect(getRefreshToken()).toBe("rt-1");
    expect(localStorage.getItem("df_refresh_token")).toBe("rt-1");
  });
  it("clears from both memory and localStorage", () => {
    setRefreshToken("rt-1");
    clearRefreshToken();
    expect(getRefreshToken()).toBeNull();
    expect(localStorage.getItem("df_refresh_token")).toBeNull();
  });
});

describe("401 auto-refresh", () => {
  it("refreshes once and replays the request on 401", async () => {
    setRefreshToken("old-refresh");
    setAuthToken("old-access");
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/auth/refresh")) {
        return new Response(
          JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }),
          { status: 200 },
        );
      }
      // guarded endpoint: first call 401, replay 200
      const guardedCalls = fetchMock.mock.calls.filter(
        (c) => !(c[0] as string).endsWith("/api/auth/refresh"),
      ).length;
      if (guardedCalls === 1) {
        return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const res = await request<{ ok: boolean }>("/api/files");
    expect(res).toEqual({ ok: true });
    expect(getAuthToken()).toBe("new-access");
    expect(getRefreshToken()).toBe("new-refresh");
  });

  it("clears the refresh token when refresh itself fails", async () => {
    setRefreshToken("bad");
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/auth/refresh")) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
    });
    await expect(request("/api/x")).rejects.toThrow();
    expect(getRefreshToken()).toBeNull();
  });

  it("deduplicates concurrent 401s to a single refresh", async () => {
    setRefreshToken("r");
    let refreshCalls = 0;
    const hits = new Map<string, number>();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/auth/refresh")) {
        refreshCalls++;
        return new Response(
          JSON.stringify({ access_token: "a", refresh_token: "r2" }),
          { status: 200 },
        );
      }
      const n = (hits.get(url) ?? 0) + 1;
      hits.set(url, n);
      if (n === 1) return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await Promise.all([request("/api/x"), request("/api/y")]);
    expect(refreshCalls).toBe(1);
  });
});
