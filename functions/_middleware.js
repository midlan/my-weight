// Edge middleware that runs on every request before static assets
// are served. The single job today is canonicalising the bare CF
// Pages aliases to the custom domain — anyone landing on
// `my-weight.pages.dev` or `dev.my-weight.pages.dev` should be
// 301'd to the corresponding mojevaha.cz host so we have one
// canonical origin (matters for OAuth, SEO, link sharing, and the
// privacy-policy URL that Google's consent screen displays).
//
// Per-deployment preview URLs (e.g. `abc123.my-weight.pages.dev`)
// are intentionally NOT rewritten — those are the URLs the deploy
// workflow's smoke step hits, and the curl + Playwright checks
// would all 301 if we touched them. They're only used by CI and
// are not user-facing.

const CANONICAL = {
  'my-weight.pages.dev': 'https://www.mojevaha.cz',
  'dev.my-weight.pages.dev': 'https://dev.mojevaha.cz',
};

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = CANONICAL[url.hostname];
  if (target) {
    return Response.redirect(target + url.pathname + url.search, 301);
  }
  return context.next();
}
