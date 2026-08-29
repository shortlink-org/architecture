/** @type {import('@eventcatalog/core/bin/eventcatalog.config').Config} */
export default {
  title: 'shortlink-org',
  tagline:
    'This internal platform provides a comprehensive view of our event-driven architecture across all systems. Use this portal to discover existing domains, explore services and their dependencies, and understand the message contracts that connect our infrastructure',
  organizationName: 'shortlink-org',
  theme: 'sunset',
  homepageLink: 'https://github.com/shortlink-org',
  editUrl: 'https://github.com/shortlink-org/architecture/edit/main',
  // Supports static or server. Static renders a static site, server renders a server side rendered site
  // large catalogs may benefit from server side rendering
  output: 'static',
  // By default set to false, add true to get urls ending in /
  trailingSlash: false,
  // Deployed to GitHub Pages at https://shortlink-org.github.io/architecture
  // If a custom domain is ever attached (CNAME), set this back to '/'.
  base: '/architecture',
  // Resource search is the default lightweight search. Change this to { type: 'indexed' }
  // to enable full-content search. Indexed search requires running a build to generate the index.
  search: {
    type: 'resource',
  },
  // Customize the navigation for your docs sidebar.
  // read more at https://eventcatalog.dev/docs/development/customization/customize-sidebars/documentation-sidebar
  navigation: {
    pages: ['list:top-level-domains', 'list:top-level-diagrams', 'list:all'],
  },
  mermaid: {
    enableSupportForElkLayout: true,
    iconPacks: ['logos'],
  },
  rss: {
    enabled: true,
    limit: 15,
  },
  visualiser: {
    enabled: true,
    channels: {
      renderMode: 'flat',
    },
    architectureGraph: {
      enabled: true,
    },
  },
  // Customize the logo, add your logo to public/ folder
  logo: {
    alt: 'shortlink-org Logo',
    src: '/logo.png',
    text: 'shortlink-org',
  },
  // This lets you copy markdown contents from EventCatalog to your clipboard
  // Including schemas for your events and services
  llmsTxt: {
    enabled: true,
  },
  // required random generated id used by eventcatalog
  cId: '3680a44e-c5d3-444c-94e8-86b74db9b05f',
};
