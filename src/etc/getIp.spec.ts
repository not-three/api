import { getIp } from "./getIp";
import { HttpException } from "@nestjs/common";

const makeReq = (ip: string, headers: Record<string, string> = {}) =>
  ({ ip, headers }) as any;

describe("getIp", () => {
  const vars = [
    "BEHIND_PROXY",
    "TRUSTED_PROXIES",
    "TRUSTED_PROXIES_CACHE",
    "PROXY_IP_HEADER",
    "IP_HEADER",
    "STRIP_IPV6_ADDRESS",
  ];
  beforeEach(() => {
    // Bypass the module-global trust-list cache between tests.
    process.env.TRUSTED_PROXIES_CACHE = "0";
  });
  afterEach(() => vars.forEach((v) => delete process.env[v]));

  it("returns the request ip when not behind a proxy", async () => {
    expect(await getIp(makeReq("1.2.3.4"))).toBe("1.2.3.4");
  });

  it("ignores forwarded headers when not behind a proxy", async () => {
    expect(
      await getIp(makeReq("1.2.3.4", { "x-forwarded-for": "9.9.9.9" })),
    ).toBe("1.2.3.4");
  });

  it("uses the forwarded header behind a trusted proxy", async () => {
    process.env.BEHIND_PROXY = "true";
    expect(
      await getIp(
        makeReq("1.2.3.4", { "x-forwarded-for": "9.9.9.9, 8.8.8.8" }),
      ),
    ).toBe("9.9.9.9");
  });

  it("ignores the forwarded header from an untrusted proxy", async () => {
    process.env.BEHIND_PROXY = "true";
    process.env.TRUSTED_PROXIES = "10.0.0.0/8";
    expect(
      await getIp(makeReq("1.2.3.4", { "x-forwarded-for": "9.9.9.9" })),
    ).toBe("1.2.3.4");
  });

  it("reads the proxy address from PROXY_IP_HEADER when configured", async () => {
    process.env.BEHIND_PROXY = "true";
    process.env.TRUSTED_PROXIES = "10.0.0.0/8";
    process.env.PROXY_IP_HEADER = "X-Real-Proxy";
    expect(
      await getIp(
        makeReq("1.2.3.4", {
          "x-real-proxy": "10.1.1.1",
          "x-forwarded-for": "9.9.9.9",
        }),
      ),
    ).toBe("9.9.9.9");
  });

  it("strips the configured amount of bytes from ipv6 addresses", async () => {
    expect(await getIp(makeReq("2001:db8:1:2:3:4:5:6"))).toBe("2001:db8:1:2::");
  });

  it("keeps full ipv6 addresses when stripping is disabled", async () => {
    process.env.STRIP_IPV6_ADDRESS = "0";
    expect(await getIp(makeReq("2001:db8:1:2:3:4:5:6"))).toBe(
      "2001:db8:1:2:3:4:5:6",
    );
  });

  it("throws 511 for an invalid ip", async () => {
    await expect(getIp(makeReq("not-an-ip"))).rejects.toThrow(HttpException);
  });

  it("caches the resolved ip on the request object", async () => {
    const req = makeReq("1.2.3.4");
    await getIp(req);
    process.env.BEHIND_PROXY = "true";
    req.headers["x-forwarded-for"] = "9.9.9.9";
    expect(await getIp(req)).toBe("1.2.3.4");
  });
});
