# The image version must match the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

WORKDIR /home/pwuser

# Install the application dependencies.
COPY package.json package-lock.json /home/pwuser/
RUN npm ci --omit=dev

COPY server.js /home/pwuser

EXPOSE 56572

USER pwuser

CMD [ "node", "server.js" ]
