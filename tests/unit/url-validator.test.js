import { describe, it, expect } from "vitest";
import { normalizeVideoUrl, isPrivateAddress, assertPublicHost, resolveRedirects } from "../../server/src/services/url/UrlValidator.js";

const allowedHosts = ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com", "fb.watch"];
const norm = (u) => normalizeVideoUrl(u, { allowedHosts });
const code = (u) => { try { norm(u); return "OK"; } catch (e) { return e.code; } };

describe("normalizeVideoUrl", () => {
  it("normalises the supported Facebook URL shapes", () => {
    expect(norm("https://www.facebook.com/reel/1234567890123456?mibextid=abc&s=1").normalizedUrl).toBe("https://www.facebook.com/reel/1234567890123456");
    expect(norm("https://m.facebook.com/watch/?v=987654321012&ref=sharing").normalizedUrl).toBe("https://www.facebook.com/watch/?v=987654321012");
    expect(norm("facebook.com/watch?v=987654321012").normalizedUrl).toBe("https://www.facebook.com/watch/?v=987654321012");
    expect(norm("https://www.facebook.com/video.php?v=555555555555").normalizedUrl).toBe("https://www.facebook.com/watch/?v=555555555555");
    expect(norm("https://web.facebook.com/SomePage/videos/a-nice-slug/112233445566/").normalizedUrl).toBe("https://www.facebook.com/SomePage/videos/112233445566");
    expect(norm("https://www.facebook.com/share/r/1AbC2dEf3/").normalizedUrl).toBe("https://www.facebook.com/share/r/1AbC2dEf3/");
    expect(norm("https://fb.watch/abcDEF123/?x=1").normalizedUrl).toBe("https://fb.watch/abcDEF123/");
  });

  it("extracts the numeric video id when present", () => {
    expect(norm("https://www.facebook.com/reel/1234567890123456").externalId).toBe("1234567890123456");
    expect(norm("https://fb.watch/abc/").externalId).toBeNull();
  });

  it("treats equivalent URLs as the same video (duplicate detection relies on this)", () => {
    const a = norm("https://m.facebook.com/watch?v=987654321012&fbclid=X").normalizedUrl;
    const b = norm("http://www.facebook.com/watch/?v=987654321012#comments").normalizedUrl;
    expect(a).toBe(b);
  });

  it("rejects malformed, unsupported and unsafe URLs with stable codes", () => {
    expect(code("")).toBe("EMPTY");
    expect(code("not a url")).toBe("MALFORMED");
    expect(code("ftp://www.facebook.com/reel/1234567890")).toBe("SCHEME");
    expect(code("https://user:pw@www.facebook.com/reel/1234567890")).toBe("CREDENTIALS");
    expect(code("https://www.facebook.com:8443/reel/1234567890")).toBe("PORT");
    expect(code("https://127.0.0.1/reel/1234567890")).toBe("IP_HOST");
    expect(code("https://www.youtube.com/watch?v=abc")).toBe("HOST_NOT_ALLOWED");
    expect(code("https://evilfacebook.com/reel/1234567890")).toBe("HOST_NOT_ALLOWED");
    expect(code("https://www.facebook.com/somepage/posts/12345")).toBe("UNSUPPORTED_FORMAT");
    expect(code("https://www.facebook.com/reel/notanumber")).toBe("UNSUPPORTED_FORMAT");
  });
});

describe("SSRF protection", () => {
  it("identifies private and internal addresses", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.1.1", "::1", "fd00::1", "::ffff:10.0.0.1"])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["157.240.1.35", "31.13.71.36", "2a03:2880:f12f:83:face:b00c:0:25de"])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses hosts that resolve to private addresses", async () => {
    const lookup = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(assertPublicHost("fb.watch", lookup)).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it("validates every redirect hop against the allowlist", async () => {
    const lookup = async () => [{ address: "157.240.1.35", family: 4 }];
    const hops = { "https://fb.watch/abc/": "https://www.facebook.com/reel/1234567890123", "https://www.facebook.com/reel/1234567890123": null };
    const fetchImpl = async (url) => ({ status: hops[url] ? 302 : 200, headers: new Map([["location", hops[url]]]) });
    expect(await resolveRedirects("https://fb.watch/abc/", { allowedHosts, fetchImpl, lookup })).toBe("https://www.facebook.com/reel/1234567890123");

    const evil = async () => ({ status: 302, headers: new Map([["location", "https://metadata.internal/latest"]]) });
    await expect(resolveRedirects("https://fb.watch/abc/", { allowedHosts, fetchImpl: evil, lookup })).rejects.toMatchObject({ code: "REDIRECT_HOST" });
  });
});
