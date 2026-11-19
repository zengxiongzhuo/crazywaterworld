import {
  type FieldErrors,
  isRecord,
  type LoginSettings,
  parseLoginSettings,
} from "../contracts/login-settings";

declare global {
  interface Window {
    cwConsoleAuth?: {
      check(response: Response): void;
      redirect(): void;
    };
    cwConsoleVersion?: {
      readonly version: string;
      isStale(): boolean;
      observe(version: string | null): void;
      reject(message?: string): void;
    };
  }
}

const consoleVersionBridge = () =>
  typeof window === "undefined" ? undefined : window.cwConsoleVersion;
// Keep the HTML's original version for this module's lifetime. A fresh API
// client or a new response must never authorize writes from an old page.
const pageVersion =
  (typeof document === "undefined"
    ? ""
    : document
        .querySelector('meta[name="cw-console-version"]')
        ?.getAttribute("content")) ||
  consoleVersionBridge()?.version ||
  "";
let pageStale = false;
const versionMessage =
  "控制台已更新，当前页面已过期，请刷新页面后再保存；未保存修改仍保留。";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: FieldErrors = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function createAccountApi(
  accountId: string,
  transport: typeof fetch = fetch,
) {
  if (!accountId) throw new Error("请先选择账号");
  const url = `/api/login-settings?account=${encodeURIComponent(accountId)}`;
  async function request(options: RequestInit) {
    // An account is captured when this client is created. Never fall back to
    // the server's active account or retry a write whose result is unknown.
    const writable = !["GET", "HEAD"].includes(
      (options.method ?? "GET").toUpperCase(),
    );
    if (writable && (pageStale || consoleVersionBridge()?.isStale())) {
      throw new ApiError(versionMessage, 409, { revision: versionMessage });
    }
    const headers = new Headers(options.headers);
    if (pageVersion) headers.set("X-CW-Console-Version", pageVersion);
    const response = await transport(url, {
      credentials: "same-origin",
      ...options,
      headers,
    });
    if (response.status === 401) {
      if (typeof window !== "undefined") window.cwConsoleAuth?.redirect();
      throw new ApiError("登录已失效，请重新输入控制台密码", 401);
    }
    const receivedVersion = response.headers.get("X-CW-Console-Version");
    if (pageVersion && receivedVersion && receivedVersion !== pageVersion) {
      pageStale = true;
    }
    consoleVersionBridge()?.observe(receivedVersion);
    if (pageStale || consoleVersionBridge()?.isStale()) {
      throw new ApiError(versionMessage, 409, { revision: versionMessage });
    }
    const payload: unknown = await response.json();
    const versionRejected =
      isRecord(payload) && payload.code === "CLIENT_VERSION_MISMATCH";
    if (versionRejected) {
      pageStale = true;
      consoleVersionBridge()?.reject(versionMessage);
    }
    if (pageStale || consoleVersionBridge()?.isStale()) {
      throw new ApiError(versionMessage, 409, { revision: versionMessage });
    }
    if (!response.ok) {
      const fields: FieldErrors = {};
      if (isRecord(payload) && isRecord(payload.fields)) {
        for (const [key, value] of Object.entries(payload.fields)) {
          if (typeof value === "string") fields[key] = value;
        }
      }
      throw new ApiError(
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `控制台返回 HTTP ${response.status}`,
        response.status,
        fields,
      );
    }
    return parseLoginSettings(payload);
  }
  return {
    load: (signal: AbortSignal) => request({ signal }),
    save: (settings: LoginSettings, revision: number) =>
      request({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings, revision }),
      }),
  };
}
