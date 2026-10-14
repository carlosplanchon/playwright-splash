// NODE_OPTIONS preload: the adblock lists answer 429.
globalThis.fetch = () => Promise.resolve(new Response('Too Many Requests', { status: 429 }));
