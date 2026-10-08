import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  realpath,
  rm,
  symlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { startControlSocket } from "./socket.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function path() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "marfa-control-"));
  roots.push(root);
  return join(root, "private", "control.sock");
}
function get(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/", agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += String(chunk)));
      res.on("end", () => {
        resolve(body);
      });
    });
    req.on("error", reject);
    req.end();
  });
}
describe("private control socket", () => {
  it("serves only after restricting its directory and socket", async () => {
    const socketPath = await path();
    const server = await startControlSocket(
      socketPath,
      () => new Response("private"),
    );
    try {
      expect(await get(socketPath)).toBe("private");
      expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(join(socketPath, ".."))).mode & 0o777).toBe(0o700);
    } finally {
      await new Promise<void>((r) =>
        server.close(() => {
          r();
        }),
      );
    }
  });
  it("refuses a live collision without disrupting the first listener", async () => {
    const socketPath = await path();
    const server = await startControlSocket(
      socketPath,
      () => new Response("first"),
    );
    try {
      await expect(
        startControlSocket(socketPath, () => new Response("second")),
      ).rejects.toThrow(/already exists/);
      expect(await get(socketPath)).toBe("first");
    } finally {
      await new Promise<void>((r) =>
        server.close(() => {
          r();
        }),
      );
    }
  });
  it("refuses an accessible directory instead of silently repairing it", async () => {
    const socketPath = await path();
    const server = await startControlSocket(
      socketPath,
      () => new Response("private"),
    );
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
    await chmod(join(socketPath, ".."), 0o755);
    await expect(
      startControlSocket(socketPath, () => new Response()),
    ).rejects.toThrow(/0700/);
  });
  it("refuses symbolic-link directories", async () => {
    const socketPath = await path();
    const root = join(socketPath, "../..");
    await symlink(root, join(root, "link"));
    await expect(
      startControlSocket(
        join(root, "link", "control.sock"),
        () => new Response(),
      ),
    ).rejects.toThrow(/symbolic/);
  });
});

// Only hosted CI may switch OS users. The existing nobody account is sufficient.
it.skipIf(process.env.GITHUB_ACTIONS !== "true")(
  "another OS account cannot reach the witnessed private listener",
  async () => {
    // Both the executable and socket ancestors must be traversable by nobody.
    // macOS runner homes and per-user temporary directories are not.
    const root = await mkdtemp(
      join(await realpath("/tmp"), "marfa-user-probe-"),
    );
    roots.push(root);
    await chmod(root, 0o755);
    const executable = join(root, "node");
    await copyFile(process.execPath, executable);
    await chmod(executable, 0o755);
    const publicPath = join(root, "open.sock");
    const socketPath = join(root, "private", "control.sock");
    const witness = createServer((_request, response) =>
      response.end("witness"),
    );
    await new Promise<void>((resolve, reject) => {
      witness.once("error", reject);
      witness.listen(publicPath, () => resolve());
    });
    const probe = async (target: string) => {
      const { stdout } = await promisify(execFile)(
        "sudo",
        [
          "-n",
          "-u",
          "nobody",
          executable,
          "-e",
          `const http=require('node:http');const req=http.get({socketPath:process.argv[1],path:'/'});req.on('response',res=>res.pipe(process.stdout));req.on('error',error=>process.stdout.write(error.code));req.setTimeout(3000,()=>req.destroy(new Error('timeout')));`,
          target,
        ],
        { cwd: root, timeout: 10_000 },
      );
      return stdout;
    };
    let server: Awaited<ReturnType<typeof startControlSocket>> | undefined;
    try {
      await chmod(publicPath, 0o666);
      expect(await probe(publicPath)).toBe("witness");
      server = await startControlSocket(
        socketPath,
        () => new Response("private"),
      );
      expect(await get(socketPath)).toBe("private");
      expect(await probe(socketPath)).toBe("EACCES");
      expect(await probe(publicPath)).toBe("witness");
    } finally {
      await Promise.all(
        [witness, ...(server ? [server] : [])].map(
          (listener) =>
            new Promise<void>((done) => listener.close(() => done())),
        ),
      );
    }
  },
);

it("closing a listener leaves a replacement socket intact", async () => {
  const firstPath = await path();
  const secondPath = join(firstPath, "..", "other.sock");
  const first = await startControlSocket(
    firstPath,
    () => new Response("first"),
  );
  const second = await startControlSocket(
    secondPath,
    () => new Response("second"),
  );
  try {
    expect(await get(firstPath)).toBe("first");
    await rename(secondPath, firstPath);
    expect(await get(firstPath)).toBe("second");
    await new Promise<void>((done) => {
      first.close(() => {
        done();
      });
    });
    expect(await get(firstPath)).toBe("second");
  } finally {
    await new Promise<void>((done) => {
      second.close(() => {
        done();
      });
    });
  }
});
