// First-party Android phone MCP server: physical USB devices (no emulators, wireless or network ADB), plus
// DuoPlus cloud phones driven through DuoPlus's AI gateway, or its command API, when DUOPLUS_API_KEY is set.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

type Json = Record<string, unknown>;
type Device = { serial: string; state: string; model: string; connection: "usb" | "network" | "emulator" | "cloud" };
type UiNode = { text: string; description: string; id: string; className: string; bounds: [number, number, number, number] };
type ClaimOutcome = { ok: true } | { ok: false; message: string };

const MAX_ADB_OUTPUT = 16 * 1024 * 1024;
const PHONE_BUSY_TEXT = "Another thread is using the phone. This call was not performed. Pause phone work until that thread finishes, then read the screen again before acting.";
const PACKAGE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;
const COMPONENT = /^([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\/\S+$/;
const SAFE_TEXT = /^[A-Za-z0-9 _.,@-]+$/;
const KEYCODES: Record<string, string> = {
  back: "KEYCODE_BACK",
  delete: "KEYCODE_DEL",
  down: "KEYCODE_DPAD_DOWN",
  enter: "KEYCODE_ENTER",
  escape: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  left: "KEYCODE_DPAD_LEFT",
  recent: "KEYCODE_APP_SWITCH",
  return: "KEYCODE_ENTER",
  right: "KEYCODE_DPAD_RIGHT",
  space: "KEYCODE_SPACE",
  tab: "KEYCODE_TAB",
  up: "KEYCODE_DPAD_UP",
};
const DUOPLUS_API = "https://openapi.duoplus.net";
const DUOPLUS_PREFIX = "duoplus:";
// DuoPlus allows one request per second on each endpoint.
const DUOPLUS_INTERVAL_MS = 1_000;
const DUOPLUS_STATES: Record<number, string> = {
  0: "not configured",
  1: "device",
  2: "powered off",
  3: "expired",
  4: "renewal overdue",
  10: "powering on",
  11: "configuring",
  12: "configuration failed",
};
// DuoPlus's AI gateway reaches the agent service on a running phone and answers once each action has finished.
const DUOPLUS_GATEWAY = "https://agent-gateway.duoplus.net/agent-command";
const DUOPLUS_GATEWAY_TIMEOUT_MS = 60_000;
const GATEWAY_REGION = /^[a-z]{2}\d*$/;
const GATEWAY_IP = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// Seen live: "automation result exceeds Binder V1 limit" for a ~400 KB home-screen screenshot.
const GATEWAY_TOO_LARGE = /exceeds Binder/i;
// Without the gateway, the same agent service on every cloud phone takes Base64 JSON actions over this broadcast. Base64 is shell-safe.
const DUOPLUS_AGENT_BROADCAST = "com.duoplus.service.PROCESS_DATA";
// Agent actions run after the broadcast returns; wait so the next read or tap sees their effect.
const DUOPLUS_AGENT_SETTLE_MS = 1_500;
// Any visible text, one line: the agent service types Unicode, unlike `input text`.
const CLOUD_TEXT = /^[^\p{Cc}]+$/u;
const KNOWN_PACKAGES: Record<string, string> = {
  skyscanner: "net.skyscanner.android.main",
  uber: "com.ubercab",
};

function executableName(platform = process.platform) {
  return platform === "win32" ? "adb.exe" : "adb";
}

export function resolveAdbPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const executable = executableName(platform);
  const home = homedir();
  const candidates = [
    env.OMB_ADB_PATH,
    env.OMB_RESOURCES_PATH && join(env.OMB_RESOURCES_PATH, "android-platform-tools", platform, executable),
    ...(env.PATH ?? "").split(delimiter).map((entry) => entry && join(entry, executable)),
    platform === "darwin" && join(home, "Library/Android/sdk/platform-tools/adb"),
    platform === "darwin" && "/opt/homebrew/bin/adb",
    platform === "darwin" && "/usr/local/bin/adb",
    platform === "linux" && join(home, "Android/Sdk/platform-tools/adb"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function runAdb(args: string[], options: { binary?: boolean; timeoutMs?: number } = {}): Promise<Buffer> {
  const adb = resolveAdbPath();
  if (!adb) throw new Error("Android platform tools are unavailable. Reopen OpenMausBot or install adb.");
  return new Promise((resolve, reject) => {
    const child = spawn(adb, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The Android device command timed out"));
    }, options.timeoutMs ?? 12_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ADB_OUTPUT) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (size > MAX_ADB_OUTPUT) return reject(new Error("The Android device returned too much data"));
      if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `adb exited ${code}`));
      resolve(Buffer.concat(stdout));
    });
  });
}

