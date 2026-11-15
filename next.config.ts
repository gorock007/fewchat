import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output keeps the Docker image small (see Dockerfile).
  output: process.env.NEXT_OUTPUT === "export" ? "export" : "standalone",
  cacheComponents: process.env.NEXT_OUTPUT !== "export",
  partialPrefetching: process.env.NEXT_OUTPUT !== "export",
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
