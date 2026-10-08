import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";

export interface SharedOwnerSession {
  baseUrl: string;
  cookie: string;
}

/** Serialize real sign-ins across Vitest workers sharing one launched instance. */
export async function withOwnerSession<T>(
  path: string,
  use: (
    session: SharedOwnerSession,
    save: (cookie: string) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error("Timed out waiting for the shared owner session lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    const session = JSON.parse(
      await readFile(path, "utf8"),
    ) as SharedOwnerSession;
    return await use(session, async (cookie) => {
      await writeOwnerSession(path, { baseUrl: session.baseUrl, cookie });
    });
  } finally {
    await rmdir(lock);
  }
}

export async function writeOwnerSession(
  path: string,
  session: SharedOwnerSession,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(session), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Reuse only a session the server still accepts with a recent authentication. */
export async function authenticateOwner(
  baseUrl: string,
  cookie: string | undefined,
  credentials: { email: string; password: string },
): Promise<{ cookie: string; authenticatedAt: number }> {
  if (cookie) {
    const current = await fetch(`${baseUrl}/auth/get-session`, {
      headers: { cookie, origin: new URL(baseUrl).origin },
    });
    if (!current.ok && current.status !== 401 && current.status !== 403)
      throw new Error(`Owner session lookup answered ${current.status}`);
    if (current.ok) {
      const session = (await current.json()) as {
        session?: { createdAt: string };
      } | null;
      const authenticatedAt =
        Date.parse(session?.session?.createdAt ?? "") || 0;
      const age = Date.now() - authenticatedAt;
      if (age >= 0 && age < 240_000) return { cookie, authenticatedAt };
    }
  }
  const response = await fetch(`${baseUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: new URL(baseUrl).origin,
    },
    body: JSON.stringify(credentials),
  });
  if (!response.ok)
    throw new Error(`Owner reauthentication answered ${response.status}`);
  const nextCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("marfa.auth.session_token="))
    ?.split(";")[0];
  if (!nextCookie) throw new Error("Owner reauthentication set no cookie");
  return { cookie: nextCookie, authenticatedAt: Date.now() };
}
