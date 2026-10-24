import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Parallel local builds (e.g. two agents) each use their own output folder.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  // The shared contract is TypeScript source in this repository.
  transpilePackages: ["@murmur/account-api"],
};

export default config;
