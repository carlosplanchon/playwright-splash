FROM node:24-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN useradd --create-home pwuser
WORKDIR /home/pwuser

# Install the application dependencies.
COPY package.json package-lock.json /home/pwuser/
RUN apt-get update \
    && apt-get install -y --no-install-recommends procps \
    && npm ci --omit=dev \
    && npx playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm

COPY server.js proxy.js /home/pwuser/

EXPOSE 56572

USER pwuser

CMD [ "node", "server.js" ]
