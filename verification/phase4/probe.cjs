var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../../shared/phase4-implementation-20261009/native-probe/probe-entry.ts
var import_promises2 = require("node:fs/promises");
var import_node_fs = require("node:fs");
var import_node_path2 = __toESM(require("node:path"));
var import_node_os = require("node:os");
var import_strict = __toESM(require("node:assert/strict"));

// src/main/phase4/descriptor-metadata.ts
var import_node_child_process = require("node:child_process");
var import_node_path = __toESM(require("node:path"), 1);

// src/collector/orca/process-group.ts
var import_promises = require("node:fs/promises");
var GRACE_MS = 100;
var CLEANUP_MS = 1e3;
var pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function signalOwnedGroup(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
  }
}
async function groupState(child) {
  if (!child.pid) return "gone";
  if (process.platform === "win32") return child.exitCode !== null || child.signalCode !== null ? "gone" : "live";
  try {
    process.kill(-child.pid, 0);
  } catch (error) {
    return error.code === "ESRCH" ? "gone" : "unknown";
  }
  if (process.platform !== "linux") return "live";
  let entries;
  try {
    entries = await (0, import_promises.readdir)("/proc");
  } catch {
    return "unknown";
  }
  let unknown = false;
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const stat = await (0, import_promises.readFile)(`/proc/${entry}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      const fields = stat.slice(end + 2).split(" ");
      if (end < 0 || fields.length < 4) {
        unknown = true;
        continue;
      }
      const [state, , group, session] = fields;
      if (Number(group) === child.pid && Number(session) === child.pid && state !== "Z" && state !== "X") return "live";
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") unknown = true;
    }
  }
  return unknown ? "unknown" : "snapshot-quiescent";
}
async function finalizeQueryGroup(child) {
  const started = performance.now();
  signalOwnedGroup(child, "SIGTERM");
  let hardKilled = false;
  while (performance.now() - started < CLEANUP_MS) {
    if (!hardKilled && performance.now() - started >= GRACE_MS) {
      signalOwnedGroup(child, "SIGKILL");
      hardKilled = true;
    }
    const state = await Promise.race([groupState(child), pause(100).then(() => "unknown")]);
    if (state === "gone") return true;
    if (state === "snapshot-quiescent") {
      if (hardKilled) return true;
      signalOwnedGroup(child, "SIGKILL");
      hardKilled = true;
    }
    await pause(10);
  }
  signalOwnedGroup(child, "SIGKILL");
  return false;
}

// src/main/phase4/descriptor-metadata.ts
var DESCRIPTOR_METADATA_LIMITS = Object.freeze({ entries: 5e3, depth: 24, pathBytes: 4096, concurrency: 4, timeoutMs: 5e3, outputBytes: 4 * 1024 * 1024 });
var DescriptorMetadataError = class extends Error {
  constructor(code) {
    super(`Safe document metadata unavailable (${code}).`);
    this.code = code;
    this.name = "DescriptorMetadataError";
  }
  code;
};
var descriptorMetadataIdentity = (stat) => `${stat.dev}:${stat.ino}:${stat.mode}`;
var PROGRAM = String.raw`import sys, os, stat, json, errno
class Changed(Exception): pass
def identity(s): return str(s.st_dev)+':'+str(s.st_ino)+':'+str(s.st_mode)
def stamp(s): return (s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def metadata(s):
    return dict(dev=str(s.st_dev),ino=str(s.st_ino),mode=s.st_mode,nlink=s.st_nlink,size=s.st_size,mtimeMs=s.st_mtime_ns/1000000,ctimeMs=s.st_ctime_ns/1000000)
def name_ok(n):
    return isinstance(n,str) and 0<len(n)<=1024 and n not in ('.','..') and not any(c in n for c in ('/','\\','\x00')) and not any(ord(c)<32 or ord(c)==127 or 0xd800<=ord(c)<=0xdfff for c in n)
def run():
    req=json.loads(sys.argv[1])
    if set(req)!=set(('op','rootIdentity','components','expectedDirectories','limit','name')): raise ValueError()
    op,expected,parts,known,limit,name=(req[k] for k in ('op','rootIdentity','components','expectedDirectories','limit','name'))
    if op not in ('list','stat') or not isinstance(parts,list) or len(parts)>24 or not all(name_ok(p) for p in parts): raise ValueError()
    if len('/'.join(parts).encode('utf-8'))>4096 or not isinstance(expected,str): raise ValueError()
    if known is not None and (not isinstance(known,list) or len(known)!=len(parts) or not all(isinstance(k,str) for k in known)): raise ValueError()
    if op=='list' and (type(limit) is not int or not 1<=limit<=5000 or name is not None): raise ValueError()
    if op=='stat' and (not name_ok(name) or limit is not None): raise ValueError()
    if not all(hasattr(os,k) for k in ('O_DIRECTORY','O_NOFOLLOW','O_NONBLOCK')) or os.scandir not in os.supports_fd or os.open not in os.supports_dir_fd or os.stat not in os.supports_dir_fd or os.stat not in os.supports_follow_symlinks: return dict(version=1,error='unsupported')
    inherited=os.fstat(3)
    if not stat.S_ISDIR(inherited.st_mode) or identity(inherited)!=expected: raise Changed()
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK
    opened=[]
    try:
        fd=os.open('.',flags,dir_fd=3);opened.append(fd)
        first=os.fstat(fd)
        if identity(first)!=expected: raise Changed()
        before=[first]
        for i,part in enumerate(parts):
            fd=os.open(part,flags,dir_fd=fd);opened.append(fd)
            current=os.fstat(fd)
            if not stat.S_ISDIR(current.st_mode) or known is not None and identity(current)!=known[i]: raise Changed()
            before.append(current)
        response=dict(version=1,op=op,rootIdentity=expected,chain=[identity(s) for s in before[1:]])
        if op=='list':
            entries=[];partial=False;count=0
            with os.scandir(fd) as iterator:
                for item in iterator:
                    count+=1
                    if count>limit: partial=True;break
                    if not name_ok(item.name): continue
                    # Never use DirEntry's path, follow links, or open file bodies.
                    current=os.stat(item.name,dir_fd=fd,follow_symlinks=False)
                    entries.append(dict(name=item.name,stat=metadata(current)))
            response.update(entries=entries,partial=partial,examinedCount=min(count,limit))
        else:
            response['stat']=metadata(os.stat(name,dir_fd=fd,follow_symlinks=False))
        for i,current in enumerate(opened):
            if stamp(os.fstat(current))!=stamp(before[i]): raise Changed()
            if i and stamp(os.stat(parts[i-1],dir_fd=opened[i-1],follow_symlinks=False))!=stamp(before[i]): raise Changed()
        if stamp(os.fstat(3))!=stamp(first): raise Changed()
        return response
    finally:
        for fd in reversed(opened): os.close(fd)
try:
    result=run()
except Changed:
    result=dict(version=1,error='path_changed')
except OSError as e:
    code={errno.ENOENT:'ENOENT',errno.EACCES:'EACCES',errno.EPERM:'EPERM',errno.ELOOP:'path_changed',errno.ENOTDIR:'path_changed'}.get(e.errno,'command_failed')
    result=dict(version=1,error=code)
except (ValueError,TypeError,KeyError,OverflowError):
    result=dict(version=1,error='invalid_request')
except Exception:
    result=dict(version=1,error='command_failed')
finally:
    try: os.close(3)
    except OSError: pass
sys.stdout.write(json.dumps(result,ensure_ascii=True,allow_nan=False,separators=(',',':'))+'\n')
`;
function bad() {
  throw new DescriptorMetadataError("invalid_response");
}
var validName = (v) => typeof v === "string" && v.length > 0 && v.length <= 1024 && v !== "." && v !== ".." && !/[\/\\\u0000-\u001f\u007f\ud800-\udfff]/u.test(v);
var validIdentity = (v) => typeof v === "string" && /^(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19}):[0-9]{1,7}$/u.test(v);
function record(v, keys) {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length !== keys.length) bad();
  const out = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d || !("value" in d)) bad();
    out[key] = d.value;
  }
  return out;
}
function metadata(v) {
  const r = record(v, ["dev", "ino", "mode", "nlink", "size", "mtimeMs", "ctimeMs"]);
  if (![r.dev, r.ino].every((n) => typeof n === "string" && /^(0|[1-9][0-9]{0,19})$/u.test(n)) || ![r.mode, r.nlink, r.size].every((n) => Number.isSafeInteger(n) && Number(n) >= 0) || Number(r.mode) > 65535 || ![r.mtimeMs, r.ctimeMs].every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 864e13)) bad();
  const value = r;
  return { ...value, isFile: () => (value.mode & 61440) === 32768, isDirectory: () => (value.mode & 61440) === 16384, isSymbolicLink: () => (value.mode & 61440) === 40960 };
}
function request(op, value) {
  if (!Number.isSafeInteger(value.rootFd) || value.rootFd < 0 || !validIdentity(value.rootIdentity) || value.signal !== void 0 && !(value.signal instanceof AbortSignal)) throw new DescriptorMetadataError("invalid_request");
  const parts = value.components ?? [], known = value.expectedDirectories;
  if (!Array.isArray(parts) || parts.length > DESCRIPTOR_METADATA_LIMITS.depth || !parts.every(validName) || Buffer.byteLength(parts.join("/")) > DESCRIPTOR_METADATA_LIMITS.pathBytes || known !== void 0 && (!Array.isArray(known) || known.length !== parts.length || !known.every(validIdentity)) || op === "list" && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > DESCRIPTOR_METADATA_LIMITS.entries) || op === "stat" && !validName(value.name)) throw new DescriptorMetadataError("invalid_request");
  return { op, rootIdentity: value.rootIdentity, components: [...parts], expectedDirectories: known ? [...known] : null, limit: op === "list" ? value.limit : null, name: op === "stat" ? value.name : null };
}
function response(value, req) {
  if (value && typeof value === "object" && Object.hasOwn(value, "error")) {
    const r2 = record(value, ["version", "error"]);
    if (r2.version !== 1 || !["unsupported", "path_changed", "invalid_request", "command_failed", "ENOENT", "EACCES", "EPERM"].includes(String(r2.error))) bad();
    throw new DescriptorMetadataError(r2.error);
  }
  const r = record(value, req.op === "list" ? ["version", "op", "rootIdentity", "chain", "entries", "partial", "examinedCount"] : ["version", "op", "rootIdentity", "chain", "stat"]);
  if (r.version !== 1 || r.op !== req.op || r.rootIdentity !== req.rootIdentity || !Array.isArray(r.chain) || r.chain.length !== req.components.length || !r.chain.every(validIdentity) || req.expectedDirectories && r.chain.some((id, i) => id !== req.expectedDirectories[i])) bad();
  if (req.op === "stat") return metadata(r.stat);
  if (!Array.isArray(r.entries) || r.entries.length > req.limit || typeof r.partial !== "boolean" || !Number.isSafeInteger(r.examinedCount) || Number(r.examinedCount) < r.entries.length || Number(r.examinedCount) > req.limit || r.partial && r.examinedCount !== req.limit) bad();
  const seen = /* @__PURE__ */ new Set();
  const entries = r.entries.map((value2) => {
    const e = record(value2, ["name", "stat"]);
    if (!validName(e.name) || seen.has(e.name)) bad();
    seen.add(e.name);
    return { name: e.name, stat: metadata(e.stat) };
  });
  return { entries, partial: r.partial, examinedCount: r.examinedCount };
}
function createDescriptorMetadataTransport(config) {
  const timeout = config.timeoutMs ?? DESCRIPTOR_METADATA_LIMITS.timeoutMs, maximum = config.maxOutputBytes ?? DESCRIPTOR_METADATA_LIMITS.outputBytes;
  if (typeof config.pythonPath !== "string" || !import_node_path.default.isAbsolute(config.pythonPath) || import_node_path.default.normalize(config.pythonPath) !== config.pythonPath || /[\u0000-\u001f\u007f]/u.test(config.pythonPath) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3e4 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8 * 1024 * 1024) throw new DescriptorMetadataError("invalid_request");
  const controller = new AbortController(), pending = /* @__PURE__ */ new Set(), children = /* @__PURE__ */ new Set();
  let poisoned = false;
  function execute(req, rootFd, signal) {
    if (signal.aborted) return Promise.reject(new DescriptorMetadataError("cancelled"));
    if (poisoned) return Promise.reject(new DescriptorMetadataError("cleanup_unverified"));
    if (process.platform !== "linux" && process.platform !== "darwin") return Promise.reject(new DescriptorMetadataError("unsupported"));
    if (children.size >= DESCRIPTOR_METADATA_LIMITS.concurrency) return Promise.reject(new DescriptorMetadataError("busy"));
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = (0, import_node_child_process.spawn)(config.pythonPath, ["-I", "-B", "-S", "-c", PROGRAM, JSON.stringify(req)], {
          shell: false,
          windowsHide: true,
          detached: true,
          cwd: "/",
          env: { LANG: "C", LC_ALL: "C" },
          stdio: ["ignore", "pipe", "pipe", rootFd]
        });
      } catch {
        reject(new DescriptorMetadataError("command_failed"));
        return;
      }
      children.add(child);
      let chunks = [], bytes = 0, settled = false, stopped = null, cleanup;
      const wipe = () => {
        for (const chunk of chunks) chunk.fill(0);
        chunks = [];
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        wipe();
        if (error) reject(new DescriptorMetadataError(error));
        else resolve(result);
      };
      const clean = () => cleanup ??= finalizeQueryGroup(child).catch(() => false).then((ok) => {
        if (!ok) {
          poisoned = true;
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish("cleanup_unverified");
        }
        return ok;
      });
      const stop = (code) => {
        if (stopped || settled) return;
        stopped = code;
        wipe();
        child.stdout?.destroy();
        child.stderr?.destroy();
        void clean();
      };
      const abort = () => stop("cancelled"), timer = setTimeout(() => stop("timeout"), timeout);
      const receive = (chunk, retain) => {
        if (stopped || settled) return;
        bytes += chunk.byteLength;
        if (bytes > maximum) {
          stop("output_limit");
          return;
        }
        if (retain) chunks.push(Buffer.from(chunk));
      };
      child.stdout?.on("data", (chunk) => receive(chunk, true));
      child.stderr?.on("data", (chunk) => receive(chunk, false));
      child.stdout?.on("error", () => stop("command_failed"));
      child.stderr?.on("error", () => stop("command_failed"));
      child.once("error", () => stop("command_failed"));
      child.once("exit", () => {
        void clean();
      });
      child.once("close", async (code, termination) => {
        children.delete(child);
        if (!await clean() || settled) return;
        if (stopped) {
          finish(stopped);
          return;
        }
        if (code !== 0 || termination !== null) {
          finish("command_failed");
          return;
        }
        const buffer = Buffer.concat(chunks);
        wipe();
        try {
          finish(void 0, response(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)), req));
        } catch (error) {
          finish(error instanceof DescriptorMetadataError ? error.code : "invalid_response");
        } finally {
          buffer.fill(0);
        }
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  const run = (op, value) => {
    let req;
    try {
      req = request(op, value);
    } catch (error) {
      return Promise.reject(error);
    }
    const signal = value.signal ? AbortSignal.any([controller.signal, value.signal]) : controller.signal;
    const flight = execute(req, value.rootFd, signal);
    pending.add(flight);
    void flight.then(() => pending.delete(flight), () => pending.delete(flight));
    return flight;
  };
  return {
    list: (value) => run("list", value),
    stat: (value) => run("stat", value),
    dispose() {
      controller.abort();
    },
    async settle() {
      while (pending.size) await Promise.allSettled([...pending]);
      if (poisoned) throw new DescriptorMetadataError("cleanup_unverified");
    }
  };
}

// ../../../shared/phase4-implementation-20261009/native-probe/probe-entry.ts
async function probe() {
  const python = process.env.PHASE4_PYTHON;
  if (!python || !import_node_path2.default.isAbsolute(python)) throw Error("PHASE4_PYTHON must identify existing trusted interpreter");
  const root = await (0, import_promises2.mkdtemp)(import_node_path2.default.join((0, import_node_os.tmpdir)(), "note-phase4-native-metadata-"));
  const approved = import_node_path2.default.join(root, "approved"), outside = import_node_path2.default.join(root, "outside");
  await (0, import_promises2.mkdir)(approved);
  await (0, import_promises2.mkdir)(outside);
  await (0, import_promises2.mkdir)(import_node_path2.default.join(approved, "child"));
  await (0, import_promises2.writeFile)(import_node_path2.default.join(approved, "safe.md"), "synthetic");
  await (0, import_promises2.writeFile)(import_node_path2.default.join(approved, "child", "nested.md"), "synthetic");
  await (0, import_promises2.writeFile)(import_node_path2.default.join(outside, "outside-only.md"), "synthetic");
  for (let i = 0; i < 313; i++) await (0, import_promises2.writeFile)(import_node_path2.default.join(approved, `synthetic-${i}.md`), "synthetic");
  const fd = await (0, import_promises2.open)(approved, import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_DIRECTORY | import_node_fs.constants.O_NOFOLLOW);
  const transport = createDescriptorMetadataTransport({ pythonPath: python });
  const result = { platform: process.platform, node: process.versions.node, electron: process.versions.electron ?? null, processType: process.type ?? "node", checks: [], status: "running" };
  try {
    const rootIdentity = descriptorMetadataIdentity(await fd.stat()), request2 = { rootFd: fd.fd, rootIdentity };
    const started = performance.now(), first = await transport.list({ ...request2, limit: 5e3 });
    result.list313Ms = performance.now() - started;
    import_strict.default.equal(first.entries.length, 315);
    (0, import_strict.default)(!first.partial);
    result.checks.push("actual module inherited-fd listing and metadata for313files");
    const child = first.entries.find((entry) => entry.name === "child");
    (0, import_strict.default)(child.stat.isDirectory());
    const nested = await transport.stat({ ...request2, components: ["child"], expectedDirectories: [descriptorMetadataIdentity(child.stat)], name: "nested.md" });
    (0, import_strict.default)(nested.isFile());
    result.checks.push("relative child openat and no-follow metadata");
    await (0, import_promises2.rename)(approved, approved + "-moved");
    await (0, import_promises2.mkdir)(approved);
    await (0, import_promises2.writeFile)(import_node_path2.default.join(approved, "outside-only.md"), "synthetic replacement");
    const after = await transport.list({ ...request2, limit: 5e3 });
    (0, import_strict.default)(after.entries.some((entry) => entry.name === "safe.md"));
    (0, import_strict.default)(!after.entries.some((entry) => entry.name === "outside-only.md"));
    result.checks.push("ancestor replacement never changes inherited descriptor enumeration");
    await (0, import_promises2.rename)(import_node_path2.default.join(approved + "-moved", "child"), import_node_path2.default.join(approved + "-moved", "child-old"));
    await (0, import_promises2.mkdir)(import_node_path2.default.join(approved + "-moved", "child"));
    await (0, import_promises2.writeFile)(import_node_path2.default.join(approved + "-moved", "child", "nested.md"), "replacement");
    await import_strict.default.rejects(() => transport.stat({ ...request2, components: ["child"], expectedDirectories: [descriptorMetadataIdentity(child.stat)], name: "nested.md" }));
    result.checks.push("expected child inode replacement is rejected");
    await (0, import_promises2.symlink)(outside, import_node_path2.default.join(approved + "-moved", "symlink-child"));
    await import_strict.default.rejects(() => transport.stat({ ...request2, components: ["symlink-child"], name: "outside-only.md" }));
    result.checks.push("symlink directory child is not followed");
    const cancellation = new AbortController();
    cancellation.abort();
    await import_strict.default.rejects(() => transport.list({ ...request2, limit: 10, signal: cancellation.signal }));
    result.checks.push("already-cancelled operation denied");
    const bounded = await transport.list({ ...request2, limit: 2 });
    import_strict.default.equal(bounded.entries.length, 2);
    (0, import_strict.default)(bounded.partial);
    result.checks.push("listing bound is explicit partial result");
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = String(error);
  } finally {
    transport.dispose();
    await transport.settle();
    await fd.close();
    await (0, import_promises2.rm)(root, { recursive: true, force: true });
    result.cleanup = "helper settled and synthetic directory removed";
  }
  return result;
}
async function main() {
  const result = await probe();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.status === "passed" ? 0 : 1;
}
if (process.versions.electron && process.type === "browser") {
  const { app } = require("electron");
  const profile = process.env.PHASE4_PROFILE;
  if (!profile || !import_node_path2.default.isAbsolute(profile)) throw Error("PHASE4_PROFILE must be an explicit disposable profile");
  (0, import_node_fs.mkdirSync)(profile, { recursive: true });
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.setName("note-app Phase4 metadata verification");
  app.whenReady().then(async () => app.exit(await main())).catch((error) => {
    console.error(String(error));
    app.exit(1);
  });
} else {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
