# playwright_splash
Simple Playwright scraper which receives an URL and returns the website code.

### Docker Image:
The Docker image for Playwright Splash can be found at
https://hub.docker.com/repository/docker/carlosplanchon/playwright_splash/general

### Running Playwright Splash:
To run Playwright Splash, use the following command:
```
docker run -it --rm --ipc=host --user pwuser --security-opt seccomp=seccomp_profile.json -p 56572:56572 carlosplanchon/playwright_splash
```

Please note that this command needs the seccomp_profile.json file from this repository. It is Docker's default seccomp profile (https://github.com/moby/profiles/blob/main/seccomp/default.json) plus the user namespace rule that Playwright adds to its own profile (https://playwright.dev/docs/docker). Playwright's profile itself makes containers fail to start with recent Docker versions (tested with Docker 29.9 and runc 1.5.2).
