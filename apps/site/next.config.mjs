/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true
  },
  devIndicators: false,
  poweredByHeader: false
};

export default nextConfig;
