import './globals.css';

export const metadata = {
  title: 'OMR + Pallikaranai — 3D Flood Visualiser',
  description: 'Google Photorealistic 3D + Time-Stepping Water Model for OMR & Pallikaranai Marshland, Chennai',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&family=Oswald:wght@600;700&display=swap"
          rel="stylesheet"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/cesium@1.117.0/Build/Cesium/Widgets/widgets.css"
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.CESIUM_BASE_URL = 'https://cdn.jsdelivr.net/npm/cesium@1.117.0/Build/Cesium/';`,
          }}
        />
        <script src="https://cdn.jsdelivr.net/npm/cesium@1.117.0/Build/Cesium/Cesium.js" />
      </head>
      <body>{children}</body>
    </html>
  );
}
