/** @type {import('next').NextConfig} */

// Static export for GitHub Pages (A4), gated so `next dev` / a normal `next
// build` stay a full Next server. `NEXT_OUTPUT=export` turns on the static
// export; `NEXT_PUBLIC_BASE_PATH` (e.g. `/FocusEngine`) scopes the site under
// the repo subpath. Images are unoptimized because a static export has no image
// optimizer. All runtime fetch/WS URLs already flow through
// NEXT_PUBLIC_API_BASE_URL, so the export needs no rewrites/proxy.
const isExport = process.env.NEXT_OUTPUT === "export";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig = {
  reactStrictMode: true,
  // packages/schemas ships raw .ts with no build step (ARCHITECTURE.md §2) —
  // Next must transpile it itself rather than expect compiled JS in node_modules.
  transpilePackages: ["@focusengine/schemas"],

  ...(isExport ? { output: "export" } : {}),
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  images: { unoptimized: true },
  // Trailing slashes make the exported `out/` directory-per-route layout serve
  // cleanly from GitHub Pages' static host.
  ...(isExport ? { trailingSlash: true } : {}),
};

export default nextConfig;
