/** @type {import('next').NextConfig}
 * Export estático: permite servir el frontend en GitHub Pages, nginx o cualquier CDN.
 * En GitHub Actions, actions/configure-pages inyecta basePath automáticamente.
 * NEXT_PUBLIC_API_URL define el backend (Cloud Run) en build time.
 */
const nextConfig = {
  reactStrictMode: true,
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
