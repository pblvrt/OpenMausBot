import { describe, expect, it } from "vitest";

import {
  createDuoPlusClient,
  createPhoneClaim,
  duoPlusAgentCommand,
  duoPlusCommand,
  duoPlusRoutes,
  asciiJson,
  findPackages,
  parseDevices,
  parseDuoPlusPhones,
  parseLaunchablePackages,
  parseUiNodes,
} from "./phone-proxy.ts";

describe("phone MCP parsing", () => {
  it("keeps physical USB devices distinguishable from network and emulator transports", () => {
    expect(parseDevices(`List of devices attached
USB123 device product:husky model:Pixel_8 usb:1-2 transport_id:4
emulator-5554 device product:sdk model:Emulator transport_id:6
192.0.2.4:5555 device product:remote model:Remote transport_id:7
`)).toEqual([
      { serial: "USB123", state: "device", connection: "usb", model: "Pixel 8" },
      { serial: "emulator-5554", state: "device", connection: "emulator", model: "Emulator" },
      { serial: "192.0.2.4:5555", state: "device", connection: "network", model: "Remote" },
    ]);
  });

  it("extracts unique launchable packages", () => {
    expect(parseLaunchablePackages(`2 activities found:
      com.ubercab/.presidio.RootActivity
      net.skyscanner.android.main/net.skyscanner.shell.SplashActivity
      com.ubercab/.presidio.RootActivity
    `)).toEqual(["com.ubercab", "net.skyscanner.android.main"]);
  });

  it("resolves common human app names before using package-name heuristics", () => {
    const packages = ["com.ubercab", "net.skyscanner.android.main", "com.example.other"];
    expect(findPackages("Uber", packages)).toEqual(["com.ubercab"]);
    expect(findPackages("Skyscanner", packages)).toEqual(["net.skyscanner.android.main"]);
  });

  it("turns Android UI XML into tap-ready visible nodes", () => {
    expect(parseUiNodes(`<?xml version="1.0"?><hierarchy><node text="Where to?" resource-id="com.ubercab:id/input" class="android.widget.TextView" content-desc="Destination" bounds="[12,100][400,180]" /></hierarchy>`)).toEqual([
      { text: "Where to?", description: "Destination", id: "com.ubercab:id/input", className: "android.widget.TextView", bounds: [12, 100, 400, 180] },
    ]);
  });
});

