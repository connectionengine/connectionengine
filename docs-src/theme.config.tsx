import { useConfig } from 'nextra-theme-docs'

export default {
  project: {
    link: 'https://github.com/connectionengine/connectionengine'
  },
  logo: <span style={{ fontWeight: 600 }}>Connection Engine</span>,
  darkMode: true,
  docsRepositoryBase: 'https://github.com/connectionengine/connectionengine/blob/main/docs-src',
  footer: {
    text: 'Connection Engine — a spatial semantic web runtime. CAL-1.0.'
  },
  search: {
    loading: 'Loading…'
  },
  head: function useHead() {
    const config = useConfig<{ description?: string }>()
    const description =
      config.frontMatter.description ??
      'Connection Engine — a TypeScript ECS + multiplayer engine for spatial semantic experiences.'
    return (
      <>
        <meta httpEquiv="Content-Language" content="en" />
        <meta name="description" content={description} />
        <meta name="og:description" content={description} />
        <meta name="og:title" content={`${config.title} – Connection Engine`} />
      </>
    )
  },
  useNextSeoProps() {
    return {
      titleTemplate: '%s | Connection Engine'
    }
  }
}
