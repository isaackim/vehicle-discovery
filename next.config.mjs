/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["@langchain/langgraph", "@langchain/core", "@langchain/anthropic"],
  },
};

export default nextConfig;
