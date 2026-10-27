import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { parseLinuxProcessArguments, parseMacProcessArgumentsForTest, readNativeProcessArguments } from "../src/domain/native-process-arguments.js";

describe("native process argv boundaries", () => {
  it("rejects malformed, truncated, invalid UTF-8 and oversized Linux cmdline buffers", () => {
    expect(parseLinuxProcessArguments(Buffer.from("codex\0resume\0\0"))).toEqual(["codex", "resume", ""]);
    expect(parseLinuxProcessArguments(Buffer.from("codex\0resume"))).toBeNull();
    expect(parseLinuxProcessArguments(Buffer.from("\0resume\0"))).toBeNull();
    expect(parseLinuxProcessArguments(Buffer.from([99, 111, 100, 101, 120, 0, 0xff, 0]))).toBeNull();
    expect(parseLinuxProcessArguments(Buffer.alloc(1024 * 1024 + 1))).toBeNull();
  });

  it.skipIf(process.platform !== "darwin")("parses only declared macOS arguments, rejecting short argc and bad bytes", async () => {
    const fixture = (argc: number, args: Buffer[], environment = Buffer.from("SENTINEL=secret\0")) => {
      const count = Buffer.alloc(4);
      count.writeInt32LE(argc);
      return Buffer.concat([count, Buffer.from("/usr/bin/node\0\0"), ...args.map(arg => Buffer.concat([arg, Buffer.from([0])])), environment]);
    };
    const valid = fixture(3, [Buffer.from("node"), Buffer.from("例"), Buffer.alloc(0)]);
    expect(await parseMacProcessArgumentsForTest(valid)).toEqual(["node", "例", ""]);
    expect(await parseMacProcessArgumentsForTest(fixture(4, [Buffer.from("node"), Buffer.from("resume")], Buffer.alloc(0)))).toBeNull();
    expect(await parseMacProcessArgumentsForTest(fixture(2, [Buffer.from("node"), Buffer.from([0xff])]))).toBeNull();
    expect(await parseMacProcessArgumentsForTest(Buffer.from([1, 0, 0, 0, 110, 111, 100, 101]))).toBeNull();
  });

  it("ignores invalid PIDs without inspecting another process", async () => {
    expect((await readNativeProcessArguments([0, -1, NaN, 1.5, 2147483648])).size).toBe(0);
  });

  it.skipIf(!["darwin", "linux"].includes(process.platform))("reads only the owned child's argv, preserving spaces, quotes, Unicode and empty arguments", async () => {
    const args = ["/Users/me/Library/Application Support/例", "Bob's \"app\"", "", "resume", "00000000-0000-7000-8000-000000000001"];
    const code = "process.stdout.write('ready'); setInterval(() => {}, 1000)";
    const sentinel = "environment-must-not-be-returned";
    const child = spawn(process.execPath, ["-e", code, "--", ...args], {
      env: { ...process.env, OPENRIG_ARGV_TEST_SECRET: sentinel }, stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await once(child.stdout!, "data");
      const found = await readNativeProcessArguments([child.pid!]);
      expect(found.get(child.pid!)).toEqual([process.execPath, "-e", code, "--", ...args]);
      expect(JSON.stringify([...found])).not.toContain(sentinel);
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
  });
});