export function parseDevices(output: string): Device[] {
  const devices: Device[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices attached") || line.startsWith("* daemon")) continue;
    const [serial, state, ...fields] = line.split(/\s+/);
    if (!serial || !state) continue;
    const connection = serial.startsWith("emulator-")
      ? "emulator"
      : serial.includes(":") || serial.startsWith("adb-")
        ? "network"
        : "usb";
    const properties = Object.fromEntries(fields.flatMap((field) => {
      const split = field.indexOf(":");
      return split > 0 ? [[field.slice(0, split), field.slice(split + 1)]] : [];
    }));
    devices.push({
      serial,
      state,
      connection,
      model: String(properties.model ?? properties.product ?? "Android device").replaceAll("_", " "),
    });
  }
  return devices;
}

type DuoPlusPhone = { id?: unknown; name?: unknown; status?: unknown; os?: unknown; ip?: unknown; region?: unknown; http_status?: unknown };
type GatewayRoute = { region: string; ip: string };

/** Phones DuoPlus's AI gateway can reach: running, AI access on, with a private IP and a gateway region. */
export function duoPlusRoutes(list: unknown): Map<string, GatewayRoute> {
  const routes = new Map<string, GatewayRoute>();
  if (!Array.isArray(list)) return routes;
  for (const phone of list as DuoPlusPhone[]) {
    const region = typeof phone?.region === "string" ? phone.region.trim().toLowerCase() : "";
    const ip = typeof phone?.ip === "string" ? phone.ip.trim() : "";
    if (typeof phone?.id !== "string" || !phone.id || Number(phone.http_status) !== 1) continue;
    if (GATEWAY_REGION.test(region) && GATEWAY_IP.test(ip)) routes.set(`${DUOPLUS_PREFIX}${phone.id}`, { region, ip });
  }
  return routes;
}

/** JSON with every non-ASCII character escaped as \\uXXXX (emoji as surrogate pairs). */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The gateway could not reach the phone, so nothing ran there and the command API can take over safely. */
class GatewayUnavailable extends Error {}

export function parseDuoPlusPhones(list: unknown): Device[] {
  if (!Array.isArray(list)) return [];
  return (list as DuoPlusPhone[]).flatMap((phone) => {
    if (typeof phone?.id !== "string" || !phone.id) return [];
    const status = Number(phone.status);
    const label = [phone.name, phone.os].filter((part) => typeof part === "string" && part).join(", ");
    return [{
      serial: `${DUOPLUS_PREFIX}${phone.id}`,
      state: DUOPLUS_STATES[status] ?? `status ${String(phone.status)}`,
      connection: "cloud" as const,
      model: label ? `DuoPlus cloud phone (${label})` : "DuoPlus cloud phone",
    }];
  });
}

/** Maps the adb arguments this proxy uses onto one DuoPlus shell command. `adb shell a b` joins with spaces too. */
export function duoPlusCommand(args: string[]): { command: string; base64: boolean } {
  if (args[0] === "shell" && args.length > 1) return { command: args.slice(1).join(" "), base64: false };
  if (args[0] === "exec-out" && args[1] === "screencap") return { command: "screencap -p | base64", base64: true };
  throw new Error(`DuoPlus cloud phones do not support adb ${args[0] ?? ""}`);
}

/** One DuoPlus agent action as a shell command; the service acts on it without replying. */
export function duoPlusAgentCommand(actionName: string, params: Json, taskId = `mausbot-${Date.now()}`): string {
  const payload = { task_type: "ai", action: "execute", task_id: taskId, md5: "mausbot", action_name: actionName, params };
  return `am broadcast -a ${DUOPLUS_AGENT_BROADCAST} --es message ${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`;
}

