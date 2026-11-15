import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard is a static export served by the Worker (docs/adr/0002).
  output: "export",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
