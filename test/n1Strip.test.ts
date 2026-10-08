import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { N1StripClient } from "../src/core/n1Strip.js";
import { silentLogger } from "../src/core/services/logger.js";

interface Request { event: string; device: string; image?: string }

/** Stand-in for the driver's strip socket: hands out requests in arrival order. */
class FakeStripServer {
  readonly connections: net.Socket[] = [];
  private readonly arrived: Request[] = [];
  private waiting: ((request: Request) => void) | null = null;
  private readonly server = net.createServer((socket) => {
    this.connections.push(socket);
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      pending += chunk;
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        this.deliver(JSON.parse(pending.slice(0, end)) as Request);
        pending = pending.slice(end + 1);
        socket.write('{"ok":true}\n');
      }
    });
  });

  listen(path: string): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.listen(path, resolve);
    return promise;
  }

  next(): Promise<Request> {
    const queued = this.arrived.shift();
    if (queued) return Promise.resolve(queued);
    const { promise, resolve } = Promise.withResolvers<Request>();
    this.waiting = resolve;
    return promise;
  }

  close(): Promise<void> {
    for (const socket of this.connections) socket.destroy();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.close(() => resolve());
    return promise;
  }

  private deliver(request: Request): void {
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) waiting(request);
    else this.arrived.push(request);
  }
}

const svgOf = (request: Request): string =>
  Buffer.from(request.image!.replace("data:image/svg+xml;base64,", ""), "base64").toString();

test("N1 strip client draws once per change, resends after the driver drops it, and releases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "muxboard-strip-"));
  const server = new FakeStripServer();
  await server.listen(join(dir, "strip.sock"));
  const client = new N1StripClient(join(dir, "strip.sock"), silentLogger, 0);

  try {
    client.draw("n1-a", "<svg>one</svg>");
    client.draw("n1-a", "<svg>one</svg>");
    client.draw("n1-a", "<svg>two</svg>");
    const first = await server.next();
    assert.equal(first.event, "drawStrip");
    assert.equal(first.device, "n1-a");
    assert.equal(svgOf(first), "<svg>one</svg>");
    assert.equal(svgOf(await server.next()), "<svg>two</svg>", "an unchanged frame must not be resent");

    server.connections[0].destroy();
    assert.equal(svgOf(await server.next()), "<svg>two</svg>", "the last frame is resent after reconnecting");

    client.release("n1-a");
    assert.deepEqual(await server.next(), { event: "releaseStrip", device: "n1-a" });
  } finally {
    client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
