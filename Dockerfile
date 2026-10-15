FROM node:24-bookworm-slim

ENV DISPLAY=:99
RUN useradd --create-home pwuser
WORKDIR /home/pwuser

# Install the application dependencies, Google Chrome and a virtual display.
COPY package.json package-lock.json /home/pwuser/
RUN apt-get update \
    && apt-get install -y --no-install-recommends procps xvfb \
    && npm ci --omit=dev \
    && npx patchright install chrome \
    && mkdir -p /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# Keeps WebRTC from sending UDP outside the proxy.
RUN mkdir -p /etc/opt/chrome/policies/managed \
    && echo '{ "WebRtcIPHandling": "disable_non_proxied_udp" }' > /etc/opt/chrome/policies/managed/splash.json

COPY server.js proxy.js /home/pwuser/

EXPOSE 56572

USER pwuser

CMD [ "sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp & exec node server.js" ]
