export async function onRequest(context) {
  const response = await context.next();
  const url = new URL(context.request.url);

  // Clone the response so we can modify headers
  const newResponse = new Response(response.body, response);

  // ─── Cross-Origin Isolation (required for SharedArrayBuffer / FFmpeg WASM multi-threaded) ───
  // These headers MUST be set here in the middleware because Cloudflare Pages
  // _headers file only applies to static assets — when a Pages Function
  // (this middleware) handles the request, _headers rules are bypassed.
  //
  // COOP: prevents other origins from getting a reference to this window.
  // COEP: "credentialless" (not "require-corp") is used because the FFmpeg
  //       WASM files are fetched from unpkg.com, which does NOT set a
  //       Cross-Origin-Resource-Policy header. "require-corp" would block
  //       those fetches and cause the silent stall in production.
  //       "credentialless" enables SharedArrayBuffer while allowing
  //       no-credential cross-origin fetches to succeed.
  newResponse.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  newResponse.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');

  // Block search-engine indexing of preview/staging *.pages.dev deploys
  if (url.hostname.endsWith('.pages.dev')) {
    newResponse.headers.set('X-Robots-Tag', 'noindex');
  }

  return newResponse;
}
