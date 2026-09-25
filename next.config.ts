import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: Next gates HMR + dev assets on the request origin. The box is
  // reached over the LAN and the wg0 VPN as well as localhost, so allow those.
  allowedDevOrigins: ["10.8.0.3", "192.168.5.19"],
  output: "standalone",
  // Native server-only deps that must NOT be bundled by Turbopack:
  // - pg: native postgres bindings
  // - patchright(-core): ships .ttf/.html assets and dynamic requires that
  //   Turbopack can't statically trace; pulled in transitively via
  //   scraper/cf-shared.ts.
  serverExternalPackages: ["pg", "patchright", "patchright-core"],
};

export default nextConfig;