export function createDuoPlusClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const key = env.DUOPLUS_API_KEY?.trim();
  if (!key) return null;
  const base = env.DUOPLUS_API_URL?.trim() || DUOPLUS_API;
  const gatewayUrl = env.DUOPLUS_GATEWAY_URL?.trim() || DUOPLUS_GATEWAY;
  const routes = new Map<string, GatewayRoute>();
  const lastCall = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();

  async function request(path: string, body: Json): Promise<unknown> {
    const wait = (lastCall.get(path) ?? 0) + DUOPLUS_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(path, Date.now());
    const response = await fetchImpl(new URL(path, base), {
      method: "POST",
      redirect: "error",
      headers: { "DuoPlus-API-Key": key!, "content-type": "application/json", lang: "en" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => null) as { code?: unknown; message?: unknown; data?: unknown } | null;
    if (!response.ok || payload?.code !== 200) {
      const reason = typeof payload?.message === "string" && payload.message ? payload.message : `HTTP ${response.status}`;
      throw new Error(`DuoPlus refused the request: ${reason}`);
    }
    return payload.data;
  }
  // One request at a time keeps every endpoint under its rate limit.
  const call = (path: string, body: Json) => {
    const run = queue.then(() => request(path, body));
    queue = run.catch(() => undefined);
    return run;
  };

  async function platformCommand(serial: string, command: string): Promise<string> {
    const data = await call("/api/v1/cloudPhone/command", { image_id: serial.slice(DUOPLUS_PREFIX.length), command }) as
      { success?: unknown; content?: unknown; message?: unknown } | null;
    if (data?.success !== true) {
      throw new Error(typeof data?.message === "string" && data.message ? data.message : "The DuoPlus cloud phone did not run the command");
    }
    return typeof data.content === "string" ? data.content : "";
  }

  // Runs one agent action and waits for it to finish. Not rate limited like the control API.
  async function gateway(serial: string, actionName: string, params: Json): Promise<string> {
    const route = routes.get(serial);
    if (!route) throw new GatewayUnavailable("The phone has no AI gateway route");
    const taskId = `mausbot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let response: Response;
    try {
      response = await fetchImpl(gatewayUrl, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${key!}`, region: route.region, cloudip: route.ip, "content-type": "application/json" },
        // The gateway garbles raw UTF-8 in request bodies; JSON escapes reach the phone intact.
        body: asciiJson({
          operation: "submit",
          command_id: `${taskId}-command`,
          task_id: taskId,
          action: "execute",
          payload: { task_type: "ai", task_id: taskId, action: "execute", lang: "en", action_name: actionName, params },
        }),
        signal: AbortSignal.timeout(DUOPLUS_GATEWAY_TIMEOUT_MS),
      });
    } catch (error) {
      // After a timeout the action may still have run: never repeat it through the command API.
      if (error instanceof Error && error.name === "TimeoutError") throw new Error("The DuoPlus cloud phone did not answer in time");
      throw new GatewayUnavailable(error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) throw new GatewayUnavailable(`HTTP ${response.status}`);
    const outer = await response.json().catch(() => null) as { state?: unknown; message?: unknown; result_json?: unknown } | null;
    let inner: { success?: unknown; message?: unknown; result_text?: unknown } | null = null;
    try {
      inner = JSON.parse(String(outer?.result_json));
    } catch {
      inner = null;
    }
    if (outer?.state !== "SUCCEEDED" || inner?.success !== true) {
      const reason = [inner?.message, outer?.message].find((value) => typeof value === "string" && value);
      throw new Error(typeof reason === "string" ? reason : "The DuoPlus cloud phone could not do that");
    }
    return typeof inner.result_text === "string" ? inner.result_text : "";
  }

  return {
    async devices(): Promise<Device[]> {
      const data = await call("/api/v1/cloudPhone/list", { page: 1, pagesize: 100 }) as { list?: unknown } | null;
      routes.clear();
      for (const [serial, route] of duoPlusRoutes(data?.list)) routes.set(serial, route);
      return parseDuoPlusPhones(data?.list);
    },
    async run(serial: string, args: string[]): Promise<Buffer> {
      const { command, base64 } = duoPlusCommand(args);
      let content: string;
      try {
        content = await gateway(serial, "SHELL_COMMAND", { command, need_screenshot: false });
      } catch (error) {
        // The gateway can't return large output (a wallpapered screenshot); the commands that produce it only read.
        if (!(error instanceof GatewayUnavailable) && !(error instanceof Error && GATEWAY_TOO_LARGE.test(error.message))) throw error;
        content = await platformCommand(serial, command);
      }
      return base64 ? Buffer.from(content.replace(/\s+/g, ""), "base64") : Buffer.from(content, "utf8");
    },
    async act(serial: string, actionName: string, params: Json): Promise<void> {
      try {
        await gateway(serial, actionName, params);
        return;
      } catch (error) {
        if (!(error instanceof GatewayUnavailable)) throw error;
      }
      const output = await platformCommand(serial, duoPlusAgentCommand(actionName, params));
      if (!output.includes("Broadcast completed")) throw new Error("The DuoPlus cloud phone did not accept the action");
      await sleep(DUOPLUS_AGENT_SETTLE_MS);
    },
  };
}

