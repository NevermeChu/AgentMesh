import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startMcpServer } from "../../src/mcp/server.js";

describe("mcp/server", () => {
  it("removes process signal listeners when a server closes", async () => {
    const baselineSigint = process.listenerCount("SIGINT");
    const baselineSigterm = process.listenerCount("SIGTERM");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startMcpServer({ transport: serverTransport });

    expect(process.listenerCount("SIGINT")).toBe(baselineSigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(baselineSigterm + 1);

    await server.close();
    await clientTransport.close();

    expect(process.listenerCount("SIGINT")).toBe(baselineSigint);
    expect(process.listenerCount("SIGTERM")).toBe(baselineSigterm);
  });

  it("allows programmatic servers to opt out of signal handling", async () => {
    const baselineSigint = process.listenerCount("SIGINT");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startMcpServer({ transport: serverTransport, handleSignals: false });

    expect(process.listenerCount("SIGINT")).toBe(baselineSigint);

    await server.close();
    await clientTransport.close();
  });
});
