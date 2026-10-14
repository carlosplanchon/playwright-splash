# playwright_splash
Simple Playwright scraper which receives an URL and returns the website code.

### Docker Image:
The Docker image for Playwright Splash can be found at
https://hub.docker.com/repository/docker/carlosplanchon/playwright_splash/general

### Running Playwright Splash:
To run Playwright Splash, use the following command:
```
docker run -it --rm --init --ipc=host --security-opt seccomp=seccomp_profile.json -e SPLASH_TOKEN=<your-token> -p 127.0.0.1:56572:56572 carlosplanchon/playwright_splash
```

`SPLASH_TOKEN` is required: the server refuses to start without it. You can generate one with `openssl rand -hex 32`. The port is only published on 127.0.0.1; change `-p` if other machines need to reach the server.

At most 4 pages are rendered at the same time and the other requests wait for their turn. Set `SPLASH_MAX_PAGES` (e.g. `-e SPLASH_MAX_PAGES=8`) to change that limit. When a client disconnects, its request is dropped: if it was waiting, its page is never opened, and if it was rendering, its page is closed right away.

Each page gets up to 120 seconds in total. Once its HTML has loaded, the server waits up to 10 seconds for images and other resources (if they take longer, it reads the page anyway) and then spends up to 30 seconds scrolling to load lazy content. Set `SPLASH_REQUEST_TIMEOUT`, `SPLASH_LOAD_TIMEOUT` and `SPLASH_SCROLL_TIMEOUT` (in milliseconds) to change them.

Pages can't reach internal networks (loopback, private ranges, link-local addresses such as cloud metadata endpoints, etc.). The server answers 403 when the URL points to one, and all the browser's traffic goes through an internal proxy that also blocks them in redirects, subresources and WebSockets. To allow specific internal networks, set `SPLASH_ALLOWED_NETWORKS` to a comma-separated list of addresses or CIDR ranges (e.g. `-e SPLASH_ALLOWED_NETWORKS=10.1.2.0/24,192.168.1.10`).

Please note that this command needs the seccomp_profile.json file from this repository, because Chromium runs with its sandbox enabled. It is Docker's default seccomp profile (https://github.com/moby/profiles/blob/main/seccomp/default.json) plus the user namespace rule that Playwright adds to its own profile (https://playwright.dev/docs/docker). Playwright's profile itself makes containers fail to start with recent Docker versions (tested with Docker 29.9 and runc 1.5.2).

### Usage:
Send the URL to `/scrape` with the token. Only http and https URLs are accepted.
```
curl -X POST http://127.0.0.1:56572/scrape -H 'Authorization: Bearer <your-token>' -H 'Content-Type: application/json' -d '{"url": "https://example.com"}'
```

The response body is the rendered HTML. The `X-Splash-Status` header has the HTTP status of the page (e.g. `404`) and `X-Splash-Url` its final URL, after redirects, including the ones the page does by itself (meta refresh, JavaScript). The server answers 403 when the URL points to an internal network or redirects to one over plain HTTP.

### Tests:
`npm test` runs the unit and integration tests (it needs Node.js 20 or later). The integration tests build the Docker image and run containers against local test pages, so they need Docker on Linux; they are skipped when Docker isn't available. `npm run test:unit` runs only the unit tests.