const duoPlus = createDuoPlusClient();

async function usbDevices() {
  if (!resolveAdbPath()) return [];
  return parseDevices((await runAdb(["devices", "-l"])).toString("utf8")).filter((device) => device.connection === "usb");
}

async function phoneDevices() {
  return [...await usbDevices(), ...(duoPlus ? await duoPlus.devices() : [])];
}

async function readySerial(requested?: unknown): Promise<string> {
  const devices = await phoneDevices();
  const serial = typeof requested === "string" && requested ? requested : process.env.PH_ANDROID_SERIAL;
  const candidates = serial ? devices.filter((device) => device.serial === serial) : devices;
  if (!candidates.length) throw new Error(duoPlus ? "No USB Android device or DuoPlus cloud phone is available" : "No physical USB Android device is connected");
  if (candidates.length > 1 && !serial) throw new Error("Multiple Android devices are available; pass serial");
  const device = candidates[0];
  if (device.state === "unauthorized") throw new Error("Unlock the phone and accept Allow USB debugging");
  if (device.connection === "cloud" && device.state !== "device") {
    throw new Error(`The DuoPlus cloud phone is ${device.state}. Start it in DuoPlus, then try again.`);
  }
  if (device.state !== "device") throw new Error(`The Android device is ${device.state}`);
  return device.serial;
}

async function onDevice(serial: string, args: string[], binary = false) {
  if (duoPlus && serial.startsWith(DUOPLUS_PREFIX)) return duoPlus.run(serial, args);
  return runAdb(["-s", serial, ...args], { binary });
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseLaunchablePackages(output: string): string[] {
  const packages: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = COMPONENT.exec(raw.trim());
    if (match && !packages.includes(match[1])) packages.push(match[1]);
  }
  return packages;
}

export function findPackages(name: string, packages: string[]) {
  if (PACKAGE.test(name) && packages.includes(name)) return [name];
  const needle = normalize(name);
  const known = KNOWN_PACKAGES[needle];
  if (known && packages.includes(known)) return [known];
  if (needle.length < 4) return [];
  const ranked = [
    (token: string) => token === needle,
    (token: string) => token.startsWith(needle),
    (token: string) => token.includes(needle),
  ];
  for (const matches of ranked) {
    const found = packages.filter((pkg) => pkg.split(".").some((token) => matches(normalize(token))));
    if (found.length) return found;
  }
  return [];
}

async function launchablePackages(serial: string) {
  const output = await onDevice(serial, [
    "shell", "cmd", "package", "query-activities", "--brief",
    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER",
  ]);
  return parseLaunchablePackages(output.toString("utf8"));
}

function decodeXml(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    // uiautomator writes emoji and other astral characters as numeric references.
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, code: string) => {
      const point = code[0].toLowerCase() === "x" ? Number.parseInt(code.slice(1), 16) : Number(code);
      return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replaceAll("&amp;", "&");
}