describe("phone MCP lazy claim gate", () => {
  const harnessEnv = { OMB_HARNESS_URL: "http://127.0.0.1:8799", OMB_PHONE_TOKEN: "tok" };
  const stub = (handler: (request: Request) => Promise<{ ok: boolean; status: number }>) => {
    const calls: Request[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      calls.push(request);
      return handler(request);
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  it("proceeds without a harness when the proxy runs standalone", async () => {
    const { calls, fetchImpl } = stub(async () => ({ ok: true, status: 200 }));
    const ensure = createPhoneClaim({}, fetchImpl);
    await expect(ensure()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it("claims lazily and revalidates ownership on every call", async () => {
    const { calls, fetchImpl } = stub(async () => ({ ok: true, status: 200 }));
    const ensure = createPhoneClaim(harnessEnv, fetchImpl);
    expect(calls).toHaveLength(0);
    await expect(ensure()).resolves.toEqual({ ok: true });
    await expect(ensure()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.get("authorization")).toBe("Bearer tok");
  });

  it.each([401, 403, 409])("rejects a previously successful caller after ownership is lost (%s)", async (status) => {
    let active = true;
    const { calls, fetchImpl } = stub(async () => active ? { ok: true, status: 200 } : { ok: false, status });
    const ensure = createPhoneClaim(harnessEnv, fetchImpl);
    await expect(ensure()).resolves.toEqual({ ok: true });
    active = false;
    await expect(ensure()).resolves.toMatchObject({ ok: false });
    expect(calls).toHaveLength(2);
  });

  it("returns the blocked text on conflict and retries on a later call", async () => {
    let busy = true;
    const { calls, fetchImpl } = stub(async () => (busy ? { ok: false, status: 409 } : { ok: true, status: 200 }));
    const ensure = createPhoneClaim(harnessEnv, fetchImpl);
    const first = await ensure();
    expect(first).toEqual({ ok: false, message: "Another thread is using the phone. This call was not performed. Pause phone work until that thread finishes, then read the screen again before acting." });
    busy = false;
    await expect(ensure()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("names the ended turn when the capability is gone and stays honest on transport failure", async () => {
    let reject = false;
    const { fetchImpl } = stub(async () => (reject
      ? Promise.reject(new Error("fetch failed"))
      : Promise.resolve({ ok: false, status: 401 })));
    const ensure = createPhoneClaim(harnessEnv, fetchImpl);
    await expect(ensure()).resolves.toEqual({ ok: false, message: "This turn no longer has phone access. Start a new turn to use the phone." });
    reject = true;
    await expect(ensure()).resolves.toMatchObject({ ok: false, message: expect.stringContaining("could not be reached") });
  });
});

describe("DuoPlus cloud phones", () => {
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const stub = (handler: (request: Request, body: Record<string, unknown>) => Response) => {
    const calls: Array<{ request: Request; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      const body = JSON.parse(await request.clone().text()) as Record<string, unknown>;
      calls.push({ request, body });
      return handler(request, body);
    }) as typeof fetch;
    return { calls, fetchImpl };
  };
  const noSleep = async () => {};

  it("stays off without an API key", () => {
    expect(createDuoPlusClient({})).toBeNull();
  });

  it("lists cloud phones as their own transport with readable states", () => {
    expect(parseDuoPlusPhones([
      { id: "sChH1", name: "snap", status: 1, os: "Android 15" },
      { id: "x2", name: "", status: 2, os: "" },
      { id: "x3", status: 99 },
      { name: "no id", status: 1 },
    ])).toEqual([
      { serial: "duoplus:sChH1", state: "device", connection: "cloud", model: "DuoPlus cloud phone (snap, Android 15)" },
      { serial: "duoplus:x2", state: "powered off", connection: "cloud", model: "DuoPlus cloud phone" },
      { serial: "duoplus:x3", state: "status 99", connection: "cloud", model: "DuoPlus cloud phone" },
    ]);
  });

  it("maps the adb calls the proxy makes onto DuoPlus shell commands", () => {
    expect(duoPlusCommand(["shell", "input", "tap", "10", "20"])).toEqual({ command: "input tap 10 20", base64: false });
    expect(duoPlusCommand(["exec-out", "screencap", "-p"])).toEqual({ command: "screencap -p | base64", base64: true });
    expect(() => duoPlusCommand(["install", "app.apk"])).toThrow(/do not support adb install/);
  });

  it("encodes DuoPlus agent actions as a shell-safe broadcast", () => {
    const command = duoPlusAgentCommand("INPUT_CONTENT", { content: "café 日本 $(rm -rf /)'\"", clear_first: false }, "t1");
    const match = /^am broadcast -a com\.duoplus\.service\.PROCESS_DATA --es message ([A-Za-z0-9+/=]+)$/.exec(command);
    expect(match).not.toBeNull();
    expect(JSON.parse(Buffer.from(match![1], "base64").toString("utf8"))).toEqual({
      task_type: "ai", action: "execute", task_id: "t1", md5: "mausbot",
      action_name: "INPUT_CONTENT", params: { content: "café 日本 $(rm -rf /)'\"", clear_first: false },
    });
  });

  it("authenticates, lists phones, and runs commands by phone id", async () => {
    const { calls, fetchImpl } = stub((request) => request.url.endsWith("/list")
      ? respond({ code: 200, data: { list: [{ id: "sChH1", name: "snap", status: 1, os: "Android 15" }] } })
      : respond({ code: 200, data: { success: true, content: "Physical size: 1080x2400\n", message: "" } }));
    const client = createDuoPlusClient({ DUOPLUS_API_KEY: "key" }, fetchImpl, noSleep)!;
    await expect(client.devices()).resolves.toMatchObject([{ serial: "duoplus:sChH1", state: "device" }]);
    const output = await client.run("duoplus:sChH1", ["shell", "wm", "size"]);
    expect(output.toString("utf8")).toBe("Physical size: 1080x2400\n");
    expect(calls[0].request.url).toBe("https://openapi.duoplus.net/api/v1/cloudPhone/list");
    expect(calls[0].request.headers.get("DuoPlus-API-Key")).toBe("key");
    expect(calls[1].body).toEqual({ image_id: "sChH1", command: "wm size" });
  });

  it("decodes base64 screenshots back to PNG bytes", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000", "hex");
    const wrapped = png.toString("base64").replace(/(.{4})/g, "$1\n");
    const { fetchImpl } = stub(() => respond({ code: 200, data: { success: true, content: wrapped } }));
    const client = createDuoPlusClient({ DUOPLUS_API_KEY: "key" }, fetchImpl, noSleep)!;
    await expect(client.run("duoplus:a", ["exec-out", "screencap", "-p"])).resolves.toEqual(png);
  });

  it("surfaces DuoPlus refusals and failed commands as errors", async () => {
    let refuse = true;
    const { fetchImpl } = stub(() => refuse
      ? respond({ code: 401, message: "Invalid API key" })
      : respond({ code: 200, data: { success: false, message: "device offline" } }));
    const client = createDuoPlusClient({ DUOPLUS_API_KEY: "key" }, fetchImpl, noSleep)!;
    await expect(client.devices()).rejects.toThrow("DuoPlus refused the request: Invalid API key");
    refuse = false;
    await expect(client.run("duoplus:a", ["shell", "ls"])).rejects.toThrow("device offline");
  });

  it("decodes numeric character references in screen text", () => {
    expect(parseUiNodes(`<?xml version="1.0"?><hierarchy><node text="caf&#233; &#128512; &#x2713; &amp;#65;" bounds="[0,0][1,1]" /></hierarchy>`)[0].text).toBe("café 😀 ✓ &#65;");
  });

  it("escapes non-ASCII text so the gateway passes it through intact", () => {
    const body = asciiJson({ content: "Wi‑Fi café ✓ 日本 😀" });
    expect(body).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(body)).toEqual({ content: "Wi‑Fi café ✓ 日本 😀" });
  });

  it("routes only running, AI-enabled phones with a valid region and IP through the gateway", () => {
    expect([...duoPlusRoutes([
      { id: "a", http_status: 1, region: "SG1", ip: "10.250.81.96" },
      { id: "b", http_status: 0, region: "sg1", ip: "10.0.0.2" },
      { id: "c", http_status: 1, region: "sg1", ip: "" },
      { id: "d", http_status: 1, region: "sg1\r\nx: y", ip: "10.0.0.4" },
    ])]).toEqual([["duoplus:a", { region: "sg1", ip: "10.250.81.96" }]]);
  });

  const gatewayPhone = { id: "a", status: 1, http_status: 1, region: "sg1", ip: "10.0.0.9" };
  const gatewayReply = (inner: Record<string, unknown>, state = "SUCCEEDED") => respond({ state, result_json: JSON.stringify(inner) });

  it("runs shell commands and actions through the AI gateway when the phone supports it", async () => {
    const { calls, fetchImpl } = stub((request) => request.url.endsWith("/list")
      ? respond({ code: 200, data: { list: [gatewayPhone] } })
      : gatewayReply({ success: true, result_text: "Physical size: 1080x1920\n" }));
    const client = createDuoPlusClient({ DUOPLUS_API_KEY: "key" }, fetchImpl, noSleep)!;
    await client.devices();
    await expect(client.run("duoplus:a", ["shell", "wm", "size"])).resolves.toEqual(Buffer.from("Physical size: 1080x1920\n"));
    await client.act("duoplus:a", "INPUT_CONTENT", { content: "café", clear_first: false });
    const [, shell, action] = calls;
    expect(shell.request.url).toBe("https://agent-gateway.duoplus.net/agent-command");
    expect(shell.request.headers.get("authorization")).toBe("Bearer key");
    expect(shell.request.headers.get("region")).toBe("sg1");
    expect(shell.request.headers.get("cloudip")).toBe("10.0.0.9");
    expect(shell.body).toMatchObject({ operation: "submit", action: "execute", payload: { action_name: "SHELL_COMMAND", params: { command: "wm size", need_screenshot: false } } });
    expect(action.body).toMatchObject({ payload: { action_name: "INPUT_CONTENT", params: { content: "café" } } });
    expect(await action.request.clone().text()).toContain("caf\\u00e9");
  });

  it("reports a gateway action that ran and failed instead of repeating it", async () => {
    const { calls, fetchImpl } = stub((request) => request.url.endsWith("/list")
      ? respond({ code: 200, data: { list: [gatewayPhone] } })
      : gatewayReply({ success: false, message: "Click element - Failed" }, "FAILED"));
    const client = createDuoPlusClient({ DUOPLUS_API_KEY: "key" }, fetchImpl, noSleep)!;
    await client.devices();
    await expect(client.act("duoplus:a", "SLIDE_PAGE", { direction: "up" })).rejects.toThrow("Click element - Failed");
    expect(calls).toHaveLength(2);
  });

  it("falls back to the command API and the agent broadcast when the gateway cannot reach the phone", async () => {
    const waits: number[] = [];
    const { calls, fetchImpl } = stub((request) => request.url.endsWith("/list")
      ? respond({ code: 200, data: { list: [gatewayPhone] } })
      : request.url.endsWith("/agent-command")
        ? new Response("Forbidden", { status: 403 })
        : respond({ code: 200, data: { success: true, content: "Broadcast completed: result=0\n" } }));
    const client = createDuoPlusClient({ DUOPLUS_API_KEY: "key" }, fetchImpl, async (ms) => { waits.push(ms); })!;
    await client.devices();
    await client.act("duoplus:a", "SLIDE_PAGE", { direction: "up" });
    expect(calls.map((call) => new URL(call.request.url).pathname)).toEqual(["/api/v1/cloudPhone/list", "/agent-command", "/api/v1/cloudPhone/command"]);
    expect(String(calls[2].body.command)).toMatch(/^am broadcast -a com\.duoplus\.service\.PROCESS_DATA --es message /);
    expect(waits).toContain(1_500);
  });

  it("spaces calls to the same endpoint to respect the one-request-per-second limit", async () => {
    const waits: number[] = [];
    const { fetchImpl } = stub(() => respond({ code: 200, data: { success: true, content: "" } }));
    const client = createDuoPlusClient({ DUOPLUS_API_KEY: "key" }, fetchImpl, async (ms) => { waits.push(ms); })!;
    await Promise.all([client.run("duoplus:a", ["shell", "ls"]), client.run("duoplus:a", ["shell", "ls"])]);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(900);
  });
});
