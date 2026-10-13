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

Please note that this command needs the seccomp_profile.json file from this repository, because Chromium runs with its sandbox enabled. It is Docker's default seccomp profile (https://github.com/moby/profiles/blob/main/seccomp/default.json) plus the user namespace rule that Playwright adds to its own profile (https://playwright.dev/docs/docker). Playwright's profile itself makes containers fail to start with recent Docker versions (tested with Docker 29.9 and runc 1.5.2).

### Usage:
Send the URL to `/scrape` with the token. Only http and https URLs are accepted.
```
curl -X POST http://127.0.0.1:56572/scrape -H 'Authorization: Bearer <your-token>' -H 'Content-Type: application/json' -d '{"url": "https://example.com"}'
```