export function parseUiNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const match of xml.matchAll(/<node\s+([^>]+?)\/?\s*>/g)) {
    const attributes: Record<string, string> = {};
    for (const attribute of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attributes[attribute[1]] = decodeXml(attribute[2]);
    }
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attributes.bounds ?? "");
    if (!bounds) continue;
    const text = attributes.text ?? "";
    const description = attributes["content-desc"] ?? "";
    if (!text && !description && !attributes["resource-id"]) continue;
    nodes.push({
      text,
      description,
      id: attributes["resource-id"] ?? "",
      className: attributes.class ?? "",
      bounds: [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])],
    });
  }
  return nodes;
}

async function readNodes(serial: string) {
  if (serial.startsWith(DUOPLUS_PREFIX)) {
    // One round trip: each DuoPlus call costs seconds, and `dump /dev/tty` prints no XML there.
    // Base64 keeps non-ASCII labels intact; the gateway garbles raw UTF-8 output.
    const remotePath = "/data/local/tmp/openmaus-window.xml";
    const encoded = (await onDevice(serial, ["shell", `uiautomator dump ${remotePath} >/dev/null && base64 ${remotePath}; rm -f ${remotePath}`])).toString("utf8");
    const dumped = Buffer.from(encoded.replace(/\s+/g, ""), "base64").toString("utf8");
    const start = dumped.indexOf("<?xml");
    return parseUiNodes(start >= 0 ? dumped.slice(start) : dumped);
  }
  const streamed = (await onDevice(serial, ["shell", "uiautomator", "dump", "/dev/tty"])).toString("utf8");
  const streamedStart = streamed.indexOf("<?xml");
  if (streamedStart >= 0) return parseUiNodes(streamed.slice(streamedStart));

  const remotePath = "/data/local/tmp/openmaus-window.xml";
  await onDevice(serial, ["shell", "uiautomator", "dump", remotePath]);
  const saved = (await onDevice(serial, ["shell", "cat", remotePath])).toString("utf8");
  void onDevice(serial, ["shell", "rm", "-f", remotePath]).catch(() => undefined);
  const savedStart = saved.indexOf("<?xml");
  return parseUiNodes(savedStart >= 0 ? saved.slice(savedStart) : saved);
}

function nodeLines(nodes: UiNode[]) {
  return nodes.slice(0, 250).map((node, index) => {
    const label = [node.text, node.description].filter(Boolean).join(" · ");
    return `${index}: ${JSON.stringify(label || node.id)} bounds=${node.bounds.join(",")} class=${node.className}`;
  }).join("\n") || "No accessible Android UI text is visible.";
}

const TOOLS = [
  { name: "status", description: "Check physical USB Android devices, USB-debugging authorization, and DuoPlus cloud phones before any Android phone task.", inputSchema: { type: "object", properties: {} } },
  { name: "read_screen", description: "Read visible text, accessibility labels, resource ids, and pixel bounds from the connected Android screen. Use after every action to verify the result.", inputSchema: { type: "object", properties: { serial: { type: "string" } } } },
  { name: "screenshot", description: "Capture the connected Android screen when accessibility text is insufficient. Returns a PNG image.", inputSchema: { type: "object", properties: { serial: { type: "string" } } } },
  { name: "list_apps", description: "List installed launchable Android package names, optionally filtered by a human app name. Prefer open_app first.", inputSchema: { type: "object", properties: { query: { type: "string" }, serial: { type: "string" } } } },
  { name: "open_app", description: "Open an installed Android app directly by its human name, such as Uber or Skyscanner. Do not scan the app drawer first.", inputSchema: { type: "object", properties: { name: { type: "string" }, serial: { type: "string" } }, required: ["name"] } },
  { name: "tap_text", description: "Tap visible Android text or an accessibility label, then use read_screen to verify.", inputSchema: { type: "object", properties: { text: { type: "string" }, exact: { type: "boolean" }, index: { type: "integer", minimum: 0 }, serial: { type: "string" } }, required: ["text"] } },
  { name: "tap", description: "Tap Android screen pixel coordinates obtained from read_screen or screenshot.", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, serial: { type: "string" } }, required: ["x", "y"] } },
  { name: "swipe", description: "Swipe the Android screen in a direction, then use read_screen to verify.", inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, serial: { type: "string" } }, required: ["direction"] } },
  { name: "type_text", description: "Type basic ASCII text into the focused Android field (any one-line text, including accents and emoji, on DuoPlus cloud phones). Never enter passwords or payment details. A one-time code only for a sign-in the person asked for, into the app it was sent for.", inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 256 }, serial: { type: "string" } }, required: ["text"] } },
  { name: "press", description: "Press an Android navigation or keyboard key.", inputSchema: { type: "object", properties: { key: { type: "string", enum: Object.keys(KEYCODES) }, serial: { type: "string" } }, required: ["key"] } },
] as const;

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };
const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

