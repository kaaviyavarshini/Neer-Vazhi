/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  env: {
    NEXT_PUBLIC_GOOGLE_MAPS_KEY: process.env.GOOGLE_MAPS_KEY || '',
  },
};

export default nextConfig;
