import type { NextConfig } from "next";
const config: NextConfig = {
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  turbopack: { root: __dirname },
};
export default config;