// The harness reserves the phone per turn from the first real tool call. Retained MCP processes can
// outlive their turn, so every call revalidates the claim.
export function createPhoneClaim(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): () => Promise<ClaimOutcome> {
  const url = env.OMB_HARNESS_URL?.trim();
  const token = env.OMB_PHONE_TOKEN?.trim();
  if (!url || !token) {
    return async () => ({ ok: true });
  }
  return async () => {
    try {
      const response = await fetchImpl(new URL("/api/internal/phone/claim", url), {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true };
      if (response.status === 409) return { ok: false, message: PHONE_BUSY_TEXT };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: "This turn no longer has phone access. Start a new turn to use the phone." };
      }
      return { ok: false, message: "OpenMausBot could not reserve the phone for this call. This call was not performed; try again, or start a new turn if it keeps failing." };
    } catch {
      return { ok: false, message: "OpenMausBot could not be reached to reserve the phone. This call was not performed; try again." };
    }
  };
}

async function callTool(name: string, args: Json): Promise<ToolResult> {
  if (name === "status") {
    const adb = resolveAdbPath();
    const devices = adb ? await usbDevices() : [];
    let cloudError: string | undefined;
    if (duoPlus) {
      try {
        devices.push(...await duoPlus.devices());
      } catch (error) {
        cloudError = error instanceof Error ? error.message : String(error);
      }
    }
    return textResult(JSON.stringify({ available: Boolean(adb || duoPlus), devices, ...(cloudError ? { cloudError } : {}) }, null, 2));
  }
  const serial = await readySerial(args.serial);
  const cloud = Boolean(duoPlus) && serial.startsWith(DUOPLUS_PREFIX);
  if (name === "read_screen") return textResult(nodeLines(await readNodes(serial)));
  if (name === "screenshot") {
    const png = await onDevice(serial, ["exec-out", "screencap", "-p"], true);
    if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("Android returned an invalid screenshot");
    return { content: [{ type: "text", text: `Android screenshot from ${serial}` }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
  }
  if (name === "list_apps") {
    const packages = await launchablePackages(serial);
    const query = typeof args.query === "string" ? args.query : "";
    return textResult((query ? findPackages(query, packages) : packages).join("\n") || "No matching launchable app found");
  }
  if (name === "open_app") {
    const appName = String(args.name ?? "").trim();
    if (!appName) throw new Error("name is required");
    const matches = findPackages(appName, await launchablePackages(serial));
    if (matches.length !== 1) throw new Error(matches.length ? `App name is ambiguous: ${matches.join(", ")}` : `No installed launchable app matches ${JSON.stringify(appName)}`);
    await onDevice(serial, ["shell", "monkey", "-p", matches[0], "-c", "android.intent.category.LAUNCHER", "1"]);
    return textResult(`Opened ${appName} (${matches[0]})`);
  }
  if (name === "tap_text") {
    const query = String(args.text ?? "").trim().toLowerCase();
    if (!query) throw new Error("text is required");
    const exact = args.exact === true;
    const hits = (await readNodes(serial)).filter((node) => {
      const labels = [node.text, node.description].filter(Boolean).map((value) => value.toLowerCase());
      return labels.some((label) => exact ? label === query : label.includes(query));
    });
    const index = Number.isInteger(args.index) ? Number(args.index) : 0;
    const hit = hits[index];
    if (!hit) throw new Error(`No visible Android text matches ${JSON.stringify(args.text)}`);
    const [x1, y1, x2, y2] = hit.bounds;
    await onDevice(serial, ["shell", "input", "tap", String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2))]);
    return textResult(`Tapped ${JSON.stringify(hit.text || hit.description)}`);
  }
  if (name === "tap") {
    const x = Number(args.x); const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) throw new Error("Invalid Android coordinates");
    await onDevice(serial, ["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
    return textResult(`Tapped ${Math.round(x)},${Math.round(y)}`);
  }
  if (name === "swipe") {
    const direction = String(args.direction ?? "");
    if (cloud) {
      if (!["up", "down", "left", "right"].includes(direction)) throw new Error("Invalid swipe direction");
      await duoPlus!.act(serial, "SLIDE_PAGE", { direction });
      return textResult(`Swiped ${direction}`);
    }
    const size = (await onDevice(serial, ["shell", "wm", "size"])).toString("utf8");
    const match = /(\d+)x(\d+)/.exec(size);
    if (!match) throw new Error("Could not read Android screen size");
    const width = Number(match[1]); const height = Number(match[2]);
    const points: Record<string, [number, number, number, number]> = {
      up: [width / 2, height * 0.75, width / 2, height * 0.25],
      down: [width / 2, height * 0.25, width / 2, height * 0.75],
      left: [width * 0.75, height / 2, width * 0.25, height / 2],
      right: [width * 0.25, height / 2, width * 0.75, height / 2],
    };
    const point = points[direction];
    if (!point) throw new Error("Invalid swipe direction");
    await onDevice(serial, ["shell", "input", "swipe", ...point.map((value) => String(Math.round(value))), "260"]);
    return textResult(`Swiped ${direction}`);
  }
  if (name === "type_text") {
    const value = String(args.text ?? "");
    if (cloud) {
      if (!value || value.length > 256 || !CLOUD_TEXT.test(value)) throw new Error("Android text must be one line of up to 256 characters");
      await duoPlus!.act(serial, "INPUT_CONTENT", { content: value, clear_first: false });
      return textResult("Typed text into the focused Android field");
    }
    if (!value || value.length > 256 || !SAFE_TEXT.test(value)) throw new Error("Android text supports only basic ASCII text up to 256 characters");
    await onDevice(serial, ["shell", "input", "text", value.replaceAll(" ", "%s")]);
    return textResult("Typed text into the focused Android field");
  }
  if (name === "press") {
    const key = String(args.key ?? "").toLowerCase();
    if (!KEYCODES[key]) throw new Error("Unsupported Android key");
    await onDevice(serial, ["shell", "input", "keyevent", KEYCODES[key]]);
    return textResult(`Pressed ${key}`);
  }
  throw new Error(`Unknown phone tool: ${name}`);
}

const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(message: Json, ensureClaim: () => Promise<ClaimOutcome>) {
  const id = message.id;
  const method = message.method;
  const params = (message.params ?? {}) as Json;
  if (method === "initialize") return ok(id, { protocolVersion: String(params.protocolVersion ?? "2024-11-05"), capabilities: { tools: {} }, serverInfo: { name: "openmausbot-phone", version: "1" } });
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = String(params.name ?? "");
    if (!TOOLS.some((tool) => tool.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const claim = await ensureClaim();
    if (!claim.ok) return ok(id, textResult(claim.message, true));
    try {
      return ok(id, await callTool(name, (params.arguments ?? {}) as Json));
    } catch (error) {
      return ok(id, textResult(error instanceof Error ? error.message : String(error), true));
    }
  }
  if (id !== undefined) rpcError(id, -32601, `Method not found: ${String(method)}`);
}

if (process.argv[1] && existsSync(process.argv[1]) && /phone-proxy\.(?:ts|js)$/.test(process.argv[1])) {
  const ensureClaim = createPhoneClaim();
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line) as Json;
      void handle(message, ensureClaim).catch((error) => rpcError(message.id, -32603, error instanceof Error ? error.message : String(error)));
    } catch {}
  });
}
