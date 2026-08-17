const path = require('path');
const { version: appVersion } = require('./package.json');
const { PHASE_DEVELOPMENT_SERVER } = require('next/constants');
const tiptapPmResolveBase = path.dirname(require.resolve('@tiptap/pm/model'));
const resolveFromTiptapPm = (pkg) =>
  require.resolve(pkg, { paths: [tiptapPmResolveBase] });

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion,
  },
  reactStrictMode: false, // Disabled for BlockNote compatibility
  output: 'export',
  images: {
    unoptimized: true,
  },
  // Add basePath configuration
  basePath: '',
  assetPrefix: '/',

  // Add webpack configuration for Tauri
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
      };

      // Keep ProseMirror single-instanced for BlockNote/Tiptap.
      config.resolve.alias = {
        ...config.resolve.alias,
        '@blocknote/core$': require.resolve('@blocknote/core'),
        '@blocknote/react$': require.resolve('@blocknote/react'),
        '@blocknote/shadcn$': require.resolve('@blocknote/shadcn'),
        'prosemirror-model': resolveFromTiptapPm('prosemirror-model'),
        'prosemirror-state': resolveFromTiptapPm('prosemirror-state'),
        'prosemirror-view': resolveFromTiptapPm('prosemirror-view'),
        'prosemirror-transform': resolveFromTiptapPm('prosemirror-transform'),
        'prosemirror-tables': resolveFromTiptapPm('prosemirror-tables'),
        'prosemirror-schema-list': resolveFromTiptapPm('prosemirror-schema-list'),
        'prosemirror-keymap': resolveFromTiptapPm('prosemirror-keymap'),
        'prosemirror-commands': resolveFromTiptapPm('prosemirror-commands'),
        'prosemirror-history': resolveFromTiptapPm('prosemirror-history'),
        'prosemirror-inputrules': resolveFromTiptapPm('prosemirror-inputrules'),
        'prosemirror-gapcursor': resolveFromTiptapPm('prosemirror-gapcursor'),
        'prosemirror-dropcursor': resolveFromTiptapPm('prosemirror-dropcursor'),
      };
    }
    return config;
  },
}

module.exports = (phase) => {
  const isDevelopment = phase === PHASE_DEVELOPMENT_SERVER;

  return {
    ...nextConfig,
    // Static export is a production packaging concern. Keeping it enabled in
    // development prevents Next from applying the no-cache headers below,
    // which lets WKWebView reuse an HTML/webpack pair from different builds.
    output: isDevelopment ? undefined : 'export',
    // Keep development assets separate from production build output. Otherwise
    // running `next build` while Tauri dev is open can replace the live CSS and
    // leave the app rendered without styles until the server is restarted.
    distDir: isDevelopment ? '.next-dev' : '.next',
    ...(isDevelopment ? {
      // Next's development chunks use stable file names. WKWebView must always
      // revalidate them or an old webpack runtime can make every control inert.
      async headers() {
        return [{
          source: '/:path*',
          headers: [{
            key: 'Cache-Control',
            value: 'no-store, no-cache, must-revalidate, max-age=0',
          }],
        }];
      },
    } : {}),
  };
}
