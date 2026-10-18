// The process that holds the device's binding, so a fixture can drive it.
//
// A fixture runs the scripted server in its own process. An engine call that
// blocks its thread, as a synchronous one does while it reads from the
// server, would stop that server answering if both shared a process, so the
// binding lives here and the fixture talks to it over the IPC channel. Each
// request carries an `id` and is answered by a reply with the same `id`, in
// whatever order the calls finish, so two calls can be in flight at once.
// `binding-adapter.ts` is the other end.
//
// The messages, each from the fixture with an `id`:
//   { op: "open", handle, path, url?, key?, reader? }
//   { op: "call", handle, method, args }   the method of the core opened as
//                                          `handle`; an argument of the form
//                                          { $stop: name } is that stop
//   { op: "stop", name, action: "new" | "raise" }
//   { op: "subscribe", handle, name, kind: "follow" | "watch", toldUnreachable }
//   { op: "unsubscribe", name }
//   { op: "hook", name, point }            the debug build's testHooks
//   { op: "clock", name, arg? }           the debug build's testClock
//   { op: "exit" }
// A reply is { id, ok: true, value } or { id, ok: false, error }. A
// subscription also sends { event: "change", name, change } for each change
// and, last, { event: "end", name, error }.
import { createRequire } from "node:module";

const modulePath = process.env.MARFA_DEVICE_MODULE;
if (modulePath === undefined || modulePath === "") {
  throw new Error("MARFA_DEVICE_MODULE is unset");
}
const binding = createRequire(import.meta.url)(modulePath);

const cores = new Map();
const stops = new Map();
const subscriptions = new Map();

/** A thrown error as data: its code, its message and the fields it carries. */
function describe(thrown) {
  if (thrown === null || thrown === undefined) return null;
  if (!(thrown instanceof Error)) return { message: String(thrown) };
  const fields = {};
  for (const name of Object.getOwnPropertyNames(thrown)) {
    if (name !== "stack") fields[name] = thrown[name];
  }
  return { ...fields, name: thrown.name, message: thrown.message };
}

function core(handle) {
  const found = cores.get(handle);
  if (found === undefined) throw new Error(`no core is open as ${handle}`);
  return found;
}

function argument(value) {
  if (value !== null && typeof value === "object" && "$stop" in value) {
    const stop = stops.get(value.$stop);
    if (stop === undefined) throw new Error(`no stop named ${value.$stop}`);
    return stop;
  }
  return value;
}

function debugOnly(name) {
  const controls = binding[name];
  if (controls === undefined) {
    throw new Error(
      `${name} is absent: MARFA_DEVICE_MODULE is not a debug build (build it without --release)`,
    );
  }
  return controls;
}

function subscribe(message) {
  const { handle, name, kind, toldUnreachable } = message;
  const onChange = (change) => process.send({ event: "change", name, change });
  const onEnd = (error) => {
    subscriptions.delete(name);
    process.send({ event: "end", name, error: describe(error) });
  };
  subscriptions.set(
    name,
    core(handle)[kind](onChange, onEnd, toldUnreachable ?? undefined),
  );
}

async function handle(message) {
  switch (message.op) {
    case "open": {
      const { MarfaCore } = binding;
      cores.set(
        message.handle,
        message.reader === true
          ? MarfaCore.openReader(message.path)
          : MarfaCore.open(message.path, message.url, message.key),
      );
      return null;
    }
    case "call": {
      const target = core(message.handle);
      if (typeof target[message.method] !== "function") {
        throw new Error(`a core has no ${message.method}`);
      }
      return await target[message.method](...message.args.map(argument));
    }
    case "stop": {
      if (message.action === "new") {
        stops.set(message.name, new binding.Stop());
      } else {
        stops.get(message.name)?.raise();
      }
      return null;
    }
    case "subscribe":
      subscribe(message);
      return null;
    case "unsubscribe":
      subscriptions.get(message.name)?.stop();
      return null;
    case "hook":
      return debugOnly("testHooks")[message.name](message.point);
    case "clock":
      return debugOnly("testClock")[message.name](message.arg);
    case "exit":
      setImmediate(() => process.exit(0));
      return null;
    default:
      throw new Error(`no operation ${String(message.op)}`);
  }
}

process.on("message", (message) => {
  handle(message).then(
    (value) => process.send({ id: message.id, ok: true, value: value ?? null }),
    (error) =>
      process.send({ id: message.id, ok: false, error: describe(error) }),
  );
});
process.on("disconnect", () => process.exit(0));
