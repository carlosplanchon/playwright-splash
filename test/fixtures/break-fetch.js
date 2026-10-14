// NODE_OPTIONS preload: the adblock lists fail to download.
globalThis.fetch = () => Promise.reject(new Error('simulated network failure'));
