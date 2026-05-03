import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Native server-only deps that must NOT be bundled by Turbopack:
  // - pg: native postgres bindings
  // - patchright(-core): ships .ttf/.html assets and dynamic requires that
  //   Turbopack can't statically trace; pulled in transitively via
  //   scraper/cf-shared.ts.
  serverExternalPackages: ["pg", "patchright", "patchright-core"],
};

export default nextConfig;
