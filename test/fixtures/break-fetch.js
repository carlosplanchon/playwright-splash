// Preloaded with NODE_OPTIONS to make the adblock list download fail.
globalThis.fetch = () => Promise.reject(new Error('simulated network failure'));
